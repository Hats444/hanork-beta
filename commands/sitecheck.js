// commands/sitecheck.js — Checagem tecnica de site/dominio (Universal Router)
'use strict';
/**
 * .sitecheck <dominio|url>  (atalhos: .checarsite, .sc)
 *
 * NIVEL DE PERMISSAO: vip (decisao registrada em core/router/registeredCommands.js).
 * POR QUE vip e nao owner:
 *   - e MAIS LEVE que o .osint, que hoje e owner: aqui nao ha dado de
 *     vazamento, e-mail ou pessoa — so a superficie tecnica publica do site;
 *   - reusa os provedores pagos (Shodan/Censys/VT) que ja estao no plano VIP;
 *   - ADM DE GRUPO NAO ENTRA: no permissionEngine `adm` e "moderacao de UM
 *     grupo" (par de vip, nao superior). Dar varredura de infraestrutura
 *     externa a um admin de grupo permitiria recon de alvo por terceiros;
 *   - USER COMUM NAO ENTRA: consome cota de API de terceiros; sem controle
 *     de abuso viraria exaustao do rate-limit das fontes.
 *  OU seja: platform_admin/owner e vip liberados; adm e user negados — a
 *   regra de 4 niveis que ja existe em permissionEngine.canUseCommand.
 *
 * PADROES: rate limit em ratePolicy.HEAVY_DEFAULT, guardrails de
 * osint/core/guardrails.js, tipografia de utils/typography.js, paginacao via
 * helpers.sendInteractiveList (mesmo caminho do .figurinha).
 */

const logger = require('../logger');
const { runSiteCheck } = require('../core/osint/sitecheck/service');
const { paginate } = require('../core/osint/sitecheck/format');
const { formatReportBlock, labelValue } = require('../utils/typography');
const { getConversationSession } = require('../utils/conversationSession');
const { sendInteractiveList } = require('../helpers');

/** Segundos de cooldown por usuario (anti-abuso: varredura custa API). */
const COOLDOWN_S = Number(process.env.SITECHECK_COOLDOWN_S) || 20;
const LOCK_S = Number(process.env.SITECHECK_LOCK_S) || 45;
const MAX_TARGET_LEN = 253;

function helpText() {
  return formatReportBlock('HANORK SITECHECK', [
    'Checagem tecnica de um site: DNS, HTTP, headers de seguranca,',
    'CDN/WAF, SSL/TLS, tecnologias, IP/geo e portas comuns.',
    '',
    labelValue('Uso', '.sitecheck <dominio ou url>'),
    labelValue('Exemplos', '.sitecheck exemplo.com'),
    labelValue('Atalhos', '.checarsite  .sc'),
    labelValue('Nivel', 'vip (dono e vip)'),
    '',
    'Tudo em paralelo, com timeout por checagem: uma falha nunca',
    'derruba as outras. Resultado fica em cache SQL por um tempo curto.',
    'Coleta passiva: nada de exploit, brute ou area logada.'
  ]);
}

function ensureSession(ctx) {
  if (!ctx.session || typeof ctx.session !== 'object') {
    try {
      ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
    } catch (_) {
      ctx.session = {};
    }
  }
  return ctx.session;
}

/**
 * Rate limit POR USUARIO, com estado na sessao (nao vaza entre sessoes:
 * cada sessao tem seu proprio objeto e o cooldown nao e global).
 */
function hitCooldown(ctx) {
  const s = ensureSession(ctx);
  const now = Date.now();
  const until = Number(s.sitecheckUntil || 0);
  if (until > now) return Math.ceil((until - now) / 1000);
  s.sitecheckUntil = now + COOLDOWN_S * 1000;
  s.sitecheckCount = (Number(s.sitecheckCount) || 0) + 1;
  return 0;
}

function parseTarget(args) {
  const raw = String((Array.isArray(args) ? args.join(' ') : args) || '').trim();
  if (!raw) return { ok: false, motivo: 'informe um dominio ou url' };
  if (raw.length > MAX_TARGET_LEN + 12) return { ok: false, motivo: 'alvo longo demais' };
  return { ok: true, target: raw };
}

/** Botoes de navegacao entre paginas do relatorio (padrao do bot). */
function pageButtons(total, current, target) {
  const rows = [];
  if (current > 0) {
    rows.push({
      id: `scpage_${target}_${current - 1}`,
      label: `Anterior ${current}/${total}`,
      description: 'Pagina anterior do relatorio'
    });
  }
  if (current < total - 1) {
    rows.push({
      id: `scpage_${target}_${current + 1}`,
      label: `Proxima ${current + 1}/${total}`,
      description: 'Proxima pagina do relatorio'
    });
  }
  return rows;
}

