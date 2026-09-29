// utils/productOffer.js — menu sobre / comprar / planos (user-facing)
'use strict';

const OWNER_NAME = 'Hanork: #Loja online';
const DEFAULT_BOT_USERNAME = 'hanork_bot';
const FREE_TELEGRAM = `https://t.me/${DEFAULT_BOT_USERNAME}`;
/** legado: nao aponta mais pro Zap. Botao/compra = Telegram. */
const DEV_PHONE_DISPLAY = '';
const DEV_WA_CHAT = `${FREE_TELEGRAM}?start=comprar`;
const FREE_CATALOG = `${FREE_TELEGRAM}?start=comprar`;
const PRICE_FULL = 250;

function telegramBotUsername() {
  const env = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  if (env) return env;
  return DEFAULT_BOT_USERNAME;
}

function telegramStartLink(payload = 'comprar') {
  const u = telegramBotUsername();
  const p = String(payload || 'comprar').replace(/[^\w-]/g, '');
  if (u) return `https://t.me/${u}?start=${p}`;
  return FREE_TELEGRAM;
}

function telegramRefLink(code) {
  const c = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  return telegramStartLink(c ? `ref_${c}` : 'comprar');
}

/**
 * Pos-compra / menu TG: o cliente nao adivinha que o uso e no WhatsApp.
 * Prefixo do Zap e live (setprefix). Telegram continua /.
 * @param {string|number} [telegramUserId]
 */
const POSITIONING =
  'Bot que segura o grupo da loja e manda o PIX/cardapio sozinho.';

function livePlanLabels() {
  try {
    const {
      daypassPlan,
      monthlyPlanForTier,
      yearlyPlan,
      zipPlan,
      formatReaisLabel
    } = require('../services/billing/logic');
    const rs = (p) => (p ? formatReaisLabel(p.price_cents) : '');
    const day = rs(daypassPlan()) || 'R$1';
    const month = rs(monthlyPlanForTier('pro')) || 'R$30';
    const year = rs(yearlyPlan()) || 'R$200';
    const zip = rs(zipPlan()) || 'R$250';
    return {
      day,
      month,
      year,
      zip,
      pro: month,
      starter: month,
      ent: year
    };
  } catch (_) {
    return { day: 'R$1', month: 'R$30', year: 'R$200', zip: 'R$250', pro: 'R$30', starter: 'R$30', ent: 'R$200' };
  }
}

/** Vitrine publica: 4 linhas. Sem catalogo, sem 750 cmds. */
function storefrontText() {
  const { day, month, year, zip } = livePlanLabels();
  return [
    'Hanork',
    POSITIONING,
    'Segura o grupo da loja e manda o PIX/cardapio sozinho.',
    `1 dia — ${day}`,
    `30 dias — ${month}`,
    `1 ano de assinatura do bot — ${year}`,
    `Zip completo do bot (codigo aberto) — ${zip}`,
    'Paga aqui no Telegram. Depois conecta o WhatsApp.'
  ].join('\n');
}

function howToUseWhatsApp(telegramUserId) {
  return [
    'Como funciona:',
    '1) Escolha um plano e pague.',
    '2) Toque em Conectar (QR ou codigo).',
    '3) Me coloca admin no grupo e toque em Proteger grupo.',
    'Neste chat do Telegram os comandos sao com / (ex: /menu /cpf /divmenu).',
    'Figurinha e musica sao no WhatsApp, com o prefixo da sua sessao.'
  ].join('\n');
}

function howToAfterPay(telegramUserId) {
  return [
    'Pagou. Agora conecta o WhatsApp.',
    'Toque em Conectar (QR ou codigo).',
    'Quando o chip ficar online, toque em Proteger grupo — nao precisa mandar comando no Zap.'
  ].join('\n');
}

function howToChipOnline(_telegramUserId) {
  return [
    'WhatsApp online.',
    '1) Me coloca admin no grupo da loja.',
    '2) Toque em Proteger grupo (antilink + anti-roubo).',
    '3) Pronto. Link de membro some sozinho.'
  ].join('\n');
}

function shopSetupKeyboard() {
  return [
    [
      { text: 'Proteger grupo', callback_data: 'shop_protect' },
      { text: 'Agora nao', callback_data: 'shop_later' }
    ]
  ];
}

const CAPABILITIES = [
  'Downloads (YouTube, TikTok, Instagram, Facebook, Spotify, Kwai...)',
  'Hanork API (~750 comandos: logos, animes, IAs, pesquisas...)',
  'Figurinhas e midia (sticker, toimg, attp...)',
  'Consultas (CPF, nome, placa) e ferramentas web/IA',
  'Divulgacao em massa (grupos / close friends) com ocupacao META',
  'Grupo morto sai sozinho e a vaga reporna da fila',
  'Protecao de grupo (antilink, antiflood, antiataque, anti-admin...)',
  'OSINT publico (dominio, username, wiki, gist, correlacao)',
  'Menus com botoes interativos no WhatsApp',
  'Evolucao de uso (XP, niveis, tips A/B, quotas VIP)',
  'Multi-sessao via Telegram (QR ou codigo, dados isolados)',
  'Prefixo live no Zap (setprefix) — Telegram continua /',
  'PIX, cartao e boleto no Telegram (Mercado Pago)',
  'Host / admin / config (dono)',
  'Versao FREE no Telegram: so logar e usar'
];

function planPricesLines() {
  const { day, month, year, zip } = livePlanLabels();
  return [
    `1 dia ${day}.`,
    `30 dias ${month}.`,
    `1 ano de assinatura ${year}.`,
    `Zip completo do bot ${zip}.`
  ];
}

/** Banall nao e aquisicao. Sem venda. */
function banallPayFooter() {
  return [];
}

/**
 * @param {{ prefix?: string, telegramUserId?: string|number }} [opts]
 */
function buildSobreMenu(opts = {}) {
  const { displayPrefix } = require('./configManager');
  const p = opts.telegramUserId != null
    ? displayPrefix(opts.telegramUserId, { prefix: opts.prefix })
    : (opts.prefix || '.');
  return [
    storefrontText(),
    '',
    howToUseWhatsApp(opts.telegramUserId),
    '',
    `Pagar: ${p}comprar`,
    telegramStartLink('comprar'),
    `Conta: ${p}minhaconta`,
    `Checklist no grupo: ${p}start`
  ].join('\n');
}

module.exports = {
  OWNER_NAME,
  DEFAULT_BOT_USERNAME,
  DEV_PHONE_DISPLAY,
  DEV_WA_CHAT,
  FREE_CATALOG,
  FREE_TELEGRAM,
  PRICE_FULL,
  CAPABILITIES,
  POSITIONING,
  livePlanLabels,
  storefrontText,
  planPricesLines,
  banallPayFooter,
  telegramBotUsername,
  telegramStartLink,
  telegramRefLink,
  howToUseWhatsApp,
  howToAfterPay,
  howToChipOnline,
  shopSetupKeyboard,
  buildSobreMenu
};
