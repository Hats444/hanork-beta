'use strict';

const crypto = require('crypto');
const { requireSessionOwner } = require('../utils/authorization');
const { prefixFromCtx } = require('../utils/configManager');
const { sendInteractiveButtons } = require('../helpers');
const { formatReportBlock, labelValue, formatStatusBlock } = require('../utils/typography');
const { createWhatsAppStatus } = require('../utils/statusProgress');
const {
  parseOsintTarget,
  stripCommand,
  stripTextMode,
  parseCompare
} = require('../osint/core/target');
const { buildPlan } = require('../osint/core/plan');
const logger = require('../logger');

const commands = {};
const pending = new Map();
const TTL_MS = 10 * 60 * 1000;
const MOD_NAMES = [
  'dns', 'whois', 'certs', 'all', 'github', 'web',
  'search', 'archive', 'username', 'email', 'wiki', 'media', 'pastes', 'plan'
];

function pendingKey(ctx) {
  return `${ctx.sessionId || ctx.telegramUserId || 's'}::${ctx.from}`;
}

function kvScope(ctx) {
  return `osint:${ownerKey(ctx)}`;
}

function setPending(ctx, parsed) {
  const plan = buildPlan(parsed, 'all');
  pending.set(pendingKey(ctx), { parsed, plan, at: Date.now() });
  try {
    require('../utils/sqlStore').upsertKv(kvScope(ctx), 'pending', {
      parsed,
      plan,
      at: Date.now(),
      from: ctx.from
    });
  } catch (_) { /* sql opcional */ }
}