async function sendReport(conn, ctx, result, target) {
  const pages = paginate(result);
  const s = ensureSession(ctx);
  // Guarda o resultado da sessao para as paginas seguintes (isolado por sessao).
  s.sitecheckLast = { target, pages: pages.map((p) => p.texto), host: result.host };

  if (pages.length === 1) {
    return conn.sendMessage(ctx.from, { text: pages[0].texto }, { quoted: ctx.info });
  }

  await conn.sendMessage(ctx.from, { text: pages[0].texto }, { quoted: ctx.info });
  const rows = pageButtons(pages.length, 0, target);
  if (!rows.length) return null;
  return sendInteractiveList(
    conn,
    ctx.from,
    'SITECHECK',
    [{ title: 'Navegar relatorio', rows }],
    `${result.host} · ${pages.length} paginas`,
    ctx.info,
    null,
    ctx.telegramUserId || null,
    ctx.sessionId || conn._sessionId || null
  );
}

module.exports = { helpText, COOLDOWN_S, LOCK_S, ensureSession, hitCooldown, parseTarget, pageButtons, sendReport };

// ---------- execucao ----------
async function execute(conn, ctx) {
  const args = (ctx.args || []).join(' ').trim();
  const parsed = parseTarget(args);
  if (!parsed.ok) {
    return conn.sendMessage(ctx.from, { text: helpText() }, { quoted: ctx.info });
  }

  const wait = hitCooldown(ctx);
  if (wait > 0) {
    return conn.sendMessage(ctx.from, {
      text: formatReportBlock('SITECHECK', [
        labelValue('Aguarde', `${wait}s`),
        '',
        `Limite de 1 checagem a cada ${COOLDOWN_S}s por usuario.`
      ])
    }, { quoted: ctx.info });
  }

  // Trava maior durante a coleta: impede 2 coletas concorrentes do mesmo user.
  ensureSession(ctx).sitecheckUntil = Date.now() + LOCK_S * 1000;

  try {
    const result = await runSiteCheck(parsed.target);
    logger.logInfo(
      `[sitecheck] host=${result.host} cached=${result.cached} ms=${result.ms} ev=${result.evidences.length}`
    );
    return await sendReport(conn, ctx, result, result.host);
  } catch (e) {
    const msg = String((e && e.message) || e);
    logger.logAviso(`[sitecheck] falhou ${parsed.target}: ${msg}`);
    return conn.sendMessage(ctx.from, {
      text: formatReportBlock('SITECHECK FALHOU', [
        labelValue('Alvo', parsed.target.slice(0, 120)),
        labelValue('Motivo', msg.slice(0, 200)),
        '',
        'Aceitos: dominio publico ou url http/https.',
        'Bloqueados: IP privado, .onion, area logada e coleta ativa.'
      ])
    }, { quoted: ctx.info });
  }
}

/** Clique nos botoes de paginacao do relatorio. */
async function handleClick(conn, ctx, buttonId) {
  const m = /^scpage_([a-z0-9.-]{1,253})_(\d{1,3})$/i.exec(String(buttonId || ''));
  if (!m) return conn.sendMessage(ctx.from, { text: helpText() }, { quoted: ctx.info });
  const s = ensureSession(ctx);
  const last = s.sitecheckLast;
  if (!last || !Array.isArray(last.pages) || !last.pages.length) {
    return conn.sendMessage(ctx.from, {
      text: formatReportBlock('SITECHECK', [
        labelValue('Status', 'sem relatorio guardado nesta sessao'),
        '',
        'Rode de novo: .sitecheck <dominio>'
      ])
    }, { quoted: ctx.info });
  }
  const idx = Math.max(0, Math.min(last.pages.length - 1, Number(m[2]) || 0));
  return conn.sendMessage(ctx.from, { text: last.pages[idx] }, { quoted: ctx.info });
}

const commands = {};

commands.sitecheck = {
  useCtx: true,
  description: 'Checagem tecnica de site (DNS, TLS, CDN, stack, portas)',
  usage: 'sitecheck <dominio|url>',
  permission: 'vip',
  execute
};
commands.checarsite = commands.sitecheck;

module.exports = {
  helpText, COOLDOWN_S, LOCK_S, ensureSession, hitCooldown,
  parseTarget, pageButtons, sendReport, execute, handleClick, commands
};

