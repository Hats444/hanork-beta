'use strict';
/** Comandos migrados Duda / Zero Two Beta — nomes da auditoria. */

const { previewText, labelValue } = require('../utils/typography');
const shop = require('../utils/shopStore');
const botGate = require('../utils/botGate');

const commands = {};

function pfx(ctx) {
  try {
    return require('../utils/configManager').prefixFromCtx(ctx) || '.';
  } catch (_) {
    return '.';
  }
}

function uidOf(ctx, conn) {
  return String(ctx.telegramUserId || conn?._telegramUserId || '').trim();
}

function needGroup(conn, ctx) {
  if (ctx.isGroup) return true;
  conn.sendMessage(ctx.from, { text: 'Use no grupo.' }, { quoted: ctx.info });
  return false;
}

function needOwner(conn, ctx) {
  try {
    const { isFreshSessionOwner } = require('../utils/authorization');
    if (isFreshSessionOwner(ctx)) {
      ctx.isOwner = true;
      return true;
    }
  } catch (_) {
    if (ctx.isOwner) return true;
  }
  conn.sendMessage(ctx.from, { text: 'So o dono da sessao.' }, { quoted: ctx.info });
  return false;
}

function needAdm(conn, ctx) {
  if (!needGroup(conn, ctx)) return false;
  try {
    const { isFreshSessionOwner } = require('../utils/authorization');
    if (isFreshSessionOwner(ctx)) return true;
  } catch (_) {
    if (ctx.isOwner) return true;
  }
  try {
    const { isGroupAdminActor } = require('../utils/commandGate');
    if (isGroupAdminActor(ctx)) return true;
  } catch (_) { /* */ }
  if (ctx.isAdmin || ctx.authRole === 'group_admin') return true;
  conn.sendMessage(ctx.from, { text: 'So admin deste grupo.' }, { quoted: ctx.info });
  return false;
}

async function downloadQuotedOrOwn(conn, ctx) {
  if (typeof ctx.downloadMedia === 'function') {
    try {
      const buf = await ctx.downloadMedia();
      if (buf && buf.length) {
        const msg = ctx.info?.message || {};
        const q = msg.extendedTextMessage?.contextInfo?.quotedMessage
          || msg.imageMessage
          || null;
        const node =
          q?.imageMessage || q?.videoMessage || q?.audioMessage || q?.stickerMessage
          || msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.stickerMessage;
        const keyName = node && node.mimetype && String(node.mimetype).includes('webp')
          ? 'stickerMessage'
          : (msg.audioMessage || q?.audioMessage ? 'audioMessage' : 'imageMessage');
        return { buf: Buffer.from(buf), node: node || {}, keyName };
      }
    } catch (_) { /* fallback */ }
  }
  const msg = ctx.info?.message || {};
  const q = msg.extendedTextMessage?.contextInfo?.quotedMessage || null;
  const node =
    q?.imageMessage || q?.videoMessage || q?.audioMessage || q?.stickerMessage || q?.documentMessage ||
    msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.stickerMessage;
  if (!node) return null;
  const keyName = q?.imageMessage || msg.imageMessage ? 'imageMessage'
    : q?.videoMessage || msg.videoMessage ? 'videoMessage'
      : q?.audioMessage || msg.audioMessage ? 'audioMessage'
        : q?.stickerMessage || msg.stickerMessage ? 'stickerMessage'
          : 'documentMessage';
  const fake = {
    key: ctx.info?.key || { remoteJid: ctx.from, id: ctx.messageId, fromMe: false },
    message: { [keyName]: node }
  };
  const opts = {};
  if (conn?.updateMediaMessage) opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
  const { downloadMediaMessage } = require('@systemzero/baileys');
  const buf = await downloadMediaMessage(fake, 'buffer', {}, opts);
  return buf && buf.length ? { buf: Buffer.from(buf), node, keyName } : null;
}

async function reply(conn, ctx, text) {
  return conn.sendMessage(ctx.from, { text: previewText(text) }, { quoted: ctx.info });
}

commands.tabela = {
  useCtx: true,
  description: 'Mostra o cardapio do grupo',
  usage: 'tabela',
  execute: async (conn, ctx) => {
    if (!needGroup(conn, ctx)) return;
    const body = await shop.getText(uidOf(ctx, conn), ctx.from, 'tabela');
    if (!body) return reply(conn, ctx, `Vazio. Admin: ${pfx(ctx)}settabela texto`);
    return reply(conn, ctx, body);
  }
};

