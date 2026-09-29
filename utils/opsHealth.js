'use strict';
/**
 * Snapshot operacional pro painel TG — versao lojista (sem jargao de infra).
 * Numeros vêm das mesmas fontes (healthServer, sessionRegistry, opsMetrics).
 */

const typo = require('./typography');
function reportBlock(title, lines) {
  const fn = typo.formatReportBlock || typo.formatReportBlock;
  return fn(title, lines);
}

function checkdataStatus() {
  const tok = String(process.env.CHECKDATA_API_TOKEN || '').trim();
  if (!tok) return { ok: false, label: 'desligado' };
  return { ok: true, label: 'ok' };
}

function mind7Status() {
  try {
    const m7 = require('../services/mind7Client');
    if (typeof m7.isEnabled === 'function' && !m7.isEnabled()) {
      return { ok: false, label: 'desligado' };
    }
    if (!m7.isConfigured()) return { ok: false, label: 'desligado' };
    const detail = typeof m7.getHealthDetail === 'function' ? m7.getHealthDetail() : null;
    if (detail && detail.lastError) return { ok: false, label: 'falhou o login' };
    if (detail && detail.sessionOk) return { ok: true, label: 'ok' };
    return { ok: false, label: 'aguardando login' };
  } catch (_) {
    return { ok: false, label: 'desligado' };
  }
}

function divStatusForAdmin(telegramUserId) {
  try {
    const { getConfig } = require('./divulgacao');
    const cfg = getConfig(telegramUserId);
    if (!cfg) return 'desligada';
    const grupos = Array.isArray(cfg.grupos) ? cfg.grupos.length : 0;
    if (!cfg.autoEnabled) return grupos ? 'desligada (' + grupos + ' grupos na lista)' : 'desligada';
    return 'ligada em ' + grupos + ' grupo(s)';
  } catch (_) {
    return 'sem dados';
  }
}

function statusLabel(st) {
  const s = String(st || '').toLowerCase();
  if (s === 'connected') return 'ligada';
  if (s === 'connecting') return 'ligando';
  return 'caiu';
}

function accountLabel(s, i) {
  const phone = String(s && (s.phone || s.phoneNumber) || '').replace(/\D/g, '');
  if (phone.length >= 8) return phone;
  return 'conta ' + (i + 1);
}

function gradePhrase(grade) {
  const g = String(grade || 'OK').toUpperCase();
  if (g === 'OK') return 'Funcionando normal';
  if (g === 'DEGRADED') return 'Sistema instavel hoje';
  return 'Precisa de atencao';
}

function formatSessionSummary(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const up = list.filter((s) => s.status === 'connected');
  const down = list.filter((s) => s.status !== 'connected');
  const lines = [
    up.length + ' contas conectadas de ' + list.length + ' no total'
  ];
  if (down.length) {
    const names = down.slice(0, 8).map((s, i) => accountLabel(s, i));
    lines.push('Cairam: ' + names.join(', '));
    if (down.length > 8) lines.push('(+ ' + (down.length - 8) + ')');
  }
  return lines;
}

function todayBits() {
  try {
    const { snapshot, dayKey } = require('./opsMetrics');
    const s = snapshot(dayKey());
    const bits = [];
    const joins = Number(s.joins) || 0;
    const leaves = Number(s.leaves) || 0;
    if (joins || leaves) {
      bits.push(joins + ' pessoas entraram e ' + leaves + ' sairam dos grupos');
    }
    if (s.kicks) bits.push(s.kicks + ' removidos');
    const divOk = Number(s.divOk) || 0;
    const divFail = Number(s.divFail) || 0;
    if (divOk || divFail) {
      bits.push('Divulgacoes de hoje: ' + divOk + ' enviadas, ' + divFail + ' falharam');
    }
    if (s.sales) bits.push(s.sales + ' venda(s)');
    if (s.antirouboApply) bits.push('anti-roubo agiu ' + s.antirouboApply + ' vez(es)');
    if (!bits.length) return 'nada demais';
    return bits.join(' · ');
  } catch (_) {
    return 'sem dados';
  }
}

