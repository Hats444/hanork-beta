'use strict';
/**
 * Planos + helpers puros (testaveis sem MP/SQL).
 * Planos publicos: 1 dia R$1 · 30 dias R$30 · 1 ano R$200 · zip R$250.
 * vip_N (R$1/dia) permanece so pra pedido PIX antigo nao quebrar.
 */

const CENTS_PER_DAY = 100;
const MIN_VIP_DAYS = 1;
const MAX_VIP_DAYS = 365;
const BOT_PRICE_CENTS = 25000;
const DAYPASS_CENTS = 100;

const TIER_RANK = { free: 0, starter: 1, pro: 2, enterprise: 3 };

const PLANS = [
  { id: 'daypass', name: '1 dia', price_cents: DAYPASS_CENTS, duration_days: 1, quota_tier: 'starter', sort_order: 10, kind: 'daypass', term: 'dia' },
  { id: 'pro_m', name: '30 dias', price_cents: 3000, duration_days: 30, quota_tier: 'pro', sort_order: 20, kind: 'sub', term: 'mensal' },
  { id: 'pro_y', name: '1 ano', price_cents: 20000, duration_days: 365, quota_tier: 'pro', sort_order: 22, kind: 'sub', term: 'anual' },
  {
    id: 'bot',
    name: 'Zip completo do bot',
    price_cents: BOT_PRICE_CENTS,
    duration_days: 0,
    quota_tier: 'enterprise',
    sort_order: 99,
    kind: 'bot'
  }
];

const LEGACY_PLAN_IDS = [
  'entry', 'recommended', 'premium',
  'yearly_entry', 'yearly_recommended', 'yearly_premium',
  'lifetime',
  'starter_m', 'starter_q', 'starter_y',
  'pro_q',
  'ent_m', 'ent_q', 'ent_y'
];

const PROMO_RECOMMENDED_CENTS = 3900;

/** Pedido antigo ainda resolve; nao aparece na vitrine. */
const LEGACY_RESOLVE = [
  { id: 'starter_m', name: 'Starter mensal (legado)', price_cents: 2900, duration_days: 30, quota_tier: 'starter', sort_order: 10, kind: 'sub', term: 'mensal' },
  { id: 'starter_q', name: 'Starter trimestral (legado)', price_cents: 7500, duration_days: 90, quota_tier: 'starter', sort_order: 11, kind: 'sub', term: 'trimestral' },
  { id: 'starter_y', name: 'Starter anual (legado)', price_cents: 24900, duration_days: 365, quota_tier: 'starter', sort_order: 12, kind: 'sub', term: 'anual' },
  { id: 'pro_q', name: 'Pro trimestral (legado)', price_cents: 12900, duration_days: 90, quota_tier: 'pro', sort_order: 21, kind: 'sub', term: 'trimestral' },
  { id: 'ent_m', name: 'Enterprise mensal (legado)', price_cents: 9900, duration_days: 30, quota_tier: 'enterprise', sort_order: 30, kind: 'sub', term: 'mensal' },
  { id: 'ent_q', name: 'Enterprise trimestral (legado)', price_cents: 24900, duration_days: 90, quota_tier: 'enterprise', sort_order: 31, kind: 'sub', term: 'trimestral' },
  { id: 'ent_y', name: 'Enterprise anual (legado)', price_cents: 79900, duration_days: 365, quota_tier: 'enterprise', sort_order: 32, kind: 'sub', term: 'anual' }
];

function clampVipDays(n) {
  const d = Math.round(Number(n));
  if (!Number.isFinite(d)) return 30;
  return Math.min(MAX_VIP_DAYS, Math.max(MIN_VIP_DAYS, d));
}

function normalizePlan(p) {
  if (!p) return null;
  const price = Number(p.price_cents != null ? p.price_cents : p.price_cents) || 0;
  const days = Number(p.duration_days != null ? p.duration_days : p.duration_days) || 0;
  return {
    ...p,
    price_cents: price,
    duration_days: days
  };
}

