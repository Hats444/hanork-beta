// utils/divulgacao.js (modificado)
const fs = require('fs');
const path = require('path');
const { getUserDir } = require('./userManager');

function getDivulgacaoPath(telegramUserId) {
  const userDir = getUserDir(telegramUserId);
  const configDir = path.join(userDir, 'config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'divulgacao.json');
}

function mediaDir(telegramUserId) {
  return path.dirname(getDivulgacaoPath(telegramUserId));
}

function mediaAbs(telegramUserId, fileName) {
  if (!fileName) return null;
  return path.join(mediaDir(telegramUserId), path.basename(String(fileName)));
}

function writeMediaFile(telegramUserId, slot, buffer) {
  const file = 'div-' + slot + '.bin';
  const abs = mediaAbs(telegramUserId, file);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, buffer);
  return file;
}

function readMediaFile(telegramUserId, fileName) {
  const abs = mediaAbs(telegramUserId, fileName);
  if (!abs || !fs.existsSync(abs)) return null;
  try { return fs.readFileSync(abs); } catch (_) { return null; }
}

function unlinkMediaFile(telegramUserId, fileName) {
  const abs = mediaAbs(telegramUserId, fileName);
  if (!abs) return;
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch (_) { /* */ }
}

function bufferFromStored(telegramUserId, stored, fileName) {
  const fromFile = readMediaFile(telegramUserId, fileName);
  if (fromFile && fromFile.length) return fromFile;
  if (typeof stored === 'string' && stored.length > 40 && !stored.startsWith('[')) {
    try { return Buffer.from(stored, 'base64'); } catch (_) { /* */ }
  }
  return null;
}

function unwrapLocal(msg) {
  let m = msg;
  if (!m || typeof m !== 'object') return m;
  if (m.message && !m.imageMessage && !m.videoMessage && !m.audioMessage && !m.documentMessage) {
    m = m.message;
  }
  for (let i = 0; i < 6; i++) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m;
}

function protoNode(inner) {
  if (!inner || typeof inner !== 'object') return {};
  return inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.documentMessage || {};
}

function kindFromProto(inner) {
  if (!inner || typeof inner !== 'object') return null;
  if (inner.imageMessage) return 'image';
  if (inner.videoMessage?.gifPlayback) return 'gif';
  if (inner.videoMessage) return 'video';
  if (inner.audioMessage) return 'audio';
  if (inner.documentMessage) return 'document';
  return null;
}

function kindMatches(want, got) {
  if (!got) return false;
  if (want === got) return true;
  if (want === 'gif' && got === 'video') return true;
  if (want === 'video' && got === 'gif') return true;
  return false;
}

async function captureMediaFromCtx(ctx, kind) {
  const direct = unwrapLocal(ctx.mediaMessage || ctx.message);
  const quoted = unwrapLocal(ctx.quoted?.message);
  const inner = kindFromProto(direct) ? direct : quoted;
  const gotKind = kindFromProto(inner) || (
    ctx.isImage ? 'image' :
    ctx.isGif ? 'gif' :
    ctx.isVideo ? 'video' :
    ctx.isAudio ? 'audio' :
    ctx.isDocument ? 'document' : null
  );
  if (!kindMatches(kind, gotKind) || !inner) return null;

  let buffer = null;
  if (typeof ctx.downloadMedia === 'function') {
    try { buffer = await ctx.downloadMedia(); } catch (_) { buffer = null; }
  }
  if (!buffer || !buffer.length) {
    try {
      const { downloadMediaMessage } = require('@systemzero/baileys');
      const isQuoted = inner === quoted && quoted;
      const fakeMsg = {
        key: {
          remoteJid: ctx.from,
          id: isQuoted
            ? (ctx.quoted?.stanzaId || ctx.quoted?.key?.id || ctx.key?.id)
            : ctx.key?.id,
          fromMe: false,
          participant: isQuoted
            ? (ctx.quoted?.participant || ctx.quoted?.sender || ctx.sender)
            : ctx.sender
        },
        message: inner
      };
      const opts = {};
      const conn = ctx.conn;
      if (conn?.updateMediaMessage) opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
      buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, opts);
    } catch (_) {
      return null;
    }
  }
  if (!buffer || !buffer.length) return null;
  const node = protoNode(inner);
  return {
    buffer,
    mimetype: node.mimetype || (
      kind === 'image' ? 'image/jpeg' :
      kind === 'audio' ? 'audio/mpeg' :
      kind === 'document' ? 'application/octet-stream' : 'video/mp4'
    ),
    caption: node.caption || ctx.caption || '',
    fileName: node.fileName || null,
    tipo: kind === 'gif' ? 'gif' : kind
  };
}

