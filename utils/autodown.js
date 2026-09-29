// utils/autodown.js — auto-baixa links conhecidos quando flag autodown esta ON no grupo
'use strict';

const logger = require('../logger');
const { getGroupSecurity } = require('./moderation');

function detectDownloadIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const urlMatch = t.match(/https?:\/\/[^\s]+/i);
  const url = urlMatch ? urlMatch[0].replace(/[)\].,;]+$/, '') : '';
  if (!url) return null;

  if (/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) return { command: 'tiktok', args: url };
  if (/instagram\.com/i.test(url)) return { command: 'instagram', args: url };
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return { command: 'facebook', args: url };
  if (/youtube\.com|youtu\.be/i.test(url)) return { command: 'playvideo', args: url };
  if (/kwai/i.test(url)) return { command: 'kwai', args: url };
  if (/threads\.(net|com)/i.test(url)) return { command: 'threads', args: url };
  if (/mediafire\.com/i.test(url)) return { command: 'mediafire', args: url };
  if (/(twitter\.com|x\.com)\//i.test(url)) return { command: 'twitter', args: url };
  if (/(pinterest\.|pin\.it)/i.test(url)) return { command: 'pinterest', args: url };
  if (/spotify\.com/i.test(url)) return { command: 'spotify', args: url };
  if (/soundcloud\.com/i.test(url)) return { command: 'soundcloud', args: url };
  if (/capcut/i.test(url)) return { command: 'capcut', args: url };
  return null;
}

/**
 * Se autodown ON e mensagem tem link conhecido, executa handler de download.
 * Retorna true se disparou (mensagem tratada).
 */
async function tryAutodown(conn, ctx, telegramUserId) {
  if (!ctx?.isGroup || ctx.command || ctx.fromMe) return false;
  const flags = getGroupSecurity(ctx.from, telegramUserId);
  if (!flags.autodown) return false;

  const text = ctx.body || ctx.fullText || ctx.text || '';
  const hit = detectDownloadIntent(text);
  if (!hit) return false;

  const { getCommand } = require('../commands');
  const cmd = getCommand(hit.command);
  if (!cmd || typeof cmd.execute !== 'function') return false;

  logger.logInfo(`[AUTODOWN] ${hit.command} grupo=${ctx.from}`);
  const { displayPrefix } = require('./configManager');
  const fakeCtx = {
    ...ctx,
    command: hit.command,
    text: hit.args,
    args: hit.args.split(/\s+/),
    body: hit.args,
    prefix: displayPrefix(ctx.telegramUserId, { prefix: ctx.prefix })
  };
  try {
    await cmd.execute(conn, fakeCtx);
    return true;
  } catch (e) {
    logger.logErro(`[AUTODOWN] ${e.message}`);
    return false;
  }
}

module.exports = { detectDownloadIntent, tryAutodown };
