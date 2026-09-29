// utils/authSilence.js
// Negacoes de autorizacao NAO vao pro chat — so console (evita ban em grupo)

const AUTH_DENIAL_RE = new RegExp(
  [
    'permiss[aã]o\\s+negada',
    'sem\\s+permiss[aã]o',
    'n[aã]o\\s+autorizad[oa]',
    'apenas\\s+(o\\s+)?dono',
    'apenas\\s+donos',
    'apenas\\s+dono\\/vip',
    'apenas\\s+donos\\s+ou\\s+vips',
    'comando\\s+restrito',
    'restrito\\s+ao\\s+administrador',
    'voc[eê]\\s+n[aã]o\\s+tem\\s+permiss',
    'sem\\s+permiss[aã]o\\s+para',
    'authorized\\s*=\\s*false',
    'access\\s+denied',
    'not\\s+authorized',
    'permission\\s+denied'
  ].join('|'),
  'i'
);

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content !== 'object') return '';
  return String(
    content.text ||
      content.caption ||
      content.conversation ||
      content.extendedTextMessage?.text ||
      ''
  );
}

function isAuthDenialText(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return false;
  return AUTH_DENIAL_RE.test(t);
}

function isAuthDenialContent(content) {
  return isAuthDenialText(extractText(content));
}

function isGroupJid(jid, meta = {}) {
  if (meta.isGroup === true) return true;
  if (meta.isGroup === false) return false;
  const j = String(jid || '');
  return j.endsWith('@g.us') || j.endsWith('@newsletter');
}

/**
 * Em grupo: engole negacao (evita flood/ban).
 * Em PV/DM: NAO engole — usuario precisa saber por que nada aconteceu.
 * Retorna true se a mensagem deve ser engolida.
 */
function swallowAuthDenial(jid, content, meta = {}) {
  if (!isAuthDenialContent(content)) return false;
  const text = extractText(content).replace(/\s+/g, ' ').slice(0, 160);
  const where = meta.sessionId ? ` session=${meta.sessionId}` : '';
  if (!isGroupJid(jid, meta)) {
    console.log(`[AUTH_DM] jid=${jid || '?'}${where} | ${text}`);
    return false;
  }
  console.log(`[AUTH_SILENT] jid=${jid || '?'}${where} | ${text}`);
  return true;
}

module.exports = {
  AUTH_DENIAL_RE,
  isAuthDenialText,
  isAuthDenialContent,
  swallowAuthDenial,
  isGroupJid,
  extractText
};
