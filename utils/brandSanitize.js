// utils/brandSanitize.js — remove marca de terceiros das respostas (Lucas / Zero Two → Hanork)
'use strict';

const BRAND_REPLACEMENTS = [
  [/@lucas_mod_domina/gi, '@hanork'],
  [/lucas_mod_domina/gi, 'hanork'],
  [/\blucas\s*mod(?:\s*domina)?\b/gi, 'hanork'],
  [/\b@lucas\b/gi, '@hanork'],
  [/\bLucas\s*Mod\s*Domina\b/gi, 'Hanork'],
  // NAO substituir zero-two-apis.store em URLs (quebra download de midia)
  [/\bZero\s*Two\s*API\b/gi, 'Hanork API'],
  [/\bZero\s*Two\s*Rest[\s-]*API\b/gi, 'Hanork API'],
  [/\bAPI\s*Zero\s*Two\b/gi, 'Hanork API'],
  [/\bZeroTwo\b/gi, 'Hanork'],
  [/\bZero\s*Two\b/gi, 'Hanork'],
  [/\bzero\s*two\b/gi, 'hanork'],
  [/\bOtaku\.mp4\b/gi, 'hanork'],
  [/@Otaku\.mp4\b/gi, '@hanork'],
  [/\bOtakump4\b/gi, 'hanork'],
  [/powered\s*by\s*zero\s*two/gi, 'powered by hanork'],
  [/criado\s*por\s*lucas[^.\n]*/gi, 'criado por hanork'],
  [/\blucas_mod(?:_domina)?\b/gi, 'hanork'],
  [/\bzerotwoapis?\b/gi, 'hanork'],
  [/\bapi\s+do\s+lucas\b/gi, 'api hanork']
];

function hanorkChannelLink() {
  try {
    const canal = require('./canal');
    return canal.getCanalLink() || canal.formatCanalPublicText();
  } catch (_) {
    return '120363412971004933@newsletter';
  }
}

function isOwnTelegramUrl(url) {
  const own = String(process.env.TELEGRAM_CHANNEL_LINK || '').trim().toLowerCase();
  if (!own) return false;
  const a = String(url || '').trim().toLowerCase().replace(/\/+$/, '');
  const b = own.replace(/\/+$/, '');
  return a === b || a.includes(b) || b.includes(a);
}

function collapsePromoResidue(text) {
  return String(text || '')
    .replace(/[ \t]+$/gm, '')
    .replace(/^(?:canal|grupo|link|telegram|discord|instagram|youtube)\s*[:\-–]\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Tira propaganda de terceiros (canal/grupo/telegram do dono da API).
 * Se aparecer canal WhatsApp, troca pelo da Hanork.
 * NAO mexe em zero-two-apis.store (URL de midia).
 */
function stripThirdPartyPromo(value) {
  if (value == null || typeof value !== 'string') return value;
  const mine = hanorkChannelLink();
  let out = value;

  out = out.replace(
    /(?:https?:\/\/)?(?:www\.)?(?:wa\.me\/channel\/|whatsapp\.com\/channel\/)([A-Za-z0-9_-]+)/gi,
    () => mine
  );
  out = out.replace(
    /(?:https?:\/\/)?(?:www\.)?chat\.whatsapp\.com\/[A-Za-z0-9_-]+/gi,
    ''
  );
  out = out.replace(
    /(?:https?:\/\/)?(?:t(?:elegram)?\.me|telegram\.dog)\/[^\s)\]>]+/gi,
    (u) => (isOwnTelegramUrl(u) ? u : '')
  );
  out = out.replace(
    /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|linktr\.ee)\/[^\s)\]>]+/gi,
    ''
  );
  out = out.replace(
    /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\/(?:@)?(?:lucas[_-]?mod|otaku(?:\.mp4)?|zerotwo)[^\s)\]>]*/gi,
    ''
  );
  out = out.replace(
    /(?:entre|entra|inscreva-se|inscreva se|segue|siga|acessa|acess(?:e|a))\s+(?:no|o|no nosso)?\s*(?:meu\s+)?(?:canal|grupo)(?:\s+(?:oficial|do\s+(?:criador|dono|dev|lucas)))?[^\n]{0,60}/gi,
    ''
  );
  out = out.replace(
    /(?:canal|grupo)\s+(?:oficial\s+)?(?:da\s+api|do\s+criador|do\s+dono|do\s+lucas)[^\n]{0,80}/gi,
    ''
  );
  return collapsePromoResidue(out);
}

function sanitizeBrand(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [re, rep] of BRAND_REPLACEMENTS) {
    out = out.replace(re, rep);
  }
  return out;
}

/** Marca + promo de terceiros. Usar na saida da IA (nao em URL de download). */
function sanitizeAiOutput(value) {
  if (value == null || typeof value !== 'string') return value;
  return stripThirdPartyPromo(sanitizeBrand(value));
}

/** Remove campos criador / credit e sanitiza strings em profundidade */
function scrubApiData(data, depth = 0) {
  if (depth > 8) return data;
  if (data == null) return data;
  if (typeof data === 'string') return sanitizeBrand(data);
  if (Array.isArray(data)) return data.map((x) => scrubApiData(x, depth + 1));
  if (typeof data === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(data)) {
      if (/^(criador|creator|credit|credits|powered[_-]?by|by|author|autor|developer|desenvolvedor)$/i.test(key)) continue;
      out[key] = scrubApiData(val, depth + 1);
    }
    return out;
  }
  return data;
}

function looksLikeHtml(text) {
  const s = String(text || '').trim().slice(0, 200).toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.includes('<head');
}

module.exports = {
  sanitizeBrand,
  sanitizeAiOutput,
  stripThirdPartyPromo,
  scrubApiData,
  looksLikeHtml,
  BRAND_REPLACEMENTS
};
