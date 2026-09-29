// utils/divulgacao.js (modificado)
const fs = require('fs');
const path = require('path');
const { getUserDir, isAdmin, normalizeTenantUid } = require('./userManager');
const {
    normalizeGrupoJid,
    isCanalDestino,
    uniqueGrupos,
    listParticipatingGroupJids,
    listJoinedInviteJids,
    resolveGruposDestino,
    formatDestinoResumo
} = require('./divDestinos');

/** Slots paralelos so pra TELEGRAM_ADMIN: CTA + Status (1=legado, 2=extra). */
const SLOT_TRACKS = ['cta', 'status'];
const SLOT_IDS = [1, 2];
const MAX_SLOT = 2;

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

function clampSlot(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > MAX_SLOT) return MAX_SLOT;
  return n;
}

function isDivAdmin(telegramUserId) {
  try {
    return !!isAdmin(String(telegramUserId || ''));
  } catch (_) {
    return false;
  }
}

/** normal | normal:2 | cta:3 → { tipo, slot, key } */
function parseTipoSlot(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return { tipo: 'normal', slot: 1, key: 'normal' };
  // Aceita cta:2 (jobs) e cta_2 (ids de botao WhatsApp)
  const m = s.match(/^(normal|texto|cta|botao|pay|pagamento|status|cf|closefriends|full|completa)(?::(\d+)|_(\d+))?$/i);
  if (!m) {
    const alias = ({ texto: 'normal', botao: 'cta', pagamento: 'pay', cf: 'status', closefriends: 'status', completa: 'full' })[s] || s;
    return { tipo: alias, slot: 1, key: alias === 'normal' ? 'normal' : alias };
  }
  let tipo = m[1].toLowerCase();
  if (tipo === 'texto') tipo = 'normal';
  if (tipo === 'botao') tipo = 'cta';
  if (tipo === 'pagamento') tipo = 'pay';
  if (tipo === 'cf' || tipo === 'closefriends') tipo = 'status';
  if (tipo === 'completa') tipo = 'full';
  const slot = clampSlot(m[2] || m[3] || 1);
  const key = modoKey(tipo, slot);
  return { tipo, slot, key };
}

function modoKey(tipo, slot) {
  const t = String(tipo || 'normal').toLowerCase();
  const s = clampSlot(slot);
  if (s <= 1) return t;
  return `${t}:${s}`;
}

function emptyNormalSlot() {
  return {
    texto: '',
    midia: null,
    midiaFile: null,
    midiaTipo: null,
    midiaMimetype: null,
    midiaNome: null,
    legenda: ''
  };
}

function emptyCtaSlot() {
  return {
    texto: '',
    label: '',
    url: '',
    label2: '',
    url2: '',
    midia: null,
    midiaFile: null,
    midiaTipo: null,
    midiaMimetype: null
  };
}

function emptyPaySlot() {
  return { textoPay: '' };
}

function emptyStatusSlot() {
  return {
    textoStatus: '',
    statusMidiaFile: null,
    statusMidiaTipo: null,
    statusMidiaMimetype: null,
    statusMidiaNome: null
  };
}

function emptySlotForTrack(track) {
  if (track === 'cta') return emptyCtaSlot();
  if (track === 'pay') return emptyPaySlot();
  if (track === 'status') return emptyStatusSlot();
  return emptyNormalSlot();
}

function mediaFileSlotName(track, slot) {
  const s = clampSlot(slot);
  if (track === 'normal' || track === 'texto') {
    return s <= 1 ? 'texto' : `texto-${s}`;
  }
  if (track === 'cta') return s <= 1 ? 'cta' : `cta-${s}`;
  if (track === 'status') return s <= 1 ? 'status' : `status-${s}`;
  return `${track}-${s}`;
}

function legacyNormalFromCfg(cfg) {
  return {
    texto: String(cfg?.texto || ''),
    midia: cfg?.midia ?? null,
    midiaFile: cfg?.midiaFile || null,
    midiaTipo: cfg?.midiaTipo || null,
    midiaMimetype: cfg?.midiaMimetype || null,
    midiaNome: cfg?.midiaNome || null,
    legenda: cfg?.legenda || ''
  };
}

function legacyCtaFromCfg(cfg) {
  const c = cfg?.cta && typeof cfg.cta === 'object' ? cfg.cta : {};
  return {
    texto: String(c.texto || ''),
    label: String(c.label || ''),
    url: String(c.url || ''),
    label2: String(c.label2 || ''),
    url2: String(c.url2 || ''),
    midia: c.midia ?? null,
    midiaFile: c.midiaFile || null,
    midiaTipo: c.midiaTipo || null,
    midiaMimetype: c.midiaMimetype || null
  };
}

function legacyPayFromCfg(cfg) {
  return { textoPay: String(cfg?.textoPay || '') };
}

function legacyStatusFromCfg(cfg) {
  return {
    textoStatus: String(cfg?.textoStatus || ''),
    statusMidiaFile: cfg?.statusMidiaFile || null,
    statusMidiaTipo: cfg?.statusMidiaTipo || null,
    statusMidiaMimetype: cfg?.statusMidiaMimetype || null,
    statusMidiaNome: cfg?.statusMidiaNome || null
  };
}

function applyNormalSlotToCfg(cfg, slotData) {
  const s = slotData || emptyNormalSlot();
  cfg.texto = String(s.texto || '');
  cfg.midia = s.midia ?? null;
  cfg.midiaFile = s.midiaFile || null;
  cfg.midiaTipo = s.midiaTipo || null;
  cfg.midiaMimetype = s.midiaMimetype || null;
  cfg.midiaNome = s.midiaNome || null;
  cfg.legenda = s.legenda || '';
}

