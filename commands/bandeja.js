'use strict';
const logger = require('../logger');
const { requireSessionOwner } = require('../utils/authorization');
const { isGroup } = require('../utils');
const {
  uidOf,
  getTemplate,
  setTexto,
  setMidia,
  clearTemplate,
  getMidiaBuffer,
  isReady,
  formatSummary,
  sendBandejaTodos,
  sendBandejaMembros,
  sendBandejaCanal,
  captureBandejaMedia
} = require('../utils/bandeja');
const { formatSendResult } = require('../utils/groupStatusV2');

const commands = {};

const HELP =
  'BANDEJA — status de grupo (V2)\n' +
  'Nao e chat. Vai pra bandeja do grupo (nao a aba Status pessoal).\n' +
  'Texto, foto, video ou legenda junto.\n' +
  'Default: so membros (admin nao ve). Use todos pra admin tambem ver.\n\n' +
  '.bandeja texto <legenda>\n' +
  '.bandeja foto  (mande ou responda foto)\n' +
  '.bandeja video (mande ou responda video)\n' +
  '.bandeja ver\n' +
  '.bandeja limpar\n' +
  '.postbandeja [membros|todos|canal]';

function reply(conn, ctx, text) {
  return conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
}

async function saveFoto(conn, ctx, uid) {
  const pack = await captureBandejaMedia(ctx, 'image');
  if (!pack) return reply(conn, ctx, 'Manda ou responde uma foto com .bandeja foto');
  setMidia(uid, pack.buffer, pack);
  const cap = String(pack.caption || '').trim();
  if (cap) setTexto(uid, cap);
  return reply(conn, ctx, 'Foto da bandeja salva.\n' + formatSummary(uid));
}

async function saveVideo(conn, ctx, uid) {
  const pack = await captureBandejaMedia(ctx, 'video') || await captureBandejaMedia(ctx, 'gif');
  if (!pack) return reply(conn, ctx, 'Manda ou responde um video com .bandeja video');
  setMidia(uid, pack.buffer, pack);
  const cap = String(pack.caption || '').trim();
  if (cap) setTexto(uid, cap);
  return reply(conn, ctx, 'Video da bandeja salvo.\n' + formatSummary(uid));
}

commands.bandeja = {
  useCtx: true,
  description: 'Edita o status de grupo (bandeja V2): texto/foto/video',
  usage: 'bandeja texto <legenda> | foto | video | ver | limpar',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const uid = uidOf(conn, ctx);
    const raw = String(ctx.text || '').trim();
    const args = Array.isArray(ctx.args) ? ctx.args.slice() : [];
    const sub = String(args[0] || '').toLowerCase();

    if (!sub && (ctx.isImage || ctx.hasMedia)) {
      if (ctx.isVideo || ctx.isGif) return saveVideo(conn, ctx, uid);
      return saveFoto(conn, ctx, uid);
    }

    if (!sub) {
      return reply(conn, ctx, HELP + '\n\n' + formatSummary(uid));
    }

    if (sub === 'ver' || sub === 'preview' || sub === 'status') {
      const tpl = getTemplate(uid);
      const pack = getMidiaBuffer(uid, tpl);
      const texto = formatSummary(uid);
      if (pack && pack.tipo === 'image') {
        return conn.sendMessage(ctx.from, { image: pack.buffer, caption: texto }, { quoted: ctx.info });
      }
      if (pack && (pack.tipo === 'video' || pack.tipo === 'gif')) {
        return conn.sendMessage(ctx.from, { video: pack.buffer, caption: texto }, { quoted: ctx.info });
      }
      return reply(conn, ctx, texto);
    }

    if (sub === 'limpar' || sub === 'clear' || sub === 'apagar') {
      clearTemplate(uid);
      return reply(conn, ctx, 'Bandeja limpa.');
    }

    if (sub === 'foto' || sub === 'img' || sub === 'image') {
      return saveFoto(conn, ctx, uid);
    }

    if (sub === 'video' || sub === 'gif') {
      return saveVideo(conn, ctx, uid);
    }

    if (sub === 'texto' || sub === 'txt' || sub === 'legenda' || sub === 'caption') {
      const rest = args.slice(1).join(' ').trim();
      if (!rest) return reply(conn, ctx, 'Uso: .bandeja texto <legenda>');
      setTexto(uid, rest);
      return reply(conn, ctx, 'Texto da bandeja salvo.\n' + formatSummary(uid));
    }

    if (sub === 'enviar' || sub === 'post' || sub === 'manda') {
      return commands.postbandeja.execute(conn, ctx);
    }

    setTexto(uid, raw);
    return reply(conn, ctx, 'Texto da bandeja salvo.\n' + formatSummary(uid));
  }
};

commands.postbandeja = {
  useCtx: true,
  description: 'Envia a bandeja V2 no grupo (membros ou todos) ou status de canal',
  usage: 'postbandeja [membros|todos|canal]',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const uid = uidOf(conn, ctx);
    if (!isReady(uid)) {
      return reply(conn, ctx, 'Nada pra enviar. Configure com .bandeja texto / .bandeja foto');
    }
    const tokens = (ctx.args || []).map((a) => String(a || '').toLowerCase());
    const wantCanal = tokens.includes('canal') || tokens.includes('channel') || tokens.includes('newsletter')
      || (ctx.args || []).some((a) => String(a).includes('@newsletter'));
    const mode = tokens.includes('todos') || tokens.includes('all') || tokens.includes('grupo') || tokens.includes('tray')
      ? 'todos'
      : (wantCanal ? 'canal' : 'membros');
    try {
      if (mode === 'canal') {
        const { resolveCanalJid } = require('../utils/groupStatusV2');
        const dest = resolveCanalJid((ctx.args || []).find((a) => String(a).includes('@newsletter')) || '');
        if (!dest) return reply(conn, ctx, 'Passe o JID @newsletter ou configure o canal oficial.');
        const r = await sendBandejaCanal(conn, dest, uid);
        return reply(conn, ctx, formatSendResult(r));
      }
      if (!isGroup(ctx.from)) {
        return reply(conn, ctx, 'Use .postbandeja dentro do grupo (ou .postbandeja canal).');
      }
      if (mode === 'todos') {
        const r = await sendBandejaTodos(conn, ctx.from, uid);
        return reply(conn, ctx, formatSendResult(r));
      }
      const r = await sendBandejaMembros(conn, ctx.from, uid);
      return reply(conn, ctx, formatSendResult(r));
    } catch (e) {
      logger.logErro('postbandeja', e.message);
      return reply(conn, ctx, 'Falha ao enviar a bandeja.');
    }
  }
};

module.exports = { commands };
