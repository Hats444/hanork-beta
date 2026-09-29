// utils/phoneTarget.js — parse telefone/JID internacional (E.164) + BR local
'use strict';

/** E.164: 8–15 digitos (DDI + nacional). WA usa so digitos no JID. */
const MIN_E164 = 8;
const MAX_E164 = 15;

/**
 * DDIs em que o "0" apos o codigo e tronco nacional (ex: +44 (0) 7911…).
 * Removido so quando o numero veio com "+" / "00".
 */
const TRUNK_ZERO_CC = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229',
  '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243',
  '244', '245', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260',
  '261', '262', '263', '264', '265', '266', '267', '268', '269',
  '351', '352', '353', '354', '355', '356', '357', '358', '359',
  '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '383', '385', '386', '387', '389',
  '420', '421', '423'
]);

/**
 * Limpa espacos/unicode/sinais e deixa so pedacos tipicos de telefone.
 * Aceita: + ( ) - . / espacos (inclusive NBSP), digitos.
 */
function scrubPhoneString(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/[‐‑‒–—―−﹣－]/g, '-')
    .replace(/[＋]/g, '+')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[^\d+().\-\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrai numero + quantidade opcional do texto livre apos o comando.
 * Aceita qualquer pais e formata com espaco/traco/ponto/parenteses:
 *   +1 (202) 555-1234, +351 912-345-678, +44 (0) 7911 123456,
 *   +55 51 8205-2118, (51) 98205-2118, 00 44 7911 123456, jid@s.whatsapp.net
 * Sem "+": 10/11 digitos → assume BR e prefixa 55 (UX local).
 *
 * @param {string} input
 * @param {{ defaultQty?: number, maxQty?: number, defaultCountry?: string }} [opts]
 * @returns {{ digits: string, jid: string, quantidade: number, hadExplicitQty: boolean, e164?: string, countryHint?: string }|null}
 */
function parsePhoneAndQty(input, opts = {}) {
  const defaultQty = Number.isFinite(opts.defaultQty) ? opts.defaultQty : 10;
  const maxQty = Number.isFinite(opts.maxQty) ? opts.maxQty : 5000;
  const defaultCountry = String(opts.defaultCountry || 'BR').toUpperCase();
  let s = scrubPhoneString(input);
  if (!s) return null;

  // Ja e JID (nao passa por scrub total — preservar @lid/@g.us/@s.whatsapp.net)
  const rawIn = String(input || '').trim();
  if (rawIn.includes('@')) {
    const parts = rawIn.split(/\s+/);
    const jid = parts[0].trim();
    let quantidade = defaultQty;
    let hadExplicitQty = false;
    if (parts[1] && /^\d{1,4}$/.test(parts[1])) {
      const q = parseInt(parts[1], 10);
      if (q >= 1 && q <= maxQty) {
        quantidade = q;
        hadExplicitQty = true;
      }
    }
    const digits = jid.split('@')[0].replace(/\D/g, '');
    if (!digits && !jid.includes('@lid')) return null;
    return {
      digits: digits || jid,
      jid,
      quantidade,
      hadExplicitQty,
      e164: digits ? `+${digits}` : undefined
    };
  }

  const hadPlus = /^\+/.test(s) || /\+\d/.test(String(input || ''));
  const hadIntlPrefix = hadPlus || /^00\d/.test(s.replace(/\s+/g, ''));

  // Normaliza separadores comuns de telefone
  const normalized = s
    .replace(/[()/\-.]/g, ' ')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length) return null;

  let quantidade = defaultQty;
  let hadExplicitQty = false;
  let phoneTokens = tokens;

  // Ultimo token = quantidade SO se for 1–3 digitos (nunca o bloco final BR de 4)
  // e o restante ja for um telefone completo. Senao `+55 41 9214-2464` virava 55419214.
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (/^\d{1,3}$/.test(last)) {
      const q = parseInt(last, 10);
      const without = tokens.slice(0, -1).join('').replace(/\D/g, '');
      const trial = normalizeInternationalDigits(without, {
        hadPlus: hadIntlPrefix,
        defaultCountry
      });
      if (q >= 1 && q <= maxQty && trial && looksCompletePhone(trial, hadIntlPrefix)) {
        quantidade = q;
        hadExplicitQty = true;
        phoneTokens = tokens.slice(0, -1);
      }
    }
  }

  let digits = phoneTokens.join('').replace(/\D/g, '');
  digits = normalizeInternationalDigits(digits, {
    hadPlus: hadIntlPrefix,
    defaultCountry
  });
  if (!digits) return null;

  return {
    digits,
    jid: `${digits}@s.whatsapp.net`,
    quantidade,
    hadExplicitQty,
    e164: `+${digits}`,
    countryHint: hadIntlPrefix ? 'intl' : defaultCountry
  };
}

