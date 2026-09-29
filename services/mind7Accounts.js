'use strict';
/**
 * Parser de contas Mind7 (email:senha, csv, json). Sem logar senha.
 */

function parseAccountsText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed);
    const arr = Array.isArray(j) ? j : [j];
    return arr.map((row) => {
      if (Array.isArray(row)) return { email: row[0], password: row[1] };
      return {
        email: row.email || row.user || row.login || row.usuario,
        password: row.password || row.senha || row.pass
      };
    }).filter((a) => a.email && a.password);
  }
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (i === 0 && /^(email|usuario|user|login)\s*[,;:]/i.test(line)) continue;
    let email = '';
    let password = '';
    const colon = line.indexOf(':');
    const comma = line.indexOf(',');
    const semi = line.indexOf(';');
    if (colon > 0 && (comma < 0 || colon < comma) && (semi < 0 || colon < semi)) {
      email = line.slice(0, colon).trim();
      password = line.slice(colon + 1);
    } else {
      const parts = line.split(/[,;]/);
      email = (parts[0] || '').trim();
      password = parts.slice(1).join(',').trim();
    }
    email = String(email || '').trim();
    password = String(password || '');
    if (email && password) out.push({ email, password });
  }
  return out;
}

module.exports = { parseAccountsText };
