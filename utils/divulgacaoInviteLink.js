'use strict';
/**
 * Link de convite vivo pra templates de divulgacao (ADM).
 * Placeholder {{groupInviteLink}} — resolve via Baileys no momento do envio.
 */
const logger = require('../logger');

const PLACEHOLDER = '{{groupInviteLink}}';
const PLACEHOLDER_RE = /\{\{\s*(groupInviteLink|groupInviteLink|inviteLink|grupoInviteLink|groupInviteLink)\s*\}\}/gi;
const CHAT_LINK_RE = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/gi;

/** Cache curto (segundos). Fonte de verdade = API live. */
const CACHE_MS = Math.max(
  2000,
  Math.min(30_000, Number(process.env.HANORK_DIV_INVITE_CACHE_MS) || 8000)
);

/** @type {Map<string, { url: string, code: string, at: number }>} */
const cacheByGroup = new Map();

function hasInvitePlaceholder(text) {
  const s = String(text || '');
  if (/\{\{\s*affiliateLink\s*\}\}/i.test(s) &&
      !/\{\{\s*(groupInviteLink|inviteLink|grupoInviteLink)\s*\}\}/i.test(s)) {
    return false;
  }
  return /\{\{\s*(groupInviteLink|inviteLink|grupoInviteLink)\s*\}\}/i.test(s)
    || /\{\{[^}]*(invite|convite)[^}]*\}\}/i.test(s);
}

function envInviteUrl(telegramUserId) {
  try {
    const { isAdmin } = require('./userManager');
    if (!isAdmin(String(telegramUserId || ''))) return '';
  } catch (_) {
    return '';
  }
  const u = String(process.env.HANORK_DIV_INVITE_URL || '').trim();
  return /^https?:\/\/chat\.whatsapp\.com\//i.test(u) ? u : '';
}

function needsInviteResolve(text) {
  const s = String(text || '');
  return hasInvitePlaceholder(s) || /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/i.test(s);
}