commands.settabela = {
  useCtx: true,
  description: 'Define o cardapio do grupo',
  usage: 'settabela <texto>',
  execute: async (conn, ctx) => {
    if (!needAdm(conn, ctx)) return;
    const t = String(ctx.text || '').trim();
    if (!t) return reply(conn, ctx, `Uso: ${pfx(ctx)}settabela Pizza 30`);
    await shop.setText(uidOf(ctx, conn), ctx.from, 'tabela', t);
    return reply(conn, ctx, 'Tabela salva.');
  }
};

commands.nota = {
  useCtx: true,
  description: 'Recado fixo do grupo',
  usage: 'nota [texto]',
  execute: async (conn, ctx) => {
    if (!needGroup(conn, ctx)) return;
    const t = String(ctx.text || '').trim();
    if (!t) {
      const body = await shop.getText(uidOf(ctx, conn), ctx.from, 'nota');
      return reply(conn, ctx, body || `Vazio. Admin: ${pfx(ctx)}nota texto`);
    }
    if (/^(off|0)$/i.test(t)) {
      if (!needAdm(conn, ctx)) return;
      await shop.setText(uidOf(ctx, conn), ctx.from, 'nota', '');
      return reply(conn, ctx, 'Nota apagada.');
    }
    if (!needAdm(conn, ctx)) return;
    await shop.setText(uidOf(ctx, conn), ctx.from, 'nota', t);
    return reply(conn, ctx, 'Nota salva.');
  }
};

commands.sorteio = {
  useCtx: true,
  description: 'Sorteio por nomes ou por reacao',
  usage: 'sorteio Ana, Bia | sorteio reacao [n] [texto] | sorteio fim',
  execute: async (conn, ctx) => {
    if (!needAdm(conn, ctx)) return;
    const raw = String(ctx.text || '').trim();
    const low = raw.toLowerCase();
    if (low === 'fim' || low.startsWith('fim ')) {
      const row = await shop.getRaffle(uidOf(ctx, conn), ctx.from);
      if (!row) return reply(conn, ctx, 'Nenhum sorteio aberto.');
      const pool = String(row.participants || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (pool.length < 1) {
        await shop.clearRaffle(uidOf(ctx, conn), ctx.from);
        return reply(conn, ctx, 'Ninguem reagiu.');
      }
      const n = Math.min(Number(row.winners_n) || 1, pool.length);
      const copy = [...pool];
      const wins = [];
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        wins.push(copy.splice(idx, 1)[0]);
      }
      await shop.clearRaffle(uidOf(ctx, conn), ctx.from);
      const tags = wins.map((j) => `@${String(j).split('@')[0]}`);
      return conn.sendMessage(ctx.from, {
        text: `Sorteado: ${tags.join(', ')}`,
        mentions: wins
      }, { quoted: ctx.info });
    }
    if (low.startsWith('reacao') || low.startsWith('reação')) {
      const rest = raw.replace(/^rea[cç]ao\s*/i, '').trim();
      const m = rest.match(/^(\d+)\s*(.*)$/);
      const n = m ? Math.max(1, parseInt(m[1], 10) || 1) : 1;
      const prompt = (m ? m[2] : rest).trim() || 'Reaja pra participar.';
      const sent = await conn.sendMessage(ctx.from, {
        text: `${prompt}\nReaja nesta msg. Ganhadores: ${n}. Admin: ${pfx(ctx)}sorteio fim`
      }, { quoted: ctx.info });
      const mid = sent?.key?.id;
      if (!mid) return reply(conn, ctx, 'Nao abri o sorteio.');
      await shop.startRaffle(uidOf(ctx, conn), ctx.from, mid, n, prompt);
      return;
    }
    let pool = [];
    if (raw) {
      pool = raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      await shop.setSorteioNames(uidOf(ctx, conn), ctx.from, pool);
    } else {
      pool = await shop.getSorteioNames(uidOf(ctx, conn), ctx.from);
    }
    if (pool.length < 2) {
      return reply(conn, ctx, `Uso:\n${pfx(ctx)}sorteio Ana, Bia, Caio\n${pfx(ctx)}sorteio reacao 1 Reaja pra ganhar\n${pfx(ctx)}sorteio fim`);
    }
    const win = pool[Math.floor(Math.random() * pool.length)];
    return reply(conn, ctx, labelValue('Sorteado', win));
  }
};

