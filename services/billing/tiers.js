'use strict';
/**
 * Mapa comando → tier minimo (schema do Universal Router + cats de produto).
 * Gate de billing vive no commandGate; isto so classifica.
 */

const { rankOfTier, hasTier } = require('./logic');

const FREE_CMDS = new Set([
  'menu', 'ping', 'stats', 'comandos', 'tutorial', 'start', 'novidades', 'changelog', 'oquemudou',
  'status', 'help', 'ajuda', 'sobre', 'dono', 'comprar', 'planos', 'preco', 'ownerinfo',
  'minhaconta', 'meuplano', 'meupagamento', 'suporte', 'vincular', 'vincularconta',
  'baixarbot', 'meubot', 'afiliado', 'indicar', 'conectar', 'connect', 'mysessions',
  'meujid', 'cancelar'
]);

const ENTERPRISE_CMDS = new Set([
  'autodivbot', 'autodivulgabot'
]);

function looksDiv(name) {
  const n = String(name || '').toLowerCase();
  return (
    n === 'divulgar' ||
    n === 'dk' ||
    n === 'entrardk' ||
    n === 'msgdk' ||
    n === 'fotodk' ||
    n === 'videodk' ||
    n === 'apagardk' ||
    n === 'qtddk' ||
    n === 'dkpay' ||
    n === 'msgdkpay' ||
    n === 'dkmidia' ||
    n === 'rmfotodk' ||
    n === 'listfotodk' ||
    n === 'menu_dk' ||
    n === 'dkmenu' ||
    n === 'menudk' ||
    n.startsWith('div') ||
    n.startsWith('msgdivul') ||
    n.startsWith('fotodivul') ||
    n.startsWith('videodivul') ||
    n.startsWith('gifdivul') ||
    n.startsWith('audiodivul') ||
    n.startsWith('documentodivul') ||
    n.startsWith('apagardivul') ||
    n.startsWith('previewdivul') ||
    n === 'addgrupo' ||
    n === 'removergrupo' ||
    n === 'divgrupos'
  );
}

function looksProtection(name) {
  const n = String(name || '').toLowerCase();
  try {
    const { GROUP_SECURITY_CMDS } = require('../../utils/commandGate');
    if (GROUP_SECURITY_CMDS.has(n)) return true;
  } catch (_) { /* ignore */ }
  return /^(anti|modenable|moddisable|modstatus|modlist|gpseguranca|protecoes|presetprotecao|presetseg|bangp|soadm|onlyadm)/.test(n);
}

function looksIntent(name) {
  const n = String(name || '').toLowerCase();
  return n === 'intentrouter' || n === 'hanork' || n === 'grok' || n === 'grokia' || n === 'deepsearch';
}

function minTierFor(commandName) {
  const n = String(commandName || '').toLowerCase().replace(/^[^a-z0-9_]+/i, '');
  if (!n) return 'free';
  if (FREE_CMDS.has(n) || n.startsWith('bill_')) return 'free';
  if (ENTERPRISE_CMDS.has(n)) return 'enterprise';
  if (looksProtection(n) || looksIntent(n)) return 'pro';
  if (looksDiv(n)) return 'pro';
  if (/^(statuspost|groupstatus|channelstatus|closefriends|paypost|pagamentopost|postpay)$/.test(n)) {
    return 'pro';
  }
  return 'starter';
}

function sessionProductTier(ctx) {
  try {
    const { isAdmin } = require('../../utils/userManager');
    const tid = String((ctx && ctx.telegramUserId) || '');
    if (tid && isAdmin(tid)) return 'enterprise';
  } catch (_) { /* ignore */ }
  try {
    const vipIndex = require('./vipIndex');
    const tid = String((ctx && ctx.telegramUserId) || '');
    let best = tid ? vipIndex.tierOf('telegram', tid) : 'free';
    const ids = [];
    try {
      const { collectAuthIdentities, resolveCanonicalIdentity } = require('../../utils/authorization');
      ids.push(...(collectAuthIdentities(ctx) || []));
      ids.push(...(resolveCanonicalIdentity(ctx?.sender, ctx) || []));
    } catch (_) { /* ignore */ }
    if (ctx?.sender) ids.push(ctx.sender);
    const wa = vipIndex.tierOfAny('whatsapp', ids);
    if (rankOfTier(wa) > rankOfTier(best)) best = wa;
    return best;
  } catch (_) {
    return 'free';
  }
}

function sessionHasDaypass(ctx) {
  try {
    const vipIndex = require('./vipIndex');
    const tid = String((ctx && ctx.telegramUserId) || '');
    if (tid && vipIndex.isDaypass('telegram', tid)) return true;
    const ids = [];
    try {
      const { collectAuthIdentities, resolveCanonicalIdentity } = require('../../utils/authorization');
      ids.push(...(collectAuthIdentities(ctx) || []));
      ids.push(...(resolveCanonicalIdentity(ctx?.sender, ctx) || []));
    } catch (_) { /* ignore */ }
    if (ctx?.sender) ids.push(ctx.sender);
    return vipIndex.isDaypassAny('whatsapp', ids);
  } catch (_) {
    return false;
  }
}

function upgradeTarget(need) {
  const n = String(need || 'starter').toLowerCase();
  if (n === 'enterprise') return 'enterprise';
  if (n === 'pro') return 'pro';
  return 'starter';
}

module.exports = {
  FREE_CMDS,
  minTierFor,
  sessionProductTier,
  sessionHasDaypass,
  looksProtection,
  looksDiv,
  upgradeTarget,
  hasTier,
  rankOfTier
};