/** Pedido antigo vip_N ainda resolve (nao cria plano novo na tela). */
function vipPlanForDays(days) {
  const d = clampVipDays(days);
  const annual = d === 365;
  return normalizePlan({
    id: `vip_${d}`,
    name: annual ? 'Anual legado' : (d === 1 ? 'VIP 1 dia (legado)' : `VIP ${d} dias (legado)`),
    price_cents: d * CENTS_PER_DAY,
    duration_days: d,
    quota_tier: 'pro',
    sort_order: d,
    kind: 'vip'
  });
}

function resolvePlan(id) {
  const s = String(id || '').trim();
  if (!s) return null;
  const m = /^vip_(\d+)$/i.exec(s);
  if (m) return vipPlanForDays(m[1]);
  const listed = PLANS.find((p) => p.id === s);
  if (listed) return normalizePlan(listed);
  const legacy = LEGACY_RESOLVE.find((p) => p.id === s);
  return legacy ? normalizePlan(legacy) : null;
}

function formatMpAmount(amountReais) {
  const n = Number(amountReais);
  if (!Number.isFinite(n) || n < 0.5) {
    const err = new Error('Valor minimo para pagamento: R$ 0,50');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  return Number(n.toFixed(2));
}

function centsToReais(cents) {
  return formatMpAmount((Number(cents) || 0) / 100);
}

function applyPromoPrice(plan, priorPaidCount) {
  if (!plan) return null;
  const n = normalizePlan(plan);
  return { ...n, promo: false };
}

function amountsMatch(orderCents, paidCents, tolerance = 1) {
  return Math.abs(Number(orderCents) - Number(paidCents)) <= tolerance;
}

function canDeliver(order, payment) {
  if (!order || !payment) return { ok: false, reason: 'missing' };
  if (order.status === 'delivered') return { ok: false, reason: 'already_delivered' };
  const st = String(payment.status || '').toLowerCase();
  if (st !== 'approved') return { ok: false, reason: 'not_approved' };
  const orderAmt = Number(order.amount_cents != null ? order.amount_cents : order.amount_cents);
  const payAmt = Number(payment.amount_cents != null ? payment.amount_cents : payment.amount_cents);
  if (!amountsMatch(orderAmt, payAmt)) {
    return { ok: false, reason: 'amount_mismatch' };
  }
  return { ok: true };
}

function nextExpiryIso(currentExpiresAt, durationDays, now = new Date()) {
  if (!durationDays || durationDays <= 0) return null;
  const base = currentExpiresAt && new Date(currentExpiresAt) > now
    ? new Date(currentExpiresAt)
    : now;
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + Number(durationDays));
  return d.toISOString();
}

function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return false;
  return new Date(expiresAt) <= now;
}

function planKind(plan) {
  if (!plan) return 'sub';
  if (plan.kind) return plan.kind;
  if (plan.id === 'bot' || plan.quota_tier === 'bot') return 'bot';
  if (plan.id === 'daypass') return 'daypass';
  if (/^vip_/i.test(String(plan.id || ''))) return 'vip';
  return 'sub';
}

function isBotPlan(plan) {
  return planKind(plan) === 'bot';
}

function vipPlans(list) {
  return (list || []).filter((p) => !isBotPlan(p) && String(p.id) !== 'bot');
}

function botPlans(list) {
  return (list || []).filter((p) => isBotPlan(p));
}

function plansForTier(tier) {
  const t = String(tier || '').toLowerCase();
  return PLANS.filter((p) => p.quota_tier === t && p.kind === 'sub');
}

/** Rotulo de preco no botao (igual Day pass R$1). */
function formatReaisLabel(cents) {
  const n = Math.round(Number(cents) || 0) / 100;
  if (!Number.isFinite(n)) return 'R$0';
  if (Number.isInteger(n)) return `R$${n}`;
  return `R$${String(n.toFixed(2)).replace('.', ',')}`;
}

function monthlyPlanForTier(tier) {
  const t = String(tier || '').toLowerCase();
  return PLANS.find((p) => p.quota_tier === t && p.kind === 'sub' && p.term === 'mensal') || null;
}

function daypassPlan() {
  return PLANS.find((p) => p.id === 'daypass') || null;
}

function yearlyPlan() {
  return PLANS.find((p) => p.id === 'pro_y') || null;
}