function carregarConfig(telegramUserId) {
  const uid = String(telegramUserId || '');
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('divulgacao', uid);
      if (hit && typeof hit === 'object') {
        // Midia pesada continua no JSON se existir
        const file = getDivulgacaoPath(telegramUserId);
        if (fs.existsSync(file)) {
          try {
            const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (disk.midiaFile && !hit.midiaFile) hit.midiaFile = disk.midiaFile;
            if (disk.midia && (!hit.midia || String(hit.midia).startsWith('['))) {
              hit.midia = disk.midia;
              hit.midiaTipo = disk.midiaTipo || hit.midiaTipo;
              hit.midiaMimetype = disk.midiaMimetype || hit.midiaMimetype;
            }
            if (disk.cta && typeof disk.cta === 'object') {
              hit.cta = { ...(hit.cta || {}), ...(disk.cta || {}) };
            }
          } catch (_) { /* ignore */ }
        }
        offloadHeavyMedia(uid, hit);
        return migrateDivulgacao(hit);
      }
    }
  } catch (_) { /* fallback */ }

  const file = getDivulgacaoPath(telegramUserId);
  try {
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      try {
        const { slimDivulgacao } = require('./sqlStore');
        require('./sqlStore').upsertKv('divulgacao', uid, slimDivulgacao(cfg));
      } catch (_) { /* */ }
      return migrateDivulgacao(cfg);
    }
  } catch (e) {}
  return defaultDivulgacao();
}

function migrateDivulgacao(cfg) {
  if (!cfg || typeof cfg !== 'object') return defaultDivulgacao();
  if (cfg.textoPay == null) cfg.textoPay = '';
  if (cfg.cta && typeof cfg.cta === 'object') {
    if (!String(cfg.cta.texto || '').trim() && (cfg.cta.label || cfg.cta.url) && cfg.texto) {
      cfg.cta.texto = cfg.texto;
    }
  }
  if (cfg.delayMsg === 3000) cfg.delayMsg = 1200;
  if (cfg.delayGrupo === 2000) cfg.delayGrupo = 800;
  return cfg;
}

const CTA_LABEL_MAX = 20;

function defaultDivulgacao() {
  return {
    texto: '',
    textoPay: '',
    midia: null,
    midiaTipo: null,
    midiaMimetype: null,
    legenda: '',
    configurado: false,
    modoPrincipal: 'normal',
    statusAtivo: false,
    quantidade: 1,
    midiaFile: null,
    delayMsg: 1200,
    delayGrupo: 800,
    ordem: 'sequencial',
    repetir: false,
    grupos: [],
    modoGrupos: 'especificos',
    cta: null
  };
}

function normalizeCtaUrl(raw) {
  let u = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!u) return null;
  u = u.split(/\s+/)[0];
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function clampCtaLabel(raw) {
  const label = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!label) return '';
  return label.slice(0, CTA_LABEL_MAX);
}

