'use strict';
/**
 * Textos do painel admin no Telegram (sessoes, VIP, compras).
 */

function maskId(raw) {
  const s = String(raw || '');
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}..${s.slice(-4)}`;
}

function validade(iso) {
  if (!iso) return 'vitalicio';
  const exp = Date.parse(iso);
  if (!Number.isFinite(exp)) return String(iso).slice(0, 10);
  const days = Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
  return `${String(iso).slice(0, 10)} (${days}d)`;
}

function reais(cents) {
  return `R$ ${(Number(cents || 0) / 100).toFixed(0)}`;
}

function sessionCounts() {
  const { getAllSessions } = require('./sessionRegistry');
  const all = getAllSessions() || [];
  const live = all.filter((s) => s.status === 'connected').length;
  const linking = all.filter((s) => s.status === 'connecting').length;
  return { all, live, linking, off: Math.max(0, all.length - live - linking) };
}

async function formatOverview() {
  const store = require('../services/billing/store');
  const { all, live, linking, off } = sessionCounts();
  let w = { count: 0, cents: 0, vip: 0, bot: 0, lastPaidAt: '' };
  let st = { pending: 0, delivered24h: 0 };
  let vips = [];
  let bots = [];
  try { w = await store.weekSales(); } catch (_) { /* sql */ }
  try { st = await store.stats(); } catch (_) { /* sql */ }
  try { vips = await store.listActiveVips(80); } catch (_) { /* sql */ }
  try { bots = await store.listBotLicenses(80); } catch (_) { /* sql */ }
  const last = w.lastPaidAt
    ? `Ultima venda: ${String(w.lastPaidAt).slice(0, 16).replace('T', ' ')}`
    : 'Nenhuma venda ainda.';
  return [
    'HANORK · PAINEL',
    '',
    `Sessoes: ${live} no ar · ${linking} ligando · ${off} off`,
    `Total no registro: ${all.length}`,
    `VIP ativo: ${vips.length}`,
    `Licenca do bot: ${bots.length}`,
    `Semana: ${w.count} venda(s) · ${reais(w.cents)}`,
    `  VIP ${w.vip || 0} · bot ${w.bot || 0}`,
    `PIX aberto: ${st.pending || 0} · entregas 24h: ${st.delivered24h || 0}`,
    last
  ].join('\n');
}

function formatSessions() {
  const { all, live } = sessionCounts();
  if (!all.length) return 'HANORK · SESSOES\n\nNenhuma sessao no registro.';
  const lines = [`HANORK · SESSOES`, `${live} no ar / ${all.length}`, ''];
  const slice = all.slice(0, 18);
  for (const s of slice) {
    const mark = s.status === 'connected' ? 'ON' : (s.status === 'connecting' ? '..' : 'OFF');
    const phone = s.phone || String(s.sessionId || '').slice(0, 10);
    lines.push(`[${mark}] ${phone}  tg ${maskId(s.telegramUserId)}`);
  }
  if (all.length > slice.length) lines.push(`… +${all.length - slice.length}`);
  return lines.join('\n');
}

async function formatVips() {
  const store = require('../services/billing/store');
  let rows = [];
  let bots = [];
  try { rows = await store.listActiveVips(20); } catch (_) { /* sql */ }
  try { bots = await store.listBotLicenses(12); } catch (_) { /* sql */ }
  const lines = ['HANORK · VIP', `${rows.length} ativo(s)`, ''];
  if (!rows.length) lines.push('(nenhum)');
  for (const r of rows) {
    lines.push(`${maskId(r.platform_user)} · ${r.quota_tier || 'vip'} · ${validade(r.expires_at)}`);
  }
  if (bots.length) {
    lines.push('', `Licenca bot: ${bots.length}`);
    for (const b of bots.slice(0, 8)) lines.push(`bot ${maskId(b.platform_user)}`);
  }
  return lines.join('\n');
}

async function formatSales() {
  const store = require('../services/billing/store');
  let w = { count: 0, cents: 0, vip: 0, bot: 0 };
  let rows = [];
  try { w = await store.weekSales(); } catch (_) { /* sql */ }
  try { rows = await store.recentOrders(10); } catch (_) { /* sql */ }
  const lines = [
    'HANORK · COMPRAS',
    `Semana ${w.count} · ${reais(w.cents)} · VIP ${w.vip || 0} · bot ${w.bot || 0}`,
    ''
  ];
  if (!rows.length) lines.push('(nenhum pedido)');
  for (const o of rows) {
    const day = String(o.created_at || '').slice(0, 10);
    lines.push(`${day} ${o.plan_id} ${reais(o.amount_cents)} ${o.status} ${maskId(o.platform_user)}`);
  }
  return lines.join('\n');
}

async function formatPix() {
  const store = require('../services/billing/store');
  let rows = [];
  try { rows = await store.pendingPixOrders(); } catch (_) { /* sql */ }
  const lines = ['HANORK · PIX ABERTO', `${rows.length} pedido(s)`, ''];
  if (!rows.length) lines.push('(nenhum PIX pendente)');
  for (const o of rows.slice(0, 12)) {
    const day = String(o.created_at || '').slice(5, 16).replace('T', ' ');
    lines.push(`${day} ${o.plan_id || '?'} ${reais(o.amount_cents)} ${String(o.id || '').slice(0, 8)}`);
  }
  return lines.join('\n');
}

function nav(refresh = 'admin_ops') {
  return [
    [{ text: 'Painel', callback_data: 'admin_ops' }, { text: 'Sessoes', callback_data: 'admin_list_all' }],
    [{ text: 'VIP', callback_data: 'admin_vips' }, { text: 'Compras', callback_data: 'admin_sales' }],
    [{ text: 'PIX aberto', callback_data: 'admin_pix' }, { text: 'Health', callback_data: 'admin_health' }],
    [{ text: 'Atualizar', callback_data: refresh }, { text: 'Voltar', callback_data: 'menu_admin' }]
  ];
}

module.exports = {
  formatOverview,
  formatSessions,
  formatVips,
  formatSales,
  formatPix,
  nav
};