commands.atividade = {
  useCtx: true,
  description: 'Quem mais fala no grupo',
  usage: 'atividade',
  execute: async (conn, ctx) => {
    if (!needAdm(conn, ctx)) return;
    const rows = await shop.topActivity(uidOf(ctx, conn), ctx.from, 10);
    if (!rows.length) return reply(conn, ctx, 'Ainda sem contagem neste grupo.');
    const lines = rows.map((r, i) => `${i + 1}. ${String(r.member_jid).split('@')[0]} — ${r.n}`);
    return reply(conn, ctx, `Atividade\n${lines.join('\n')}`);
  }
};

commands.inativos = {
  useCtx: true,
  description: 'Quem pouco fala',
  usage: 'inativos [n]',
  execute: async (conn, ctx) => {
    if (!needAdm(conn, ctx)) return;
    const max = Math.max(0, parseInt(ctx.args?.[0] || '0', 10) || 0);
    let rows = await shop.lowActivity(uidOf(ctx, conn), ctx.from, max);
    if (!rows.length) {
      try {
        const { listGhostCandidates } = require('../utils/moderation');
        const ghosts = await listGhostCandidates(conn, ctx.from, uidOf(ctx, conn), max);
        rows = (ghosts || []).map((g) => ({ member_jid: g.id, n: g.msgs }));
      } catch (_) { /* */ }
    }
    if (!rows.length) return reply(conn, ctx, 'Ninguem com poucas msgs na contagem.');
    const lines = rows.slice(0, 20).map((r) => `${String(r.member_jid).split('@')[0]} — ${r.n}`);
    return reply(conn, ctx, `Inativos (<=${max})\n${lines.join('\n')}`);
  }
};

