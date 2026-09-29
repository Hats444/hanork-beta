'use strict';

const crypto = require('crypto');
const logger = require('../../logger');
const { runAsync, getAsync, allAsync, isReady } = require('../../utils/sqlStore');
const {
  PLANS,
  LEGACY_PLAN_IDS,
  applyPromoPrice,
  centsToReais,
  canDeliver,
  nextExpiryIso,
  isExpired,
  isBotPlan,
  resolvePlan,
  normalizeAffiliateCode,
  productTierOfPlan,
  productTierFromEntitlement
} = require('./logic');
const mp = require('./mercadoPagoService');
const vipIndex = require('./vipIndex');

function pgMirror(table, row, pk) {
  try {
    const pg = require('../pgClient');
    if (!pg.isDualWrite()) return;
    Promise.resolve(pg.upsert(table, row, pk)).catch(() => {});
  } catch (_) { /* PG opcional */ }
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function identKey(platform, user) {
  return {
    platform: String(platform || '').toLowerCase(),
    user: String(user || '').trim().toLowerCase().replace(/:\d+(?=@)/, '')
  };
}

async function seedPlans() {
  if (!isReady()) return 0;
  let n = 0;
  for (const p of PLANS) {
    await runAsync(
      `INSERT INTO billing_plan (id, name, price_cents, duration_days, quota_tier, active, sort_order)
       VALUES (?,?,?,?,?,1,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         price_cents=excluded.price_cents,
         duration_days=excluded.duration_days,
         quota_tier=excluded.quota_tier,
         sort_order=excluded.sort_order`,
      [p.id, p.name, p.price_cents, p.duration_days, p.quota_tier, p.sort_order]
    );
    n++;
  }
  if (LEGACY_PLAN_IDS.length) {
    const ph = LEGACY_PLAN_IDS.map(() => '?').join(',');
    await runAsync(
      `UPDATE billing_plan SET active=0 WHERE id IN (${ph})`,
      LEGACY_PLAN_IDS
    );
  }
  try {
    await runAsync(
      `UPDATE billing_entitlement SET product_tier='enterprise'
        WHERE kind IN ('bot','bot_license') AND (product_tier IS NULL OR product_tier='')`
    );
    await runAsync(
      `UPDATE billing_entitlement SET product_tier='starter'
        WHERE kind='vip' AND quota_tier IN ('entry','starter') AND (product_tier IS NULL OR product_tier='')`
    );
    await runAsync(
      `UPDATE billing_entitlement SET product_tier='pro'
        WHERE kind='vip' AND (product_tier IS NULL OR product_tier='')`
    );
  } catch (_) { /* coluna nova pode ainda nao existir */ }
  return n;
}

async function listPlans() {
  if (!isReady()) return PLANS.filter((p) => p.active !== 0);
  const rows = await allAsync(
    `SELECT id, name, price_cents, duration_days, quota_tier, active, sort_order
     FROM billing_plan WHERE active=1 ORDER BY sort_order ASC`
  );
  return rows.length ? rows : PLANS;
}

async function getPlan(id) {
  const syn = resolvePlan(id);
  if (syn) return syn;
  if (!isReady()) return PLANS.find((p) => p.id === id) || null;
  const row = await getAsync(
    `SELECT id, name, price_cents, duration_days, quota_tier, active, sort_order
     FROM billing_plan WHERE id=?`,
    [String(id || '')]
  );
  return row || null;
}

async function findCustomerByIdentity(platform, platformUser) {
  const { platform: p, user } = identKey(platform, platformUser);
  if (!p || !user || !isReady()) return null;
  const via = await getAsync(
    `SELECT c.* FROM billing_identity i
     JOIN billing_customer c ON c.id=i.customer_id
     WHERE i.platform=? AND i.platform_user=?`,
    [p, user]
  );
  if (via) return via;
  const legacy = await getAsync(
    `SELECT * FROM billing_customer WHERE platform=? AND platform_user=?`,
    [p, user]
  );
  if (legacy) {
    await attachIdentity(legacy.id, p, user);
    return legacy;
  }
  return null;
}

async function attachIdentity(customerId, platform, platformUser) {
  const { platform: p, user } = identKey(platform, platformUser);
  if (!customerId || !p || !user) return;
  const existing = await getAsync(
    `SELECT * FROM billing_identity WHERE platform=? AND platform_user=?`,
    [p, user]
  );
  if (existing) {
    if (existing.customer_id !== customerId) {
      await mergeCustomers(existing.customer_id, customerId);
      await runAsync(
        `UPDATE billing_identity SET customer_id=? WHERE platform=? AND platform_user=?`,
        [customerId, p, user]
      );
    }
    return;
  }
  await runAsync(
    `INSERT INTO billing_identity (platform, platform_user, customer_id, created_at) VALUES (?,?,?,?)`,
    [p, user, customerId, nowIso()]
  );
}

async function listIdentities(customerId) {
  return allAsync(
    `SELECT platform, platform_user FROM billing_identity WHERE customer_id=?`,
    [String(customerId)]
  );
}

async function mergeCustomers(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const fromEnt = await getAsync(
    `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='vip'`,
    [fromId]
  );
  const toEnt = await getAsync(
    `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='vip'`,
    [toId]
  );
  if (fromEnt && !toEnt) {
    await runAsync(`UPDATE billing_entitlement SET customer_id=? WHERE customer_id=?`, [toId, fromId]);
  } else if (fromEnt && toEnt) {
    const fromExp = fromEnt.expires_at ? Date.parse(fromEnt.expires_at) : Infinity;
    const toExp = toEnt.expires_at ? Date.parse(toEnt.expires_at) : Infinity;
    const keepFrom = fromEnt.status === 'active' && (toEnt.status !== 'active' || fromExp > toExp);
    if (keepFrom) {
      await runAsync(
        `UPDATE billing_entitlement SET status=?, quota_tier=?, expires_at=? WHERE id=?`,
        [fromEnt.status, fromEnt.quota_tier, fromEnt.expires_at, toEnt.id]
      );
    }
    await runAsync(`DELETE FROM billing_entitlement WHERE customer_id=?`, [fromId]);
  }
  await runAsync(`UPDATE billing_order SET customer_id=? WHERE customer_id=?`, [toId, fromId]);
  await runAsync(`UPDATE billing_subscription SET customer_id=? WHERE customer_id=?`, [toId, fromId]);
  await runAsync(`UPDATE billing_ticket SET customer_id=? WHERE customer_id=?`, [toId, fromId]);
  await runAsync(`UPDATE billing_identity SET customer_id=? WHERE customer_id=?`, [toId, fromId]);
}

async function upsertCustomer(platform, platformUser, aliases) {
  const { platform: p, user } = identKey(platform, platformUser);
  if (!p || !user) throw new Error('cliente incompleto');
  let row = await findCustomerByIdentity(p, user);
  if (!row) {
    row = { id: newId(), platform: p, platform_user: user, created_at: nowIso() };
    await runAsync(
      `INSERT INTO billing_customer (id, platform, platform_user, created_at) VALUES (?,?,?,?)`,
      [row.id, row.platform, row.platform_user, row.created_at]
    );
    await attachIdentity(row.id, p, user);
  }
  const extra = Array.isArray(aliases) ? aliases : [];
  for (const a of extra) {
    const k = identKey(p, a);
    if (k.user && k.user !== user) await attachIdentity(row.id, k.platform, k.user);
  }
  return row;
}

async function paidCount(customerId) {
  const row = await getAsync(
    `SELECT COUNT(*) AS c FROM billing_order WHERE customer_id=? AND status IN ('paid','delivered')`,
    [String(customerId)]
  );
  return Number(row?.c) || 0;
}

async function createOrder({ customer, planId, method, sessionOwner, chatJid, platform }) {
  const plan = await getPlan(planId);
  if (!plan) {
    const err = new Error('Plano invalido');
    err.code = 'NO_PLAN';
    throw err;
  }
  const priced = applyPromoPrice(plan, await paidCount(customer.id));
  const order = {
    id: newId(),
    customer_id: customer.id,
    plan_id: priced.id,
    amount_cents: Number(priced.price_cents || priced.price_cents) || 0,
    method: String(method || 'pix'),
    status: 'pending',
    session_owner: String(sessionOwner || ''),
    chat_jid: String(chatJid || ''),
    platform: String(platform || customer.platform),
    created_at: nowIso(),
    updated_at: nowIso(),
    promo: !!priced.promo
  };
  await runAsync(
    `INSERT INTO billing_order
      (id, customer_id, plan_id, amount_cents, method, status, session_owner, chat_jid, platform, poll_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
    [
      order.id, order.customer_id, order.plan_id, order.amount_cents, order.method, order.status,
      order.session_owner, order.chat_jid, order.platform, order.created_at, order.updated_at
    ]
  );
  try {
    const tid = String(sessionOwner || customer.platform_user || '');
    await runAsync(
      `UPDATE billing_order SET tenant_id=?, session_owner_id=? WHERE id=?`,
      [tid, tid, order.id]
    );
    order.tenant_id = tid;
    order.session_owner_id = tid;
  } catch (_) { /* coluna nova */ }
  await runAsync(
    `INSERT INTO billing_delivery (id, order_id, status, attempts) VALUES (?,?,?,0)`,
    [newId(), order.id, 'pending']
  );
  pgMirror('billing_order', {
    id: order.id,
    customer_id: order.customer_id,
    plan_id: order.plan_id,
    amount_cents: order.amount_cents,
    method: order.method,
    status: order.status,
    mp_preference_id: null,
    mp_payment_id: null,
    session_owner: order.session_owner,
    chat_jid: order.chat_jid,
    platform: order.platform,
    poll_count: 0,
    created_at: order.created_at,
    updated_at: order.updated_at
  }, 'id');
  return order;
}

async function getOrder(id) {
  return getAsync(`SELECT * FROM billing_order WHERE id=?`, [String(id)]);
}

async function updateOrder(id, patch) {
  const cur = await getOrder(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updated_at: nowIso() };
  await runAsync(
    `UPDATE billing_order SET
      status=?, mp_preference_id=?, mp_payment_id=?, poll_count=?, updated_at=?
     WHERE id=?`,
    [
      next.status,
      next.mp_preference_id || null,
      next.mp_payment_id || null,
      Number(next.poll_count) || 0,
      next.updated_at,
      id
    ]
  );
  return next;
}

async function recordPayment(order, mpPay) {
  const pid = String(mpPay.id);
  const existing = await getAsync(`SELECT * FROM billing_payment WHERE mp_payment_id=?`, [pid]);
  if (existing) return existing;
  const row = {
    id: newId(),
    order_id: order.id,
    mp_payment_id: pid,
    status: String(mpPay.status),
    amount_cents: Number(mpPay.amount_cents) || 0,
    created_at: nowIso()
  };
  try {
    await runAsync(
      `INSERT INTO billing_payment (id, order_id, mp_payment_id, status, amount_cents, created_at)
       VALUES (?,?,?,?,?,?)`,
      [row.id, row.order_id, row.mp_payment_id, row.status, row.amount_cents, row.created_at]
    );
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      return getAsync(`SELECT * FROM billing_payment WHERE mp_payment_id=?`, [pid]);
    }
    throw e;
  }
  pgMirror('billing_payment', row, 'id');
  return row;
}

async function claimWebhook(mpPaymentId) {
  const id = String(mpPaymentId || '');
  if (!id) return { first: false };
  try {
    await runAsync(
      `INSERT INTO billing_webhook_event (id, mp_payment_id, processed, created_at) VALUES (?,?,0,?)`,
      [newId(), id, nowIso()]
    );
    return { first: true };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { first: false };
    throw e;
  }
}

async function markWebhookProcessed(mpPaymentId) {
  await runAsync(
    `UPDATE billing_webhook_event SET processed=1 WHERE mp_payment_id=?`,
    [String(mpPaymentId)]
  );
}

function grantVipOnSessions(platformUser, extraUsers) {
  if (process.env.HANORK_BILLING_SKIP_VIP === '1') return 0;
  const { addVip } = require('../../utils/configManager');
  const { ADMIN_IDS } = require('../../utils/userManager');
  const { getAllSessions } = require('../../utils/sessionRegistry');
  const ids = new Set((ADMIN_IDS || []).map(String));
  try {
    for (const s of getAllSessions() || []) {
      if (s.telegramUserId) ids.add(String(s.telegramUserId));
    }
  } catch (_) { /* ignore */ }
  const targets = [platformUser, ...(extraUsers || [])].filter(Boolean);
  let n = 0;
  for (const uid of ids) {
    for (const t of targets) {
      try {
        if (addVip(uid, t)) n++;
      } catch (_) { /* TG id curto nao entra na lista WA — indice SQL cobre */ }
    }
  }
  return n;
}

async function customerHasActiveDaypass(customerId) {
  const cid = String(customerId || '');
  if (!cid || !isReady()) return false;
  const row = await getAsync(
    `SELECT id FROM billing_subscription
     WHERE customer_id=? AND plan_id='daypass' AND status='active'
       AND (expires_at IS NULL OR expires_at > ?)
     LIMIT 1`,
    [cid, nowIso()]
  );
  return !!row;
}

async function rememberCustomerVip(customerId, active) {
  const rows = await listIdentities(customerId);
  let tier = 'pro';
  const daypass = active ? await customerHasActiveDaypass(customerId) : false;
  try {
    const ents = await allAsync(
      `SELECT kind, quota_tier, product_tier FROM billing_entitlement WHERE customer_id=? AND status='active'`,
      [String(customerId)]
    );
    const { rankOfTier } = require('./logic');
    let best = 'free';
    for (const e of ents || []) {
      const t = productTierFromEntitlement(e);
      if (rankOfTier(t) > rankOfTier(best)) best = t;
    }
    if (best !== 'free') tier = best;
  } catch (_) { /* ignore */ }
  for (const r of rows) {
    if (active) vipIndex.remember(r.platform, r.platform_user, tier, { daypass: daypass && tier === 'starter' });
    else vipIndex.forget(r.platform, r.platform_user);
  }
  try {
    const { getUserSessions } = require('../../utils/sessionRegistry');
    for (const r of rows) {
      if (String(r.platform || '').toLowerCase() !== 'telegram') continue;
      for (const s of getUserSessions(String(r.platform_user)) || []) {
        const phone = String(s.phone || s.phoneNumber || '').replace(/\D/g, '');
        if (phone.length < 10) continue;
        const jid = `${phone}@s.whatsapp.net`;
        if (active) vipIndex.remember('whatsapp', jid, tier, { daypass: daypass && tier === 'starter' });
        else vipIndex.forget('whatsapp', jid);
      }
    }
  } catch (_) { /* registry opcional */ }
}

async function warmVipIndex() {
  if (!isReady()) return 0;
  vipIndex.clear();
  const rows = await allAsync(
    `SELECT i.platform, i.platform_user, i.customer_id, e.quota_tier, e.product_tier, e.kind
     FROM billing_identity i
     JOIN billing_entitlement e ON e.customer_id=i.customer_id
     WHERE e.status='active' AND e.kind IN ('vip','bot_license','bot')
       AND (e.expires_at IS NULL OR e.expires_at > ?)`,
    [nowIso()]
  );
  const dpRows = await allAsync(
    `SELECT DISTINCT customer_id FROM billing_subscription
     WHERE plan_id='daypass' AND status='active' AND (expires_at IS NULL OR expires_at > ?)`,
    [nowIso()]
  );
  const dpSet = new Set((dpRows || []).map((r) => String(r.customer_id)));
  for (const r of rows) {
    const tier = productTierFromEntitlement(r);
    const daypass = dpSet.has(String(r.customer_id)) && tier === 'starter';
    vipIndex.remember(r.platform, r.platform_user, tier, { daypass });
  }
  return rows.length;
}

function newLinkCode() {
  return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

async function createLinkCode(customerId) {
  const code = newLinkCode();
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await runAsync(
    `INSERT INTO billing_link_code (code, customer_id, expires_at, created_at) VALUES (?,?,?,?)`,
    [code, String(customerId), expires, nowIso()]
  );
  return { code, expires_at: expires };
}

async function consumeLinkCode(code, platform, platformUser, aliases) {
  const raw = String(code || '').trim().toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(raw)) return { ok: false, reason: 'codigo_invalido' };
  const row = await getAsync(`SELECT * FROM billing_link_code WHERE code=?`, [raw]);
  if (!row) return { ok: false, reason: 'codigo_invalido' };
  if (Date.parse(row.expires_at) < Date.now()) {
    await runAsync(`DELETE FROM billing_link_code WHERE code=?`, [raw]);
    return { ok: false, reason: 'codigo_expirado' };
  }
  await attachIdentity(row.customer_id, platform, platformUser);
  for (const a of aliases || []) await attachIdentity(row.customer_id, platform, a);
  await runAsync(`DELETE FROM billing_link_code WHERE code=?`, [raw]);
  const ent = await getAsync(
    `SELECT * FROM billing_entitlement WHERE customer_id=? AND status='active'`,
    [row.customer_id]
  );
  if (ent && !isExpired(ent.expires_at)) {
    const ids = await listIdentities(row.customer_id);
    grantVipOnSessions(platformUser, ids.map((i) => i.platform_user));
    await rememberCustomerVip(row.customer_id, true);
  }
  return { ok: true, customerId: row.customer_id };
}

function revokeVipOnSessions(platformUser) {
  if (process.env.HANORK_BILLING_SKIP_VIP === '1') return;
  const { removeVip } = require('../../utils/configManager');
  const { ADMIN_IDS } = require('../../utils/userManager');
  const { getAllSessions } = require('../../utils/sessionRegistry');
  const ids = new Set((ADMIN_IDS || []).map(String));
  try {
    for (const s of getAllSessions() || []) {
      if (s.telegramUserId) ids.add(String(s.telegramUserId));
    }
  } catch (_) { /* ignore */ }
  for (const uid of ids) {
    try { removeVip(uid, platformUser); } catch (_) { /* ignore */ }
  }
}

async function deliverOrder(order, payment) {
  const gate = canDeliver(order, {
    status: payment.status,
    amount_cents: payment.amount_cents
  });
  if (!gate.ok) return gate;

  const del = await getAsync(`SELECT * FROM billing_delivery WHERE order_id=?`, [order.id]);
  if (del?.status === 'delivered') return { ok: false, reason: 'already_delivered' };

  await runAsync(
    `UPDATE billing_delivery SET status='processing', attempts=attempts+1 WHERE order_id=?`,
    [order.id]
  );

  const customer = await getAsync(`SELECT * FROM billing_customer WHERE id=?`, [order.customer_id]);
  const plan = await getPlan(order.plan_id);
  if (!customer || !plan) {
    await runAsync(
      `UPDATE billing_delivery SET status='failed', last_error=? WHERE order_id=?`,
      ['customer/plan missing', order.id]
    );
    return { ok: false, reason: 'missing_customer' };
  }

  const botSale = isBotPlan(plan);
  const identRows = await listIdentities(customer.id);
  const extraUsers = identRows.map((r) => r.platform_user);
  const ent = await getAsync(
    `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='vip'`,
    [customer.id]
  );
  let expires = botSale ? null : nextExpiryIso(ent?.expires_at, plan.duration_days || plan.duration_days);
  if (!botSale && ent && !ent.expires_at) expires = null;
  const pTier = productTierOfPlan(plan);
  grantVipOnSessions(customer.platform_user, extraUsers);
  try { require('../../utils/opsMetrics').bump('sales'); } catch (_) { /* ignore */ }
  try {
    const m = require('../../utils/opsMetrics');
    if (plan.id === 'daypass') m.bump('daypassPaid');
    else if (String(plan.quota_tier) === 'pro' || String(plan.id).startsWith('pro_')) m.bump('proPaid');
    else if (String(plan.quota_tier) === 'enterprise' || String(plan.id).startsWith('ent_')) m.bump('entPaid');
  } catch (_) { /* */ }

  if (plan.id !== 'daypass') {
    try {
      await runAsync(
        `UPDATE billing_subscription SET status='expired' WHERE customer_id=? AND plan_id='daypass' AND status='active'`,
        [customer.id]
      );
    } catch (_) { /* */ }
  }

  if (ent) {
    await runAsync(
      `UPDATE billing_entitlement SET status='active', quota_tier=?, product_tier=?, expires_at=?, session_owner=?, session_owner_id=? WHERE id=?`,
      [plan.quota_tier, pTier, expires, order.session_owner, order.session_owner, ent.id]
    );
  } else {
    await runAsync(
      `INSERT INTO billing_entitlement (id, customer_id, kind, status, quota_tier, product_tier, expires_at, session_owner, session_owner_id)
       VALUES (?,?, 'vip', 'active', ?, ?, ?, ?, ?)`,
      [newId(), customer.id, plan.quota_tier, pTier, expires, order.session_owner, order.session_owner]
    );
  }

  if (botSale) {
    const botEnt = await getAsync(
      `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='bot_license'`,
      [customer.id]
    );
    if (botEnt) {
      await runAsync(
        `UPDATE billing_entitlement SET status='active', quota_tier='enterprise', product_tier='enterprise', expires_at=NULL, session_owner=?, session_owner_id=? WHERE id=?`,
        [order.session_owner, order.session_owner, botEnt.id]
      );
    } else {
      await runAsync(
        `INSERT INTO billing_entitlement (id, customer_id, kind, status, quota_tier, product_tier, expires_at, session_owner, session_owner_id)
         VALUES (?,?, 'bot_license', 'active', 'enterprise', 'enterprise', NULL, ?, ?)`,
        [newId(), customer.id, order.session_owner, order.session_owner]
      );
    }
  }

  await rememberCustomerVip(customer.id, true);

  try {
    const live = await getAsync(
      `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind=?`,
      [customer.id, botSale ? 'bot_license' : 'vip']
    );
    if (live) pgMirror('billing_entitlement', live, ['customer_id', 'kind']);
  } catch (_) { /* PG opcional */ }

  const subId = newId();
  await runAsync(
    `INSERT INTO billing_subscription (id, customer_id, plan_id, status, starts_at, expires_at, last_order_id)
     VALUES (?,?,?,'active',?,?,?)`,
    [subId, customer.id, plan.id, nowIso(), expires, order.id]
  );

  await runAsync(
    `UPDATE billing_delivery SET status='delivered', delivered_at=?, last_error=NULL WHERE order_id=?`,
    [nowIso(), order.id]
  );
  await updateOrder(order.id, {
    status: 'delivered',
    mp_payment_id: payment.mp_payment_id || payment.id || order.mp_payment_id,
    mp_preference_id: order.mp_preference_id,
    poll_count: order.poll_count
  });

  logger.logInfo(`[billing] delivered order=${order.id} plan=${plan.id} kind=${botSale ? 'bot' : 'vip'}`);
  try { await creditReferralOnPaid(customer.id, order, plan); } catch (e) {
    logger.logAviso(`[billing] referral: ${e.message}`);
  }
  try { await getOrCreateAffiliate(customer.id); } catch (_) { /* link de indica */ }
  return { ok: true, expires_at: expires, plan, kind: botSale ? 'bot' : 'vip' };
}

async function processApprovedPayment(mpPay) {
  // R1: nunca entregar VIP sem status approved real da API MP
  if (String(mpPay?.status || '').toLowerCase() !== 'approved') {
    return { ok: false, reason: 'not_approved' };
  }
  const ref = String(mpPay.external_reference || '');
  let order = ref ? await getOrder(ref) : null;
  if (!order && mpPay.id) {
    order = await getAsync(`SELECT * FROM billing_order WHERE mp_payment_id=?`, [String(mpPay.id)]);
  }
  if (!order) return { ok: false, reason: 'order_not_found' };

  const payment = await recordPayment(order, mpPay);
  // canDeliver tambem exige approved + valor — segunda trava
  const result = await deliverOrder(order, payment);
  return { ...result, orderId: order.id };
}

async function expireDue() {
  if (!isReady()) return 0;
  const rows = await allAsync(
    `SELECT e.*, c.platform, c.platform_user FROM billing_entitlement e
     JOIN billing_customer c ON c.id=e.customer_id
     WHERE e.status='active' AND e.expires_at IS NOT NULL AND e.expires_at <= ?`,
    [nowIso()]
  );
  let n = 0;
  for (const row of rows) {
    revokeVipOnSessions(row.platform_user);
    await rememberCustomerVip(row.customer_id, false);
    await runAsync(`UPDATE billing_entitlement SET status='expired' WHERE id=?`, [row.id]);
    await runAsync(
      `UPDATE billing_subscription SET status='expired' WHERE customer_id=? AND status='active'`,
      [row.customer_id]
    );
    try {
      const { notifyUser } = require('./notify');
      await notifyUser({
        platform: row.platform,
        platformUser: row.platform_user,
        sessionOwner: row.session_owner,
        text: require('./notify').vipWarnText(row.platform, {
          expired: true,
          daypass: String(row.quota_tier || row.product_tier || '') === 'starter'
        })
      });
    } catch (_) { /* notify opcional */ }
    n++;
  }
  if (n) logger.logInfo(`[billing] expired entitlements n=${n}`);
  return n;
}

/** VIPs com expires_at em [fromIso, toIso] (inclusive-ish). */
async function listVipExpiringBetween(fromIso, toIso) {
  if (!isReady()) return [];
  return allAsync(
    `SELECT e.*, c.platform, c.platform_user
     FROM billing_entitlement e
     JOIN billing_customer c ON c.id=e.customer_id
     WHERE e.status='active' AND e.kind='vip'
       AND e.expires_at IS NOT NULL
       AND e.expires_at > ?
       AND e.expires_at <= ?`,
    [fromIso, toIso]
  );
}

/**
 * Avisa VIP D-3 e D-1 uma vez (kv billing).
 * @returns {number} avisos enviados
 */
async function warnVipExpiring() {
  if (!isReady()) return 0;
  if (String(process.env.HANORK_VIP_EXPIRY_WARN || '1') === '0') return 0;
  const sql = require('../../utils/sqlStore');
  const now = Date.now();
  const dayMs = 86400000;
  const windows = [
    { tag: 'd3', from: now + 2 * dayMs, to: now + 3 * dayMs + 3600000 },
    { tag: 'd1', from: now, to: now + 1 * dayMs + 3600000 }
  ];
  let sent = 0;
  const { notifyUser } = require('./notify');
  for (const w of windows) {
    const rows = await listVipExpiringBetween(new Date(w.from).toISOString(), new Date(w.to).toISOString());
    for (const row of rows) {
      const kvKey = `warn_${w.tag}_${row.id}`;
      try {
        const already = await sql.getKv('billing', kvKey);
        if (already) continue;
      } catch (_) { /* ignore */ }
      const day = String(row.expires_at || '').slice(0, 10);
      const msLeft = Date.parse(row.expires_at) - now;
      const daypassish =
        String(row.quota_tier || row.product_tier || '') === 'starter' &&
        Number.isFinite(msLeft) &&
        msLeft > 0 &&
        msLeft <= 36 * 3600 * 1000;
      const text = require('./notify').vipWarnText(row.platform, {
        day,
        tag: w.tag,
        daypass: daypassish
      });
      await notifyUser({
        platform: row.platform,
        platformUser: row.platform_user,
        sessionOwner: row.session_owner,
        text
      });
      try {
        await sql.upsertKvAsync('billing', kvKey, { at: nowIso(), day });
      } catch (_) { /* ignore */ }
      sent++;
    }
  }
  if (sent) logger.logInfo(`[billing] vip expiry warns n=${sent}`);
  return sent;
}

function makeAffiliateCode() {
  return `HK${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function getOrCreateAffiliate(customerId) {
  const cid = String(customerId || '');
  if (!cid || !isReady()) return null;
  let row = await getAsync(`SELECT * FROM billing_affiliate WHERE customer_id=?`, [cid]);
  if (row) return row;
  let code = makeAffiliateCode();
  for (let i = 0; i < 6; i++) {
    const clash = await getAsync(`SELECT code FROM billing_affiliate WHERE code=?`, [code]);
    if (!clash) break;
    code = makeAffiliateCode();
  }
  await runAsync(
    `INSERT INTO billing_affiliate (code, customer_id, hits, conversions, created_at) VALUES (?,?,0,0,?)`,
    [code, cid, nowIso()]
  );
  return { code, customer_id: cid, hits: 0, conversions: 0 };
}

async function attachReferral(customerId, codeRaw) {
  const cid = String(customerId || '');
  const code = normalizeAffiliateCode(codeRaw);
  if (!cid || !code || !isReady()) return { ok: false, reason: 'bad' };
  const aff = await getAsync(`SELECT * FROM billing_affiliate WHERE code=?`, [code]);
  if (!aff) return { ok: false, reason: 'unknown' };
  if (String(aff.customer_id) === cid) return { ok: false, reason: 'self' };
  const existing = await getAsync(`SELECT * FROM billing_referral WHERE customer_id=?`, [cid]);
  if (existing) return { ok: true, already: true, code: existing.referrer_code };
  await runAsync(
    `INSERT INTO billing_referral (customer_id, referrer_code, converted, created_at) VALUES (?,?,0,?)`,
    [cid, code, nowIso()]
  );
  await runAsync(`UPDATE billing_affiliate SET hits=hits+1 WHERE code=?`, [code]);
  return { ok: true, code };
}

async function attachReferralFromTelegram(telegramUserId, code) {
  const customer = await upsertCustomer('telegram', String(telegramUserId));
  return attachReferral(customer.id, code);
}

/** Cortesia: VIP ativo N dias (empilha se ja tiver). Lifetime (expires null) so reativa. */
async function grantComplimentaryVip(telegramUserId, days, { planId = 'pro_m' } = {}) {
  if (!isReady()) return { ok: false, reason: 'sql-cold' };
  const uid = String(telegramUserId || '').trim();
  if (!/^\d{5,}$/.test(uid)) return { ok: false, reason: 'bad-uid' };
  const nDays = Math.max(1, Math.min(365, Number(days) || 30));
  const plan = await getPlan(planId);
  if (!plan) return { ok: false, reason: 'no-plan' };
  const customer = await upsertCustomer('telegram', uid);
  const identRows = await listIdentities(customer.id);
  const extraUsers = identRows.map((r) => r.platform_user);
  const ent = await getAsync(
    `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='vip'`,
    [customer.id]
  );
  const lifetime = !!(ent && ent.expires_at == null && String(ent.status || '') === 'active');
  const expires = lifetime ? null : nextExpiryIso(ent?.expires_at, nDays);
  const pTier = productTierOfPlan(plan);
  grantVipOnSessions(customer.platform_user, extraUsers);
  if (ent) {
    await runAsync(
      `UPDATE billing_entitlement SET status='active', quota_tier=?, product_tier=?, expires_at=?, session_owner=?, session_owner_id=? WHERE id=?`,
      [plan.quota_tier, pTier, expires, uid, uid, ent.id]
    );
  } else {
    await runAsync(
      `INSERT INTO billing_entitlement (id, customer_id, kind, status, quota_tier, product_tier, expires_at, session_owner, session_owner_id)
       VALUES (?,?, 'vip', 'active', ?, ?, ?, ?, ?)`,
      [newId(), customer.id, plan.quota_tier, pTier, expires, uid, uid]
    );
  }
  await rememberCustomerVip(customer.id, true);
  try {
    const live = await getAsync(
      `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='vip'`,
      [customer.id]
    );
    if (live) pgMirror('billing_entitlement', live, ['customer_id', 'kind']);
  } catch (_) { /* PG opcional */ }
  try {
    await runAsync(
      `INSERT INTO billing_subscription (id, customer_id, plan_id, status, starts_at, expires_at, last_order_id)
       VALUES (?,?,?,'active',?,?,?)`,
      [newId(), customer.id, plan.id, nowIso(), expires, '']
    );
  } catch (_) { /* historico opcional */ }
  logger.logInfo(`[billing] comp vip uid=${uid.slice(0, 8)} days=${nDays} plan=${plan.id}`);
  return { ok: true, customerId: customer.id, expires_at: expires, planId: plan.id };
}

async function creditReferralOnPaid(customerId, order, plan) {
  const cid = String(customerId || '');
  if (!cid || !isReady()) return { ok: false };
  if (plan && isBotPlan(plan)) return { ok: false, reason: 'bot' };
  const ref = await getAsync(`SELECT * FROM billing_referral WHERE customer_id=?`, [cid]);
  if (!ref || Number(ref.converted)) return { ok: false };
  const aff = await getAsync(`SELECT * FROM billing_affiliate WHERE code=?`, [ref.referrer_code]);
  if (!aff) return { ok: false };
  const rate = Math.min(0.5, Math.max(0, Number(process.env.HANORK_AFFILIATE_RATE || 0.3)));
  const amount = Math.max(0, Math.round(Number(order && order.amount_cents ? order.amount_cents : 0) * rate));
  await runAsync(`UPDATE billing_referral SET converted=1 WHERE customer_id=?`, [cid]);
  await runAsync(`UPDATE billing_affiliate SET conversions=conversions+1 WHERE code=?`, [aff.code]);
  if (amount > 0) {
    await runAsync(
      `INSERT INTO billing_affiliate_ledger
        (id, affiliate_code, referrer_customer_id, buyer_customer_id, order_id, plan_id, amount_cents, status, created_at)
       VALUES (?,?,?,?,?,?,?,'pending',?)`,
      [
        newId(),
        aff.code,
        aff.customer_id,
        cid,
        order && order.id ? order.id : '',
        plan && plan.id ? plan.id : '',
        amount,
        nowIso()
      ]
    );
  }
  const reais = (amount / 100).toFixed(2).replace('.', ',');
  logger.logInfo(`[billing] referral credit code=${aff.code} cents=${amount}`);
  try {
    const ids = await listIdentities(aff.customer_id);
    const tg = (ids || []).find((i) => String(i.platform) === 'telegram' && i.platform_user);
    if (tg) {
      const { bot } = require('../../telegramBot');
      if (bot) {
        await bot.sendMessage(
          tg.platform_user,
          `Alguem comprou com o seu codigo ${aff.code}.\n` +
          `Saldo +R$${reais} (30% da primeira compra).\n` +
          `Saque: combinado com o dono. Nao e automatico.\n` +
          `/afiliado`
        ).catch(() => {});
      }
    }
  } catch (_) { /* aviso opcional */ }
  return { ok: true, amount_cents: amount };
}

async function affiliateBalance(customerId) {
  const cid = String(customerId || '');
  if (!cid || !isReady()) return { pending_cents: 0, paid_cents: 0, rows: [] };
  const rows = await allAsync(
    `SELECT * FROM billing_affiliate_ledger WHERE referrer_customer_id=? ORDER BY created_at DESC LIMIT 40`,
    [cid]
  );
  let pending = 0;
  let paid = 0;
  for (const r of rows || []) {
    const n = Number(r.amount_cents) || 0;
    if (String(r.status) === 'paid') paid += n;
    else pending += n;
  }
  return { pending_cents: pending, paid_cents: paid, rows: rows || [] };
}

async function listPendingAffiliatePayouts(limit = 30) {
  if (!isReady()) return [];
  return allAsync(
    `SELECT * FROM billing_affiliate_ledger WHERE status='pending' ORDER BY created_at ASC LIMIT ?`,
    [Math.max(1, Number(limit) || 30)]
  );
}

async function markAffiliatePayoutPaid(ledgerId) {
  const id = String(ledgerId || '');
  if (!id || !isReady()) return { ok: false };
  const row = await getAsync(`SELECT * FROM billing_affiliate_ledger WHERE id=?`, [id]);
  if (!row) return { ok: false, reason: 'missing' };
  await runAsync(
    `UPDATE billing_affiliate_ledger SET status='paid', paid_at=? WHERE id=?`,
    [nowIso(), id]
  );
  return { ok: true, row };
}

async function remindStaleCheckouts() {
  if (!isReady()) return 0;
  if (String(process.env.HANORK_CART_REMIND || '1') === '0') return 0;
  const hours = Math.max(2, Number(process.env.HANORK_CART_REMIND_H || 3));
  const rows = await allAsync(
    `SELECT * FROM billing_order WHERE status='pending' ORDER BY created_at ASC LIMIT 20`
  );
  const cutoff = Date.now() - hours * 3600 * 1000;
  const { getKv, upsertKvAsync } = require('../../utils/sqlStore');
  const { notifyCustomer } = require('./notify');
  let n = 0;
  for (const o of rows || []) {
    const t = Date.parse(o.created_at || '') || 0;
    if (!t || t > cutoff) continue;
    const key = 'cart_remind_' + o.id;
    const already = await getKv('billing', key);
    if (already) continue;
    await upsertKvAsync('billing', key, nowIso());
    await notifyCustomer(
      o,
      'Seu PIX ainda esta em aberto.\nSe ja pagou, ignora esta msg.\nSe nao, abre /comprar no Telegram e gera de novo.'
    );
    n += 1;
  }
  return n;
}

async function accountFor(platform, platformUser) {
  const customer = await findCustomerByIdentity(platform, platformUser);
  if (!customer) return { customer: null, entitlement: null, botLicense: null, orders: [] };
  const entitlement = await getAsync(
    `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='vip'`,
    [customer.id]
  );
  const botLicense = await getAsync(
    `SELECT * FROM billing_entitlement WHERE customer_id=? AND kind='bot_license'`,
    [customer.id]
  );
  const orders = await allAsync(
    `SELECT id, plan_id, amount_cents, method, status, created_at FROM billing_order
     WHERE customer_id=? ORDER BY created_at DESC LIMIT 8`,
    [customer.id]
  );
  return { customer, entitlement, botLicense, orders };
}

async function pendingPixOrders() {
  return allAsync(
    `SELECT * FROM billing_order WHERE status='pending' AND method='pix' AND poll_count < 12
     ORDER BY created_at ASC LIMIT 20`
  );
}

async function stats() {
  if (!isReady()) return { sql: false, pending: 0, delivered24h: 0, openTickets: 0 };
  const pending = await getAsync(`SELECT COUNT(*) AS c FROM billing_order WHERE status='pending'`);
  const since = new Date(Date.now() - 86400000).toISOString();
  const delivered = await getAsync(
    `SELECT COUNT(*) AS c FROM billing_delivery WHERE status='delivered' AND delivered_at >= ?`,
    [since]
  );
  const tickets = await getAsync(`SELECT COUNT(*) AS c FROM billing_ticket WHERE status IN ('open','waiting_admin')`);
  return {
    sql: true,
    pending: Number(pending?.c) || 0,
    delivered24h: Number(delivered?.c) || 0,
    openTickets: Number(tickets?.c) || 0,
    mpConfigured: mp.isConfigured()
  };
}

function maskId(raw) {
  const s = String(raw || '');
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}..${s.slice(-4)}`;
}

async function listActiveVips(limit = 25) {
  if (!isReady()) return [];
  const now = nowIso();
  return allAsync(
    `SELECT e.customer_id, e.quota_tier, e.expires_at, e.kind, c.platform, c.platform_user
     FROM billing_entitlement e
     JOIN billing_customer c ON c.id=e.customer_id
     WHERE e.status='active' AND e.kind='vip'
       AND (e.expires_at IS NULL OR e.expires_at > ?)
     ORDER BY CASE WHEN e.expires_at IS NULL THEN 1 ELSE 0 END, e.expires_at ASC
     LIMIT ?`,
    [now, Number(limit) || 25]
  );
}

async function listBotLicenses(limit = 25) {
  if (!isReady()) return [];
  return allAsync(
    `SELECT e.customer_id, c.platform, c.platform_user
     FROM billing_entitlement e
     JOIN billing_customer c ON c.id=e.customer_id
     WHERE e.status='active' AND e.kind IN ('bot','bot_license')
     ORDER BY c.created_at DESC
     LIMIT ?`,
    [Number(limit) || 25]
  );
}

async function recentOrders(limit = 12) {
  if (!isReady()) return [];
  return allAsync(
    `SELECT o.id, o.plan_id, o.amount_cents, o.method, o.status, o.created_at, o.platform, c.platform_user
     FROM billing_order o
     LEFT JOIN billing_customer c ON c.id=o.customer_id
     ORDER BY o.created_at DESC
     LIMIT ?`,
    [Number(limit) || 12]
  );
}

async function weekSales() {
  if (!isReady()) return { count: 0, cents: 0, vip: 0, bot: 0, lastPaidAt: '' };
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = await allAsync(
    `SELECT plan_id, amount_cents, created_at FROM billing_order
     WHERE status IN ('paid','delivered') AND created_at >= ?`,
    [since]
  );
  const last = await getAsync(
    `SELECT created_at FROM billing_order WHERE status IN ('paid','delivered') ORDER BY created_at DESC LIMIT 1`
  );
  let cents = 0;
  let vip = 0;
  let bot = 0;
  for (const r of rows || []) {
    cents += Number(r.amount_cents) || 0;
    if (String(r.plan_id) === 'bot') bot += 1;
    else vip += 1;
  }
  return {
    count: (rows || []).length,
    cents,
    vip,
    bot,
    lastPaidAt: last?.created_at || ''
  };
}

async function createTicket({ customerId, subject, body }) {
  const row = {
    id: newId(),
    customer_id: customerId || null,
    subject: String(subject || 'duvida').slice(0, 80),
    status: 'open',
    body: String(body || '').slice(0, 2000),
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await runAsync(
    `INSERT INTO billing_ticket (id, customer_id, subject, status, body, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    [row.id, row.customer_id, row.subject, row.status, row.body, row.created_at, row.updated_at]
  );
  return row;
}

async function listOpenTickets(limit = 15) {
  return allAsync(
    `SELECT id, subject, status, created_at FROM billing_ticket
     WHERE status IN ('open','waiting_admin') ORDER BY created_at DESC LIMIT ?`,
    [Number(limit) || 15]
  );
}

module.exports = {
  seedPlans,
  listPlans,
  getPlan,
  upsertCustomer,
  createOrder,
  getOrder,
  updateOrder,
  recordPayment,
  claimWebhook,
  markWebhookProcessed,
  deliverOrder,
  processApprovedPayment,
  expireDue,
  accountFor,
  pendingPixOrders,
  stats,
  createTicket,
  listOpenTickets,
  centsToReais,
  isExpired,
  grantComplimentaryVip,
  grantVipOnSessions,
  attachIdentity,
  findCustomerByIdentity,
  listIdentities,
  createLinkCode,
  consumeLinkCode,
  warmVipIndex,
  rememberCustomerVip,
  listVipExpiringBetween,
  warnVipExpiring,
  getOrCreateAffiliate,
  attachReferral,
  attachReferralFromTelegram,
  creditReferralOnPaid,
  affiliateBalance,
  listPendingAffiliatePayouts,
  markAffiliatePayoutPaid,
  remindStaleCheckouts,
  weekSales,
  listActiveVips,
  listBotLicenses,
  recentOrders,
  maskId
};
