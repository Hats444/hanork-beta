'use strict';

const logger = require('../logger');
const { prefixFromCtx } = require('../utils/configManager');
const { sendInteractiveButtons } = require('../helpers');
const store = require('../services/billing/store');
const mp = require('../services/billing/mercadoPagoService');
const {
  centsToReais,
  vipPlans,
  botPlans,
  isBotPlan,
  clampVipDays,
  vipPlanForDays,
  BOT_PRICE_CENTS,
  validityLabel,
  plansForTier,
  formatReaisLabel,
  monthlyPlanForTier,
  daypassPlan,
  tierButtonLabel,
  daypassButtonLabel
} = require('../services/billing/logic');
const { notifyAdmins } = require('../services/billing/notify');
const knowledge = require('../data/product/knowledge.json');
const { buildSobreMenu, DEV_WA_CHAT, FREE_TELEGRAM, FREE_CATALOG, howToUseWhatsApp } = require('../utils/productOffer');

const commands = {};

function pfx(ctx) {
  return prefixFromCtx(ctx) || (ctx?.platform === 'telegram' ? '/' : '.');
}

function isTgAdmin(ctx) {
  try {
    const { isAdmin } = require('../utils/userManager');
    const id = ctx?.telegramUserId || ctx?.tgUserId;
    return !!(id && isAdmin(id));
  } catch (_) {
    return false;
  }
}

const ADMIN_TEST_BANNER = 'MODO TESTE ADMIN — neste chip tudo ja esta liberado. Sem pagar. O fluxo abaixo e o que o cliente ve.';

function identityFromCtx(ctx) {
  if (ctx.platform === 'telegram' || ctx._isTelegramShim) {
    return {
      platform: 'telegram',
      platformUser: String(ctx.telegramUserId || ctx.sender || ''),
      aliases: []
    };
  }
  const main = String(ctx.sender || ctx.info?.key?.participant || ctx.from || '');
  const aliases = [ctx.senderAlt, ctx.info?.key?.participantAlt, ctx.info?.key?.remoteJidAlt]
    .map((x) => String(x || '').trim())
    .filter((x) => x && x !== main && !x.endsWith('@g.us'));
  return { platform: 'whatsapp', platformUser: main, aliases };
}

const BILLING_OPEN_CMDS = new Set([
  'comprar', 'planos', 'preco', 'minhaconta', 'meuplano', 'meupagamento',
  'suporte', 'vincular', 'vincularconta', 'baixarbot', 'meubot', 'afiliado', 'indicar'
]);

const BILLING_OPEN_PHRASE = /\b(comprar|planos?|assinatura|precos?|pix|pagar|licenca|quero o bot|baixar.?bot|meuplano|minhaconta|vincular|checkout|quero vip|plano vip)\b/i;

function mapBillingPhrase(ctx) {
  const t = String(ctx?.fullText || ctx?.text || ctx?.command || '').toLowerCase().trim();
  if (!t) return '';
  if (/^(comprar|planos|preco|precos|assinatura)\b/.test(t)) return 'comprar';
  if (/^(minhaconta|meuplano|meupagamento)\b/.test(t)) return 'minhaconta';
  if (/^(vincular|vincularconta)\b/.test(t)) return 'vincular';
  if (/^(baixarbot|meubot)\b/.test(t)) return 'baixarbot';
  if (/^(afiliado|afiliados|indicar)\b/.test(t)) return 'afiliado';
  if (/^(suporte)\b/.test(t)) return 'suporte';
  return '';
}

function isBillingOpenInbound(ctx) {
  const cmd = String(ctx.command || '').toLowerCase();
  if (BILLING_OPEN_CMDS.has(cmd)) return true;
  const mapped = mapBillingPhrase(ctx);
  if (mapped) {
    if (!ctx.command) ctx.command = mapped;
    return true;
  }
  const id = String(ctx.buttonId || ctx.fullText || '').trim();
  if (/^bill_/i.test(id)) return true;
  if (/^cmd_(comprar|planos|preco|minhaconta|suporte|vincular|baixarbot)/i.test(id)) return true;
  const step = String(ctx.session?.step || '');
  if (/^bill_|awaiting_bill|awaiting_pix|awaiting_vip|awaiting_comprar/i.test(step)) return true;
  const blob = `${ctx.fullText || ''} ${ctx.text || ''} ${ctx.buttonId || ''}`;
  if (BILLING_OPEN_PHRASE.test(blob)) return true;
  return false;
}

async function hasOpenCheckout(ctx) {
  try {
    const ident = identityFromCtx(ctx);
    const users = [ident.platformUser, ...(ident.aliases || [])].filter(Boolean);
    for (const u of users) {
      const acc = await store.accountFor(ident.platform, u);
      const orders = acc?.orders || [];
      if (orders.some((o) => String(o.status || '') === 'pending')) return true;
    }
  } catch (_) { /* store opcional */ }
  return false;
}

async function ensureBillingPv(conn, ctx) {
  if (!ctx || ctx._isTelegramShim || ctx.platform === 'telegram') return ctx;
  if (!ctx.isGroup) return ctx;
  const pv = String(ctx.sender || '').trim();
  if (!pv || pv.endsWith('@g.us')) return ctx;
  try {
    await conn.sendMessage(ctx.from, { react: { text: '📩', key: ctx.info?.key } });
  } catch (_) { /* react opcional */ }
  try {
    await conn.sendMessage(ctx.from, {
      text: `Abri a compra no seu privado. Se nao chegar, me chama no PV e manda ${pfx(ctx)}comprar`
    }, { quoted: ctx.info, skipForward: true, _hanorkTrusted: true });
  } catch (_) { /* grupo pode recusar */ }
  ctx.from = pv;
  ctx.info = null;
  return ctx;
}

function formatPlanLine(plan) {
  const reais = (Number(plan.price_cents) / 100).toFixed(0);
  const days = Number(plan.duration_days);
  if (isBotPlan(plan)) return `${plan.name} — R$ ${reais} — permanente (nao vence)`;
  if (!days) return `${plan.name} — R$ ${reais} — vitalicio`;
  if (days === 365) return `${plan.name} — R$ ${reais} — vale 365 dias (anual)`;
  return `${plan.name} — R$ ${reais} — vale ${days} dia${days === 1 ? '' : 's'}`;
}