function applyCtaSlotToCfg(cfg, slotData) {
  const s = slotData || emptyCtaSlot();
  const hasAny = !!(
    String(s.texto || '').trim() ||
    String(s.label || '').trim() ||
    String(s.url || '').trim() ||
    s.midiaFile
  );
  cfg.cta = hasAny
    ? {
        texto: String(s.texto || ''),
        label: String(s.label || ''),
        url: String(s.url || ''),
        label2: String(s.label2 || ''),
        url2: String(s.url2 || ''),
        midia: s.midia ?? null,
        midiaFile: s.midiaFile || null,
        midiaTipo: s.midiaTipo || null,
        midiaMimetype: s.midiaMimetype || null
      }
    : null;
}

function applyPaySlotToCfg(cfg, slotData) {
  cfg.textoPay = String((slotData && slotData.textoPay) || '');
}

function applyStatusSlotToCfg(cfg, slotData) {
  const s = slotData || emptyStatusSlot();
  cfg.textoStatus = String(s.textoStatus || '');
  cfg.statusMidiaFile = s.statusMidiaFile || null;
  cfg.statusMidiaTipo = s.statusMidiaTipo || null;
  cfg.statusMidiaMimetype = s.statusMidiaMimetype || null;
  cfg.statusMidiaNome = s.statusMidiaNome || null;
}

function syncLegacyToSlot1(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (!cfg.divSlots || typeof cfg.divSlots !== 'object') cfg.divSlots = {};
  for (const track of SLOT_TRACKS) {
    if (!cfg.divSlots[track] || typeof cfg.divSlots[track] !== 'object') cfg.divSlots[track] = {};
  }
  cfg.divSlots.cta[1] = legacyCtaFromCfg(cfg);
  cfg.divSlots.status[1] = legacyStatusFromCfg(cfg);
  return cfg;
}

function syncSlot1ToLegacy(cfg) {
  if (!cfg?.divSlots) return cfg;
  const c = cfg.divSlots.cta?.[1];
  const st = cfg.divSlots.status?.[1];
  if (c) applyCtaSlotToCfg(cfg, c);
  if (st) applyStatusSlotToCfg(cfg, st);
  return cfg;
}

function ensureDivSlots(telegramUserId, cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (!isDivAdmin(telegramUserId)) {
    delete cfg.divSlots;
    delete cfg.activeSlot;
    return cfg;
  }
  if (!cfg.divSlots || typeof cfg.divSlots !== 'object') cfg.divSlots = {};
  if (!cfg.activeSlot || typeof cfg.activeSlot !== 'object') {
    cfg.activeSlot = { cta: 1, status: 1 };
  } else {
    // Limpa trilhas antigas (texto/pay) do activeSlot
    cfg.activeSlot = {
      cta: clampSlot(cfg.activeSlot.cta || 1),
      status: clampSlot(cfg.activeSlot.status || 1)
    };
  }
  for (const track of SLOT_TRACKS) {
    if (!cfg.divSlots[track] || typeof cfg.divSlots[track] !== 'object') cfg.divSlots[track] = {};
    const bag = cfg.divSlots[track];
    if (!bag[1]) {
      if (track === 'cta') bag[1] = legacyCtaFromCfg(cfg);
      else bag[1] = legacyStatusFromCfg(cfg);
    }
    for (const id of SLOT_IDS) {
      if (!bag[id]) bag[id] = emptySlotForTrack(track);
    }
    // Drop slot 3+ leftovers from versao antiga
    for (const k of Object.keys(bag)) {
      const n = Number(k);
      if (Number.isFinite(n) && n > MAX_SLOT) delete bag[k];
    }
    cfg.activeSlot[track] = clampSlot(cfg.activeSlot[track] || 1);
  }
  // Remove trilhas antigas do objeto
  if (cfg.divSlots.normal) delete cfg.divSlots.normal;
  if (cfg.divSlots.pay) delete cfg.divSlots.pay;
  // NAO copiar legado em cima do slot 1 se ele ja existe — isso vazava CTA1↔CTA2.
  return cfg;
}

function getActiveSlot(cfg, track) {
  const t = track === 'texto' ? 'normal' : track;
  const n = cfg?.activeSlot?.[t];
  return clampSlot(n || 1);
}

function setActiveSlot(telegramUserId, track, slot) {
  const t = track === 'texto' ? 'normal' : String(track || 'normal');
  if (!SLOT_TRACKS.includes(t)) return getConfig(telegramUserId);
  const cfg = carregarConfig(telegramUserId);
  if (!isDivAdmin(telegramUserId)) return cfg;
  ensureDivSlots(telegramUserId, cfg);
  cfg.activeSlot[t] = clampSlot(slot);
  salvarConfig(telegramUserId, cfg);
  return cfg;
}

function getSlotData(cfg, track, slot) {
  const t = track === 'texto' ? 'normal' : track;
  const s = clampSlot(slot);
  if (!cfg?.divSlots?.[t]?.[s]) {
    if (s <= 1) {
      if (t === 'normal') return legacyNormalFromCfg(cfg);
      if (t === 'cta') return legacyCtaFromCfg(cfg);
      if (t === 'pay') return legacyPayFromCfg(cfg);
      if (t === 'status') return legacyStatusFromCfg(cfg);
    }
    return emptySlotForTrack(t);
  }
  return { ...emptySlotForTrack(t), ...cfg.divSlots[t][s] };
}

function cloneDivCfg(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : defaultDivulgacao();
  const base = { ...src };
  if (src.cta && typeof src.cta === 'object') base.cta = { ...src.cta };
  if (src.activeSlot && typeof src.activeSlot === 'object') base.activeSlot = { ...src.activeSlot };
  if (Array.isArray(src.autoModos)) base.autoModos = src.autoModos.slice();
  if (src.divSlots && typeof src.divSlots === 'object') {
    base.divSlots = {};
    for (const track of Object.keys(src.divSlots)) {
      const bag = src.divSlots[track];
      if (!bag || typeof bag !== 'object') continue;
      base.divSlots[track] = {};
      for (const k of Object.keys(bag)) {
        const slot = bag[k];
        base.divSlots[track][k] = slot && typeof slot === 'object' ? { ...slot } : slot;
      }
    }
  }
  return base;
}