/** Remove 0 de tronco apos DDI (UK/FR/DE/PT etc.) */
function stripTrunkZero(digits) {
  let d = String(digits || '');
  for (const ccLen of [3, 2]) {
    if (d.length <= ccLen + 1) continue;
    const cc = d.slice(0, ccLen);
    if (TRUNK_ZERO_CC.has(cc) && d[ccLen] === '0') {
      return cc + d.slice(ccLen + 1);
    }
  }
  return d;
}

/**
 * Normaliza digitos pra E.164 sem "+".
 * - Com "+" / "00": nunca forca 55; tira tronco 0; aceita 8–15
 * - Sem "+": 10/11 digitos → BR (+55); NANP 1… preservado; 12–15 → DDI ja incluso
 */
function normalizeInternationalDigits(rawDigits, opts = {}) {
  let digits = String(rawDigits || '').replace(/\D/g, '');
  if (!digits) return null;

  const hadPlus = !!opts.hadPlus;
  const defaultCountry = String(opts.defaultCountry || 'BR').toUpperCase();

  // 00DDI… → DDI…
  if (digits.startsWith('00') && digits.length >= 10) {
    digits = digits.replace(/^00+/, '');
  } else if (!hadPlus && digits.startsWith('0') && digits.length >= 11) {
    // 0DDD… BR / local
    digits = digits.replace(/^0+/, '');
  }

  if (hadPlus) {
    digits = stripTrunkZero(digits);
  }

  if (digits.length < MIN_E164 || digits.length > MAX_E164) return null;

  // Explicit international (+ / 00) — nao prefixar BR
  if (hadPlus) {
    return digits;
  }

  // Ja parece ter DDI (12–15) — manter
  if (digits.length >= 12) {
    return digits;
  }

  // Ambiguo sem "+":
  // - 10 digitos → BR local (DDD+numero)
  // - 11 digitos com padrao NANP (1 + area) → EUA/CA, nao prefixar 55
  // - 11 digitos demais → BR celular (DDD+9…)
  if (defaultCountry === 'BR' && !digits.startsWith('55')) {
    if (digits.length === 10) {
      digits = `55${digits}`;
    } else if (digits.length === 11) {
      const looksNanp = /^1[2-9]\d{2}[2-9]\d{6}$/.test(digits);
      if (!looksNanp) {
        digits = `55${digits}`;
      }
    }
    if (digits.length > MAX_E164) return null;
    return digits;
  }

  return digits;
}

function looksCompletePhone(digits, hadPlus) {
  const n = String(digits || '').replace(/\D/g, '');
  if (hadPlus) return n.length >= 10 && n.length <= 15;
  return n.length >= 10 && n.length <= 15;
}

/** Celular BR no Zap: 55 + DDD + 9 + 8. Completa 55 e o 9 se faltar. */
function preferBrWaNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('55') && d.length === 12) {
    return `55${d.slice(2, 4)}9${d.slice(4)}`;
  }
  if (!d.startsWith('55') && d.length === 10) {
    return `55${d.slice(0, 2)}9${d.slice(2)}`;
  }
  if (!d.startsWith('55') && d.length === 11 && d[2] === '9') {
    return `55${d}`;
  }
  return d;
}