function parseCtaParts(raw) {
  const segs = String(raw || '').split('|').map(s => s.trim());
  while (segs.length && segs[segs.length - 1] === '') segs.pop();
  if (segs.length >= 3) {
    return {
      texto: segs.slice(0, -2).join(' | ').trim(),
      label: segs[segs.length - 2],
      url: segs[segs.length - 1]
    };
  }
  if (segs.length === 2) {
    return { texto: '', label: segs[0], url: segs[1] };
  }
  return null;
}

function isCtaReady(config) {
  const texto = String(config?.cta?.texto || '').trim();
  const label = String(config?.cta?.label || '').trim();
  const url = normalizeCtaUrl(config?.cta?.url);
  return !!(texto && label && url);
}

function ctaMissing(config) {
  const miss = [];
  if (!String(config?.cta?.texto || '').trim()) miss.push('texto da mensagem CTA');
  if (!String(config?.cta?.label || '').trim()) miss.push('texto do botao');
  if (!normalizeCtaUrl(config?.cta?.url)) miss.push('link');
  return miss;
}

function isTextoReady(config) {
  return !!String(config?.texto || '').trim();
}

function isPayReady(config) {
  return !!String(config?.textoPay || '').trim();
}

function formatCtaSummary(config) {
  const texto = String(config?.cta?.texto || '').trim();
  const label = String(config?.cta?.label || '').trim();
  const url = config?.cta?.url || '';
  const hasFoto = !!(config?.cta?.midiaFile) ||
    !!(config?.cta?.midia && !String(config.cta.midia).startsWith('[')) ||
    (config?.midiaTipo === 'image' && (!!config?.midiaFile || !!config?.midia));
  const ready = isCtaReady(config);
  const miss = ctaMissing(config);
  let out = ready ? 'CTA: pronto\n' : `CTA: incompleto${miss.length ? ' (falta ' + miss.join(', ') + ')' : ''}\n`;
  out += `Texto CTA: ${texto ? texto.substring(0, 120) + (texto.length > 120 ? '...' : '') : '(vazio)'}\n`;
  out += `Botao: ${label || '(vazio)'}\n`;
  out += `Link: ${url || '(vazio)'}\n`;
  out += `Foto CTA: ${hasFoto ? 'sim' : 'nao — manda a foto (botao Foto CTA ou .fotodivulcta)'}`;
  return out;
}

function getCtaImageBuffer(config, telegramUserId) {
  const cta = config?.cta;
  if (cta?.midiaFile && telegramUserId) {
    const buf = readMediaFile(telegramUserId, cta.midiaFile);
    if (buf) return buf;
  }
  if (cta?.midia) {
    try {
      if (typeof cta.midia === 'string' && !cta.midia.startsWith('[')) {
        return Buffer.from(cta.midia, 'base64');
      }
    } catch (_) { /* */ }
  }
  if (config?.midiaFile && config.midiaTipo === 'image' && telegramUserId) {
    const buf = readMediaFile(telegramUserId, config.midiaFile);
    if (buf) return buf;
  }
  if (config?.midia && config.midiaTipo === 'image') {
    try { return Buffer.from(config.midia, 'base64'); } catch (_) { /* */ }
  }
  return null;
}

function getTextoMediaBuffer(config, telegramUserId) {
  if (!config) return null;
  const buf = bufferFromStored(telegramUserId, config.midia, config.midiaFile);
  if (!buf || !config.midiaTipo) return null;
  return {
    buffer: buf,
    tipo: config.midiaTipo,
    mimetype: config.midiaMimetype,
    fileName: config.midiaNome
  };
}

function saveTextoMediaBuffer(telegramUserId, buffer, meta) {
  if (!buffer || !buffer.length) return null;
  const file = writeMediaFile(telegramUserId, 'texto', buffer);
  return updateConfig(telegramUserId, {
    midia: null,
    midiaFile: file,
    midiaTipo: (meta && meta.tipo) || 'image',
    midiaMimetype: (meta && meta.mimetype) || 'image/jpeg',
    midiaNome: (meta && meta.fileName) || null,
    legenda: (meta && meta.caption) || '',
    configurado: true
  });
}

