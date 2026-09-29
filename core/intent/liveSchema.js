'use strict';
/**
 * Schema vivo de function-calling a partir do catalog + registry.
 * Regenera em memoria; nao depende do JSON estatico stale.
 */
let _schema = null;
let _builtAt = 0;

function buildLiveCommandSchema(force = false) {
  const now = Date.now();
  if (!force && _schema && now - _builtAt < 60_000) return _schema;
  const { buildCatalog } = require('../router/intent/catalog');
  let getCommandMinLevel = () => 'user';
  let isDestructive = () => false;
  try {
    ({ getCommandMinLevel } = require('../router/registeredCommands'));
  } catch (_) { /* ignore */ }
  try {
    ({ isDestructiveConfirmCommand: isDestructive } = require('../router/intent/safety'));
  } catch (_) { /* ignore */ }

  const catalog = buildCatalog(force);
  const commands = catalog.map((entry) => {
    const permission = entry.permission || getCommandMinLevel(entry.command);
    return {
      command: entry.command,
      description: entry.description || entry.command,
      usage: entry.usage || entry.command,
      category: entry.category || 'extra',
      permission,
      sensitive: !!entry.sensitive,
      destructive: !!entry.destructive || !!isDestructive(entry.command),
      platforms: entry.platforms || ['whatsapp', 'telegram'],
      examples: Array.isArray(entry.phrases) ? entry.phrases.slice(0, 8) : []
    };
  });
  _schema = {
    generatedAt: new Date().toISOString(),
    count: commands.length,
    commands
  };
  _builtAt = now;
  return _schema;
}

function invalidateLiveCommandSchema() {
  _schema = null;
  _builtAt = 0;
}

module.exports = {
  buildLiveCommandSchema,
  invalidateLiveCommandSchema
};