function zipPlan() {
  return PLANS.find((p) => p.id === 'bot') || null;
}

function publicStorefrontPlans() {
  return [daypassPlan(), monthlyPlanForTier('pro'), yearlyPlan(), zipPlan()].filter(Boolean);
}

function tierButtonLabel(tier) {
  const t = String(tier || '').toLowerCase();
  if (t === 'pro' || t === 'starter') {
    const p = monthlyPlanForTier('pro');
    return p ? `30 dias ${formatReaisLabel(p.price_cents)}` : '30 dias';
  }
  if (t === 'enterprise') {
    const p = yearlyPlan();
    return p ? `1 ano ${formatReaisLabel(p.price_cents)}` : '1 ano';
  }
  const p = monthlyPlanForTier(tier);
  return p ? `${p.name} ${formatReaisLabel(p.price_cents)}` : String(tier || '');
}

function daypassButtonLabel() {
  const p = daypassPlan();
  const cents = p ? p.price_cents : DAYPASS_CENTS;
  return `1 dia ${formatReaisLabel(cents)}`;
}

function productTierOfPlan(plan) {
  if (!plan) return 'free';
  if (isBotPlan(plan) || plan.id === 'lifetime' || plan.quota_tier === 'bot') return 'enterprise';
  const q = String(plan.quota_tier || plan.product_tier || '').toLowerCase();
  if (q === 'enterprise' || q === 'pro' || q === 'starter') return q;
  if (q === 'premium' || q === 'recommended') return 'pro';
  if (q === 'entry') return 'starter';
  if (plan.id === 'daypass' || plan.kind === 'daypass') return 'starter';
  if (plan.kind === 'vip' || /^vip_/i.test(String(plan.id || ''))) return 'pro';
  return 'starter';
}

function productTierFromEntitlement(row) {
  if (!row) return 'free';
  const kind = String(row.kind || '').toLowerCase();
  if (kind === 'bot' || kind === 'bot_license') return 'enterprise';
  const stored = String(row.product_tier || '').toLowerCase();
  if (stored === 'enterprise' || stored === 'pro' || stored === 'starter') return stored;
  return productTierOfPlan({
    id: row.plan_id,
    quota_tier: row.quota_tier,
    kind: row.kind
  });
}

function rankOfTier(tier) {
  const k = String(tier || 'free').toLowerCase();
  return TIER_RANK[k] != null ? TIER_RANK[k] : 0;
}

function hasTier(have, need) {
  return rankOfTier(have) >= rankOfTier(need);
}

function validityLabel(ent, active) {
  if (!active) return 'Validade: sem assinatura ativa';
  if (!ent || !ent.expires_at) return 'Validade: vitalicio (nao vence)';
  const exp = Date.parse(ent.expires_at);
  const days = Number.isFinite(exp) ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : 0;
  return `Validade: ate ${String(ent.expires_at).slice(0, 10)} (${days} dia${days === 1 ? '' : 's'} restantes)`;
}

function normalizeAffiliateCode(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^ref[_-]?/i, '');
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

module.exports = {
  PLANS,
  LEGACY_PLAN_IDS,
  PROMO_RECOMMENDED_CENTS,
  CENTS_PER_DAY,
  MIN_VIP_DAYS,
  MAX_VIP_DAYS,
  BOT_PRICE_CENTS,
  DAYPASS_CENTS,
  TIER_RANK,
  clampVipDays,
  vipPlanForDays,
  resolvePlan,
  normalizePlan,
  formatMpAmount,
  centsToReais,
  applyPromoPrice,
  amountsMatch,
  canDeliver,
  nextExpiryIso,
  isExpired,
  planKind,
  isBotPlan,
  vipPlans,
  botPlans,
  plansForTier,
  formatReaisLabel,
  monthlyPlanForTier,
  daypassPlan,
  tierButtonLabel,
  daypassButtonLabel,
  productTierOfPlan,
  productTierFromEntitlement,
  rankOfTier,
  hasTier,
  validityLabel,
  normalizeAffiliateCode,
  yearlyPlan,
  zipPlan,
  publicStorefrontPlans
};
