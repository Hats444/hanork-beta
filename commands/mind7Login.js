'use strict';
const { formatReportBlock } = require('../utils/typography');
const { verifyMind7Login, maskSecret } = require('../services/mind7Auth');
const { parseAccountsText } = require('../services/mind7Accounts');

const MAX_WA = 8;

async function textFromCtx(ctx) {
  if (ctx && typeof ctx.downloadMedia === 'function' && (ctx.hasMedia || ctx.isDocument)) {
    const buf = await ctx.downloadMedia();
    if (buf && Buffer.isBuffer(buf)) return buf.toString('utf8');
  }
  return '';
}

function parseInline(args) {
  const a = Array.isArray(args) ? args : [];
  if (a.length >= 2) return [{ email: a[0], password: a.slice(1).join(' ') }];
  return [];
}

async function runBatch(accounts, limit) {
  const list = accounts.slice(0, limit);
  const lines = [];
  let valid = 0;
  let invalid = 0;
  let error = 0;
  for (const acc of list) {
    const email = String(acc.email || '').trim();
    const shown = `${email} / ${maskSecret(acc.password)}`;
    try {
      const r = await verifyMind7Login(email, acc.password);
      if (r.status === 'valid') {
        valid += 1;
        lines.push('VALIDO   ' + shown);
      } else if (r.status === 'invalid') {
        invalid += 1;
        lines.push('INVALIDO ' + shown + '  (' + (r.reason || 'credencial') + ')');
      } else {
        error += 1;
        lines.push('ERRO     ' + shown + '  (' + (r.reason || 'erro') + ')');
      }
    } catch (e) {
      error += 1;
      lines.push('ERRO     ' + shown + '  (' + String(e.message || e).slice(0, 60) + ')');
    }
  }
  return { lines, valid, invalid, error, total: accounts.length, ran: list.length };
}

const commands = {};

commands.checkmind7 = {
  useCtx: true,
  description: 'Verifica login Mind7 (email/senha ou arquivo). Nao mostra senha.',
  usage: 'checkmind7 <email> <senha> | responda um .txt/.csv/.json',
  execute: async (conn, ctx) => {
    if (!ctx.isOwner) {
      return conn.sendMessage(ctx.from, {
        text: formatReportBlock('mind7', ['Apenas dono.'])
      }, { quoted: ctx.info });
    }
    let accounts = parseInline(ctx.args);
    if (!accounts.length) {
      const fileText = await textFromCtx(ctx);
      if (fileText) accounts = parseAccountsText(fileText);
    }
    if (!accounts.length) {
      return conn.sendMessage(ctx.from, {
        text: formatReportBlock('mind7', [
          'checkmind7 email senha',
          'ou responda um arquivo txt/csv/json (email:senha por linha).',
          'Lote no Zap: no maximo ' + MAX_WA + ' contas. Arquivo grande: CLI.'
        ])
      }, { quoted: ctx.info });
    }
    const result = await runBatch(accounts, MAX_WA);
    const extra = result.total > result.ran
      ? ['lote cortado em ' + MAX_WA + ' (arquivo tem ' + result.total + '). Use o script no PC.']
      : [];
    await conn.sendMessage(ctx.from, {
      text: formatReportBlock('mind7', [
        ...result.lines,
        '--- total=' + result.ran + ' validos=' + result.valid + ' invalidos=' + result.invalid + ' erros=' + result.error,
        ...extra
      ])
    }, { quoted: ctx.info });
  }
};
commands.mind7login = commands.checkmind7;
commands.verifymind7 = commands.checkmind7;

module.exports = { commands };