function parseHm(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

commands.horariogrupo = {
  useCtx: true,
  description: 'Abre e fecha o grupo todo dia',
  usage: 'horariogrupo HH:mm HH:mm|off',
  execute: async (conn, ctx) => {
    if (!needAdm(conn, ctx)) return;
    const a = ctx.args || [];
    if (String(a[0] || '').toLowerCase() === 'off') {
      const cur = await shop.getHours(uidOf(ctx, conn), ctx.from);
      if (cur) await shop.setHours(uidOf(ctx, conn), ctx.from, cur.open_hm, cur.close_hm, false);
      return reply(conn, ctx, 'Horario desligado.');
    }
    const open = parseHm(a[0]);
    const close = parseHm(a[1]);
    if (!open || !close) return reply(conn, ctx, `Uso: ${pfx(ctx)}horariogrupo 08:00 18:00`);
    await shop.setHours(uidOf(ctx, conn), ctx.from, open, close, true);
    return reply(conn, ctx, `Abre ${open} / fecha ${close} (BRT).`);
  }
};

commands.figquote = {
  useCtx: true,
  description: 'Figurinha com o texto',
  usage: 'figquote <texto>',
  execute: async (conn, ctx) => {
    const t = String(ctx.text || '').trim();
    if (!t) return reply(conn, ctx, `Uso: ${pfx(ctx)}figquote bom dia`);
    try {
      const { quotePng } = require('../utils/shopMedia');
      const png = await quotePng(t);
      const { sendSticker } = require('../services/stickerService');
      await sendSticker(conn, ctx.from, png, ctx.info, { kind: 'image' });
    } catch (e) {
      return reply(conn, ctx, 'Nao montou a figurinha.');
    }
  }
};

async function saveBv(conn, ctx, kind) {
  if (!needAdm(conn, ctx)) return;
  const t = String(ctx.text || '').trim().toLowerCase();
  if (t === 'off' || t === '0') {
    await shop.deleteWelcomeMedia(uidOf(ctx, conn), ctx.from, kind);
    return reply(conn, ctx, 'Midia de BV removida.');
  }
  const got = await downloadQuotedOrOwn(conn, ctx);
  if (!got) return reply(conn, ctx, 'Responda a foto, figurinha ou audio.');
  const ok = await shop.setWelcomeMedia(uidOf(ctx, conn), ctx.from, kind, got.buf, got.node?.mimetype);
  if (!ok) return reply(conn, ctx, 'Arquivo grande demais.');
  const label = kind.includes('audio') ? 'Audio' : (kind.includes('fig') ? 'Fig' : 'Foto');
  const lado = kind.includes('saiu') ? 'saida' : 'entrada';
  return reply(conn, ctx, `${label} de ${lado} salva. Liga com ${pfx(ctx)}bemvindo on`);
}

commands.fotobv = {
  useCtx: true,
  description: 'Foto de boas-vindas',
  usage: 'fotobv (responda foto) | off',
  execute: (conn, ctx) => saveBv(conn, ctx, 'foto')
};

commands.figbv = {
  useCtx: true,
  description: 'Figurinha de boas-vindas',
  usage: 'figbv (responda fig ou foto) | off',
  execute: (conn, ctx) => saveBv(conn, ctx, 'fig')
};

commands.audiobv = {
  useCtx: true,
  description: 'Audio de boas-vindas',
  usage: 'audiobv (responda audio) | off',
  execute: (conn, ctx) => saveBv(conn, ctx, 'audio')
};

commands.fotosaida = {
  useCtx: true,
  description: 'Foto de saida',
  usage: 'fotosaida (responda foto) | off',
  execute: (conn, ctx) => saveBv(conn, ctx, 'foto_saiu')
};
commands.figsaida = {
  useCtx: true,
  description: 'Figurinha de saida',
  usage: 'figsaida (responda) | off',
  execute: (conn, ctx) => saveBv(conn, ctx, 'fig_saiu')
};
commands.audiosaida = {
  useCtx: true,
  description: 'Audio de saida',
  usage: 'audiosaida (responda) | off',
  execute: (conn, ctx) => saveBv(conn, ctx, 'audio_saiu')
};

commands.bvstatus = {
  useCtx: true,
  description: 'O que esta configurado no bem-vindo',
  usage: 'bvstatus',
  execute: async (conn, ctx) => {
    if (!needGroup(conn, ctx)) return;
    const { statusLines, howto } = require('../utils/welcomeKit');
    const lists = require('../utils/moderation').getGroupLists(ctx.from, uidOf(ctx, conn));
    const st = await statusLines(uidOf(ctx, conn), ctx.from, lists);
    return reply(conn, ctx, `${st}\n\n${howto(pfx(ctx))}`);
  }
};

commands.reagircanal = {
  useCtx: true,
  description: 'Reage numa msg de canal',
  usage: 'reagircanal <link> <emoji>',
  execute: async (conn, ctx) => {
    if (!needOwner(conn, ctx)) return;
    const parts = String(ctx.text || '').trim().split(/\s+/);
    const link = parts[0] || '';
    const emoji = parts.slice(1).join(' ').trim() || '✅';
    const m = link.match(/whatsapp\.com\/channel\/([^/\s]+)\/([^/\s]+)/i);
    if (!m) return reply(conn, ctx, `Uso: ${pfx(ctx)}reagircanal <link da msg> ✅`);
    if (typeof conn.newsletterReactMessage !== 'function') {
      return reply(conn, ctx, 'Este WhatsApp nao reage em canal.');
    }
    try {
      const meta = await conn.newsletterMetadata('invite', m[1]);
      const jid = meta?.id || meta?.jid;
      if (!jid) throw new Error('canal');
      await conn.newsletterReactMessage(jid, m[2], emoji);
      return reply(conn, ctx, 'Reacao enviada.');
    } catch (e) {
      return reply(conn, ctx, 'Falhou. Confere o link.');
    }
  }
};

commands.ausente = {
  useCtx: true,
  description: 'Marca ausencia (adm)',
  usage: 'ausente [texto]|off',
  execute: async (conn, ctx) => {
    if (!needAdm(conn, ctx)) return;
    const t = String(ctx.text || '').trim();
    const me = String(ctx.sender || '');
    if (!me) return;
    if (!t || /^off$/i.test(t)) {
      await shop.clearAusente(uidOf(ctx, conn), me);
      return reply(conn, ctx, 'Ausente off.');
    }
    await shop.setAusente(uidOf(ctx, conn), me, t);
    return reply(conn, ctx, 'Ausente on.');
  }
};

commands.tomp3 = {
  useCtx: true,
  description: 'Converte audio/video em mp3',
  usage: 'tomp3 (responda)',
  execute: async (conn, ctx) => {
    const got = await downloadQuotedOrOwn(conn, ctx);
    if (!got) return reply(conn, ctx, 'Responda um audio ou video.');
    try {
      const { toMp3 } = require('../utils/shopMedia');
      const mp3 = await toMp3(got.buf);
      await conn.sendMessage(ctx.from, { audio: mp3, mimetype: 'audio/mpeg' }, { quoted: ctx.info });
    } catch (e) {
      return reply(conn, ctx, 'Nao converteu.');
    }
  }
};

commands.audiofx = {
  useCtx: true,
  description: 'Efeito no audio',
  usage: 'audiofx grave|agudo|rapido|lento|eco (responda)',
  execute: async (conn, ctx) => {
    const fx = String(ctx.args?.[0] || ctx.text || '').toLowerCase().trim();
    const { audioFx, FX_NAMES } = require('../utils/shopMedia');
    if (!FX_NAMES.includes(fx)) {
      return reply(conn, ctx, `Uso: ${pfx(ctx)}audiofx ${FX_NAMES.join('|')} (responda)`);
    }
    const got = await downloadQuotedOrOwn(conn, ctx);
    if (!got) return reply(conn, ctx, 'Responda um audio.');
    try {
      const mp3 = await audioFx(got.buf, fx);
      await conn.sendMessage(ctx.from, { audio: mp3, mimetype: 'audio/mpeg', ptt: true }, { quoted: ctx.info });
    } catch (e) {
      return reply(conn, ctx, 'Nao aplicou o efeito.');
    }
  }
};

commands.tts = {
  useCtx: true,
  description: 'Texto em audio',
  usage: 'tts <texto>',
  execute: async (conn, ctx) => {
    const t = String(ctx.text || '').trim();
    if (!t) return reply(conn, ctx, `Uso: ${pfx(ctx)}tts ola`);
    try {
      const zt = require('../services/zerotwoClient');
      const { buffer } = await zt.fetchBufferFromApi('/api/ia/tts', { query: t, texto: t }, 25000);
      if (!buffer || !buffer.length) throw new Error('vazio');
      await conn.sendMessage(ctx.from, { audio: buffer, mimetype: 'audio/mpeg', ptt: true }, { quoted: ctx.info });
    } catch (e) {
      return reply(conn, ctx, 'TTS fora do ar.');
    }
  }
};

function parseBotiOnOff(ctx) {
  const raw = `${ctx.text || ''} ${(ctx.args || []).join(' ')}`.toLowerCase();
  if (/\b(off|desliga|desligar|0)\b/.test(raw)) return true;
  if (/\b(on|liga|ligar|1)\b/.test(raw)) return false;
  return null;
}

async function setBot(conn, ctx, off) {
  if (!needOwner(conn, ctx)) return;
  await botGate.setBotOff(uidOf(ctx, conn), off);
  return reply(conn, ctx, off ? 'Bot off. So o dono usa comando.' : 'Bot on. Comandos liberados.');
}

commands.boti = {
  useCtx: true,
  description: 'Liga/desliga comandos pra todos',
  usage: 'boti on|off',
  execute: async (conn, ctx) => {
    if (!needOwner(conn, ctx)) return;
    const off = parseBotiOnOff(ctx);
    if (off === null) {
      const cur = botGate.isBotOff(uidOf(ctx, conn));
      return reply(conn, ctx, cur
        ? `Bot off. ${pfx(ctx)}boti on pra liberar.`
        : `Bot on. ${pfx(ctx)}boti off pra so o dono usar.`);
    }
    return setBot(conn, ctx, off);
  }
};

commands.boton = {
  useCtx: true,
  description: 'Liga comandos pra todos',
  usage: 'boton',
  execute: (conn, ctx) => setBot(conn, ctx, false)
};
commands.botion = commands.boton;

commands.botoff = {
  useCtx: true,
  description: 'Desliga comandos (so dono)',
  usage: 'botoff',
  execute: (conn, ctx) => setBot(conn, ctx, true)
};
commands.botioof = commands.botoff;

module.exports = { commands };
