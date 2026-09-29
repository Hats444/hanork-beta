'use strict';
/**
 * Skeleton de fallback da DIV de admin (tabela SQL vazia na 1a execucao).
 * Nao e fonte de preco nem de vantagem — isso entra so no assemble
 * (store.listPlans / CAPABILITIES / opsMetrics).
 */
const { isAdmin } = require('./userManager');
const tpl = require('./adminDivTemplate');

const ADMIN_MARKETING_VERSION = 15;
const AFFILIATE_SENTINEL = 'ref_HANORKAFF';

function storeUrl() {
  try {
    return require('./productOffer').telegramStartLink('comprar');
  } catch (_) {
    return 'https://t.me/hanork_bot?start=comprar';
  }
}

function buyUrl() {
  return storeUrl();
}

function telegramRefUrl(code) {
  try {
    return require('./productOffer').telegramRefLink(code);
  } catch (_) {
    return storeUrl();
  }
}

function applyAdminMarketingDefaults(telegramUserId, cfg) {
  return tpl.applyAdminOverlay(telegramUserId, cfg);
}

function markAdminMarketingCustom(updates) {
  return updates;
}

async function hydrateAdminAffiliate(config, telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!config || !uid || !isAdmin(uid)) return config;
  return tpl.hydrateRuntime(config, uid);
}

function skeletonSlotsBundle() {
  return tpl.skeletonSlots();
}

module.exports = {
  ADMIN_MARKETING_VERSION,
  AFFILIATE_SENTINEL,
  applyAdminMarketingDefaults,
  markAdminMarketingCustom,
  hydrateAdminAffiliate,
  skeletonSlotsBundle,
  storeUrl,
  buyUrl,
  telegramRefUrl,
  invitePlaceholder: () => {
    try {
      return require('./divulgacaoInviteLink').PLACEHOLDER;
    } catch (_) {
      return '{{groupInviteLink}}';
    }
  }
};