function saveCtaImageBuffer(telegramUserId, buffer, mimetype) {
  if (!buffer || !buffer.length) return null;
  const file = writeMediaFile(telegramUserId, 'cta', buffer);
  return updateConfig(telegramUserId, {
    cta: {
      midia: null,
      midiaFile: file,
      midiaTipo: 'image',
      midiaMimetype: mimetype || 'image/jpeg'
    },
    configurado: true
  });
}

function clearCtaMidia(cta) {
  if (!cta || typeof cta !== 'object') return cta;
  const next = { ...cta };
  delete next.midia;
  delete next.midiaFile;
  delete next.midiaTipo;
  delete next.midiaMimetype;
  return next;
}

function formatTextoSummary(config) {
  const texto = String(config?.texto || '').trim();
  return texto
    ? `Texto: pronto\n${texto.substring(0, 160)}${texto.length > 160 ? '...' : ''}`
    : 'Texto: (vazio) — use msgdivul (pode ter varios links)';
}

function formatPaySummary(config) {
  const texto = String(config?.textoPay || '').trim();
  return texto
    ? `Pagamento: pronto\n${texto.substring(0, 160)}${texto.length > 160 ? '...' : ''}`
    : 'Pagamento: (vazio) — use msgdivulpay';
}

function formatTracksSummary(config) {
  return [
    formatTextoSummary(config),
    formatCtaSummary(config),
    formatPaySummary(config)
  ].join('\n\n');
}

function queueTextForTipo(config, tipo) {
  if (tipo === 'cta') {
    const t = String(config?.cta?.texto || '').trim();
    const url = config?.cta?.url || '';
    return url ? `${t}\n\n${url}` : t;
  }
  if (tipo === 'pay') return String(config?.textoPay || '').trim();
  return String(config?.texto || '').trim();
}

function offloadHeavyMedia(telegramUserId, config) {
  if (!config || typeof config !== 'object') return config;
  if (typeof config.midia === 'string' && config.midia.length > 400 && !config.midia.startsWith('[')) {
    try {
      const buf = Buffer.from(config.midia, 'base64');
      if (buf.length) {
        config.midiaFile = writeMediaFile(telegramUserId, 'texto', buf);
        config.midia = null;
      }
    } catch (_) { /* keep */ }
  }
  if (config.cta && typeof config.cta === 'object' &&
      typeof config.cta.midia === 'string' && config.cta.midia.length > 400 &&
      !String(config.cta.midia).startsWith('[')) {
    try {
      const buf = Buffer.from(config.cta.midia, 'base64');
      if (buf.length) {
        config.cta.midiaFile = writeMediaFile(telegramUserId, 'cta', buf);
        config.cta.midia = null;
      }
    } catch (_) { /* keep */ }
  }
  return config;
}

function salvarConfig(telegramUserId, config) {
  const uid = String(telegramUserId || '');
  offloadHeavyMedia(uid, config);
  try {
    const { slimDivulgacao } = require('./sqlStore');
    require('./sqlStore').upsertKv('divulgacao', uid, slimDivulgacao(config));
  } catch (_) { /* */ }
  try {
    const file = getDivulgacaoPath(telegramUserId);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toDisk = { ...config };
    if (toDisk.midia && String(toDisk.midia).length > 400) toDisk.midia = null;
    if (toDisk.cta && toDisk.cta.midia && String(toDisk.cta.midia).length > 400) {
      toDisk.cta = { ...toDisk.cta, midia: null };
    }
    fs.writeFileSync(file, JSON.stringify(toDisk));
  } catch (e) { /* backup */ }
}

function getConfig(telegramUserId) {
  return carregarConfig(telegramUserId);
}

