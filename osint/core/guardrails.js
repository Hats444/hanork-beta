'use strict';
/**
 * Bloqueios por codigo (nao so documentacao).
 * Sem bypass, area logada, brute, exploit, leak, credencial, PII BR.
 */

const BLOCKED_PATH = /(^|\/)(login|signin|account|admin|dashboard|wp-login)(\/|$)/i;
const BLOCKED_QUERY = /\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]/i;
const LEAK_HINT = /\b(combo\s*list|leak(ed)?\s*db|dump\s*sql|haveibeenpwned|dehashed|snusbase|leakcheck)\b/i;
const ACTIVE_HINT = /\b(bypass|brute\s*force|exploit|sqlmap|hydrascan|ip\s*real\s*atr[aá]s|cloudflare\s*origin|gerar\s*senha|wordlist\s*alvo|entrar no grupo privado)\b/i;
const PRIVATE_INVITE = /\b(t\.me\/\+|t\.me\/joinchat\/|discord\.gg\/[A-Za-z0-9])/i;
const CRED_URL = /^https?:\/\/[^/\s]+:[^/\s]+@/i;

function cpfChecksum(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  let r = (s * 10) % 11;
  if (r === 10) r = 0;
  if (r !== Number(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * (11 - i);
  r = (s * 10) % 11;
  if (r === 10) r = 0;
  return r === Number(d[10]);
}

function looksLikeBrCpf(text) {
  const s = String(text || '');
  const punct = s.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g) || [];
  for (const p of punct) {
    if (cpfChecksum(p)) return true;
  }
  const raw = s.match(/\b\d{11}\b/g) || [];
  for (const p of raw) {
    if (cpfChecksum(p)) return true;
  }
  return false;
}

function stripForbiddenPii(text) {
  let s = String(text || '');
  s = s.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, (m) => (cpfChecksum(m) ? '[redacted-br-id]' : m));
  s = s.replace(/\b(?:cpf|rg|titulo\s*de\s*eleitor|pis|nis)\s*[:#]?\s*[\dXx.\-\/]+/gi, '[redacted-br-id]');
  s = s.replace(/\b(?:\+?55\s*)?\(?\d{2}\)?\s*9\d{4}[-\s]?\d{4}\b/g, '[redacted-phone]');
  return s;
}

function isRawPasteUrl(url) {
  const u = String(url || '');
  if (/gist\.githubusercontent\.com/i.test(u)) return true;
  if (/pastebin\.com\/raw\//i.test(u)) return true;
  if (/paste\.ee\/r\//i.test(u)) return true;
  if (/rentry\.(?:co|org)\/[^/\s]+\/raw\b/i.test(u)) return true;
  if (/justpaste\.it\/[^/\s]+\/raw\b/i.test(u)) return true;
  if (/dpaste\.org\/[^/\s]+\/raw\b/i.test(u)) return true;
  if (/controlc\.com\/[^/\s]+\/raw\b/i.test(u)) return true;
  return false;
}

function assertPublicUrl(url) {
  const u = String(url || '');
  if (!u) throw new Error('url vazia');
  if (CRED_URL.test(u)) throw new Error('url com credencial bloqueada');
  let parsed;
  try {
    parsed = new URL(u);
  } catch (_) {
    throw new Error('url invalida');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('so http/https publico');
  }
  if (isRawPasteUrl(u)) {
    throw new Error('paste raw/dump bloqueado (so indice publico)');
  }
  const host = String(parsed.hostname || '').toLowerCase();
  if (LEAK_HINT.test(host) || /(haveibeenpwned|dehashed|snusbase|leakcheck)\./i.test(host)) {
    throw new Error('consulta a base vazada bloqueada');
  }
  if (/(^|\.)onion$/.test(host) || host.endsWith('.onion')) {
    throw new Error('Alvo .onion nao e coletado neste bot (so http/https publico).');
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIpv4(host)) {
    throw new Error('IP privado/reservado nao e alvo publico');
  }
  if (BLOCKED_PATH.test(parsed.pathname)) throw new Error('path logado/admin bloqueado');
  if (BLOCKED_QUERY.test(parsed.search + parsed.hash)) throw new Error('query com segredo bloqueada');
  return parsed.toString();
}

function isPrivateIpv4(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  return false;
}

function assertPassiveTarget(raw) {
  const t = String(raw || '').trim();
  if (!t) throw new Error('alvo vazio');
  if (LEAK_HINT.test(t)) throw new Error('consulta a base vazada bloqueada');
  if (PRIVATE_INVITE.test(t)) throw new Error('convite privado bloqueado (so perfil/canal publico)');
  if (CRED_URL.test(t) || ACTIVE_HINT.test(t) || /bypass|brute\s*force|exploit|sqlmap|hydrascan/i.test(t)) {
    throw new Error('coleta ativa/exploit bloqueada');
  }
  if (looksLikeBrCpf(t)) throw new Error('PII brasileira bloqueada');
  return t;
}

function sanitizeHostname(raw) {
  let t = assertPassiveTarget(raw);
  t = t.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').trim().toLowerCase();
  t = t.replace(/\.$/, '');
  if (!t || t.length > 253) throw new Error('alvo invalido');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
    if (isPrivateIpv4(t)) throw new Error('IP privado/reservado nao e alvo publico');
    return t;
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(t) && !/^[a-z0-9-]+$/i.test(t)) {
    throw new Error('alvo nao e dominio/IP publico');
  }
  if (t.includes('..')) throw new Error('alvo invalido');
  return t;
}

function isOnionHost(host) {
  return /(^|\.)onion$/i.test(String(host || '')) || /\.onion\b/i.test(String(host || ''));
}

module.exports = {
  cpfChecksum,
  looksLikeBrCpf,
  stripForbiddenPii,
  assertPublicUrl,
  assertPassiveTarget,
  sanitizeHostname,
  isOnionHost,
  isPrivateIpv4,
  isRawPasteUrl
};
