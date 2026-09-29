'use strict';

const inviteStore = require('./inviteStore');
const limits = require('./limits');
const { officialList } = require('./registry');
const { occupancy } = require('./joinService');

function fmtWhen(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch (_) {
    return String(iso).slice(0, 19);
  }
}

async function snapshot(ownerKey) {
  const uid = String(ownerKey || '');
  const lim = limits.loadLimits(uid);
  const st = limits.loadState(uid);
  let cnt = {
    pending: 0, processing: 0, joined: 0, already_member: 0,
    expired: 0, invalid: 0, failed: 0, blocked: 0, left: 0, active: 0
  };
  let lastJoin = st.lastJoinAt;
  try {
    cnt = await inviteStore.counts(uid);
    lastJoin = (await inviteStore.lastJoinedAt(uid)) || lastJoin;
  } catch (_) { /* sql off */ }
  const ativos = officialList(uid);
  let names = {};
  try {
    const joined = await inviteStore.listJoined(uid, { limit: 50, offset: 0 });
    for (const r of joined || []) {
      if (r.groupJid) names[r.groupJid] = String(r.groupName || '').slice(0, 40);
    }
  } catch (_) { /* ignore */ }
  let occ = {
    current: ativos.length,
    live: null,
    registry: ativos.length,
    approximate: true,
    sessions: 0
  };
  try {
    occ = await occupancy(uid, { ttlMs: 0 });
  } catch (_) { /* fetch live falhou — usa registry */ }
  return {
    ativos: ativos.length,
    ocupacao: occ.current,
    ocupacaoLive: occ.live,
    ocupacaoAprox: !!occ.approximate,
    maxTotal: lim.maxTotalGroups,
    pending: cnt.pending,
    processing: cnt.processing,
    failed: cnt.failed,
    expired: cnt.expired,
    invalid: cnt.invalid,
    joined: cnt.joined,
    alreadyMember: cnt.already_member,
    joinsToday: st.joinsToday,
    maxJoins: lim.maxJoinsPerDay,
    leavesToday: st.leavesToday,
    maxLeaves: lim.maxLeavesPerDay,
    paused: st.paused,
    sessions: occ.sessions || 0,
    lastJoinAt: lastJoin,
    lastJoinLabel: fmtWhen(lastJoin),
    limits: lim,
    state: st,
    official: ativos,
    names
  };
}

function panelText(snap) {
  const fila = snap.paused ? 'parada' : (snap.processing > 0 ? 'executando' : 'pronta');
  const aprox = snap.ocupacaoAprox ? ' (aprox.)' : '';
  return [
    'GERENCIADOR DE GRUPOS',
    '',
    `Grupos: ${snap.ocupacao} / ${snap.maxTotal}${aprox}` +
    (snap.ocupacao > snap.maxTotal ? ' (acima do teto: para de entrar; nao sai sozinho)' : ''),
    `Auto-repor: ${snap.limits.autoRefill === true ? 'ON (completa se sair)' : 'OFF (nao entra sozinho)'}`,
    `Lista divulgacao: ${snap.ativos}`,
    `Pendentes: ${snap.pending} (todos os links unicos)`,
    `Entradas hoje: ${snap.joinsToday}/${snap.maxJoins}`,
    `Saidas hoje: ${snap.leavesToday}/${snap.maxLeaves}`,
    `Fila: ${fila}`,
    `Sessoes: ${snap.sessions}`,
    `Ultima entrada: ${snap.lastJoinLabel}`
  ].join('\n');
}

function limitsText(snap) {
  const L = snap.limits;
  const aprox = snap.ocupacaoAprox ? ' (aprox. lista divulgacao)' : '';
  return [
    'LIMITES',
    '',
    `Ocupacao: ${snap.ocupacao} / ${L.maxTotalGroups}${aprox}`,
    `Auto-repor: ${L.autoRefill === true ? 'ON' : 'OFF'} (ON = se sair, entra outro ate o teto; OFF = so no botao Entrar)`,
    `Por sessao: ${L.maxGroupsPerSession}`,
    `Entradas/dia: ${L.maxJoinsPerDay}`,
    `Saidas/dia: ${L.maxLeavesPerDay}`,
    `Lote: ${L.maxBatchSize}`,
    `Delay entrada: ${Math.round(L.joinDelayMs / 1000)}s`,
    `Delay saida: ${Math.round(L.leaveDelayMs / 1000)}s`,
    `Tentativas/convite: ${L.maxAttemptsPerInvite}`,
    '',
    'Concorrencia: 1 (sem rajada)',
    '',
    'Toque um teto (10 / 25 / 50 / 100 / 200).',
    'Ou: grupoconfig max 80',
    'Atingiu o teto = para de entrar. Nao sai dos grupos sozinho (nem os que voce entrou na mao).',
    'Grupo que o bot ja esta entra na lista DIV sozinho. Morto ainda sai pelo fluxo de grupo morto.'
  ].join('\n');
}

function queueText(snap) {
  return [
    'FILA DE CONVITES',
    '',
    `Pendentes: ${snap.pending} (sem teto de salvamento)`,
    `Processando: ${snap.processing}`,
    `Entraram: ${snap.joined + snap.alreadyMember}`,
    `Falhos: ${snap.failed}`,
    `Expirados: ${snap.expired}`,
    `Invalidos: ${snap.invalid}`,
    `Fila: ${snap.paused ? 'parada' : 'pronta'}`,
    '',
    'Limite e so na hora de ENTRAR (ocupacao / dia / lote).'
  ].join('\n');
}

const PAGE = 8;

function activePage(snap, page) {
  const list = snap.official || [];
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(pages, Math.max(1, Number(page) || 1));
  const slice = list.slice((p - 1) * PAGE, p * PAGE);
  const lines = [
    'GRUPOS ATIVOS (lista oficial divulgacao)',
    '',
    `Pagina ${p}/${pages} · ${total} grupos`,
    ''
  ];
  if (!slice.length) lines.push('Nenhum grupo na lista. Entre por convite ou use addgrupo.');
  else {
    slice.forEach((jid, i) => {
      const n = (p - 1) * PAGE + i + 1;
      const name = (snap.names && snap.names[jid]) || '';
      lines.push(name ? `${n}. ${name} · ${jid}` : `${n}. ${jid}`);
    });
  }
  return { text: lines.join('\n'), page: p, pages, total };
}

module.exports = {
  snapshot,
  panelText,
  limitsText,
  queueText,
  activePage,
  PAGE
};