function getPending(ctx) {
  const row = pending.get(pendingKey(ctx));
  if (row) {
    if (Date.now() - row.at > TTL_MS) {
      pending.delete(pendingKey(ctx));
    } else {
      return row.parsed;
    }
  }
  try {
    const saved = require('../utils/sqlStore').getCachedKv(kvScope(ctx), 'pending');
    if (saved && saved.parsed && Date.now() - Number(saved.at || 0) < TTL_MS) {
      pending.set(pendingKey(ctx), { parsed: saved.parsed, at: saved.at });
      return saved.parsed;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function ownerKey(ctx) {
  return String(ctx.telegramUserId || ctx.sessionId || 'owner').slice(0, 80);
}

function quotedText(ctx) {
  const q = ctx.quoted;
  if (!q) return '';
  const msg = q.message || {};
  return String(
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ''
  ).trim();
}

function quotedHasMedia(ctx) {
  const m = ctx.quoted && ctx.quoted.message;
  return !!(m && (m.imageMessage || m.documentMessage || m.videoMessage));
}

async function attachQuotedMedia(conn, ctx, parsed) {
  if (!quotedHasMedia(ctx)) return parsed;
  try {
    const { downloadMediaMessage } = require('@systemzero/baileys');
    const opts = {};
    if (conn && conn.updateMediaMessage) opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
    const buf = await downloadMediaMessage(ctx.quoted, 'buffer', {}, opts);
    if (!buf || !buf.length) return parsed;
    parsed.media = {
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
      mime: String(
        ctx.quoted.message.imageMessage?.mimetype ||
        ctx.quoted.message.documentMessage?.mimetype ||
        ctx.quoted.message.videoMessage?.mimetype ||
        ''
      ),
      exif: 'nao_lido'
    };
  } catch (_) { /* midia opcional */ }
  return parsed;
}

function rawQuery(ctx) {
  if (Array.isArray(ctx.args) && ctx.args.length) return ctx.args.join(' ').trim();
  let t = stripCommand(ctx.text || ctx.fullText || '');
  if (!t) t = quotedText(ctx);
  return t.trim();
}

function parseArgs(ctx) {
  const q = rawQuery(ctx);
  const parts = q.split(/\s+/).filter(Boolean);
  if (!parts.length) return { raw: '', moduleName: '' };
  const last = parts[parts.length - 1].toLowerCase();
  let moduleName = '';
  let body = parts;
  if (MOD_NAMES.includes(last) && parts.length >= 2) {
    moduleName = last === 'wiki' ? 'search' : last;
    body = parts.slice(0, -1);
  }
  const raw = stripTextMode(body.join(' '));
  return { raw, moduleName };
}

async function ack(conn, ctx, text, max = 900) {
  try {
    const cap = Math.max(200, Math.min(Number(max) || 900, 4000));
    await conn.sendMessage(ctx.from, { text: String(text).slice(0, cap) }, { quoted: ctx.info });
  } catch (e) {
    logger.logAviso(`[osint] ack: ${e.message}`);
  }
}

function helpText(ctx) {
  const p = prefixFromCtx(ctx);
  return formatReportBlock('OSINT', [
    'So dono da sessao. Fontes publicas. Sem vazamento, face, Tor ou senha.',
    '',
    'EXEMPLOS',
    labelValue('Dominio', `${p}osint exemplo.com`),
    labelValue('Tudo do tipo', `${p}osint exemplo.com all`),
    labelValue('So DNS', `${p}osint exemplo.com dns`),
    labelValue('Nome', `${p}osint joao silva`),
    labelValue('Usuario', `${p}osint @fulano`),
    labelValue('Email (formato)', `${p}osint nome@dominio.com`),
    labelValue('Pastes publicos', `${p}osint exemplo.com pastes`),
    labelValue('GitHub', `${p}osint https://github.com/user/repo`),
    labelValue('Link', `${p}osint https://site.com/pagina`),
    labelValue('Canal TG publico', `${p}osint t.me/canal`),
    labelValue('Comparar', `${p}osint compare a.com | b.com`),
    labelValue('Plano sem coletar', `${p}osint exemplo.com plan`),
    '',
    'Reply numa msg + ' + `${p}osint` + ' usa o texto/link da citada.',
    'Reply numa foto/arquivo + ' + `${p}osint` + ' gera hash do arquivo (sem face).',
    '',
    'Modulos: dns whois certs github web search archive username email pastes all',
    'Pastes: so titulo+URL (pastebin, gist, paste.ee, rentry...). Sem /raw/ e sem dump.',
    'Filtro: lang=pt since=2024 (ex.: ' + `${p}osint exemplo.com lang=pt since=2024` + ')',
    '',
    'Nao aceita: CPF, senha, dump, .onion, grupo privado, IP atras do Cloudflare.'
  ]);
}

function planText(parsed, moduleName) {
  const plan = buildPlan(parsed, moduleName || 'all');
  return formatReportBlock('OSINT PLANO', [
    labelValue('Alvo', parsed.label || parsed.raw),
    labelValue('Tipo', parsed.kind),
    labelValue('Coletores', (plan.collectors || []).join(', ') || '(nenhum)'),
    labelValue('Estimativa', `${Math.round((plan.estimatedMs || 0) / 1000)}s`),
    '',
    'Pulado (nao fingido):',
    ...(plan.skipped || []).slice(0, 10).map((s) => `- ${s.name}: ${s.reason}`),
    '',
    'Export PDF/CSV: ainda nao. Alertas: nao nesta versao.'
  ]);
}

async function showMenu(conn, ctx, parsed) {
  try {
    const { rememberPanelOperator } = require('../utils/interactiveClickGuard');
    rememberPanelOperator(conn, ctx.from, ctx.sender);
    if (ctx.senderAlt) rememberPanelOperator(conn, ctx.from, ctx.senderAlt);
  } catch (_) { /* ignore */ }
  const p = prefixFromCtx(ctx);
  const target = parsed.label || parsed.host || parsed.raw;
  const plan = buildPlan(parsed, 'all');
  const text = formatReportBlock('OSINT', [
    labelValue('Alvo', target),
    labelValue('Tipo', parsed.kind),
    labelValue('Coletores', (plan.collectors || []).join(', ') || '(nenhum)'),
    labelValue('Escopo', 'fontes publicas passivas'),
    '',
    'DNS / WHOIS / certs / GitHub / pagina / arquivo / busca.',
    'IA interpreta o JSON ja coletado (nao inventa).',
    '',
    `Plano sem coletar: ${p}osint ${target} plan`
  ]);
  await sendInteractiveButtons(
    conn,
    ctx.from,
    text,
    [
      { id: 'osint_dns', label: 'DNS', desc: 'A/AAAA/MX/NS/TXT' },
      { id: 'osint_whois', label: 'WHOIS', desc: 'RDAP + porta 43' },
      { id: 'osint_certs', label: 'Certs', desc: 'Certificate Transparency' },
      { id: 'osint_github', label: 'GitHub', desc: 'perfil/repo publico' },
      { id: 'osint_web', label: 'Pagina', desc: 'fetch publico' },
      { id: 'osint_all', label: 'Todos', desc: 'tudo que couber no alvo' },
      { id: 'osint_plan', label: 'Plano', desc: 'mostra coletores, nao busca' }
    ],
    'so dono',
    ctx.info
  );
}

async function showUsernameConfirm(conn, ctx, parsed) {
  try {
    const { rememberPanelOperator } = require('../utils/interactiveClickGuard');
    rememberPanelOperator(conn, ctx.from, ctx.sender);
  } catch (_) { /* ignore */ }
  await sendInteractiveButtons(
    conn,
    ctx.from,
    formatReportBlock('OSINT', [
      labelValue('Alvo', parsed.label),
      'Vou consultar fontes publicas de username. Continua.'
    ]),
    [
      { id: 'osint_go', label: 'Continua', desc: 'busca publica' },
      { id: 'osint_cancel', label: 'Cancela', desc: 'nao busca' }
    ],
    'so dono',
    ctx.info
  );
}

function runOsintJob(conn, ctx, parsed, moduleName) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'OSINT', {
          oneMessage: true,
          finishMax: 60000
        });
        try {
          await status.update('Alvo', parsed.label || parsed.host || parsed.raw);
          const { run } = require('../osint/core/orchestrator');
          const out = await run({
            target: parsed,
            moduleName,
            ownerKey: ownerKey(ctx),
            onProgress: (step, label) => status.update(String(step), label)
          });
          logger.logInfo(`[osint] run ${out.report.runId} mod=${moduleName || 'auto'} kind=${parsed.kind}`);
          await status.finish(out.markdown);
        } catch (e) {
          const msg = String(e.message || e).slice(0, 180);
          logger.logAviso(`[osint] job: ${msg}`);
          try {
            await status.finish(formatStatusBlock('OSINT', [['Erro', msg]]));
          } catch (_) {
            await conn.sendMessage(ctx.from, { text: formatStatusBlock('OSINT', [['Erro', msg]]) }, { quoted: ctx.info }).catch(() => {});
          }
        }
      })
      .catch((e) => logger.logAviso(`[osint] job spawn: ${e.message}`));
  });
}

