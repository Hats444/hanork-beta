// core/router/intent/audit.js
const logger = require('../../../logger');
const { maskSensitive } = require('./confidence');

/**
 * Auditoria obrigatoria para comandos sensiveis via Intent Router
 */
function auditSensitiveIntent({
  command,
  confidence,
  userId,
  sessionId,
  platform,
  text,
  telegramUserId
}) {
  const uid = maskSensitive(String(userId || telegramUserId || 'unknown'));
  const sid = String(sessionId || 'unknown').slice(0, 24);
  const preview = String(text || '')
    .replace(/\d{8,}/g, (m) => maskSensitive(m))
    .slice(0, 80);

  logger.logAviso(
    `[IntentRouter] AUDITORIA: comando sensivel executado via texto livre | cmd=${command} ` +
      `user=${uid} session=${sid} platform=${platform || '?'} confidence=${confidence} text="${preview}"`
  );
}

module.exports = {
  auditSensitiveIntent
};