/**
 * Copia cfg com campos legados preenchidos pelo slot — send/auto usam sem mudar o resto.
 */
function applyViewConfig(cfg, tipo, slot) {
  const base = cloneDivCfg(cfg);
  const parsed = parseTipoSlot(tipo);
  const t = parsed.tipo === 'full' ? 'normal' : (parsed.tipo || 'normal');
  const s = slot != null ? clampSlot(slot) : parsed.slot;
  const track = t === 'full' ? 'normal' : t;
  if (!(s <= 1 && !base.divSlots) && SLOT_TRACKS.includes(track) && !(s > 1 && !base.divSlots?.[track])) {
    const data = getSlotData(base, track, s);
    if (track === 'normal') applyNormalSlotToCfg(base, data);
    else if (track === 'cta') applyCtaSlotToCfg(base, data);
    else if (track === 'pay') applyPaySlotToCfg(base, data);
    else if (track === 'status') applyStatusSlotToCfg(base, data);
  }
  try {
    const canal = require('./canal');
    if (typeof canal.rewriteLegacyCanalInConfig === 'function') {
      canal.rewriteLegacyCanalInConfig(base);
    }
  } catch (_) { /* view segue sem remap */ }
  return base;
}

function viewForActiveTrack(telegramUserId, track) {
  const cfg = carregarConfig(telegramUserId);
  const t = track === 'texto' ? 'status' : String(track || 'cta');
  const s = isDivAdmin(telegramUserId) ? getActiveSlot(cfg, t) : 1;
  return { cfg, slot: s, view: applyViewConfig(cfg, t, s) };
}

function viewConfigForModoKey(cfg, modoKeyRaw) {
  const { tipo, slot } = parseTipoSlot(modoKeyRaw);
  return applyViewConfig(cfg, tipo, slot);
}

function isTrackReady(cfg, tipo, slot) {
  const view = applyViewConfig(cfg, tipo, slot);
  const t = parseTipoSlot(tipo).tipo;
  if (t === 'cta') return isCtaReady(view);
  if (t === 'pay') return isPayReady(view);
  if (t === 'status') return isStatusReady(view);
  if (t === 'full') {
    return isTextoReady(view) || isCtaReady(view) || isPayReady(view) || isStatusReady(view);
  }
  return isTextoReady(view);
}

function updateSlotPatch(telegramUserId, track, slot, patch) {
  const t = track === 'texto' ? 'normal' : String(track || 'normal');
  const s = clampSlot(slot);
  const cfg = carregarConfig(telegramUserId);
  if (!isDivAdmin(telegramUserId) && s > 1) {
    return updateConfig(telegramUserId, patch || {});
  }
  if (!isDivAdmin(telegramUserId)) {
    return updateLegacyFromSlotPatch(telegramUserId, t, patch);
  }
  ensureDivSlots(telegramUserId, cfg);
  const prev = cfg.divSlots[t][s] || emptySlotForTrack(t);
  const next = { ...prev, ...(patch || {}) };
  if (t === 'cta' && patch && typeof patch === 'object' && !Array.isArray(patch)) {
    /* already shallow */
  }
  cfg.divSlots[t][s] = next;
  if (s <= 1) syncSlot1ToLegacy(cfg);
  if (isDivAdmin(telegramUserId) && patch) {
    try {
      const bag = { divSlots: { [t]: { [s]: patch } } };
      require('./adminDivTemplate').persistEditsFromUpdates(telegramUserId, bag).catch(() => {});
    } catch (_) { /* ignore */ }
  }
  salvarConfig(telegramUserId, cfg);
  return cfg;
}

function updateLegacyFromSlotPatch(telegramUserId, track, patch) {
  const p = patch || {};
  if (track === 'normal') {
    return updateConfig(telegramUserId, {
      texto: p.texto != null ? p.texto : undefined,
      midia: Object.prototype.hasOwnProperty.call(p, 'midia') ? p.midia : undefined,
      midiaFile: Object.prototype.hasOwnProperty.call(p, 'midiaFile') ? p.midiaFile : undefined,
      midiaTipo: Object.prototype.hasOwnProperty.call(p, 'midiaTipo') ? p.midiaTipo : undefined,
      midiaMimetype: Object.prototype.hasOwnProperty.call(p, 'midiaMimetype') ? p.midiaMimetype : undefined,
      midiaNome: Object.prototype.hasOwnProperty.call(p, 'midiaNome') ? p.midiaNome : undefined,
      legenda: p.legenda != null ? p.legenda : undefined,
      configurado: true
    });
  }
  if (track === 'cta') {
    return updateConfig(telegramUserId, { cta: p, configurado: true });
  }
  if (track === 'pay') {
    return updateConfig(telegramUserId, { textoPay: p.textoPay, configurado: true });
  }
  if (track === 'status') {
    return updateConfig(telegramUserId, {
      textoStatus: p.textoStatus,
      statusMidiaFile: Object.prototype.hasOwnProperty.call(p, 'statusMidiaFile') ? p.statusMidiaFile : undefined,
      statusMidiaTipo: Object.prototype.hasOwnProperty.call(p, 'statusMidiaTipo') ? p.statusMidiaTipo : undefined,
      statusMidiaMimetype: Object.prototype.hasOwnProperty.call(p, 'statusMidiaMimetype') ? p.statusMidiaMimetype : undefined,
      statusMidiaNome: Object.prototype.hasOwnProperty.call(p, 'statusMidiaNome') ? p.statusMidiaNome : undefined,
      configurado: true
    });
  }
  return getConfig(telegramUserId);
}

