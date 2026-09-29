'use strict';
/**
 * Menu Dono e Menu Adm — listas curadas (sem alias), prefixo live, 1 mensagem.
 * Adm = tudo que admin de grupo pode usar. Dono = operacao da sessao + atalho pro Menu Adm.
 */

const { previewText, stripAccents } = require('./typography');

const ALIAS_SKIP = new Set([
  'kick', 'banir', 'fechargrupo', 'abrirgrupo', 'gpfechar', 'gpabrir',
  'groupclose', 'groupopen', 'attacc', 'setattacc', 'onlyadm', 'soadmin',
  'blockgp', 'admcmd', 'autoapres', 'antidel', 'welcome', 'bv',
  'linkgrupo', 'grouplink', 'promote', 'demote', 'protecoes', 'oquestaon',
  'protecoeson', 'antiattack', 'presetseg', 'antilingp', 'antidocumento',
  'anticontato', 'antichannell', 'antimencao', 'antipagamentoatk',
  'anticrash', 'anticrashgp', 'antipollatk', 'antimencaomassa',
  'antireacao', 'antiedicao', 'antistatusatk', 'antiinvisivel',
  'antiporn', 'autodownload', 'hidetag', 'tagall', 'marcar', 'marcartodos',
  'bloquearcomando', 'desbloquearcomando', 'comandosblock', 'sairdogp'
]);

/** Admin do grupo — nomes primarios, agrupados. */
const ADM_GROUPS = [
  ['Moderacao', [
    'ban', 'bantmp', 'mute', 'desmute', 'mutelist',
    'promover', 'rebaixar', 'add', 'remove',
    'adv', 'rmadv', 'listadv', 'cita', 'totag', 'banghost', 'limpar'
  ]],
  ['Protecao', [
    'gpseguranca', 'protecoesativas', 'protecoeshelp',
    'antilink', 'antilinkhard', 'antilinkgp', 'antilinkeasy',
    'antifake', 'soadm', 'antiimg', 'antivideo', 'antiaudio', 'antisticker',
    'antidoc', 'antiloc', 'antictt', 'antichannel', 'antipayment',
    'anticatalogo', 'antistatus', 'antipalavrao', 'antidelete', 'autoapresentar',
    'antiataque', 'antiatkstatus', 'antiatkinvisivel', 'antiatkpagamento',
    'antiatkcrash', 'antiatkpoll', 'antiatkmencao', 'antiatkreacao',
    'antiatkedicao', 'protoff', 'limiteflood', 'limitec'
  ]],
  ['Entrada', [
    'autoaceitar', 'autoaceitartempo', 'autoconvite',
    'aceitar', 'recusar', 'aceitarall', 'recusarall', 'pedidosentrada',
    'bemvindo', 'saiu', 'legendabv', 'convidar', 'listfake', 'banfake'
  ]],
  ['Grupo', [
    'fechargp', 'abrirgp', 'fecharas', 'horariogrupo', 'x9config',
    'groupname', 'groupdesc', 'setgrouppp', 'linkgp', 'revokeinvite',
    'settabela', 'sorteio', 'atividade', 'inativos', 'ausente', 'dk'
  ]]
];

/** Dono da sessao — o que opera o bot (nao download/consulta). */
const DONO_GROUPS = [
  ['Sessao', [
    'setprefix', 'bloquearcmd', 'desbloquearcmd', 'listablockcmd',
    'botoff', 'boton', 'boti', 'buttonmode'
  ]],
  ['PV e ligacao', [
    'antipv', 'antipv2', 'antipv3', 'msgantipv', 'anticall'
  ]],
  ['Donos e VIP', [
    'addowner', 'removeowner', 'listowners',
    'addvip', 'removevip', 'listvips', 'vipall'
  ]],
  ['Grupos', [
    'sairgp', 'sairgps', 'leave', 'bangp', 'grupos',
    'addgpowner', 'removegpowner', 'listgpowner', 'transferirdono',
    'antiadmin', 'donogrupo', 'antiroubo', 'gpseguranca'
  ]],
  ['Sistema', [
    'menu_adm', 'menu_dk', 'dk', 'entrardk', 'nuke', 'nukeconfig', 'pair', 'clearsession',
    'repairsession', 'logs', 'hoststatus'
  ]]
];

function itemOf(name) {
  const n = String(name || '').toLowerCase();
  if (!n || ALIAS_SKIP.has(n)) return null;
  try {
    const { findItem } = require('./menuCatalog');
    const hit = findItem(n);
    if (hit) return { name: n, desc: hit.desc || n, usage: hit.usage || n };
  } catch (_) { /* */ }
  return { name: n, desc: n, usage: n };
}

function groupsOf(kind) {
  return kind === 'dono' ? DONO_GROUPS : ADM_GROUPS;
}

function itemsForRole(kind) {
  const out = [];
  const seen = new Set();
  for (const [, names] of groupsOf(kind)) {
    for (const n of names) {
      if (seen.has(n) || ALIAS_SKIP.has(n)) continue;
      const it = itemOf(n);
      if (!it) continue;
      seen.add(n);
      out.push(it);
    }
  }
  return out;
}