/** CTA: convite e qualquer URL so no botao. Tira do corpo. */
function stripInviteFromText(text) {
  let s = String(text || '');
  s = s.replace(PLACEHOLDER_RE, '');
  s = s.replace(CHAT_LINK_RE, '');
  s = s.replace(/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/gi, '');
  s = s.replace(/https?:\/\/[^\s)]+/gi, '');
  s = s.replace(/\bt\.me\/[^\s)]+/gi, '');
  s = s.replace(/grupo oficial:\s*$/gim, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function inviteUrlFromCode(code) {
  const c = String(code || '').trim().split(/[?#/]/)[0];
  if (!c || c.length < 8) return '';
  return `https://chat.whatsapp.com/${c}`;
}

function normalizeGroupJid(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.endsWith('@g.us')) return s;
  if (/^\d{10,}@g\.us$/i.test(s)) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 10 && digits.includes('120363')) return `${digits}@g.us`;
  if (/^\d{15,}$/.test(digits)) return `${digits}@g.us`;
  return '';
}

/**
 * Grupo fonte do convite (NUNCA o chat atual do blast).
 * Ordem: groupJid explicito → cfg.inviteGroupJid → HANORK_DIV_INVITE_GROUP.
 * `from` so entra se allowFrom=true (ex.: botao setgrupo no grupo).
 */
function resolveInviteGroupJid({ telegramUserId, groupJid, from, allowFrom = false } = {}) {
  const explicit = normalizeGroupJid(groupJid);
  if (explicit) return explicit;
  try {
    const { getConfig } = require('./divulgacao');
    const cfg = getConfig(telegramUserId);
    const fromCfg = normalizeGroupJid(cfg?.inviteGroupJid);
    if (fromCfg) return fromCfg;
  } catch (_) { /* ignore */ }
  const fromEnv = normalizeGroupJid(process.env.HANORK_DIV_INVITE_GROUP || '');
  if (fromEnv) {
    try {
      const { isAdmin } = require('./userManager');
      if (isAdmin(String(telegramUserId || ''))) return fromEnv;
    } catch (_) { /* cliente nao herda grupo env do dono */ }
  }
  if (allowFrom && from && String(from).endsWith('@g.us')) return String(from);
  return '';
}

function invalidateInviteCache(groupJid) {
  const jid = normalizeGroupJid(groupJid) || String(groupJid || '');
  if (!jid) {
    cacheByGroup.clear();
    return;
  }
  cacheByGroup.delete(jid);
}

function invalidateInviteCacheFromUpdates(updates) {
  for (const u of updates || []) {
    if (!u || !u.id) continue;
    if (u.revoke || u.inviteCode || u.invite || u.announce != null) {
      invalidateInviteCache(u.id);
    }
  }
}

/**
 * Busca invite code live (Baileys). Cache so por poucos segundos.
 * @returns {Promise<{ ok: boolean, url?: string, code?: string, reason?: string, cached?: boolean }>}
 */
async function fetchLiveInviteLink(conn, groupJid, opts = {}) {
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return { ok: false, reason: 'no-group' };
  if (!conn || typeof conn.groupInviteCode !== 'function') {
    return { ok: false, reason: 'no-conn' };
  }

  const hit = cacheByGroup.get(jid);
  const now = Date.now();
  if (hit && hit.url && now - hit.at < CACHE_MS) {
    return { ok: true, url: hit.url, code: hit.code, cached: true };
  }

  try {
    const code = await conn.groupInviteCode(jid);
    const url = inviteUrlFromCode(code);
    if (!url) return { ok: false, reason: 'empty-code' };
    cacheByGroup.set(jid, { url, code: String(code), at: now });
    return { ok: true, url, code: String(code), cached: false };
  } catch (e) {
    const msg = String(e?.message || e || '').slice(0, 120);
    logger.logAviso(`[DIV-INVITE] groupInviteCode fail jid=${jid.slice(0, 24)} ${msg}`);
    const stale = cacheByGroup.get(jid);
    if (stale && stale.url) {
      logger.logAviso('[DIV-INVITE] usando convite em cache (API forbidden/erro)');
      return { ok: true, url: stale.url, code: stale.code, cached: true, stale: true };
    }
    try {
      const meta = await conn.groupMetadata(jid);
      const code = meta?.inviteCode || meta?.descId;
      const url = inviteUrlFromCode(code);
      if (url) {
        cacheByGroup.set(jid, { url, code: String(code), at: Date.now() });
        return { ok: true, url, code: String(code), cached: false };
      }
    } catch (_) { /* meta opcional */ }
    const env = envInviteUrl(opts.telegramUserId);
    if (env) {
      logger.logAviso('[DIV-INVITE] usando HANORK_DIV_INVITE_URL');
      return { ok: true, url: env, cached: false, fromEnv: true };
    }
    return { ok: false, reason: 'api', detail: msg };
  }
}

/**
 * Substitui placeholder (e limpa chat.whatsapp.com literal se vier do passado).
 * Nao envia texto quebrado: se precisa de link e falha, ok=false.
 */
async function renderWithLiveInvite(conn, template, opts = {}) {
  const raw = String(template || '');
  if (!raw.trim()) return { ok: false, reason: 'empty-template' };

  const needs = hasInvitePlaceholder(raw);
  if (!needs) {
    return { ok: true, text: raw, skipped: true };
  }

  const jid = resolveInviteGroupJid(opts);
  if (!jid) {
    return {
      ok: false,
      reason: 'no-group',
      message:
        'Grupo do convite nao configurado.\n' +
        'No grupo oficial: .divulgar setgrupo\n' +
        'Ou defina HANORK_DIV_INVITE_GROUP / inviteGroupJid.'
    };
  }

  const live = await fetchLiveInviteLink(conn, jid, opts);
  let url = live.ok ? live.url : '';
  if (!url && opts.lastInviteUrl && /^https?:\/\/chat\.whatsapp\.com\//i.test(String(opts.lastInviteUrl))) {
    url = String(opts.lastInviteUrl).trim();
    logger.logAviso('[DIV-INVITE] usando inviteLinkLast salvo');
  }
  if (!url && opts.telegramUserId) {
    try {
      const { getConfig } = require('./divulgacao');
      const last = String(getConfig(opts.telegramUserId)?.inviteLinkLast || '').trim();
      if (/^https?:\/\/chat\.whatsapp\.com\//i.test(last)) {
        url = last;
        logger.logAviso('[DIV-INVITE] usando inviteLinkLast do config');
      }
    } catch (_) { /* ignore */ }
  }
  if (!url) url = envInviteUrl(opts.telegramUserId);
  if (!url) {
    logger.logAviso(`[DIV-INVITE] segue sem link (jid salvo, API=${live.reason || 'fail'})`);
    const text = raw.replace(PLACEHOLDER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    return { ok: true, text, skippedLink: true, groupJid: jid };
  }
  if (live.ok && live.url && opts.telegramUserId && !live.stale) {
    try {
      const { updateConfig } = require('./divulgacao');
      updateConfig(opts.telegramUserId, { inviteLinkLast: live.url });
    } catch (_) { /* ignore */ }
  }

  const text = raw.replace(PLACEHOLDER_RE, url);
  if (hasInvitePlaceholder(text) || /\{\{\s*groupInviteLink\s*\}\}/i.test(text)) {
    return { ok: false, reason: 'unresolved', message: 'Placeholder ficou sem substituicao — nao enviei.' };
  }
  return { ok: true, text, url, groupJid: jid, cached: !!live.cached, stale: !!live.stale };
}

/** CTA pra postar em grupo — mesmo estilo dos textos de divulgacao, link vivo no fim. */
function templateCtaInvite() {
  const preco = String(process.env.HANORK_DIV_PRICE || 'R$250').trim();
  const cmdRaw = String(process.env.HANORK_DIV_CMD || '.comprar').trim();
  const cmd = cmdRaw.startsWith('.') ? cmdRaw : `.${cmdRaw}`;
  return [
    'Hanork — automação de vendas no WhatsApp e no Telegram, tudo num bot só.',
    '',
    'Você configura uma vez e ele segue trabalhando sozinho:',
    '',
    '• Divulgação automática — posta nos grupos sem você lembrar',
    '• Gerenciador de grupo — pedido de entrada entra, aprova e organiza',
    '• Proteção em tempo real — anti-invasão, anti-admin fantasma e bloqueio de quem bagunça',
    '• IA unificada — fala normal com ele, sem decorar comando',
    '• Downloads — YouTube, TikTok, Instagram, Spotify e geração de imagem',
    '• Consultas rápidas — CPF, telefone, nome, CEP, CNPJ e IP, na hora',
    '• Figurinhas — cria e repõe sozinho',
    '• Pagamento automático — Pix ou cartão, acesso liberado na hora',
    '• Menu em até 2 cliques — sem lista gigante confusa',
    '',
    'Sem ficar de atendente. Sem enrolação.',
    '',
    `Manda ${cmd} e segue o fluxo.`,
    '',
    `> Bot completo: ${preco}`,
    '',
    'Grupo oficial:',
    PLACEHOLDER
  ].join('\n');
}

/**
 * Status default — tipografia exata do prompt; canal/PV fixos; convite dinamico.
 */
function templateStatusInvite() {
  return [
    '• 𝚋𝚎𝚖-𝚟𝚒𝚗𝚍𝚘𝚜 𝚊𝚘 𝚎𝚜𝚙𝚊𝚌̧𝚘 𝚘𝚏𝚒𝚌𝚒𝚊𝚕 𝚍𝚘 𝚑𝚊𝚗𝚘𝚛𝚔.',
    '• 𝚌𝚘𝚗𝚝𝚎𝚞́𝚍𝚘𝚜 𝚟𝚊𝚛𝚒𝚊𝚍𝚘𝚜',
    '• 𝚏𝚒𝚐𝚞𝚛𝚒𝚗𝚑𝚊𝚜',
    '• 𝚒𝚗𝚏𝚘𝚛𝚖𝚊𝚌̧𝚘̃𝚎𝚜',
    '• 𝚝𝚎𝚌𝚗𝚘𝚕𝚘𝚐𝚒𝚊',
    '• 𝚛𝚎𝚜𝚎𝚗𝚑𝚊𝚜',
    '• 𝚜𝚘𝚛𝚝𝚎𝚒𝚘𝚜',
    '• 𝚌𝚑𝚊𝚝 𝚍𝚘 𝚌𝚊𝚗𝚊𝚕:',
    PLACEHOLDER,
    '• 𝚌𝚊𝚗𝚊𝚕 𝚘𝚏𝚒𝚌𝚒𝚊𝚕',
    (() => {
      try {
        return require('./canal').formatCanalPublicText().replace(/\n/g, ' ');
      } catch (_) {
        return String(process.env.WHATSAPP_CANAL_ID || '').trim();
      }
    })(),
    '• 𝚙𝚊𝚛𝚌𝚎𝚛𝚒𝚊𝚜 𝚎 𝚍𝚒𝚟𝚞𝚕𝚐𝚊𝚌̧𝚊̃𝚘, 𝚌𝚑𝚊𝚖𝚎 𝚗𝚘 𝙿𝚅:',
    (String(process.env.HANORK_CONTACT_WA || '').replace(/\D/g, '')
      ? 'wa.me/' + String(process.env.HANORK_CONTACT_WA).replace(/\D/g, '')
      : 'wa.me/'),
    '━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

function failMessage(reason, detail) {
  if (reason === 'no-group') {
    return (
      detail ||
      'Grupo do convite nao configurado. Use .divulgar setgrupo no grupo oficial.'
    );
  }
  return detail || 'Nao consegui resolver o link de convite agora. Tente de novo.';
}

module.exports = {
  PLACEHOLDER,
  PLACEHOLDER_RE,
  CACHE_MS,
  hasInvitePlaceholder,
  needsInviteResolve,
  inviteUrlFromCode,
  normalizeGroupJid,
  resolveInviteGroupJid,
  invalidateInviteCache,
  invalidateInviteCacheFromUpdates,
  fetchLiveInviteLink,
  renderWithLiveInvite,
  stripInviteFromText,
  templateCtaInvite,
  templateStatusInvite,
  failMessage
};