function formatSlotsSummary(cfg, telegramUserId) {
  if (!isDivAdmin(telegramUserId)) return formatTracksSummary(cfg);
  ensureDivSlots(telegramUserId, cfg);
  const lines = [
    'ADM — 2 CTA + 2 Status (paralelo)',
    'CTA 1 = venda do bot · CTA 2 = grupo oficial',
    'Status 1 = grupo oficial · Status 2 = venda do bot'
  ];
  for (const track of SLOT_TRACKS) {
    const label = ({ cta: 'CTA', status: 'Status' })[track];
    const active = getActiveSlot(cfg, track);
    const bits = SLOT_IDS.map((id) => {
      const ready = isTrackReady(cfg, track, id);
      const on = Array.isArray(cfg.autoModos) && cfg.autoModos.includes(modoKey(track, id));
      return `${id}${ready ? '✓' : '·'}${on ? 'A' : ''}${id === active ? '*' : ''}`;
    }).join(' ');
    lines.push(`${label}: ${bits}  (*edicao, A=auto)`);
    for (const id of SLOT_IDS) {
      const data = getSlotData(cfg, track, id);
      let snip = '';
      if (track === 'cta') {
        snip = String(data.texto || data.label || '').trim().slice(0, 48);
      } else {
        snip = String(data.textoStatus || '').trim().slice(0, 48);
        if (!snip && data.statusMidiaFile) snip = '(so midia)';
      }
      lines.push(`  ${label}${id}: ${snip || '(vazio)'}`);
    }
  }
  return lines.join('\n');
}

function cloneForOverlay(cfg) {
  if (!cfg || typeof cfg !== 'object') return defaultDivulgacao();
  const out = { ...cfg };
  if (out.cta && typeof out.cta === 'object') out.cta = { ...out.cta };
  if (out.divSlots && typeof out.divSlots === 'object') {
    try { out.divSlots = JSON.parse(JSON.stringify(out.divSlots)); }
    catch (_) { out.divSlots = { ...out.divSlots }; }
  }
  if (Array.isArray(out.grupos)) out.grupos = out.grupos.slice();
  if (Array.isArray(out.gruposExcluidos)) out.gruposExcluidos = out.gruposExcluidos.slice();
  return out;
}