function sectionsForRole(kind, prefix = '.') {
  const { rowFromCatalogItem, WA_LIST_MAX_ROWS } = require('./menuCatalog');
  const per = Math.min(10, Number(WA_LIST_MAX_ROWS) || 10);
  const sections = [];
  for (const [title, names] of groupsOf(kind)) {
    const items = [];
    const seen = new Set();
    for (const n of names) {
      if (seen.has(n) || ALIAS_SKIP.has(n)) continue;
      const it = itemOf(n);
      if (!it) continue;
      seen.add(n);
      items.push(it);
    }
    if (!items.length) continue;
    for (let i = 0; i < items.length; i += per) {
      const chunk = items.slice(i, i + per);
      sections.push({
        title: items.length > per && i > 0
          ? `${title} ${Math.floor(i / per) + 1}`.slice(0, 24)
          : String(title).slice(0, 24),
        rows: chunk.map((it) => rowFromCatalogItem(it, prefix))
      });
    }
  }
  return sections.slice(0, 10);
}

function textForRole(kind, prefix = '.') {
  const p = prefix || '.';
  const title = kind === 'dono' ? 'MENU DONO' : 'MENU ADM';
  const hint = kind === 'dono'
    ? 'So o dono da sessao. Admin de grupo nao usa estes.'
    : 'Admin deste grupo (bot tambem admin) ou dono da sessao.';
  const lines = [
    previewText(title),
    previewText(`Prefixo: ${p}`),
    previewText(hint),
    ''
  ];
  for (const [sec, names] of groupsOf(kind)) {
    const items = names.map(itemOf).filter(Boolean);
    if (!items.length) continue;
    lines.push(previewText(sec));
    for (const it of items) {
      const u = String(it.usage || it.name).replace(/^[.\/!#•$]+/, '');
      lines.push(previewText(`${p}${u} — ${it.desc}`));
    }
    lines.push('');
  }
  lines.push(previewText(`Voltar: ${p}menu`));
  return lines.join('\n');
}

function introForRole(kind, prefix = '.') {
  const p = prefix || '.';
  if (kind === 'dono') {
    return previewText(
      `Menu Dono\nPrefixo: ${p}\n\nTudo que so o dono da sessao usa. Admin de grupo nao entra aqui.`
    );
  }
  return previewText(
    `Menu Adm\nPrefixo: ${p}\n\nTudo que o admin deste grupo pode usar. Dono tambem usa.`
  );
}

async function sendRoleMenu(conn, ctx, kind) {
  const dest = ctx.from || ctx.chatId || '';
  if (!dest) return null;
  const telegramUserId = ctx.telegramUserId || conn?._telegramUserId;
  const sessionId = ctx.sessionId || conn?._sessionId;
  const { displayPrefix } = require('./configManager');
  const prefix = conn?._isTelegramShim ? '/' : displayPrefix(telegramUserId);
  const { sendInteractiveList, sendButtonlessFallback } = require('../helpers');
  const { areButtonsOn } = require('./sessionRegistry');
  const buttonsOn = areButtonsOn(sessionId, telegramUserId) && !conn?._isTelegramShim;
  const fullText = textForRole(kind, prefix);
  if (!buttonsOn) {
    return sendButtonlessFallback(conn, dest, {
      text: fullText,
      quoted: ctx.info,
      telegramUserId,
      sessionId
    });
  }
  const sections = sectionsForRole(kind, prefix);
  if (!sections.length) {
    return sendButtonlessFallback(conn, dest, {
      text: fullText,
      quoted: ctx.info,
      telegramUserId,
      sessionId
    });
  }
  return sendInteractiveList(
    conn,
    dest,
    introForRole(kind, prefix),
    sections,
    'Hanork Bot',
    ctx.info,
    'menu.jpg',
    telegramUserId,
    sessionId
  );
}

function tgPayload(kind, telegramUserId, page = 0) {
  const { displayPrefix } = require('./configManager');
  const prefix = displayPrefix(telegramUserId) || '.';
  const items = itemsForRole(kind);
  const L = (t) => stripAccents(String(t || '')).trim();
  const per = 40;
  const pages = Math.max(1, Math.ceil(items.length / per));
  const p = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const slice = items.slice(p * per, p * per + per);
  const kb = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    const a = slice[i];
    row.push({
      text: L(`${prefix}${a.name}`).slice(0, 40),
      callback_data: `tg_cmd_${a.name}`
    });
    if (slice[i + 1]) {
      const b = slice[i + 1];
      row.push({
        text: L(`${prefix}${b.name}`).slice(0, 40),
        callback_data: `tg_cmd_${b.name}`
      });
    }
    kb.push(row);
  }
  const key = kind === 'dono' ? 'menu_dono' : 'menu_adm';
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: L('Anterior'), callback_data: `${key}_p${p - 1}` });
    nav.push({ text: L(`${p + 1}/${pages}`), callback_data: `${key}_p${p}` });
    if (p < pages - 1) nav.push({ text: L('Proximo'), callback_data: `${key}_p${p + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: L('Voltar'), callback_data: 'menu_main' }, { text: L('Fechar'), callback_data: 'close' }]);
  return {
    text: introForRole(kind, prefix) + '\n\nToque no comando (roda no WhatsApp) ou digite no grupo.',
    keyboard: kb
  };
}

module.exports = {
  ADM_GROUPS,
  DONO_GROUPS,
  itemsForRole,
  sectionsForRole,
  textForRole,
  introForRole,
  sendRoleMenu,
  tgPayload
};