function runCompareJob(conn, ctx, pair) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'OSINT', {
          oneMessage: true,
          finishMax: 60000
        });
        try {
          await status.update('Compare', `${pair.a} | ${pair.b}`);
          const { runCompare } = require('../osint/core/orchestrator');
          const out = await runCompare({
            a: pair.a,
            b: pair.b,
            ownerKey: ownerKey(ctx),
            onProgress: (step, label) => status.update(String(step), label)
          });
          await status.finish(out.markdown);
        } catch (e) {
          const msg = String(e.message || e).slice(0, 180);
          logger.logAviso(`[osint] compare: ${msg}`);
          try {
            await status.finish(formatStatusBlock('OSINT', [['Erro', msg]]));
          } catch (_) { /* ignore */ }
        }
      })
      .catch((e) => logger.logAviso(`[osint] compare spawn: ${e.message}`));
  });
}

async function handleOsintClick(conn, ctx, btnId) {
  if (!(await requireSessionOwner(conn, ctx))) return;
  try {
    const { rememberPanelOperator } = require('../utils/interactiveClickGuard');
    rememberPanelOperator(conn, ctx.from, ctx.sender);
  } catch (_) { /* ignore */ }
  const mod = String(btnId || '').replace(/^osint_/, '').toLowerCase();
  if (mod === 'cancel') {
    await ack(conn, ctx, 'OSINT cancelado.');
    return;
  }
  const parsed = getPending(ctx);
  if (!parsed) {
    const p = prefixFromCtx(ctx);
    await ack(conn, ctx, `Alvo expirou. Use ${p}osint <link|dominio|texto>`);
    return;
  }
  if (mod === 'plan') {
    await ack(conn, ctx, planText(parsed, 'all'), 3500);
    return;
  }
  const runMod = mod === 'go' ? 'all' : (mod || 'all');
  await ack(conn, ctx, `OSINT: coletando ${parsed.label} (${runMod})…`);
  runOsintJob(conn, ctx, parsed, runMod);
}

commands.osint = {
  useCtx: true,
  description: 'OSINT etico (dono): dominio, link, GitHub, texto, @user, email publico',
  usage: 'osint  |  osint <alvo> [all|dns|github|web]  |  osint compare a | b',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const { enforceSearchQuery } = require('../utils/searchQueryLimit');
    const parsedArgs = parseArgs(ctx);
    if (!parsedArgs.raw) {
      await ack(conn, ctx, helpText(ctx), 4000);
      return;
    }

    const cmp = parseCompare(parsedArgs.raw);
    if (cmp) {
      try {
        enforceSearchQuery(cmp.a);
        enforceSearchQuery(cmp.b);
      } catch (e) {
        await ack(conn, ctx, e.message);
        return;
      }
      await ack(conn, ctx, `OSINT compare: ${cmp.a} | ${cmp.b}`);
      runCompareJob(conn, ctx, cmp);
      return;
    }

    let parsed;
    try {
      parsedArgs.raw = enforceSearchQuery(parsedArgs.raw);
      parsed = parseOsintTarget(parsedArgs.raw);
    } catch (e) {
      await ack(conn, ctx, String(e.message || e).slice(0, 160));
      return;
    }
    parsed = await attachQuotedMedia(conn, ctx, parsed);

    if (parsed.kind === 'onion') {
      await ack(conn, ctx, 'Alvo .onion — recusa no relatorio (sem Tor).');
      runOsintJob(conn, ctx, parsed, 'all');
      return;
    }

    setPending(ctx, parsed);

    if (parsedArgs.moduleName === 'plan') {
      await ack(conn, ctx, planText(parsed, 'all'), 3500);
      await showMenu(conn, ctx, parsed);
      return;
    }

    if (parsedArgs.moduleName) {
      await ack(conn, ctx, `OSINT: coletando ${parsed.label}…`);
      runOsintJob(conn, ctx, parsed, parsedArgs.moduleName);
      return;
    }
    if (parsed.kind === 'email' || parsed.kind === 'username') {
      await showUsernameConfirm(conn, ctx, parsed);
      return;
    }
    await ack(conn, ctx, `OSINT: ${parsed.label} — coletando…`);
    runOsintJob(conn, ctx, parsed, 'all');
  }
};

module.exports = { commands, handleOsintClick, parseArgs };