/** Disco/kv sem overlay do template SQL (grupos/midia/textos antigos intactos). */
function carregarConfigRaw(telegramUserId) {
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) return defaultDivulgacao();
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('divulgacao', uid);
      if (hit && typeof hit === 'object') {
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
            if (disk.divSlots && typeof disk.divSlots === 'object') {
              hit.divSlots = disk.divSlots;
            }
            if (disk.activeSlot && typeof disk.activeSlot === 'object') {
              hit.activeSlot = disk.activeSlot;
            }
            if (Array.isArray(disk.gruposExcluidos)) hit.gruposExcluidos = disk.gruposExcluidos;
            if (disk.divSlots) {
              if (disk.cta && typeof disk.cta === 'object') hit.cta = disk.cta;
              if (disk.textoStatus != null) hit.textoStatus = disk.textoStatus;
              if (disk.statusMidiaFile) hit.statusMidiaFile = disk.statusMidiaFile;
              if (disk.statusMidiaTipo) hit.statusMidiaTipo = disk.statusMidiaTipo;
              if (disk.statusMidiaMimetype) hit.statusMidiaMimetype = disk.statusMidiaMimetype;
              if (disk.statusMidiaNome) hit.statusMidiaNome = disk.statusMidiaNome;
            } else if (disk.cta && typeof disk.cta === 'object') {
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

function carregarConfig(telegramUserId) {
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) return finalizeDivulgacaoLoad('', defaultDivulgacao());
  return finalizeDivulgacaoLoad(uid, carregarConfigRaw(uid));
}

function stampDivOwner(telegramUserId, cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  cfg._ownerTelegramUserId = String(telegramUserId || '');
  return cfg;
}

function stripRuntimeDivFields(config) {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  delete out._ownerTelegramUserId;
  return out;
}

/** Cliente nunca herda botao/site do template ADM (vazamento 1.2). */
function stripInheritedAdminCta(telegramUserId, cfg) {
  if (!cfg || isDivAdmin(telegramUserId)) return cfg;
  let site = 'https://hats444.github.io';
  let demo = site;
  let lab = 'Ver o site';
  try {
    const t = require('./adminDivTemplate');
    site = String(t.siteUrl() || site).replace(/\/+$/, '');
    demo = String(t.demoOrSiteUrl() || demo).replace(/\/+$/, '');
    lab = t.demoOrSiteLabel() || lab;
  } catch (_) { /* defaults */ }
  const sameUrl = (u) => {
    const a = String(u || '').trim().replace(/\/+$/, '').toLowerCase();
    if (!a) return false;
    return a === site.toLowerCase() || a === demo.toLowerCase();
  };
  if (cfg.cta && typeof cfg.cta === 'object' && sameUrl(cfg.cta.url2)) {
    cfg.cta = { ...cfg.cta, url2: '', label2: cfg.cta.label2 === lab ? '' : (cfg.cta.label2 || '') };
  }
  return cfg;
}

function assertSessionOwnsDivPayload(telegramUserId, config, conn) {
  const uid = String(telegramUserId || '');
  if (!uid) {
    const err = new Error('div-no-owner');
    err.code = 'DIV_NO_OWNER';
    throw err;
  }
  const stamped = String(config?._ownerTelegramUserId || '');
  if (stamped && stamped !== uid) {
    const err = new Error('div-owner-mismatch');
    err.code = 'DIV_OWNER_MISMATCH';
    throw err;
  }
  const connUid = conn && conn._telegramUserId != null ? String(conn._telegramUserId) : '';
  if (connUid && connUid !== uid) {
    const err = new Error('div-conn-mismatch');
    err.code = 'DIV_CONN_MISMATCH';
    throw err;
  }
  return true;
}

function finalizeDivulgacaoLoad(telegramUserId, cfg) {
  const { applyAdminMarketingDefaults } = require('./divulgacaoAdminDefaults');
  let next = cloneForOverlay(migrateDivulgacao(cfg));
  const { cfg: marketed } = applyAdminMarketingDefaults(telegramUserId, next);
  const beforeUrl2 = marketed && marketed.cta ? String(marketed.cta.url2 || '') : '';
  next = stripInheritedAdminCta(telegramUserId, marketed);
  stampDivOwner(telegramUserId, next);
  ensureDivSlots(telegramUserId, next);
  let modosChanged = false;
  if (isDivAdmin(telegramUserId) && Array.isArray(next.autoModos)) {
    const cleaned = next.autoModos.filter((raw) => {
      const { tipo, slot } = parseTipoSlot(raw);
      if (slot > MAX_SLOT) return false;
      if (slot > 1 && (tipo === 'normal' || tipo === 'pay' || tipo === 'full')) return false;
      return true;
    });
    if (cleaned.length !== next.autoModos.length) {
      next.autoModos = cleaned;
      modosChanged = true;
    }
  }
  // Overlay SQL nao grava texto no JSON. So persiste limpeza de autoModos.
  const afterUrl2 = next && next.cta ? String(next.cta.url2 || '') : '';
  const healedLeak = !isDivAdmin(telegramUserId) && beforeUrl2 && beforeUrl2 !== afterUrl2;
  if (modosChanged || healedLeak) {
    try { salvarConfig(telegramUserId, next); } catch (_) { /* ignore */ }
  }
  try {
    const canal = require('./canal');
    const r = canal.rewriteLegacyCanalInConfig(next);
    if (r.changed) {
      try { salvarConfig(telegramUserId, next); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* canal opcional */ }
  return next;
}

const AUTO_INTERVAL_TIPOS = ['normal', 'cta', 'pay', 'status', 'full', 'cta:2', 'status:2'];

function seedAutoIntervalByTipo(cfg) {
  const fallback = Math.min(1440, Math.max(15, parseInt(cfg.autoIntervalMin, 10) || 30));
  const src = (cfg.autoIntervalByTipo && typeof cfg.autoIntervalByTipo === 'object')
    ? cfg.autoIntervalByTipo
    : {};
  const by = {};
  for (const t of AUTO_INTERVAL_TIPOS) {
    const n = parseInt(src[t], 10);
    by[t] = Number.isFinite(n) && n > 0 ? Math.min(1440, Math.max(15, n)) : fallback;
  }
  cfg.autoIntervalByTipo = by;
  return cfg;
}

function migrateDivulgacao(cfg) {
  if (!cfg || typeof cfg !== 'object') return defaultDivulgacao();
  if (cfg.textoPay == null) cfg.textoPay = '';
  if (cfg.textoStatus == null) cfg.textoStatus = String(cfg.texto || '');
  if (cfg.cta && typeof cfg.cta === 'object') {
    if (!String(cfg.cta.texto || '').trim() && (cfg.cta.label || cfg.cta.url) && cfg.texto) {
      cfg.cta.texto = cfg.texto;
    }
  }
  if (cfg.inviteGroupJid == null) cfg.inviteGroupJid = '';
  if (cfg.inviteLinkLast == null) cfg.inviteLinkLast = '';
  if (cfg.delayMsg === 3000) cfg.delayMsg = 1200;
  if (cfg.delayGrupo === 2000) cfg.delayGrupo = 800;
  if (cfg.autoEnabled == null) cfg.autoEnabled = false;
  if (!cfg.autoIntervalMin) cfg.autoIntervalMin = 30;
  seedAutoIntervalByTipo(cfg);
  if (!Array.isArray(cfg.autoModos)) cfg.autoModos = ['normal'];
  if (cfg.autoModoIndex == null) cfg.autoModoIndex = 0;
  if (!cfg.autoLastRunByTipo || typeof cfg.autoLastRunByTipo !== 'object') cfg.autoLastRunByTipo = {};
  if (!cfg.autoNextAtByTipo || typeof cfg.autoNextAtByTipo !== 'object') cfg.autoNextAtByTipo = {};
  if (!cfg.autoRandomByTipo || typeof cfg.autoRandomByTipo !== 'object') cfg.autoRandomByTipo = {};
  if (!cfg.autoLastSendByGroup || typeof cfg.autoLastSendByGroup !== 'object') cfg.autoLastSendByGroup = {};
  if (!cfg.autoMsgCountByGroup || typeof cfg.autoMsgCountByGroup !== 'object') cfg.autoMsgCountByGroup = {};
  if (cfg.autoMsgOptIn !== true) cfg.autoMsgEnabled = false;
  if (cfg.autoMsgEnabled == null) cfg.autoMsgEnabled = false;
  if (!cfg.autoMsgEvery) cfg.autoMsgEvery = 50;
  if (!cfg.autoMinGapMin) cfg.autoMinGapMin = 15;
  if (cfg.autoCreateEnabled == null) cfg.autoCreateEnabled = false;
  if (!cfg.autoCreateCount) cfg.autoCreateCount = 1;
  if (!cfg.autoCreateName) cfg.autoCreateName = 'Grupo';
  if (cfg.autoCreateMin == null) cfg.autoCreateMin = 0;
  if (!cfg.autoCreateSeq) cfg.autoCreateSeq = 1;
  if (!cfg.autoCreateDelayMs) cfg.autoCreateDelayMs = 10000;
  if (!Array.isArray(cfg.gruposExcluidos)) cfg.gruposExcluidos = [];
  else cfg.gruposExcluidos = uniqueGrupos(cfg.gruposExcluidos);
  return cfg;
}

const CTA_LABEL_MAX = 20;

function defaultDivulgacao() {
  return {
    texto: '',
    textoPay: '',
    textoStatus: '',
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
    gruposExcluidos: [],
    modoGrupos: 'especificos',
    inviteGroupJid: '',
    inviteLinkLast: '',
    cta: null,
    autoEnabled: false,
    autoIntervalMin: 30,
    autoIntervalByTipo: {
      normal: 30,
      cta: 30,
      pay: 30,
      status: 30,
      full: 30
    },
    autoModos: ['normal'],
    autoModoIndex: 0,
    autoLastRun: 0,
    autoLastRunByTipo: {},
    autoNextAtByTipo: {},
    autoRandomByTipo: {},
    autoLastSendByGroup: {},
    autoMsgCountByGroup: {},
    autoMsgEnabled: false,
    autoMsgOptIn: false,
    autoMsgEvery: 50,
    autoMinGapMin: 15,
    lastUiJid: null,
    autoCreateEnabled: false,
    autoCreateCount: 1,
    autoCreateName: 'Grupo',
    autoCreateMin: 0,
    autoCreateSeq: 1,
    autoCreateDelayMs: 10000,
    statusMidiaFile: null,
    statusMidiaTipo: null,
    statusMidiaMimetype: null,
    statusMidiaNome: null
  };
}

function normalizeCtaUrl(raw) {
  let u = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!u) return null;
  u = u.split(/\s+/)[0];
  if (/\{\{\s*(groupInviteLink|inviteLink)/i.test(u)) return '{{groupInviteLink}}';
  if (/\{\{\s*affiliateLink\s*\}\}/i.test(u)) return '{{affiliateLink}}';
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

function looksLikeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^(https?:\/\/|wa\.me\/|www\.)/i.test(s)) return true;
  return !!normalizeCtaUrl(s);
}

function parseCtaParts(raw) {
  const segs = String(raw || '').split('|').map(s => s.trim());
  while (segs.length && segs[segs.length - 1] === '') segs.pop();
  if (segs.length >= 5 && looksLikeUrl(segs[segs.length - 1]) && looksLikeUrl(segs[segs.length - 3])) {
    return {
      texto: segs.slice(0, -4).join(' | ').trim(),
      label: segs[segs.length - 4],
      url: segs[segs.length - 3],
      label2: segs[segs.length - 2],
      url2: segs[segs.length - 1]
    };
  }
  if (segs.length === 4 && looksLikeUrl(segs[1]) && looksLikeUrl(segs[3])) {
    return {
      texto: '',
      label: segs[0],
      url: segs[1],
      label2: segs[2],
      url2: segs[3]
    };
  }
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

function ctaUrlButtons(config, telegramUserId) {
  const uid = String(telegramUserId || config?._ownerTelegramUserId || '');
  const cta = config?.cta || {};
  const out = [];
  const l1 = clampCtaLabel(cta.label);
  const u1 = normalizeCtaUrl(cta.url);
  if (l1 && u1) out.push({ label: l1, url: u1 });
  const label2 = clampCtaLabel(cta.label2);
  const url2 = normalizeCtaUrl(cta.url2);
  if (label2 && url2) {
    out.push({ label: label2, url: url2 });
    return out;
  }
  // Botao 2 com site do dono so na sessao ADM — cliente sem url2 nao herda nada.
  if (uid && isDivAdmin(uid)) {
    try {
      const t = require('./adminDivTemplate');
      out.push({
        label: label2 || t.demoOrSiteLabel(),
        url: url2 || t.demoOrSiteUrl()
      });
    } catch (_) {
      out.push({ label: label2 || 'Ver o site', url: url2 || 'https://hats444.github.io' });
    }
  }
  return out;
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

function isStatusReady(config) {
  return !!String(config?.textoStatus || '').trim() || !!config?.statusMidiaFile;
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
  out += `Botao 1: ${label || '(vazio)'}\n`;
  out += `Link 1: ${url || '(vazio)'}\n`;
  const label2 = String(config?.cta?.label2 || '').trim();
  const url2 = config?.cta?.url2 || '';
  if (label2 || url2) {
    out += `Botao 2: ${label2 || '(vazio)'}\n`;
    out += `Link 2: ${url2 || '(vazio)'}\n`;
  } else {
    out += `Botao 2: (nao) — opcional, outro link\n`;
  }
  out += `Foto CTA: ${hasFoto ? 'sim' : 'nao — manda a foto (botao Foto CTA ou {p}fotodivulcta)'}`;
  return out;
}

function getCtaStoredBuffer(config, telegramUserId) {
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
  return null;
}

function getCtaImageBuffer(config, telegramUserId) {
  if (config?.cta?.midiaTipo && config.cta.midiaTipo !== 'image') return null;
  const own = getCtaStoredBuffer(config, telegramUserId);
  if (own) return own;
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
  const cfg0 = carregarConfig(telegramUserId);
  const slot = isDivAdmin(telegramUserId) ? getActiveSlot(cfg0, 'normal') : 1;
  const file = writeMediaFile(telegramUserId, mediaFileSlotName('normal', slot), buffer);
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

function getStatusMediaBuffer(config, telegramUserId) {
  if (!config) return null;
  const buf = bufferFromStored(telegramUserId, null, config.statusMidiaFile);
  if (buf && config.statusMidiaTipo) {
    return {
      buffer: buf,
      tipo: config.statusMidiaTipo,
      mimetype: config.statusMidiaMimetype,
      fileName: config.statusMidiaNome
    };
  }
  return null;
}

function saveStatusMediaBuffer(telegramUserId, buffer, meta) {
  if (!buffer || !buffer.length) return null;
  const cfg0 = carregarConfig(telegramUserId);
  const slot = isDivAdmin(telegramUserId) ? getActiveSlot(cfg0, 'status') : 1;
  const file = writeMediaFile(telegramUserId, mediaFileSlotName('status', slot), buffer);
  return updateConfig(telegramUserId, {
    statusMidiaFile: file,
    statusMidiaTipo: (meta && meta.tipo) || 'image',
    statusMidiaMimetype: (meta && meta.mimetype) || 'image/jpeg',
    statusMidiaNome: (meta && meta.fileName) || null,
    configurado: true
  });
}

function clearStatusMedia(telegramUserId) {
  const cfg = getConfig(telegramUserId);
  try { unlinkMediaFile(telegramUserId, cfg.statusMidiaFile || 'div-status.bin'); } catch (_) { /* */ }
  return updateConfig(telegramUserId, {
    statusMidiaFile: null,
    statusMidiaTipo: null,
    statusMidiaMimetype: null,
    statusMidiaNome: null
  });
}

function saveCtaMediaBuffer(telegramUserId, buffer, meta) {
  if (!buffer || !buffer.length) return null;
  const cfg0 = carregarConfig(telegramUserId);
  const slot = isDivAdmin(telegramUserId) ? getActiveSlot(cfg0, 'cta') : 1;
  const file = writeMediaFile(telegramUserId, mediaFileSlotName('cta', slot), buffer);
  return updateConfig(telegramUserId, {
    cta: {
      midia: null,
      midiaFile: file,
      midiaTipo: (meta && meta.tipo) || 'image',
      midiaMimetype: (meta && meta.mimetype) || 'image/jpeg'
    },
    configurado: true
  });
}

function saveCtaImageBuffer(telegramUserId, buffer, mimetype) {
  if (!buffer || !buffer.length) return null;
  const cfg0 = carregarConfig(telegramUserId);
  const slot = isDivAdmin(telegramUserId) ? getActiveSlot(cfg0, 'cta') : 1;
  const file = writeMediaFile(telegramUserId, mediaFileSlotName('cta', slot), buffer);
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
    : 'Texto: (vazio) — use {p}msgdivul (pode ter varios links)';
}

function formatPaySummary(config) {
  const texto = String(config?.textoPay || '').trim();
  return texto
    ? `Pagamento: pronto\n${texto.substring(0, 160)}${texto.length > 160 ? '...' : ''}`
    : 'Pagamento: (vazio) — use {p}msgdivulpay';
}

function formatStatusSummary(config) {
  const texto = String(config?.textoStatus || '').trim();
  const midia = config?.statusMidiaFile ? `midia ${config.statusMidiaTipo || 'ok'}` : 'sem midia';
  if (!texto && !config?.statusMidiaFile) {
    return 'Status: (vazio) — use {p}msgdivulstatus e/ou foto status';
  }
  return `Status: pronto · ${midia}\n${texto ? texto.substring(0, 160) + (texto.length > 160 ? '...' : '') : '(so midia)'}`;
}

function formatTracksSummary(config) {
  const textoMidia = config?.midiaFile || config?.midia ? `midia ${config.midiaTipo || 'ok'}` : 'sem midia';
  const ctaMidia = config?.cta?.midiaFile ? `midia ${config.cta.midiaTipo || 'foto'}` : 'sem foto';
  return [
    formatTextoSummary(config) + `\nMidia texto: ${textoMidia}`,
    formatCtaSummary(config) + `\nMidia CTA: ${ctaMidia}`,
    formatPaySummary(config),
    formatStatusSummary(config)
  ].join('\n\n');
}

function queueTextForTipo(config, tipo, telegramUserId) {
  if (tipo === 'cta') {
    const t = String(config?.cta?.texto || '').trim();
    const btns = ctaUrlButtons(config, telegramUserId || config?._ownerTelegramUserId);
    if (!btns.length) return t;
    const extra = btns.map((b) => `${b.label}: ${b.url}`).join('\n');
    return t ? `${t}\n\n${extra}` : extra;
  }
  if (tipo === 'pay') return String(config?.textoPay || '').trim();
  if (tipo === 'status') return String(config?.textoStatus || '').trim();
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
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) return;
  offloadHeavyMedia(uid, config);
  let toSave = config;
  if (isDivAdmin(uid)) {
    try {
      const disk = carregarConfigRaw(uid);
      toSave = { ...config };
      if (toSave.cta && typeof toSave.cta === 'object') toSave.cta = { ...toSave.cta };
      require('./adminDivTemplate').restoreDiskTexts(toSave, disk);
    } catch (_) {
      toSave = config;
    }
  }
  try {
    const { slimDivulgacao } = require('./sqlStore');
    require('./sqlStore').upsertKv('divulgacao', uid, slimDivulgacao(stripRuntimeDivFields(toSave)));
  } catch (_) { /* */ }
  try {
    const file = getDivulgacaoPath(telegramUserId);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toDisk = stripRuntimeDivFields(toSave);
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
  const rawUpdates = { ...(updates || {}) };
  if (isDivAdmin(telegramUserId)) {
    try {
      require('./adminDivTemplate').persistEditsFromUpdates(telegramUserId, rawUpdates).catch(() => {});
    } catch (_) { /* ignore */ }
  }
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

  if (isDivAdmin(telegramUserId)) {
    ensureDivSlots(telegramUserId, config);
    const touchedCta = Object.prototype.hasOwnProperty.call(rawUpdates, 'cta');
    const touchedStatus = ['textoStatus', 'statusMidiaFile', 'statusMidiaTipo', 'statusMidiaMimetype', 'statusMidiaNome']
      .some((k) => Object.prototype.hasOwnProperty.call(rawUpdates, k));

    const routeActive = (track, touched) => {
      if (!touched) return false;
      const a = getActiveSlot(config, track);
      if (a <= 1) return false;
      if (track === 'cta') {
        const patch = rawUpdates.cta && typeof rawUpdates.cta === 'object' ? rawUpdates.cta : {};
        config.divSlots.cta[a] = { ...getSlotData(config, 'cta', a), ...patch };
        applyCtaSlotToCfg(config, config.divSlots.cta[1]);
      } else if (track === 'status') {
        const patch = {};
        for (const k of ['textoStatus', 'statusMidiaFile', 'statusMidiaTipo', 'statusMidiaMimetype', 'statusMidiaNome']) {
          if (Object.prototype.hasOwnProperty.call(rawUpdates, k)) patch[k] = rawUpdates[k];
        }
        config.divSlots.status[a] = { ...getSlotData(config, 'status', a), ...patch };
        applyStatusSlotToCfg(config, config.divSlots.status[1]);
      }
      return true;
    };

    const routed = !!(
      routeActive('cta', touchedCta) ||
      routeActive('status', touchedStatus)
    );
    if (!routed) {
      if (touchedCta && getActiveSlot(config, 'cta') <= 1) {
        config.divSlots.cta[1] = { ...emptySlotForTrack('cta'), ...legacyCtaFromCfg(config) };
      }
      if (touchedStatus && getActiveSlot(config, 'status') <= 1) {
        config.divSlots.status[1] = { ...emptySlotForTrack('status'), ...legacyStatusFromCfg(config) };
      }
    }
  }

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

function excludedSet(config) {
    return new Set(uniqueGrupos((config && config.gruposExcluidos) || []));
}

function isGrupoExcluido(telegramUserId, jid) {
    const gid = normalizeGrupoJid(jid);
    if (!gid) return false;
    return excludedSet(carregarConfig(telegramUserId)).has(gid);
}

function getGruposParaDivulgar(telegramUserId) {
    const config = carregarConfig(telegramUserId);
    if (config.modoGrupos !== 'especificos') {
        config.modoGrupos = 'especificos';
        salvarConfig(telegramUserId, config);
    }
    const skip = excludedSet(config);
    const grupos = uniqueGrupos(config.grupos || []).filter((g) => !skip.has(g));
    const dirtyList = grupos.length !== (config.grupos || []).length;
    const dirtyEx = uniqueGrupos(config.gruposExcluidos || []).length !== (config.gruposExcluidos || []).length;
    if (dirtyList || dirtyEx) {
        config.grupos = grupos;
        config.gruposExcluidos = [...skip];
        salvarConfig(telegramUserId, config);
    }
    return { modo: 'especificos', grupos };
}

function setModoGrupos(telegramUserId, modo) {
    const config = carregarConfig(telegramUserId);
    config.modoGrupos = modo === 'todos' ? 'especificos' : (modo || 'especificos');
    salvarConfig(telegramUserId, config);
}

function adicionarGrupo(telegramUserId, jid) {
    const gid = normalizeGrupoJid(jid);
    if (!gid) return false;
    const config = carregarConfig(telegramUserId);
    const clean = uniqueGrupos(config.grupos || []);
    const skip = excludedSet(config);
    const wasExcluded = skip.delete(gid);
    config.modoGrupos = 'especificos';
    config.gruposExcluidos = [...skip];
    if (clean.includes(gid)) {
        if (wasExcluded || clean.length !== (config.grupos || []).length) {
            config.grupos = clean;
            salvarConfig(telegramUserId, config);
        }
        return wasExcluded;
    }
    clean.push(gid);
    config.grupos = clean;
    salvarConfig(telegramUserId, config);
    return true;
}

function mergeGruposLista(telegramUserId, extraJids) {
    const extra = uniqueGrupos(extraJids);
    if (!extra.length) return { total: 0, added: 0 };
    const config = carregarConfig(telegramUserId);
    const skip = excludedSet(config);
    const before = new Set(uniqueGrupos(config.grupos || []).filter((g) => !skip.has(g)));
    let added = 0;
    for (const g of extra) {
        if (skip.has(g) || before.has(g)) continue;
        before.add(g);
        added += 1;
    }
    if (added) {
        config.grupos = [...before];
        config.modoGrupos = 'especificos';
        salvarConfig(telegramUserId, config);
    }
    return { total: before.size, added };
}

function removerGrupo(telegramUserId, jid) {
    const gid = normalizeGrupoJid(jid);
    if (!gid) return false;
    const config = carregarConfig(telegramUserId);
    const before = uniqueGrupos(config.grupos || []);
    const next = before.filter((g) => g !== gid);
    const skip = excludedSet(config);
    const already = skip.has(gid);
    skip.add(gid);
    if (next.length === before.length && already) return false;
    config.grupos = next;
    config.gruposExcluidos = [...skip];
    salvarConfig(telegramUserId, config);
    return true;
}

function limparGrupos(telegramUserId) {
    const config = carregarConfig(telegramUserId);
    const skip = excludedSet(config);
    for (const g of uniqueGrupos(config.grupos || [])) skip.add(g);
    config.gruposExcluidos = [...skip];
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
    resolveGruposDestino,
    listParticipatingGroupJids,
    listJoinedInviteJids,
    formatDestinoResumo,
    normalizeGrupoJid,
    isCanalDestino,
    setModoGrupos,
    adicionarGrupo,
    mergeGruposLista,
    isGrupoExcluido,
    removerGrupo,
    limparGrupos,
    setModo,
    carregarConfig,
    salvarConfig,
    defaultDivulgacao,
    normalizeCtaUrl,
    clampCtaLabel,
    parseCtaParts,
    ctaUrlButtons,
    assertSessionOwnsDivPayload,
    stampDivOwner,
    stripInheritedAdminCta,
    isCtaReady,
    ctaMissing,
    formatCtaSummary,
    getCtaImageBuffer,
    getCtaStoredBuffer,
    clearCtaMidia,
    isTextoReady,
    isPayReady,
    isStatusReady,
    formatTextoSummary,
    formatPaySummary,
    formatStatusSummary,
    formatTracksSummary,
    formatSlotsSummary,
    queueTextForTipo,
    migrateDivulgacao,
    captureMediaFromCtx,
    writeMediaFile,
    getTextoMediaBuffer,
    getStatusMediaBuffer,
    saveTextoMediaBuffer,
    saveStatusMediaBuffer,
    clearStatusMedia,
    saveCtaImageBuffer,
    saveCtaMediaBuffer,
    unlinkMediaFile,
    CTA_LABEL_MAX,
    SLOT_TRACKS,
    SLOT_IDS,
    MAX_SLOT,
    isDivAdmin,
    clampSlot,
    parseTipoSlot,
    modoKey,
    mediaFileSlotName,
    ensureDivSlots,
    getActiveSlot,
    setActiveSlot,
    getSlotData,
    applyViewConfig,
    viewForActiveTrack,
    viewConfigForModoKey,
    isTrackReady,
    updateSlotPatch,
    syncLegacyToSlot1,
    syncSlot1ToLegacy
};