async function tgUi(bot, chatId, text, rows) {
  const keyboard = rows || [[{ text: 'Voltar', callback_data: 'bill_home' }]];
  try {
    const tg = require('../telegramBot');
    if (typeof tg.sendMenuWithImage === 'function') {
      return tg.sendMenuWithImage(chatId, text, keyboard);
    }
  } catch (_) { /* telegramBot pode nao estar pronto */ }
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

function howToFor(ctx) {
  return howToUseWhatsApp(ctx && ctx.telegramUserId);
}

function preSaleText(ctx) {
  const { storefrontText, howToUseWhatsApp } = require('../utils/productOffer');
  return [storefrontText(), '', howToUseWhatsApp(ctx && ctx.telegramUserId)].join('\n');
}

const vipDaysByUser = new Map();

function pickerKey(ctx) {
  return String(ctx.telegramUserId || ctx.tgUserId || ctx.sender || ctx.from || '');
}

function getVipDays(ctx) {
  return clampVipDays(vipDaysByUser.get(pickerKey(ctx)) || 30);
}

function setVipDays(ctx, days) {
  const n = clampVipDays(days);
  vipDaysByUser.set(pickerKey(ctx), n);
  return n;
}

function affiliateShareText(url) {
  const { storefrontText } = require('../utils/productOffer');
  return [
    storefrontText(),
    '',
    'Entra por este link (indicacao):',
    url
  ].join('\n');
}

function telegramStartUrl(payload = 'comprar') {
  try {
    return require('../utils/productOffer').telegramStartLink(payload);
  } catch (_) {
    return FREE_TELEGRAM;
  }
}

function telegramRefUrl(code) {
  try {
    return require('../utils/productOffer').telegramRefLink(code);
  } catch (_) {
    const c = String(code || '').replace(/[^A-Za-z0-9]/g, '');
    return c ? `${FREE_TELEGRAM}?start=ref_${c}` : FREE_TELEGRAM;
  }
}

async function sendHome(conn, ctx) {
  await ensureBillingPv(conn, ctx);
  const from = ctx.from;
  const p = pfx(ctx);
  const onTelegram = ctx.platform === 'telegram' || ctx._isTelegramShim || ctx.tgBot;
  if (!onTelegram) {
    const url = telegramStartUrl('comprar');
    const { storefrontText } = require('../utils/productOffer');
    const lines = [
      storefrontText(),
      '',
      `Abre no Telegram: ${url}`,
      '',
      `Conta neste Zap: ${p}minhaconta`
    ].join('\n');
    await sendInteractiveButtons(
      conn,
      from,
      lines,
      [{ url, label: 'Pagar no Telegram' }, { id: 'bill_account', label: 'Minha conta', short: 'Conta' }],
      'Hanork',
      ctx.info,
      'menu.jpg',
      ctx.telegramUserId
    );
    return;
  }
  try { require('../utils/opsMetrics').bump('funnelHome'); } catch (_) { /* */ }
  const { yearlyPlan, zipPlan, formatReaisLabel } = require('../services/billing/logic');
  const y = yearlyPlan();
  const z = zipPlan();
  const yearLbl = y ? `1 ano ${formatReaisLabel(y.price_cents)}` : '1 ano';
  const zipLbl = z ? `Zip ${formatReaisLabel(z.price_cents)}` : 'Zip';
  const lines = [
    preSaleText(ctx),
    '',
    isTgAdmin(ctx) ? ADMIN_TEST_BANNER : '',
    mp.isConfigured()
      ? 'PIX, cartao ou boleto. Libera so com pagamento aprovado.'
      : 'Pagamento automatico indisponivel. Fale com o dono.',
    `Conta: ${p}minhaconta  ·  Ajuda: ${p}suporte`
  ].filter(Boolean).join('\n');
  const monthLbl = tierButtonLabel('pro');
  const dayLbl = daypassButtonLabel();
  const buttons = mp.isConfigured()
    ? [
      { id: 'bill_plan_daypass', label: dayLbl, short: '1d' },
      { id: 'bill_plan_pro_m', label: monthLbl, short: '30d' },
      { id: 'bill_how', label: 'Como funciona', short: 'Como' }
    ]
    : [
      { url: DEV_WA_CHAT, label: 'Abrir o bot' },
      { url: FREE_TELEGRAM, label: 'Bot no Telegram' }
    ];
  if (ctx.tgBot && ctx.tgChatId) {
    const rows = mp.isConfigured()
      ? [
        [{ text: dayLbl, callback_data: 'bill_plan_daypass' }],
        [{ text: monthLbl, callback_data: 'bill_plan_pro_m' }],
        [{ text: yearLbl, callback_data: 'bill_plan_pro_y' }],
        [{ text: zipLbl, callback_data: 'bill_plan_bot' }],
        [{ text: 'Como funciona', callback_data: 'bill_how' }],
        [{ text: 'Ja sou cliente', callback_data: 'menu_main' }],
        [{ text: 'Minha conta', callback_data: 'bill_account' }, { text: 'Afiliado', callback_data: 'bill_afiliado' }],
        [{ text: 'Suporte', callback_data: 'bill_suporte' }]
      ]
      : [[{ text: 'Abrir o bot', url: DEV_WA_CHAT }]];
    return tgUi(ctx.tgBot, ctx.tgChatId, lines, rows);
  }
  await sendInteractiveButtons(conn, from, lines, buttons, 'Hanork', ctx.info, 'menu.jpg', ctx.telegramUserId);
}

async function sendTermPicker(conn, ctx, tier) {
  await ensureBillingPv(conn, ctx);
  const t = String(tier || 'pro').toLowerCase();
  if (t === 'starter') return sendMethods(conn, ctx, 'daypass');
  if (t === 'enterprise') return sendMethods(conn, ctx, 'pro_y');
  const listed = plansForTier('pro');
  if (!listed.length) return sendHome(conn, ctx);
  const lines = [
    'ASSINATURA',
    isTgAdmin(ctx) ? ADMIN_TEST_BANNER : '',
    '',
    'Escolha por quanto tempo o plano vale:',
    ...listed.map((p) => formatPlanLine(p))
  ].filter(Boolean).join('\n');
  const buttons = [
    ...listed.map((p) => ({
      id: `bill_plan_${p.id}`,
      label: `${p.term || p.name} R$ ${(p.price_cents / 100).toFixed(0)}`,
      short: String(p.term || p.id).slice(0, 8)
    })),
    { id: 'bill_home', label: 'Voltar', short: 'Voltar' }
  ];
  if (ctx.tgBot && ctx.tgChatId) {
    const rows = [
      ...listed.map((p) => [{
        text: `${p.term || p.name} R$ ${(p.price_cents / 100).toFixed(0)}`,
        callback_data: `bill_plan_${p.id}`
      }]),
      [{ text: 'Voltar', callback_data: 'bill_home' }]
    ];
    return tgUi(ctx.tgBot, ctx.tgChatId, lines, rows);
  }
  await sendInteractiveButtons(conn, ctx.from, lines, buttons, 'Hanork', ctx.info, 'menu.jpg', ctx.telegramUserId);
}

async function sendDayPicker(conn, ctx) {
  return sendTermPicker(conn, ctx, 'pro');
}

async function sendPlans(conn, ctx) {
  return sendDayPicker(conn, ctx);
}

async function sendBotOffer(conn, ctx) {
  await ensureBillingPv(conn, ctx);
  const plans = botPlans(await store.listPlans());
  const plan = plans[0];
  if (!plan) {
    return conn.sendMessage(ctx.from, { text: 'Plano do bot indisponivel.' }, { quoted: ctx.info });
  }
  return sendMethods(conn, ctx, plan.id);
}

async function sendMethods(conn, ctx, planId) {
  await ensureBillingPv(conn, ctx);
  const plan = await store.getPlan(planId);
  if (!plan) {
    return conn.sendMessage(ctx.from, { text: 'Plano nao encontrado.' }, { quoted: ctx.info });
  }
  const reais = (plan.price_cents / 100).toFixed(0);
  const text = [
    plan.name,
    `R$ ${reais}`,
    Number(plan.duration_days) > 0
      ? `Vale por: ${plan.duration_days} dia${Number(plan.duration_days) === 1 ? '' : 's'}`
      : (isBotPlan(plan) ? 'Permanente (nao vence)' : 'Vitalicio neste bot'),
    '',
    isBotPlan(plan)
      ? 'Voce compra o codigo no seu numero. Zip vai no PV depois do PIX (sem .env).'
      : (plan.id === 'daypass'
        ? '1 dia: protecao de UM grupo (preset loja / antilink). Sem divulgacao em massa.'
        : 'Pro: protecao do grupo + divulgacao no WhatsApp (depois de parear).'),
    '',
    howToFor(ctx),
    '',
    'Como pagar?'
  ].join('\n');
  if (ctx.tgBot && ctx.tgChatId) {
    return tgUi(ctx.tgBot, ctx.tgChatId, text, [
      [{ text: 'PIX', callback_data: `bill_m_pix_${plan.id}` }],
      [{ text: 'Cartao', callback_data: `bill_m_card_${plan.id}` }],
      [{ text: 'Boleto', callback_data: `bill_m_boleto_${plan.id}` }],
      [{ text: 'Voltar', callback_data: 'bill_home' }]
    ]);
  }
  await sendInteractiveButtons(
    conn,
    ctx.from,
    text,
    [
      { id: `bill_m_pix_${plan.id}`, label: 'PIX', short: 'PIX' },
      { id: `bill_m_card_${plan.id}`, label: 'Cartao', short: 'Cartao' },
      { id: `bill_m_boleto_${plan.id}`, label: 'Boleto', short: 'Boleto' }
    ],
    'Hanork',
    ctx.info,
    'menu.jpg',
    ctx.telegramUserId
  );
}

async function startCheckout(conn, ctx, planId, method) {
  if (isTgAdmin(ctx)) {
    const plan = await store.getPlan(planId);
    const name = plan?.name || planId;
    const text = [
      ADMIN_TEST_BANNER,
      '',
      `Preview: ${name} via ${method || 'pix'}.`,
      'Cliente real veria o PIX/cartao aqui.',
      'No teu chip de admin o VIP e a licenca ja estao ativos, sem validade.'
    ].join('\n');
    if (ctx.tgBot && ctx.tgChatId) {
      return tgUi(ctx.tgBot, ctx.tgChatId, text, [
        [{ text: 'Voltar', callback_data: 'bill_home' }]
      ]);
    }
    return conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
  }
  if (!mp.isConfigured()) {
    return conn.sendMessage(ctx.from, {
      text: 'Pagamento automatico indisponivel agora. Tente mais tarde ou fale com o dono.'
    }, { quoted: ctx.info });
  }
  const ident = identityFromCtx(ctx);
  if (!ident.platformUser) {
    return conn.sendMessage(ctx.from, { text: 'Nao consegui identificar sua conta.' }, { quoted: ctx.info });
  }
  const customer = await store.upsertCustomer(ident.platform, ident.platformUser, ident.aliases);
  const order = await store.createOrder({
    customer,
    planId,
    method,
    sessionOwner: ctx.telegramUserId,
    chatJid: ctx.from,
    platform: ident.platform
  });
  try {
    const m = require('../utils/opsMetrics');
    if (String(planId) === 'daypass') m.bump('daypassCheckout');
    else if (String(planId).startsWith('pro_')) m.bump('proCheckout');
  } catch (_) { /* */ }
  const plan = await store.getPlan(planId);
  const amountReais = centsToReais(order.amount_cents);
  const desc = `Hanork ${plan?.name || planId}`;

  try {
    if (method === 'pix') {
      const pix = await mp.createPix({
        amountReais,
        description: desc,
        externalRef: order.id
      });
      await store.updateOrder(order.id, {
        status: 'pending',
        mp_payment_id: pix.id,
        poll_count: 0
      });
      await sendPix(conn, ctx, order, pix, amountReais);
      return;
    }
    const pref = await mp.createCheckout({
      amountReais,
      description: desc,
      externalRef: order.id,
      method
    });
    await store.updateOrder(order.id, {
      status: 'pending',
      mp_preference_id: pref.id,
      poll_count: 0
    });
    const payLabel = method === 'boleto' ? 'Abrir boleto' : 'Pagar agora';
    const text = [
      `Pedido ${order.id.slice(0, 8)}`,
      `${plan?.name} — R$ ${Number(amountReais).toFixed(2)}`,
      '',
      method === 'boleto'
        ? 'Toque em Abrir boleto e pague no Mercado Pago.'
        : 'Toque em Pagar agora e conclua no Mercado Pago.',
      'O bot confirma sozinho. Se demorar: Ja paguei.'
    ].join('\n');
    const payButtons = [
      { url: pref.init_point, label: payLabel },
      { id: `bill_chk_${order.id}`, label: 'Ja paguei', short: 'Checar' }
    ];
    if (ctx.tgBot && ctx.tgChatId) {
      await sendTelegramPay(ctx, text, payButtons);
      return;
    }
    await sendInteractiveButtons(
      conn,
      ctx.from,
      text,
      payButtons,
      'Hanork',
      ctx.info,
      null,
      ctx.telegramUserId,
      null,
      { forceNative: true }
    );
  } catch (e) {
    logger.logAviso(`[billing] checkout: ${e.message}`);
    await conn.sendMessage(ctx.from, {
      text: 'Nao consegui gerar o pagamento agora. Tente de novo em instantes.'
    }, { quoted: ctx.info });
  }
}

function tgInlineFromPayButtons(buttons) {
  const rows = [];
  for (const b of buttons || []) {
    if (!b) continue;
    if (b.copy) {
      rows.push([{ text: String(b.label || 'Copiar PIX').slice(0, 64), copy_text: { text: String(b.copy) } }]);
    } else if (b.url) {
      rows.push([{ text: String(b.label || 'Pagar agora').slice(0, 64), url: String(b.url) }]);
    } else if (b.id) {
      rows.push([{ text: String(b.label || 'Opcao').slice(0, 64), callback_data: String(b.id).slice(0, 64) }]);
    }
  }
  return rows;
}

async function sendTelegramPay(ctx, text, buttons, photoBuf) {
  const rows = tgInlineFromPayButtons(buttons);
  if (photoBuf) {
    try {
      const tg = require('../telegramBot');
      if (typeof tg.sendPaymentQr === 'function') {
        return tg.sendPaymentQr(ctx.tgChatId, photoBuf, String(text).slice(0, 900), rows);
      }
    } catch (_) { /* fallback abaixo */ }
  } else {
    try {
      return await tgUi(ctx.tgBot, ctx.tgChatId, String(text).slice(0, 900), rows);
    } catch (_) { /* fallback abaixo */ }
  }
  const kb = { reply_markup: { inline_keyboard: rows } };
  try {
    if (photoBuf) {
      await ctx.tgBot.sendPhoto(ctx.tgChatId, photoBuf, { caption: String(text).slice(0, 900), ...kb });
    } else {
      await ctx.tgBot.sendMessage(ctx.tgChatId, text, kb);
    }
  } catch (_) {
    const fallback = buttons.reduce((acc, b) => {
      if (b?.copy) return `${acc}\n\n${b.label || 'PIX'}:\n${b.copy}`;
      if (b?.url) return `${acc}\n\n${b.label || 'Link'}: ${b.url}`;
      return acc;
    }, String(text || ''));
    const check = (buttons || []).filter((b) => b && b.id).map((b) => [{ text: b.label || 'Ja paguei', callback_data: String(b.id).slice(0, 64) }]);
    await ctx.tgBot.sendMessage(ctx.tgChatId, fallback.slice(0, 3900), {
      reply_markup: { inline_keyboard: check.length ? check : undefined }
    });
  }
}

async function sendPix(conn, ctx, order, pix, amountReais) {
  const pixCode = String(pix.qr_code || '');
  let plan = null;
  try { plan = order.plan_id ? await store.getPlan(order.plan_id) : null; } catch (_) {}
  const caption = [
    `PIX R$ ${Number(amountReais).toFixed(2)}`,
    plan ? formatPlanLine(plan) : '',
    `Pedido ${order.id.slice(0, 8)}`,
    '',
    'Toque em Copiar PIX e cole no banco.',
    'O bot confirma sozinho. Se demorar: Ja paguei.'
  ].filter(Boolean).join('\n');
  const payButtons = [];
  if (pixCode) payButtons.push({ copy: pixCode, label: 'Copiar PIX' });
  payButtons.push({ id: `bill_chk_${order.id}`, label: 'Ja paguei', short: 'Checar' });
  let qrBuf = null;
  try {
    const QRCode = require('qrcode');
    if (pixCode) qrBuf = await QRCode.toBuffer(pixCode, { type: 'png', margin: 1, width: 320 });
  } catch (_) { /* QR opcional */ }
  if (ctx.tgBot && ctx.tgChatId) {
    await sendTelegramPay(ctx, caption, payButtons, qrBuf);
    return;
  }
  await sendInteractiveButtons(
    conn,
    ctx.from,
    caption,
    payButtons,
    'Hanork',
    ctx.info,
    qrBuf,
    ctx.telegramUserId,
    null,
    { forceNative: true }
  );
}

async function checkOrder(conn, ctx, orderId) {
  const order = await store.getOrder(orderId);
  if (!order) {
    return conn.sendMessage(ctx.from, { text: 'Pedido nao encontrado.' }, { quoted: ctx.info });
  }
  if (order.status === 'delivered') {
    return conn.sendMessage(ctx.from, {
      text: `Este pedido ja foi entregue.\nConta: ${pfx(ctx)}minhaconta\n\n${howToFor(ctx)}`
    }, { quoted: ctx.info });
  }
  if (!mp.isConfigured()) {
    return conn.sendMessage(ctx.from, { text: 'Nao consigo consultar o Mercado Pago agora.' }, { quoted: ctx.info });
  }
  try {
    let hits = [];
    if (order.mp_payment_id) hits = [await mp.getStatus(order.mp_payment_id)];
    else hits = await mp.findByReference(order.id);
    const approved = hits.find((h) => String(h.status).toLowerCase() === 'approved');
    if (!approved) {
      const st = hits[0]?.status || 'pending';
      return conn.sendMessage(ctx.from, {
        text: `Ainda nao aprovado (status: ${st}). PIX pode levar alguns segundos.`
      }, { quoted: ctx.info });
    }
    const { handleApproved } = require('../services/billing/webhookService');
    const result = await handleApproved(approved);
    if (result.ok) {
      return conn.sendMessage(ctx.from, {
        text: `Pagamento aprovado.\n${howToFor(ctx)}`
      }, { quoted: ctx.info });
    }
    return conn.sendMessage(ctx.from, {
        text: `Recebi o pagamento mas a entrega nao concluiu. Abra ${pfx(ctx)}suporte`
    }, { quoted: ctx.info });
  } catch (e) {
    logger.logAviso(`[billing] check: ${e.message}`);
    return conn.sendMessage(ctx.from, {
      text: 'Nao consegui consultar agora. Tente de novo em instantes.'
    }, { quoted: ctx.info });
  }
}

async function sendAccount(conn, ctx) {
  await ensureBillingPv(conn, ctx);
  if (isTgAdmin(ctx)) {
    const p = pfx(ctx);
    const text = [
      'MINHA CONTA',
      ADMIN_TEST_BANNER,
      '',
      'VIP: ativo (admin, vitalicio)',
      'Licenca do bot: ativa (permanente, nao vence)',
      'Validade: nao vence',
      '',
      `Renovar (preview): ${p}comprar`
    ].join('\n');
    if (ctx.tgBot && ctx.tgChatId) {
      return tgUi(ctx.tgBot, ctx.tgChatId, text, [
        [{ text: 'Ver fluxo de compra', callback_data: 'bill_home' }],
        [{ text: 'Afiliado', callback_data: 'bill_afiliado' }]
      ]);
    }
    return conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
  }
  const ident = identityFromCtx(ctx);
  const acc = await store.accountFor(ident.platform, ident.platformUser);
  const p = pfx(ctx);
  if (!acc.customer) {
    return conn.sendMessage(ctx.from, {
      text: `Sem compras nesta conta.\nPlanos: ${p}comprar\nSe pagou no outro app: ${p}vincular CODIGO`
    }, { quoted: ctx.info });
  }
  const ent = acc.entitlement;
  const vip = ent && ent.status === 'active' && !store.isExpired(ent.expires_at);
  const botOk = acc.botLicense && acc.botLicense.status === 'active';
  let codeLine = '';
  try {
    const code = await store.createLinkCode(acc.customer.id);
    codeLine = `Vinculo Zap/Telegram (15 min): ${code.code}\nNo outro app: ${p}vincular ${code.code}`;
  } catch (_) { /* sql */ }
  const lines = [
    'MINHA CONTA',
    `VIP: ${vip ? 'ativo' : 'inativo'}`,
    botOk ? 'Licenca do bot: ativa (permanente, nao vence)' : '',
    validityLabel(ent, vip),
    ent?.quota_tier ? `Faixa: ${ent.quota_tier}` : '',
    codeLine,
    '',
    'Pedidos recentes:',
    ...(acc.orders.length
      ? acc.orders.map((o) => `${o.id.slice(0, 8)} ${o.plan_id} R$${(o.amount_cents / 100).toFixed(0)} ${o.status}`)
      : ['(nenhum)']),
    '',
    `Renovar: ${p}comprar  ·  ${p}suporte`,
    '',
    (vip || botOk) ? howToFor(ctx) : ''
  ].filter(Boolean).join('\n');
  await conn.sendMessage(ctx.from, { text: lines }, { quoted: ctx.info });
}

async function autoSupport(conn, ctx, kind) {
  const ident = identityFromCtx(ctx);
  const acc = await store.accountFor(ident.platform, ident.platformUser);
  const p = pfx(ctx);
  if (kind === 'pagamento') {
    const pending = (acc.orders || []).find((o) => o.status === 'pending');
    if (pending) return checkOrder(conn, ctx, pending.id);
    return conn.sendMessage(ctx.from, { text: 'Nenhum pagamento pendente. ' + p + 'comprar' }, { quoted: ctx.info });
  }
  if (kind === 'renovacao') {
    const ent = acc.entitlement;
    if (ent && ent.status === 'active' && !store.isExpired(ent.expires_at)) {
      return conn.sendMessage(ctx.from, {
        text: `${validityLabel(ent, true)}. Renovar: ${p}comprar`
      }, { quoted: ctx.info });
    }
    return conn.sendMessage(ctx.from, { text: `Plano inativo. ${p}comprar` }, { quoted: ctx.info });
  }
  if (kind === 'entrega') {
    const last = (acc.orders || [])[0];
    if (last?.status === 'delivered') {
      return conn.sendMessage(ctx.from, { text: 'Ultimo pedido ja entregue. ' + p + 'minhaconta' }, { quoted: ctx.info });
    }
    if (last?.status === 'pending') return checkOrder(conn, ctx, last.id);
    return conn.sendMessage(ctx.from, { text: 'Sem entrega pendente.' }, { quoted: ctx.info });
  }
  return null;
}

async function sendSupport(conn, ctx) {
  const p = pfx(ctx);
  const text = [
    'SUPORTE',
    '',
    'Escolha o assunto. Casos simples o bot resolve sozinho.',
    `Conta: ${p}minhaconta`
  ].join('\n');
  await sendInteractiveButtons(
    conn,
    ctx.from,
    text,
    [
      { id: 'bill_sup_pagamento', label: 'Pagamento', short: 'Pagar' },
      { id: 'bill_sup_renovacao', label: 'Renovacao', short: 'Renovar' },
      { id: 'bill_sup_entrega', label: 'Entrega', short: 'Entrega' },
      { id: 'bill_sup_api', label: 'API', short: 'API' },
      { id: 'bill_sup_duvida', label: 'Duvida', short: 'Duvida' },
      { id: 'bill_sup_humano', label: 'Atendente', short: 'Humano' }
    ],
    'Hanork',
    ctx.info,
    null,
    ctx.telegramUserId
  );
}

async function openTicket(conn, ctx, subject, extra) {
  const ident = identityFromCtx(ctx);
  let customerId = null;
  try {
    const c = await store.upsertCustomer(ident.platform, ident.platformUser);
    customerId = c.id;
  } catch (_) { /* ignore */ }
  const t = await store.createTicket({
    customerId,
    subject,
    body: extra || subject
  });
  await notifyAdmins(`[billing] ticket ${t.id.slice(0, 8)} ${subject}`);
  await conn.sendMessage(ctx.from, {
    text: `Chamado aberto (id interno). O dono ve no ${pfx(ctx)}pedidos.`
  }, { quoted: ctx.info });
}

function healthText(payload, bill) {
  const sess = payload?.sessions || {};
  const mem = payload?.memory || {};
  const q = payload?.queues || {};
  const apis = payload?.intentPool;
  let apiLine = 'APIs: n/d';
  if (apis && typeof apis === 'object') {
    const names = Object.keys(apis.providers || apis || {});
    if (names.length) apiLine = `APIs pool: ${names.length} providers`;
  }
  const mpLine = bill.mpConfigured ? 'Mercado Pago: configurado' : 'Mercado Pago: nao configurado';
  const grade = payload?.commercial?.grade || (payload?.ok ? 'OK' : 'DOWN');
  const cmds = payload?.commands || {};
  const rssLine = `RSS: ${mem.rssMB || '?'} / ${mem.rssPairMaxMB || '?'} MB`;
  const cmdLine = `Cmds 1h: ok=${cmds.ok || 0} err=${cmds.err || 0}`;
  const fo = payload?.commercial?.failOpenHour;
  return [
    'HANORK BETA — HEALTH',
    '',
    `Grade: ${grade}`,
    `WhatsApp: ${sess.connected || 0} no ar / ${sess.registered || 0} registradas`,
    `Erros WA: ${payload?.commercial?.waError || 0} (parear, nao capacidade)`,
    `Database: ${bill.sql ? 'OK' : 'cache/JSON'}`,
    mpLine,
    apiLine,
    '',
    `Memoria heap: ${mem.heapUsedMB || '?'} MB`,
    rssLine,
    `Uptime: ${payload?.uptimeSec || 0}s`,
    '',
    `Fila cmd: active=${q.execActive || 0} pending=${q.execPending || 0}`,
    cmdLine,
    fo != null ? `Fail-open LID/h: ${fo}` : null,
    `Pedidos pending: ${bill.pending}`,
    `Entregas 24h: ${bill.delivered24h}`,
    `Tickets abertos: ${bill.openTickets}`
  ].filter(Boolean).join('\n');
}

async function sendAffiliateAdmin(conn, ctx) {
  if (!isTgAdmin(ctx)) {
    return sendAffiliate(conn, ctx);
  }
  const rows = await store.listPendingAffiliatePayouts(20);
  const lines = ['AFILIADO — pendentes'];
  const kb = [];
  for (const r of rows || []) {
    const reais = (Number(r.amount_cents) / 100).toFixed(2).replace('.', ',');
    lines.push(`${String(r.id).slice(0, 8)} ${r.plan_id || ''} R$${reais}`);
    kb.push([{ text: `Pago ${String(r.id).slice(0, 8)}`, callback_data: `bill_aff_paid_${r.id}` }]);
  }
  if (!rows || !rows.length) lines.push('(nenhum)');
  kb.push([{ text: 'Voltar', callback_data: 'bill_home' }]);
  if (ctx.tgBot && ctx.tgChatId) {
    return tgUi(ctx.tgBot, ctx.tgChatId, lines.join('\n'), kb);
  }
  return conn.sendMessage(ctx.from, { text: lines.join('\n') }, { quoted: ctx.info });
}

async function handleBillingClick(conn, ctx, id) {
  await ensureBillingPv(conn, ctx);
  const raw = String(id || '');
  if (raw === 'bill_home') return sendHome(conn, ctx);
  if (raw === 'bill_how') return sendHowItWorks(conn, ctx);
  if (raw === 'bill_afiliado') return sendAffiliate(conn, ctx);
  if (raw === 'bill_aff_admin') return sendAffiliateAdmin(conn, ctx);
  if (raw === 'bill_tier_starter') return sendTermPicker(conn, ctx, 'starter');
  if (raw === 'bill_tier_pro' || raw === 'bill_cat_sub' || raw === 'bill_home_sub') {
    return sendTermPicker(conn, ctx, 'pro');
  }
  if (raw === 'bill_tier_enterprise') return sendTermPicker(conn, ctx, 'enterprise');
  if (raw === 'bill_cat_bot' || raw === 'bill_home_bot') return sendBotOffer(conn, ctx);
  if (raw === 'bill_plan_daypass') return sendMethods(conn, ctx, 'daypass');
  if (raw === 'bill_days_go') return sendMethods(conn, ctx, 'daypass');
  const setDays = /^bill_days_set_(\d+)$/.exec(raw);
  if (setDays) {
    const d = Number(setDays[1]);
    if (d <= 1) return sendMethods(conn, ctx, 'daypass');
    if (d <= 35) return sendMethods(conn, ctx, 'pro_m');
    if (d <= 100) return sendMethods(conn, ctx, 'pro_y');
    return sendMethods(conn, ctx, 'pro_y');
  }
  const addDays = /^bill_days_add_(\d+)$/.exec(raw);
  if (addDays) return sendTermPicker(conn, ctx, 'pro');
  const subDays = /^bill_days_sub_(\d+)$/.exec(raw);
  if (subDays) return sendTermPicker(conn, ctx, 'pro');
  if (raw.startsWith('bill_plan_')) return sendMethods(conn, ctx, raw.slice('bill_plan_'.length));
  if (raw.startsWith('bill_m_pix_')) return startCheckout(conn, ctx, raw.slice('bill_m_pix_'.length), 'pix');
  if (raw.startsWith('bill_m_card_')) return startCheckout(conn, ctx, raw.slice('bill_m_card_'.length), 'card');
  if (raw.startsWith('bill_m_boleto_')) return startCheckout(conn, ctx, raw.slice('bill_m_boleto_'.length), 'boleto');
  if (raw.startsWith('bill_chk_')) return checkOrder(conn, ctx, raw.slice('bill_chk_'.length));
  if (raw.startsWith('bill_aff_paid_')) {
    if (!isTgAdmin(ctx)) return sendAffiliate(conn, ctx);
    const id = raw.slice('bill_aff_paid_'.length);
    await store.markAffiliatePayoutPaid(id);
    return sendAffiliateAdmin(conn, ctx);
  }
  if (raw === 'bill_sup_pagamento') return autoSupport(conn, ctx, 'pagamento');
  if (raw === 'bill_sup_renovacao') return autoSupport(conn, ctx, 'renovacao');
  if (raw === 'bill_sup_entrega') return autoSupport(conn, ctx, 'entrega');
  if (raw === 'bill_sup_api') {
    return conn.sendMessage(ctx.from, {
      text: 'A chave da API Hanork/Zero Two e do host. Nao e entregue ao cliente.'
    }, { quoted: ctx.info });
  }
  if (raw === 'bill_sup_duvida') {
    const faq = (knowledge.faq || []).slice(0, 6).map((x) => `• ${x.q}\n${x.a}`).join('\n\n');
    return conn.sendMessage(ctx.from, { text: faq || `Veja ${pfx(ctx)}comprar` }, { quoted: ctx.info });
  }
  if (raw === 'bill_sup_humano') return openTicket(conn, ctx, 'atendente', 'Falar com atendente');
}

commands.comprar = {
  useCtx: true,
  description: 'Planos e pagamento',
  usage: 'comprar',
  execute: (conn, ctx) => sendHome(conn, ctx)
};
commands.planos = commands.comprar;
commands.preco = commands.comprar;

commands.sobre = {
  useCtx: true,
  description: 'O que e o Hanork, planos e contato',
  usage: 'sobre',
  execute: async (conn, ctx) => {
    const { sendButtonsWithImage } = require('../helpers');
    const { previewText, stripAccents } = require('../utils/typography');
    const text = buildSobreMenu({ prefix: pfx(ctx), telegramUserId: ctx.telegramUserId });
    await sendButtonsWithImage(
      conn,
      ctx.from,
      text,
      [
        { id: 'cmd_comprar', label: 'Comprar' },
        { url: DEV_WA_CHAT, label: 'Abrir o bot' },
        { url: FREE_TELEGRAM, label: 'Telegram' }
      ],
      'Hanork',
      ctx.info || null,
      'menu.jpg',
      previewText('Sobre'),
      stripAccents('Planos e contato'),
      ctx.telegramUserId
    );
  }
};
commands.dono = commands.sobre;
commands.ownerinfo = commands.sobre;

async function sendHowItWorks(conn, ctx) {
  const { howToUseWhatsApp, storefrontText } = require('../utils/productOffer');
  const text = [storefrontText(), '', howToUseWhatsApp(ctx && ctx.telegramUserId)].join('\n');
  if (ctx.tgBot && ctx.tgChatId) {
    return tgUi(ctx.tgBot, ctx.tgChatId, text, [
      [{ text: daypassButtonLabel(), callback_data: 'bill_plan_daypass' }],
      [{ text: 'Voltar', callback_data: 'bill_home' }]
    ]);
  }
  return conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
}

async function sendAffiliate(conn, ctx) {
  await ensureBillingPv(conn, ctx);
  const ident = identityFromCtx(ctx);
  const customer = await store.upsertCustomer(ident.platform, ident.platformUser, ident.aliases);
  const aff = await store.getOrCreateAffiliate(customer.id);
  const url = telegramRefUrl(aff.code);
  const ready = affiliateShareText(url);
  const p = pfx(ctx);
  let pending = 'R$0,00';
  let paid = 'R$0,00';
  try {
    const bal = await store.affiliateBalance(customer.id);
    pending = `R$${(bal.pending_cents / 100).toFixed(2).replace('.', ',')}`;
    paid = `R$${(bal.paid_cents / 100).toFixed(2).replace('.', ',')}`;
  } catch (_) { /* ledger opcional */ }
  const text = [
    ready,
    '',
    `Cliques: ${aff.hits || 0}  ·  vendas: ${aff.conversions || 0}`,
    `Saldo a receber: ${pending}`,
    `Ja marcado pago: ${paid}`,
    'Voce ganha 30% da primeira compra paga (day pass, Pro, Enterprise).',
    'Saque combinado com o dono. Nao e automatico.',
    '',
    `Conta: ${p}minhaconta`
  ].join('\n');
  if (ctx.tgBot && ctx.tgChatId) {
    return tgUi(ctx.tgBot, ctx.tgChatId, text, [
      [{ text: 'Abrir meu link', url }],
      [{ text: 'Voltar', callback_data: 'bill_home' }]
    ]);
  }
  await sendInteractiveButtons(
    conn,
    ctx.from,
    text,
    [{ url, label: 'Abrir meu link' }, { id: 'bill_home', label: 'Voltar', short: 'Voltar' }],
    'Hanork',
    ctx.info,
    'menu.jpg',
    ctx.telegramUserId
  );
}

commands.afiliado = {
  useCtx: true,
  description: 'Link de afiliado pronto pra divulgar',
  usage: 'afiliado',
  execute: (conn, ctx) => sendAffiliate(conn, ctx)
};
commands.indicar = commands.afiliado;

commands.minhaconta = {
  useCtx: true,
  description: 'Seu plano VIP e pedidos',
  usage: 'minhaconta',
  execute: (conn, ctx) => sendAccount(conn, ctx)
};
commands.meuplano = commands.minhaconta;
commands.meupagamento = commands.minhaconta;

commands.suporte = {
  useCtx: true,
  description: 'Ajuda de pagamento, entrega e conta',
  usage: 'suporte',
  execute: async (conn, ctx) => {
    await ensureBillingPv(conn, ctx);
    return sendSupport(conn, ctx);
  }
};

async function runVincular(conn, ctx) {
  await ensureBillingPv(conn, ctx);
  const code = String(ctx.text || '').trim();
  if (!code) {
    const ident = identityFromCtx(ctx);
    const acc = await store.accountFor(ident.platform, ident.platformUser);
    if (!acc.customer) {
      return conn.sendMessage(ctx.from, {
        text: 'Mande o codigo do outro app. Ex: .vincular A1B2C3'
      }, { quoted: ctx.info });
    }
    const made = await store.createLinkCode(acc.customer.id);
    return conn.sendMessage(ctx.from, {
      text: `Seu codigo (15 min): ${made.code}\nNo outro app: .vincular ${made.code} ou /vincular ${made.code}`
    }, { quoted: ctx.info });
  }
  const ident = identityFromCtx(ctx);
  const r = await store.consumeLinkCode(code, ident.platform, ident.platformUser, ident.aliases);
  if (!r.ok) {
    const why = r.reason === 'codigo_expirado' ? 'Codigo expirado. Gere outro em .minhaconta' : 'Codigo invalido.';
    return conn.sendMessage(ctx.from, { text: why }, { quoted: ctx.info });
  }
  return conn.sendMessage(ctx.from, {
    text: 'Contas vinculadas. VIP/licenca vale neste Zap e no Telegram.'
  }, { quoted: ctx.info });
}

commands.vincular = {
  useCtx: true,
  description: 'Vincula WhatsApp (LID/JID) com Telegram (id) na mesma compra',
  usage: 'vincular [codigo]',
  execute: (conn, ctx) => runVincular(conn, ctx)
};
commands.vincularconta = commands.vincular;

async function sendBotZipNow(conn, ctx) {
  await ensureBillingPv(conn, ctx);
  const ident = identityFromCtx(ctx);
  const acc = await store.accountFor(ident.platform, ident.platformUser);
  if (!acc.botLicense || acc.botLicense.status !== 'active') {
    return conn.sendMessage(ctx.from, {
      text: 'Sem licenca do bot nesta conta. Compre em .comprar ou vincule com .vincular'
    }, { quoted: ctx.info });
  }
  await conn.sendMessage(ctx.from, { text: 'Montando o zip (sem .env)...' }, { quoted: ctx.info });
  try {
    const { packProduct } = require('../services/billing/packProduct');
    const pack = await packProduct();
    await conn.sendMessage(ctx.from, {
      document: pack.buffer,
      mimetype: 'application/zip',
      fileName: pack.fileName,
      caption: 'Hanork bot. Copie .env.example e coloque suas chaves. Sem sessoes nem banco.'
    }, { quoted: ctx.info, skipForward: true, _hanorkTrusted: true });
    try { require('fs').unlinkSync(pack.tmpPath); } catch (_) { /* tmp */ }
  } catch (e) {
    logger.logAviso(`[billing] baixarbot: ${e.message}`);
    await conn.sendMessage(ctx.from, {
      text: 'Nao consegui gerar o zip agora. Tente de novo em instantes.'
    }, { quoted: ctx.info });
  }
}

commands.baixarbot = {
  useCtx: true,
  description: 'Reenvia o zip do bot (so quem comprou a licenca)',
  usage: 'baixarbot',
  execute: (conn, ctx) => sendBotZipNow(conn, ctx)
};
commands.meubot = commands.baixarbot;

commands.health = {
  useCtx: true,
  description: 'Saude real do processo (dono)',
  usage: 'health',
  execute: async (conn, ctx) => {
    if (!ctx.isOwner) {
      return conn.sendMessage(ctx.from, { text: 'Apenas o dono da sessao.' }, { quoted: ctx.info });
    }
    const { buildPayload } = require('../services/healthServer');
    const payload = buildPayload();
    const bill = await store.stats();
    await conn.sendMessage(ctx.from, { text: healthText(payload, bill) }, { quoted: ctx.info });
  }
};

commands.pedidos = {
  useCtx: true,
  description: 'Pedidos e tickets (dono)',
  usage: 'pedidos',
  execute: async (conn, ctx) => {
    if (!ctx.isOwner) {
      return conn.sendMessage(ctx.from, { text: 'Apenas o dono da sessao.' }, { quoted: ctx.info });
    }
    const bill = await store.stats();
    const tickets = await store.listOpenTickets(10);
    const lines = [
      'BILLING ADMIN',
      `MP: ${bill.mpConfigured ? 'ok' : 'off'}  SQL: ${bill.sql ? 'ok' : 'off'}`,
      `Pending: ${bill.pending}  Entregas 24h: ${bill.delivered24h}`,
      '',
      'Tickets:',
      ...(tickets.length ? tickets.map((t) => `${t.id.slice(0, 8)} ${t.status} ${t.subject}`) : ['(nenhum)'])
    ].join('\n');
    await conn.sendMessage(ctx.from, { text: lines }, { quoted: ctx.info });
  }
};

function tgIdent(userId) {
  return { platform: 'telegram', telegramUserId: userId, sender: String(userId), from: String(userId) };
}

async function handleTelegramBilling(bot, { chatId, userId, data, text }) {
  let raw = String(data || '');
  const fakeCtx = {
    ...tgIdent(userId),
    from: chatId,
    info: null,
    platform: 'telegram',
    _isTelegramShim: true,
    tgBot: bot,
    tgChatId: chatId,
    text: String(text || '')
  };
  const conn = {
    _telegramUserId: userId,
    _isTelegramShim: true,
    sendMessage: async (_jid, content) => {
      const text = content.caption || content.text || '';
      if (content.document) {
        await bot.sendDocument(
          chatId,
          content.document,
          { caption: String(text).slice(0, 900) },
          { filename: content.fileName || 'hanork-bot.zip' }
        );
        return { key: { id: 'tg' } };
      }
      if (content.image) {
        await tgUi(bot, chatId, String(text).slice(0, 900), [[{ text: 'Voltar', callback_data: 'bill_home' }]]);
        return { key: { id: 'tg' } };
      }
      if (text) await tgUi(bot, chatId, text, [[{ text: 'Voltar', callback_data: 'bill_home' }]]);
      return { key: { id: 'tg' } };
    }
  };
  if (!raw || raw === 'bill_home' || raw === 'comprar') {
    return sendHome(conn, fakeCtx);
  }
  if (raw === 'bill_how') return sendHowItWorks(conn, fakeCtx);
  if (raw === 'bill_aff_admin') return sendAffiliateAdmin(conn, fakeCtx);
  if (raw === 'bill_cat_sub' || raw.startsWith('bill_days_') || raw.startsWith('bill_tier_')) {
    return handleBillingClick(conn, fakeCtx, raw === 'bill_cat_sub' ? 'bill_cat_sub' : raw);
  }
  if (raw === 'bill_cat_bot') {
    const plan = botPlans(await store.listPlans())[0] || require('../services/billing/logic').resolvePlan('bot');
    if (!plan) {
      await tgUi(bot, chatId, 'Plano do bot indisponivel.', [[{ text: 'Voltar', callback_data: 'bill_home' }]]);
      return;
    }
    raw = `bill_plan_${plan.id}`;
  }
  if (raw === 'bill_afiliado') return sendAffiliate(conn, fakeCtx);
  if (raw === 'bill_account') return sendAccount(conn, fakeCtx);
  if (raw === 'bill_vincular') return runVincular(conn, fakeCtx);
  if (raw === 'bill_baixarbot') return sendBotZipNow(conn, fakeCtx);
  if (raw === 'bill_suporte') {
    await tgUi(bot, chatId, 'SUPORTE', [
      [{ text: 'Pagamento', callback_data: 'bill_sup_pagamento' }, { text: 'Renovacao', callback_data: 'bill_sup_renovacao' }],
      [{ text: 'Entrega', callback_data: 'bill_sup_entrega' }, { text: 'API', callback_data: 'bill_sup_api' }],
      [{ text: 'Duvida', callback_data: 'bill_sup_duvida' }, { text: 'Atendente', callback_data: 'bill_sup_humano' }]
    ]);
    return;
  }
  if (raw.startsWith('bill_plan_')) {
    return sendMethods(conn, fakeCtx, raw.slice('bill_plan_'.length));
  }
  await handleBillingClick(conn, fakeCtx, raw);
}

module.exports = {
  commands,
  handleBillingClick,
  handleTelegramBilling,
  sendPlans,
  healthText,
  isBillingOpenInbound,
  hasOpenCheckout,
  mapBillingPhrase
};
