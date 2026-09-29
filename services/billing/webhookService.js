'use strict';

const crypto = require('crypto');
const logger = require('../../logger');
const store = require('./store');
const mp = require('./mercadoPagoService');
const { notifyCustomer, notifyAdmins } = require('./notify');

const MP_IP_PREFIXES = ['200.80.', '200.24.', '186.64.', '190.232.', '::ffff:200.80.', '::ffff:200.24.'];

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || '';
}

function isMpIp(req) {
  if (process.env.MP_ENFORCE_IP !== '1') return true;
  const ip = clientIp(req);
  if (!ip) return false;
  return MP_IP_PREFIXES.some((p) => ip.startsWith(p));
}

function allowUnsignedWebhook() {
  const flag = process.env.MP_ALLOW_UNSIGNED_WEBHOOK === '1' || process.env.MP_ALLOW_UNSIGNED_WEBHOOK === 'true';
  const sandbox = process.env.MP_SANDBOX === '1' || process.env.MP_SANDBOX === 'true';
  return flag && sandbox;
}

function validateMpSignature(req) {
  const secret = String(process.env.MP_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    // Prod: poll PIX entrega. Webhook sem HMAC so no sandbox local.
    if (allowUnsignedWebhook()) return true;
    return false;
  }
  const xSig = req.headers['x-signature'];
  const xReqId = req.headers['x-request-id'];
  if (!xSig || !xReqId) return false;
  const ts = (String(xSig).match(/ts=(\d+)/) || [])[1];
  const v1 = (String(xSig).match(/v1=([a-f0-9]+)/i) || [])[1];
  if (!ts || !v1) return false;
  const dataId = req.body?.data?.id || '';
  const manifest = `id:${dataId};request-id:${xReqId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

async function deliverPaidExtras(order, result) {
  if (!order || !result || !result.ok) return;
  const plat = order.platform || 'telegram';
  const { postSaleSteps, postSaleKeyboard, isTelegramPlatform } = require('./notify');
  let linkHint = '';
  const planId = String((result.plan && result.plan.id) || '');
  const isBot = result.kind === 'bot';
  if (isBot) {
    try {
      const code = await store.createLinkCode(order.customer_id);
      const { cmdExample } = require('../../utils/configManager');
      const vinc = isTelegramPlatform(plat)
        ? `/vincular ${code.code}`
        : `${cmdExample(order.session_owner, 'vincular')} ${code.code}`;
      linkHint = `\nVinculo Zap+Telegram (15 min): ${code.code}\n${vinc}`;
    } catch (e) {
      logger.logAviso(`[billing] link-code: ${e.message}`);
    }
  }
  if (isBot) {
    try {
      const { packProduct } = require('./packProduct');
      const pack = await packProduct();
      const body = postSaleSteps(plat, {
        zipFail: false,
        telegramUserId: order.session_owner,
        planId
      }) + linkHint;
      await notifyCustomer(order, body, {
        document: pack.buffer,
        fileName: pack.fileName,
        inline_keyboard: postSaleKeyboard(plat)
      });
      try { require('fs').unlinkSync(pack.tmpPath); } catch (_) { /* tmp */ }
    } catch (e) {
      logger.logAviso(`[billing] zip: ${e.message}`);
      await notifyCustomer(order, postSaleSteps(plat, {
        zipFail: true,
        telegramUserId: order.session_owner,
        planId
      }) + linkHint, {
        inline_keyboard: postSaleKeyboard(plat)
      });
    }
    return;
  }
  await notifyCustomer(
    order,
    postSaleSteps(plat, { telegramUserId: order.session_owner, planId }),
    { inline_keyboard: postSaleKeyboard(plat) }
  );
}

async function handleApproved(mpPay) {
  const claim = await store.claimWebhook(mpPay.id);
  const result = await store.processApprovedPayment(mpPay);
  await store.markWebhookProcessed(mpPay.id);
  if (result.ok && result.orderId) {
    const order = await store.getOrder(result.orderId);
    await deliverPaidExtras(order, result);
    await notifyAdmins(
      result.kind === 'bot'
        ? `[billing] VENDA BOT ${String(result.orderId).slice(0, 8)} — zip enviado`
        : `[billing] pedido ${String(result.orderId).slice(0, 8)} entregue`
    );
    try {
      const { postSaleReference } = require('./salesRefChannel');
      await postSaleReference(order);
    } catch (e) {
      logger.logAviso(`[SALES_REF] ${e.message}`);
    }
  } else if (!claim.first && result.reason === 'already_delivered') {
    logger.logInfo(`[billing] webhook replay ignored pay=${mpPay.id}`);
  } else if (!result.ok) {
    logger.logAviso(`[billing] webhook skip reason=${result.reason}`);
  }
  return result;
}

function mount(app) {
  if (!app || typeof app.post !== 'function') return;

  app.get('/mp/success', (_req, res) => res.status(200).send('Pagamento recebido. Volte ao bot.'));
  app.get('/mp/failure', (_req, res) => res.status(200).send('Pagamento nao concluido. Volte ao bot.'));
  app.get('/mp/pending', (_req, res) => res.status(200).send('Pagamento pendente. O bot confirma sozinho.'));

  app.post('/webhooks/mercadopago', async (req, res) => {
    try {
      if (!isMpIp(req)) {
        res.status(403).json({ ok: false });
        return;
      }
      if (!validateMpSignature(req)) {
        res.status(401).json({ ok: false });
        return;
      }
      const type = req.body?.type || req.body?.action || req.query?.topic;
      const dataId = req.body?.data?.id || req.query?.id || req.body?.id;
      if (!dataId) {
        res.status(200).json({ ok: true, skip: 'no-id' });
        return;
      }
      if (type && !/payment/i.test(String(type))) {
        res.status(200).json({ ok: true, skip: 'not-payment' });
        return;
      }
      const mpPay = await mp.getStatus(dataId);
      if (String(mpPay.status).toLowerCase() !== 'approved') {
        res.status(200).json({ ok: true, status: mpPay.status });
        return;
      }
      await handleApproved(mpPay);
      res.status(200).json({ ok: true });
    } catch (e) {
      logger.logAviso(`[billing] webhook: ${e.message}`);
      res.status(200).json({ ok: false });
    }
  });
}

module.exports = { mount, handleApproved, validateMpSignature, isMpIp };
