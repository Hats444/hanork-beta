// commands/downloads.js
// Menu de downloads (play / tiktok / instagram) — Hanork API
const logger = require('../logger');
const { createWhatsAppStatus } = require('../utils/statusProgress');
const { formatStatusBlock, formatReportBlock, labelValue } = require('../utils/typography');
const { applyForwardMode } = require('../utils/channelForward');
const { friendlyMediaError } = require('../utils/onboarding');
const { prefixFromCtx } = require('../utils/configManager');
const {
  playMedia,
  playVideoMedia,
  downloadTiktok,
  downloadInstagram,
  downloadFacebook,
  downloadSpotify,
  downloadMediafire,
  downloadTwitter,
  downloadKwai,
  downloadThreads,
  downloadCapcut,
  downloadSoundcloud,
  downloadPinterest,
  searchYoutube
} = require('../services/downloadService');

const commands = {};

function isWaOverlimit(err) {
  return /rate-overlimit|overlimit|timed out|timeout/i.test(String(err?.message || err || ''));
}

async function readSearchQuery(conn, ctx, emptyUso) {
  const { readSearchQuery: take } = require('../utils/searchQueryLimit');
  return take(conn, ctx, emptyUso);
}

async function sendWithForward(conn, jid, content, quoted, sessionId) {
  const sid = sessionId || conn?._sessionId;
  const opts = (q) => ({
    ...(q ? { quoted: q } : {}),
    skipForward: true,
    _hanorkTrusted: true
  });
  const isMedia = !!(
    content &&
    (content.audio || content.video || content.image || content.sticker || content.document)
  );
  // Selo de canal em audio/video faz o Zap marcar midia corrompida.
  // Texto do relatorio continua com selo.
  const payload = isMedia ? content : applyForwardMode(content, sid, { force: true });
  try {
    return await conn.sendMessage(jid, payload, opts(isMedia ? null : quoted));
  } catch (e) {
    if (!isWaOverlimit(e)) throw e;
    logger.logAviso(`[DL_SEND] overlimit, retry: ${String(e.message || e).slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 900));
    return conn.sendMessage(jid, content, opts(null));
  }
}

async function sendDlReport(conn, ctx, report) {
  if (!report) return;
  await sendWithForward(conn, ctx.from, { text: report }, ctx.info, ctx.sessionId);
}

function finishDlError(conn, ctx, status, tag, e) {
  const msg = String(e?.message || e);
  if (/connection closed|Connection Terminated|not connected/i.test(msg)) {
    logger.logAviso(`[${tag}] conexao WA caiu no meio do envio — tente de novo apos reconectar`);
  } else {
    logger.logErro(`[${tag}]`, msg);
  }
  const errText = friendlyMediaError(e);
  return Promise.resolve()
    .then(() => status.finish(formatStatusBlock(tag, [['Erro', errText]])))
    .catch(() => conn.sendMessage(ctx.from, { text: errText }, { quoted: ctx.info }).catch(() => {}));
}

/** Libera o handler: baixa/envia fora da fila, igual o blast da div. */
function runDlJob(conn, ctx, status, tag, work) {
  setImmediate(() => {
    Promise.resolve()
      .then(work)
      .catch((e) => finishDlError(conn, ctx, status, tag, e));
  });
}
async function sendAudioBuf(conn, jid, buffer, quoted, sessionId, extra = {}) {
  const base = String(extra.fileName || 'audio').replace(/\.[^.]+$/, '').slice(0, 60) || 'audio';
  const h = Buffer.isBuffer(buffer) ? buffer.slice(0, 16) : Buffer.alloc(0);
  const s = h.toString('utf8');
  const isMp3 =
    s.startsWith('ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && h[1] !== 0xd8);
  const isFtyp = buffer && buffer.slice(4, 8).toString('ascii') === 'ftyp';

  if (!isMp3) {
    try {
      const { toPlayableMp3 } = require('../services/stillAudioMux');
      const mp3 = await toPlayableMp3(buffer);
      return sendWithForward(conn, jid, {
        audio: mp3,
        mimetype: 'audio/mpeg',
        fileName: `${base}.mp3`,
        ptt: false
      }, quoted, sessionId);
    } catch (e) {
      logger.logAviso(`[DL_SEND] mp3 skip: ${e.message}`);
    }
  } else {
    return sendWithForward(conn, jid, {
      audio: buffer,
      mimetype: 'audio/mpeg',
      fileName: `${base}.mp3`,
      ptt: false
    }, quoted, sessionId);
  }

  // Sem ffmpeg: DASH/MP4 da API sai como video (o som toca). Melhor que sumir.
  if (isFtyp) {
    return sendWithForward(conn, jid, {
      video: buffer,
      mimetype: 'video/mp4'
    }, quoted, sessionId);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 * 1024) {
    throw new Error('Audio incompleto ou em formato que o Zap nao toca. Tente de novo.');
  }
  return sendWithForward(conn, jid, {
    audio: buffer,
    mimetype: extra.mimetype || 'audio/mpeg',
    fileName: `${base}.mp3`,
    ptt: false
  }, quoted, sessionId);
}

async function sendVideoBuf(conn, jid, buffer, quoted, sessionId, extra = {}) {
  const { isPlayableVideoBuffer, isRealMediaBuffer } = require('../services/zerotwoClient');
  if (!isPlayableVideoBuffer(buffer) && !isRealMediaBuffer(buffer)) {
    throw new Error('Video invalido/corrompido (nao e MP4). Tente o link de novo.');
  }
  if (!isPlayableVideoBuffer(buffer)) {
    throw new Error('Arquivo nao e video reproduzivel (HTML/JSON/audio). Tente outro link.');
  }
  return sendWithForward(conn, jid, {
    video: buffer,
    caption: extra.caption || undefined,
    mimetype: extra.mimetype || 'video/mp4'
  }, quoted, sessionId);
}

async function sendImageBuf(conn, jid, buffer, quoted, sessionId, extra = {}) {
  return sendWithForward(conn, jid, {
    image: buffer,
    caption: extra.caption || undefined
  }, quoted, sessionId);
}

async function sendDocBuf(conn, jid, buffer, quoted, sessionId, extra = {}) {
  return sendWithForward(conn, jid, {
    document: buffer,
    mimetype: extra.mimetype || 'application/octet-stream',
    fileName: extra.fileName || 'arquivo',
    caption: extra.caption || undefined
  }, quoted, sessionId);
}

/** Video real; se so foto+audio, junta num mp4. */
async function sendPreparedMedia(conn, ctx, media) {
  const { prepareDownloadMedia, isImageBuffer } = require('../services/stillAudioMux');
  const ready = await prepareDownloadMedia(media || {});
  if (ready.videoBuffer) {
    await sendVideoBuf(conn, ctx.from, ready.videoBuffer, ctx.info, ctx.sessionId);
    return 'video';
  }
  // Foto+audio: SEMPRE junta em 1 video. Nao manda separado.
  if (ready.imageBuffers?.length && ready.audioBuffer) {
    const { muxStillAndAudio } = require('../services/stillAudioMux');
    const muxed = await muxStillAndAudio(ready.imageBuffers[0], ready.audioBuffer);
    await sendVideoBuf(conn, ctx.from, muxed, ctx.info, ctx.sessionId);
    return 'video';
  }
  if (ready.imageBuffers?.length) {
    for (const buf of ready.imageBuffers) {
      await sendImageBuf(conn, ctx.from, buf, ctx.info, ctx.sessionId);
    }
    return 'images';
  }
  if (isImageBuffer(ready.mediaBuffer)) {
    await sendImageBuf(conn, ctx.from, ready.mediaBuffer, ctx.info, ctx.sessionId);
    return 'image';
  }
  if (ready.audioBuffer) {
    await sendAudioBuf(conn, ctx.from, ready.audioBuffer, ctx.info, ctx.sessionId);
    return 'audio';
  }
  if (ready.mediaBuffer) {
    if (ready.type === 'video') {
      await sendVideoBuf(conn, ctx.from, ready.mediaBuffer, ctx.info, ctx.sessionId);
      return 'video';
    }
    await sendImageBuf(conn, ctx.from, ready.mediaBuffer, ctx.info, ctx.sessionId);
    return 'image';
  }
  return null;
}

commands.play = {
  useCtx: true,
  description: 'Baixa audio do YouTube por nome ou link',
  usage: 'play <nome ou link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}play <nome da musica>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'PLAY');
    await status.update('Buscando', query);
    runDlJob(conn, ctx, status, 'PLAY', async () => {
      const media = await playMedia(query);
      await status.remove();
      const caption = formatReportBlock('PLAY', [
        labelValue('Titulo', media.title),
        labelValue('Duracao', media.duration || '-'),
        labelValue('Canal', media.channel || '-'),
        labelValue('Link', media.url)
      ]);
      await sendAudioBuf(conn, ctx.from, media.audioBuffer, ctx.info, ctx.sessionId, {
        fileName: `${(media.title || 'audio').slice(0, 60)}.mp3`
      });
      await sendDlReport(conn, ctx, caption);
    });
  }
};

commands.ytmp3 = commands.play;
commands.mp3 = commands.play;
commands.yt = commands.play;
commands.ytaudio = commands.play;
commands.playaudio = commands.play;

commands.tiktok = {
  useCtx: true,
  description: 'Baixa video do TikTok',
  usage: 'tiktok <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}tiktok <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'TIKTOK');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'TIKTOK', async () => {
      const media = await downloadTiktok(query);
      await status.update('Estado', 'enviando');
      await status.remove();
      const caption = formatReportBlock('TIKTOK', [
        labelValue('Titulo', media.title),
        labelValue('Autor', media.author || '-')
      ]);
      const kind = await sendPreparedMedia(conn, ctx, media);
      if (!kind) await sendDlReport(conn, ctx, 'Midia nao encontrada no resultado.');
      else await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.tt = commands.tiktok;
commands.tk = commands.tiktok;
commands.tkdl = commands.tiktok;

commands.instagram = {
  useCtx: true,
  description: 'Baixa midia do Instagram',
  usage: 'instagram <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}instagram <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'INSTAGRAM');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'INSTAGRAM', async () => {
      const media = await downloadInstagram(query);
      await status.remove();
      const caption = formatReportBlock('INSTAGRAM', [labelValue('Titulo', media.title)]);
      const kind = await sendPreparedMedia(conn, ctx, media);
      if (!kind) await sendDlReport(conn, ctx, 'Midia nao encontrada. API pode estar indisponivel.');
      else await sendDlReport(conn, ctx, caption);
    });
  }
};

commands.ig = commands.instagram;
commands.insta = commands.instagram;
commands.igdl = commands.instagram;
commands.igvideo = commands.instagram;
commands.instagram2 = commands.instagram;
commands.igpost = commands.instagram;
commands.igstory = commands.instagram;
commands.ighighlights = commands.instagram;

commands.playvideo = {
  useCtx: true,
  description: 'Baixa video do YouTube por nome ou link',
  usage: 'playvideo <nome ou link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}playvideo <nome ou link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'PLAYVIDEO');
    await status.update('Buscando', query);
    runDlJob(conn, ctx, status, 'PLAYVIDEO', async () => {
      const media = await playVideoMedia(query);
      try {
        const { isPlayableVideoBuffer } = require('../services/zerotwoClient');
        const { isImageBuffer } = require('../services/stillAudioMux');
        if (!isPlayableVideoBuffer(media.videoBuffer)) {
          const audio = await playMedia(query);
          media.audioBuffer = audio.audioBuffer;
          if (isImageBuffer(media.videoBuffer)) {
            media.imageBuffers = [media.videoBuffer];
            media.videoBuffer = null;
          }
        }
      } catch (_) { /* mux so se tiver foto+audio */ }
      await status.remove();
      const caption = formatReportBlock('PLAYVIDEO', [
        labelValue('Titulo', media.title),
        labelValue('Duracao', media.duration || '-'),
        labelValue('Link', media.url)
      ]);
      const kind = await sendPreparedMedia(conn, ctx, media);
      if (!kind) throw new Error('Video do YouTube nao veio reproduzivel.');
      await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.ytmp4 = commands.playvideo;
commands.playvid = commands.playvideo;
commands.ytv = commands.playvideo;
commands.ytvideo = commands.playvideo;

commands.facebook = {
  useCtx: true,
  description: 'Baixa video do Facebook',
  usage: 'facebook <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}facebook <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'FACEBOOK');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'FACEBOOK', async () => {
      const media = await downloadFacebook(query);
      await status.remove();
      if (!media.mediaBuffer) {
        await sendDlReport(conn, ctx, 'Video nao encontrado.');
        return;
      }
      const caption = formatReportBlock('FACEBOOK', [labelValue('Titulo', media.title)]);
      const kind = await sendPreparedMedia(conn, ctx, media);
      if (!kind) await sendDlReport(conn, ctx, 'Video nao encontrado.');
      else await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.fb = commands.facebook;
commands.facevideo = commands.facebook;

commands.spotify = {
  useCtx: true,
  description: 'Baixa audio do Spotify (link ou nome)',
  usage: 'spotify <link ou nome>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}spotify <link ou nome>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'SPOTIFY');
    await status.update('Buscando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'SPOTIFY', async () => {
      const media = await downloadSpotify(query);
      await status.update('Estado', 'enviando');
      await status.remove();
      if (!media.audioBuffer) {
        await sendDlReport(conn, ctx, 'Audio nao encontrado.');
        return;
      }
      const caption = formatReportBlock('SPOTIFY', [
        labelValue('Titulo', media.title),
        labelValue('Artista', media.artist || '-'),
        labelValue('Link', media.url || '-')
      ]);
      await sendAudioBuf(conn, ctx.from, media.audioBuffer, ctx.info, ctx.sessionId, {
        fileName: `${(media.title || 'spotify').slice(0, 60)}.mp3`
      });
      await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.spotifu = commands.spotify;
commands.spotfy = commands.spotify;
commands.spottify = commands.spotify;
commands.spotifyy = commands.spotify;

commands.mediafire = {
  useCtx: true,
  description: 'Baixa arquivo do MediaFire',
  usage: 'mediafire <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}mediafire <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'MEDIAFIRE');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'MEDIAFIRE', async () => {
      const media = await downloadMediafire(query);
      await status.remove();
      const caption = formatReportBlock('MEDIAFIRE', [
        labelValue('Nome', media.filename),
        labelValue('Tamanho', media.filesize),
        labelValue('Ext', media.extension || '-')
      ]);
      await sendDocBuf(conn, ctx.from, media.fileBuffer, ctx.info, ctx.sessionId, {
        mimetype: media.mimetype || 'application/octet-stream',
        fileName: media.filename
      });
      await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.mf = commands.mediafire;

commands.twitter = {
  useCtx: true,
  description: 'Baixa midia do Twitter/X',
  usage: 'twitter <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}twitter <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'TWITTER');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'TWITTER', async () => {
      const media = await downloadTwitter(query);
      await status.remove();
      const caption = formatReportBlock('TWITTER', [labelValue('Titulo', media.title)]);
      const items = media.items?.length ? media.items : (media.mediaBuffer ? [{ type: media.type, mediaBuffer: media.mediaBuffer }] : []);
      if (!items.length) {
        await sendDlReport(conn, ctx, 'Midia nao encontrada.');
        return;
      }
      for (const item of items) {
        const sent = await sendPreparedMedia(conn, ctx, item);
        if (!sent && item.mediaBuffer) {
          if (item.type === 'video') await sendVideoBuf(conn, ctx.from, item.mediaBuffer, ctx.info, ctx.sessionId);
          else await sendImageBuf(conn, ctx.from, item.mediaBuffer, ctx.info, ctx.sessionId);
        }
      }
      await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.x = commands.twitter;
commands.twtdl = commands.twitter;

commands.kwai = {
  useCtx: true,
  description: 'Baixa video do Kwai',
  usage: 'kwai <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}kwai <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'KWAI');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'KWAI', async () => {
      const media = await downloadKwai(query);
      await status.remove();
      const caption = formatReportBlock('KWAI', [
        labelValue('Titulo', media.title),
        labelValue('Autor', media.author || '-')
      ]);
      const kind = await sendPreparedMedia(conn, ctx, media);
      if (!kind) throw new Error('Video do Kwai nao veio reproduzivel.');
      await sendDlReport(conn, ctx, caption);
    });
  }
};

commands.threads = {
  useCtx: true,
  description: 'Baixa midia do Threads',
  usage: 'threads <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}threads <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'THREADS');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'THREADS', async () => {
      const media = await downloadThreads(query);
      await status.remove();
      const caption = formatReportBlock('THREADS', [
        labelValue('Titulo', media.title),
        labelValue('Autor', media.author || '-')
      ]);
      for (const item of (media.items || []).slice(0, 6)) {
        const sent = await sendPreparedMedia(conn, ctx, item);
        if (!sent && item.mediaBuffer) {
          if (item.type === 'video') await sendVideoBuf(conn, ctx.from, item.mediaBuffer, ctx.info, ctx.sessionId);
          else await sendImageBuf(conn, ctx.from, item.mediaBuffer, ctx.info, ctx.sessionId);
        }
      }
      await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.thdl = commands.threads;

commands.capcut = {
  useCtx: true,
  description: 'Baixa modelo CapCut',
  usage: 'capcut <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}capcut <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'CAPCUT');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'CAPCUT', async () => {
      const media = await downloadCapcut(query);
      await status.remove();
      const caption = formatReportBlock('CAPCUT', [
        labelValue('Titulo', media.title),
        labelValue('Views', media.views || '-')
      ]);
      const kind = await sendPreparedMedia(conn, ctx, media);
      if (!kind) throw new Error('Video CapCut nao veio reproduzivel.');
      await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.capcutmodel = commands.capcut;

commands.soundcloud = {
  useCtx: true,
  description: 'Baixa audio do SoundCloud',
  usage: 'soundcloud <link ou nome>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}soundcloud <link ou nome>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'SOUNDCLOUD');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'SOUNDCLOUD', async () => {
      const media = await downloadSoundcloud(query);
      await status.remove();
      if (!media.audioBuffer) {
        await sendDlReport(conn, ctx, 'Audio nao encontrado.');
        return;
      }
      const caption = formatReportBlock('SOUNDCLOUD', [
        labelValue('Titulo', media.title),
        labelValue('Artista', media.artist || '-')
      ]);
      await sendAudioBuf(conn, ctx.from, media.audioBuffer, ctx.info, ctx.sessionId, {
        fileName: `${(media.title || 'soundcloud').slice(0, 60)}.mp3`
      });
      await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.sc = commands.soundcloud;
commands.scloud = commands.soundcloud;

commands.pinterest = {
  useCtx: true,
  description: 'Baixa midia do Pinterest',
  usage: 'pinterest <link>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}pinterest <link>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'PINTEREST');
    await status.update('Baixando', query.slice(0, 80));
    runDlJob(conn, ctx, status, 'PINTEREST', async () => {
      const media = await downloadPinterest(query);
      await status.remove();
      const caption = formatReportBlock('PINTEREST', [labelValue('Titulo', media.title)]);
      const kind = await sendPreparedMedia(conn, ctx, media);
      if (!kind) await sendDlReport(conn, ctx, 'Midia nao encontrada.');
      else await sendDlReport(conn, ctx, caption);
    });
  }
};
commands.pinterestmp4 = commands.pinterest;
commands.pinmp4 = commands.pinterest;
commands.pindl = commands.pinterest;

commands.download = {
  useCtx: true,
  description: 'Menu de downloads',
  usage: 'download',
  execute: async (conn, ctx) => {
    const { sendCategoryPanel } = require('../utils/menuCatalog');
    await sendCategoryPanel(conn, {
      catId: 'downloads',
      chatId: ctx.from,
      quoted: ctx.info,
      telegramUserId: ctx.telegramUserId,
      sessionId: ctx.sessionId || conn?._sessionId,
      isGroup: !!ctx.isGroup,
      viewerRole: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
      viewerCtx: ctx
    });
  }
};

commands.downloads = commands.download;
commands.ytsearch = {
  useCtx: true,
  description: 'Busca no YouTube sem baixar',
  usage: 'ytsearch <termo>',
  execute: async (conn, ctx) => {
    const query = await readSearchQuery(conn, ctx, `Uso: ${prefixFromCtx(ctx)}ytsearch <termo>`);
    if (!query) return;
    const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'YT SEARCH');
    await status.update('Buscando', query);
    runDlJob(conn, ctx, status, 'YT SEARCH', async () => {
      const list = await searchYoutube(query);
      if (!list.length) {
        await status.finish(formatStatusBlock('YT SEARCH', [['Estado', 'nenhum resultado']]));
        return;
      }
      const rows = [labelValue('Consulta', query), labelValue('Resultados', list.length), ''];
      list.slice(0, 8).forEach((r, i) => {
        rows.push(`${i + 1}. ${r.title}`);
        rows.push(`   ${r.duration || '-'} | ${r.url}`);
      });
      rows.push('', labelValue('Dica', `${prefixFromCtx(ctx)}play <nome>`));
      await status.finish(formatReportBlock('YT SEARCH', rows));
    });
  }
};

module.exports = { commands };

module.exports = { commands };


