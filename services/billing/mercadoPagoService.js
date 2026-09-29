'use strict';

const axios = require('axios');
const { randomUUID } = require('crypto');
const logger = require('../../logger');
const { formatMpAmount } = require('./logic');

function readMpToken() {
  const raw =
    process.env.MP_ACCESS_TOKEN ||
    process.env.TOKEN_MP ||
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    '';
  return String(raw).trim().replace(/^["']|["']$/g, '');
}

function tokenLooksValid(token) {
  const livePrefix = ['APP', 'USR-'].join('_');
  return !!token && token.length > 10 && (token.startsWith(livePrefix) || /^TEST-/i.test(token));
}

function isConfigured() {
  return tokenLooksValid(readMpToken());
}

function isSandbox() {
  const t = readMpToken();
  return process.env.MP_SANDBOX === '1' || process.env.MP_SANDBOX === 'true' || /^TEST-/i.test(t);
}

function formatMpError(e) {
  const status = e.response?.status;
  const data = e.response?.data;
  const parts = [];
  if (status) parts.push(`HTTP ${status}`);
  if (data?.message) parts.push(data.message);
  if (Array.isArray(data?.cause)) {
    for (const c of data.cause) {
      if (c.description) parts.push(c.description);
      else if (c.code) parts.push(String(c.code));
    }
  }
  if (data?.error) parts.push(String(data.error));
  if (parts.length) return parts.join(' - ');
  return e.message || 'Erro Mercado Pago';
}

function api() {
  const token = readMpToken();
  if (!tokenLooksValid(token)) {
    const err = new Error('Mercado Pago nao configurado. Defina MP_ACCESS_TOKEN.');
    err.code = 'MP_UNAVAILABLE';
    throw err;
  }
  const timeout = Math.max(8000, parseInt(process.env.MP_API_TIMEOUT_MS || '25000', 10));
  return axios.create({
    baseURL: 'https://api.mercadopago.com',
    timeout,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
}

function buildPayer(payerEmail) {
  const emailRaw = String(payerEmail || process.env.MP_PAYER_EMAIL || 'cliente@example.com').trim();
  const email = emailRaw.includes('@') ? emailRaw : 'cliente@example.com';
  const payer = {
    email,
    first_name: String(process.env.MP_PAYER_FIRST_NAME || 'Cliente').slice(0, 50),
    last_name: String(process.env.MP_PAYER_LAST_NAME || 'Hanork').slice(0, 50)
  };
  const cpf = String(process.env.MP_PAYER_CPF || '').replace(/\D/g, '');
  if (cpf.length === 11) {
    payer.identification = { type: 'CPF', number: cpf };
  }
  return payer;
}

function webhookUrl() {
  const u = String(process.env.MP_PUBLIC_URL || process.env.WEBHOOK_URL || '').trim().replace(/\/$/, '');
  if (!u.startsWith('https://')) return '';
  if (u.includes('/webhooks/')) return u;
  return `${u}/webhooks/mercadopago`;
}

function publicOrigin() {
  const u = String(process.env.MP_PUBLIC_URL || process.env.WEBHOOK_URL || '').trim().replace(/\/$/, '');
  if (!u.startsWith('https://')) return '';
  return u.replace(/\/webhooks\/.*$/, '');
}

async function withRetry(fn, attempts = 2, delayMs = 800) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const st = e.response?.status;
      if (st && st >= 400 && st < 500 && st !== 429) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

async function createPix({ amountReais, description, externalRef, payerEmail }) {
  const client = api();
  const unitAmount = formatMpAmount(amountReais);
  const ref = String(externalRef || '').slice(0, 64);
  const desc = String(description || 'Pedido Hanork').slice(0, 127);
  const body = {
    transaction_amount: unitAmount,
    description: desc,
    payment_method_id: 'pix',
    payer: buildPayer(payerEmail),
    external_reference: ref
  };
  const hook = webhookUrl();
  if (hook) body.notification_url = hook;

  const { data } = await withRetry(() =>
    client.post('/v1/payments', body, { headers: { 'X-Idempotency-Key': randomUUID() } })
  );
  const qr = data.point_of_interaction?.transaction_data?.qr_code;
  if (!qr) {
    const err = new Error('MP nao retornou codigo PIX');
    err.code = 'MP_PIX_EMPTY';
    throw err;
  }
  logger.logInfo(`[billing] PIX criado id=${data.id} ref=${ref}`);
  return {
    id: String(data.id),
    qr_code: qr,
    qr_code_base64: data.point_of_interaction?.transaction_data?.qr_code_base64 || null,
    ticket_url: data.point_of_interaction?.transaction_data?.ticket_url || null,
    status: data.status,
    external_reference: ref
  };
}

function checkoutExcluded(method) {
  if (method === 'boleto') {
    return { excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }, { id: 'prepaid_card' }, { id: 'atm' }] };
  }
  if (method === 'card') {
    return { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'bank_transfer' }] };
  }
  return {};
}