function protectionLine() {
  try {
    const { summarizeProtections } = require('./protectionStore');
    const s = summarizeProtections();
    if (!s || !(s.groups > 0)) return 'Grupos protegidos: nenhum';
    const atk = Number(s.antiatk) || 0;
    return (
      'Grupos protegidos: ' + s.groups +
      ' · Protecao contra ataque: ' + (atk ? 'ativa em ' + atk + ' grupo(s)' : 'desligada')
    );
  } catch (_) {
    return 'Grupos protegidos: sem dados';
  }
}

function collectSessions(payload) {
  try {
    const { getAllSessions } = require('./sessionRegistry');
    const list = typeof getAllSessions === 'function' ? getAllSessions() : [];
    if (list && list.length) return list;
  } catch (_) { /* */ }
  try {
    return payload.sessions && payload.sessions.list ? payload.sessions.list : [];
  } catch (_) {
    return [];
  }
}

function formatOpsHealthText(telegramUserId, extra = {}) {
  let payload = {};
  try {
    payload = require('../services/healthServer').buildPayload() || {};
  } catch (_) {
    payload = {};
  }

  const sessions = collectSessions(payload);
  const commercial = payload.commercial || {};
  const downN = sessions.filter((s) => s.status !== 'connected').length;
  const div = divStatusForAdmin(telegramUserId);

  const now = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit'
  }).format(new Date());

  const body = [
    gradePhrase(commercial.grade),
    ...formatSessionSummary(sessions),
    '',
    protectionLine(),
    'Divulgacao automatica: ' + div,
    '',
    'Hoje: ' + todayBits()
  ];
  if (extra.weekLine) body.push('', extra.weekLine);
  if (extra.silenceLine) body.push(extra.silenceLine);
  if (downN) {
    body.push('', 'Pra reconectar as contas que cairam, va em Admin e toque em Limpar mortas.');
  }

  return reportBlock('Hanork · ' + now, body);
}

/** So painel dono/debug — nunca misturar no relatorio do lojista. */
function formatOpsHealthDebug(telegramUserId) {
  let payload = {};
  try {
    payload = require('../services/healthServer').buildPayload() || {};
  } catch (_) {
    payload = {};
  }
  const sessions = collectSessions(payload);
  const mem = payload.memory || {};
  const up = Number(payload.uptimeSec) || Math.floor(process.uptime());
  const upStr = Math.floor(up / 3600) + 'h ' + Math.floor((up % 3600) / 60) + 'm';
  const cd = checkdataStatus();
  const m7 = mind7Status();
  const body = [
    formatOpsHealthText(telegramUserId),
    '',
    '--- debug ---',
    'Memoria: ' + (mem.rssMB || Math.round(process.memoryUsage().rss / 1024 / 1024)) + ' MB',
    'Ligado ha: ' + upStr,
    'Consultas ficha: ' + cd.label,
    'Consultas extra: ' + m7.label,
    'Contas: ' + sessions.length
  ];
  return body.join('\n');
}

function translateSessionReason(reason) {
  const s = String(reason || '').toLowerCase();
  if (/403|forbidden/.test(s)) return 'acesso recusado';
  if (/logged out|log out/.test(s)) return 'desconectou';
  if (/401|persistente|auth|connection failure/.test(s)) return 'sessao expirada';
  if (/conflict|replaced|440/.test(s)) return 'outro aparelho assumiu';
  if (/\bqr\b|expirou/.test(s)) return 'QR expirou';
  if (/411|mismatch/.test(s)) return 'precisa parear de novo';
  return 'nao volta sozinha';
}

function formatSessionDeadShopText(reason) {
  const why = translateSessionReason(reason);
  return (
    'Uma das contas caiu e nao volta sozinha. Precisa reconectar pelo Telegram.\n' +
    'Motivo: ' + why
  );
}

module.exports = {
  formatOpsHealthText,
  formatOpsHealthDebug,
  formatSessionDeadShopText,
  translateSessionReason,
  checkdataStatus,
  mind7Status,
  divStatusForAdmin
};