function updateConfig(telegramUserId, updates) {
  const config = carregarConfig(telegramUserId);
  const next = { ...(updates || {}) };
  if (Object.prototype.hasOwnProperty.call(next, 'cta')) {
    if (next.cta === null) {
      config.cta = null;
    } else if (next.cta && typeof next.cta === 'object') {
      const prev = (config.cta && typeof config.cta === 'object') ? config.cta : {};
      config.cta = { ...prev, ...next.cta };
    }
    delete next.cta;
  }
  Object.assign(config, next);
  salvarConfig(telegramUserId, config);
  return config;
}

// ... demais funções recebem telegramUserId

function limparConfig(telegramUserId) {
    unlinkMediaFile(telegramUserId, 'div-texto.bin');
    unlinkMediaFile(telegramUserId, 'div-cta.bin');
    salvarConfig(telegramUserId, defaultDivulgacao());
}

function getMidia(telegramUserId) {
    const config = carregarConfig(telegramUserId);
    const pack = getTextoMediaBuffer(config, telegramUserId);
    if (!pack) return null;
    return {
        midia: pack.buffer,
        midiaTipo: pack.tipo,
        midiaMimetype: pack.mimetype,
        midiaNome: pack.fileName,
        legenda: config.legenda
    };
}

function getGruposParaDivulgar(telegramUserId) {
    const config = carregarConfig(telegramUserId);
    // Forca especificos: divulgacao so nos grupos addgrupo
    if (config.modoGrupos !== 'especificos') {
        config.modoGrupos = 'especificos';
        salvarConfig(telegramUserId, config);
    }
    return {
        modo: 'especificos',
        grupos: config.grupos || []
    };
}

function setModoGrupos(telegramUserId, modo) {
    const config = carregarConfig(telegramUserId);
    // 'todos' descontinuado — mantem so especificos
    config.modoGrupos = modo === 'todos' ? 'especificos' : (modo || 'especificos');
    salvarConfig(telegramUserId, config);
}

function adicionarGrupo(telegramUserId, jid) {
    const config = carregarConfig(telegramUserId);
    if (!config.grupos) config.grupos = [];
    config.modoGrupos = 'especificos';
    if (!config.grupos.includes(jid)) {
        config.grupos.push(jid);
        salvarConfig(telegramUserId, config);
        return true;
    }
    salvarConfig(telegramUserId, config);
    return false;
}

function removerGrupo(telegramUserId, jid) {
    const config = carregarConfig(telegramUserId);
    if (!config.grupos) config.grupos = [];
    const index = config.grupos.indexOf(jid);
    if (index !== -1) {
        config.grupos.splice(index, 1);
        salvarConfig(telegramUserId, config);
        return true;
    }
    return false;
}

function limparGrupos(telegramUserId) {
    const config = carregarConfig(telegramUserId);
    config.grupos = [];
    salvarConfig(telegramUserId, config);
}

function setModo(telegramUserId, modo) {
    setModoGrupos(telegramUserId, modo);
}

module.exports = {
    getConfig,
    updateConfig,
    limparConfig,
    getMidia,
    getGruposParaDivulgar,
    setModoGrupos,
    adicionarGrupo,
    removerGrupo,
    limparGrupos,
    setModo,
    carregarConfig,
    salvarConfig,
    defaultDivulgacao,
    normalizeCtaUrl,
    clampCtaLabel,
    parseCtaParts,
    isCtaReady,
    ctaMissing,
    formatCtaSummary,
    getCtaImageBuffer,
    clearCtaMidia,
    isTextoReady,
    isPayReady,
    formatTextoSummary,
    formatPaySummary,
    formatTracksSummary,
    queueTextForTipo,
    migrateDivulgacao,
    captureMediaFromCtx,
    writeMediaFile,
    getTextoMediaBuffer,
    saveTextoMediaBuffer,
    saveCtaImageBuffer,
    unlinkMediaFile,
    CTA_LABEL_MAX
};