async function createCheckout({ amountReais, description, externalRef, method }) {
  const client = api();
  const unitPrice = formatMpAmount(amountReais);
  const title = String(description || 'Pedido Hanork')
    .replace(/[^\w\s#.\-]/g, ' ')
    .trim()
    .slice(0, 127) || 'Pedido Hanork';
  const ref = String(externalRef || '').slice(0, 64);
  const preferenceBody = {
    items: [{
      id: `item-${ref.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || '1'}`,
      title,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: unitPrice
    }],
    external_reference: ref,
    statement_descriptor: String(process.env.MP_STATEMENT_DESCRIPTOR || 'HANORK').slice(0, 22),
    payment_methods: checkoutExcluded(method)
  };
  const hook = webhookUrl();
  if (hook) preferenceBody.notification_url = hook;
  const origin = publicOrigin();
  if (origin) {
    preferenceBody.back_urls = {
      success: `${origin}/mp/success`,
      failure: `${origin}/mp/failure`,
      pending: `${origin}/mp/pending`
    };
  }
  const { data } = await withRetry(() => client.post('/checkout/preferences', preferenceBody));
  const test = isSandbox();
  const initPoint = test
    ? (data.sandbox_init_point || data.init_point)
    : (data.init_point || data.sandbox_init_point);
  if (!initPoint) {
    const err = new Error('MP nao retornou URL de pagamento');
    err.code = 'MP_CHECKOUT_EMPTY';
    throw err;
  }
  logger.logInfo(`[billing] checkout criado pref=${data.id} method=${method || 'any'} ref=${ref}`);
  return {
    id: String(data.id),
    init_point: initPoint,
    sandbox: test,
    external_reference: ref
  };
}

async function getStatus(paymentId) {
  const client = api();
  const id = String(paymentId || '').trim();
  if (!id) {
    const err = new Error('paymentId vazio');
    err.code = 'MP_NO_ID';
    throw err;
  }
  const { data } = await withRetry(() => client.get(`/v1/payments/${encodeURIComponent(id)}`));
  const cents = Math.round(Number(data.transaction_amount || 0) * 100);
  return {
    id: String(data.id),
    status: String(data.status || ''),
    amount_cents: cents,
    external_reference: data.external_reference || '',
    payment_method_id: data.payment_method_id || ''
  };
}

async function findByReference(ref) {
  const client = api();
  const q = encodeURIComponent(`external_reference:${String(ref || '')}`);
  const { data } = await withRetry(() => client.get(`/v1/payments/search?sort=date_created&criteria=desc&q=${q}`));
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((p) => ({
    id: String(p.id),
    status: String(p.status || ''),
    amount_cents: Math.round(Number(p.transaction_amount || 0) * 100),
    external_reference: p.external_reference || ''
  }));
}

async function verifyConnection() {
  if (!isConfigured()) return { ok: false, reason: 'token_ausente' };
  try {
    const { data } = await api().get('/users/me');
    const id = data && data.id != null ? String(data.id) : '';
    return {
      ok: true,
      sandbox: isSandbox(),
      account: id ? `id:${id.slice(0, 3)}***` : 'ok'
    };
  } catch (e) {
    return { ok: false, reason: formatMpError(e) };
  }
}

module.exports = {
  readMpToken,
  isConfigured,
  isSandbox,
  formatMpError,
  createPix,
  createCheckout,
  getStatus,
  findByReference,
  verifyConnection,
  webhookUrl
};