function parseOwnerPhone(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  if (!raw.trim()) return null;
  if (raw.includes('@lid')) {
    const jid = raw.trim().split(/\s+/)[0];
    return { digits: '', jid, e164: '' };
  }
  const parsed = parsePhoneAndQty(raw, { defaultQty: 1, maxQty: 1 });
  const base = parsed?.digits || preferBrWaNumber(raw);
  const digits = preferBrWaNumber(base);
  if (digits.length < 10 || digits.length > 15) return null;
  return { digits, jid: `${digits}@s.whatsapp.net`, e164: `+${digits}` };
}

/**
 * Grupo: id@g.us ou so digitos
 */
function parseGroupTarget(input, opts = {}) {
  const defaultQty = Number.isFinite(opts.defaultQty) ? opts.defaultQty : 10;
  const maxQty = Number.isFinite(opts.maxQty) ? opts.maxQty : 5000;
  let s = String(input || '').trim();
  if (!s) return null;

  const parts = s.split(/\s+/);
  let quantidade = defaultQty;
  if (parts.length >= 2 && /^\d{1,4}$/.test(parts[parts.length - 1])) {
    const q = parseInt(parts[parts.length - 1], 10);
    const head = parts.slice(0, -1).join(' ');
    if (q >= 1 && q <= maxQty && head.replace(/\D/g, '').length >= 10) {
      quantidade = q;
      s = head;
    }
  }

  if (s.includes('@g.us')) {
    return { jid: s.trim(), digits: s.split('@')[0].replace(/\D/g, ''), quantidade };
  }

  const digits = s.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return { jid: `${digits}@g.us`, digits, quantidade };
}

/**
 * Resolve JID real via onWhatsApp (tenta digitos e jid).
 */
async function resolveWhatsAppJid(conn, parsed) {
  if (!parsed) return null;
  if (String(parsed.jid || '').includes('@lid') || String(parsed.jid || '').includes('@g.us')) {
    return parsed.jid;
  }
  const digits = parsed.digits;
  const fallback = parsed.jid || (digits ? `${digits}@s.whatsapp.net` : null);
  if (!conn || typeof conn.onWhatsApp !== 'function') return fallback;

  const candidates = [digits, `${digits}@s.whatsapp.net`, parsed.jid].filter(Boolean);
  for (const c of candidates) {
    try {
      const info = await conn.onWhatsApp(c);
      if (Array.isArray(info) && info.length) {
        const hit = info.find((x) => x && (x.exists !== false) && x.jid) || info[0];
        if (hit?.jid) return hit.jid;
        if (info.every((x) => x && x.exists === false)) return null;
      }
    } catch (_) { /* sessao instavel: tenta proximo / fallback */ }
  }
  return fallback;
}

/**
 * Separa telefone formatado no inicio + resto (sms/call/msg).
 * Ex: "+55 51 8205-2118 ola mundo" / "+1 (202) 555-1234 hello"
 */
function peelPhoneAndRest(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  // Aceita tokens de telefone (digitos/sinais); para no 1o token com letra
  let n = 0;
  for (let i = 0; i < Math.min(tokens.length, 10); i++) {
    const t = tokens[i].normalize('NFKC');
    if (!/^[\d+().\-\/\u00A0\u2010-\u2015\u2212]+$/u.test(t) && !/^[\d+().\-\/]+$/.test(t)) break;
    n = i + 1;
  }
  if (n < 1) return null;

  const head = tokens.slice(0, n).join(' ');
  const rest = tokens.slice(n).join(' ').trim();
  const parsed = parsePhoneAndQty(head, { defaultQty: 1, maxQty: 1 });
  if (!parsed?.digits) return null;
  return {
    digits: parsed.digits,
    e164: `+${parsed.digits}`,
    jid: parsed.jid,
    rest
  };
}

module.exports = {
  parsePhoneAndQty,
  parseGroupTarget,
  resolveWhatsAppJid,
  peelPhoneAndRest,
  normalizeInternationalDigits,
  scrubPhoneString,
  preferBrWaNumber,
  parseOwnerPhone,
  looksCompletePhone,
  MIN_E164,
  MAX_E164
};
