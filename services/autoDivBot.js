'use strict';
/**
 * Liga/desliga a auto-divulgacao do bot nas sessoes admin.
 * Toggle/intervalo: registro unico admin_div_template (SQL).
 * Textos: mesmo registro (assemble em runtime). Grupos/midia: JSON da sessao.
 * Nao cria relogio proprio. Reusa divulgacaoAuto.runAutoCycleTipo.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { isAdmin } = require('../utils/userManager');

const STATE_FILE = path.join(__dirname, '..', 'data', 'autoDivBot.json');

function isOperatorTelegram(id) {
  return isAdmin(String(id || ''));
}

function adminIds() {
  try {
    const { ADMIN_IDS } = require('../utils/userManager');
    return (ADMIN_IDS || []).map(String).filter(isOperatorTelegram);
  } catch (_) {
    return [];
  }
}

function loadJsonFallback() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { on: !!j.on, lastAt: Number(j.lastAt) || 0, intervalMin: Number(j.intervalMin) || 0 };
  } catch (_) {
    return { on: false, lastAt: 0, intervalMin: 0 };
  }
}

function saveJsonFallback(st) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      on: !!st.on,
      lastAt: Number(st.lastAt) || 0,
      intervalMin: Number(st.intervalMin) || 0
    }, null, 2));
  } catch (e) {
    logger.logAviso(`[autodivbot] save: ${e.message}`);
  }
}

function loadState() {
  try {
    const tpl = require('../utils/adminDivTemplate').getTemplateSync();
    if (tpl && tpl.fromSql) {
      return { on: !!tpl.enabled, lastAt: Number(tpl.lastAt) || 0, intervalMin: Number(tpl.intervalMin) || 0 };
    }
  } catch (_) { /* sql ainda nao subiu */ }
  return loadJsonFallback();
}

function saveState(st) {
  saveJsonFallback(st);
  try {
    require('../utils/adminDivTemplate').saveTemplatePatch({
      enabled: !!st.on,
      lastAt: Number(st.lastAt) || 0,
      intervalMin: st.intervalMin || undefined
    }, 'autodivbot').catch((e) => {
      logger.logAviso(`[autodivbot] sql: ${e.message}`);
    });
  } catch (_) { /* ignore */ }
}

function applyAutoEnabled(uid, on) {
  const { updateConfig, getConfig } = require('../utils/divulgacao');
  const auto = require('../utils/divulgacaoAuto');
  const cfg = getConfig(uid);
  if (!!cfg.autoEnabled !== !!on) {
    updateConfig(uid, { autoEnabled: !!on });
  }
  if (on) auto.restartIfEnabled(uid, { armMissing: true });
  else auto.stopScheduler(uid);
  return getConfig(uid);
}

function applyInterval(uid, minutes) {
  const n = Math.min(1440, Math.max(45, parseInt(minutes, 10) || 0));
  if (!n) return;
  const { updateConfig } = require('../utils/divulgacao');
  const auto = require('../utils/divulgacaoAuto');
  const cfg = require('../utils/divulgacao').getConfig(uid);
  const patch = auto.patchIntervalByTipo(cfg, n, null);
  updateConfig(uid, patch);
}

function describe(st, uid) {
  const base = { on: !!(st && st.on), lastAt: Number(st && st.lastAt) || 0 };
  let intervalMin = Number(st && st.intervalMin) || null;
  try {
    const tpl = require('../utils/adminDivTemplate').getTemplateSync();
    if (tpl && tpl.intervalMin) intervalMin = tpl.intervalMin;
  } catch (_) { /* ignore */ }
  if (!uid) return { ...base, intervalMin, summary: 'sem admin' };
  try {
    const { getConfig } = require('../utils/divulgacao');
    const auto = require('../utils/divulgacaoAuto');
    const cfg = getConfig(uid);
    const modos = auto.parseModos(cfg.autoModos);
    return {
      ...base,
      intervalMin: intervalMin || Number(cfg.autoIntervalMin) || null,
      modos,
      autoEnabled: !!cfg.autoEnabled,
      summary: auto.formatAutoSummary(cfg),
      admins: adminIds().length
    };
  } catch (e) {
    return { ...base, intervalMin, summary: e.message };
  }
}

function setOn(on) {
  const st = loadState();
  st.on = !!on;
  saveState(st);
  const ids = adminIds();
  let intervalMin = st.intervalMin;
  try {
    const tpl = require('../utils/adminDivTemplate').getTemplateSync();
    if (tpl && tpl.intervalMin) intervalMin = tpl.intervalMin;
  } catch (_) { /* ignore */ }
  for (const uid of ids) {
    applyAutoEnabled(uid, !!on);
    if (intervalMin) applyInterval(uid, intervalMin);
  }
  return describe(st, ids[0]);
}

function status() {
  return describe(loadState(), adminIds()[0]);
}

function tiposForAdmin(uid) {
  const { getConfig } = require('../utils/divulgacao');
  const auto = require('../utils/divulgacaoAuto');
  const cfg = getConfig(uid);
  const modos = auto.parseModos(cfg.autoModos).filter((t) => auto.tipoReady(t, cfg));
  const fallback = auto.normalizeModo(cfg.modoPrincipal) || 'cta';
  return modos.length ? modos : (auto.tipoReady(fallback, cfg) ? [fallback] : []);
}

async function fireOnce() {
  try {
    await require('../utils/adminDivTemplate').ensureTemplate();
  } catch (_) { /* skeleton em memoria */ }

  const ids = adminIds();
  if (!ids.length) return { ok: false, reason: 'no-admin', results: [] };

  const auto = require('../utils/divulgacaoAuto');
  const all = [];
  for (const uid of ids) {
    if (!isOperatorTelegram(uid)) {
      all.push({ admin: String(uid).slice(-4), tipo: '-', ok: false, reason: 'not-operator' });
      continue;
    }
    const tipos = tiposForAdmin(uid);
    if (!tipos.length) {
      all.push({ admin: String(uid).slice(-4), tipo: '-', ok: false, reason: 'no-config' });
      continue;
    }
    for (const tipo of tipos) {
      try {
        const r = await auto.runAutoCycleTipo(uid, tipo, { force: true });
        all.push({
          admin: String(uid).slice(-4),
          tipo,
          ok: !!r?.ok,
          reason: r?.reason,
          done: r?.done || r?.grupos || 0
        });
      } catch (e) {
        all.push({ admin: String(uid).slice(-4), tipo, ok: false, reason: e.message });
      }
    }
  }

  const st = loadState();
  st.lastAt = Date.now();
  const over = all.some((r) => /overlimit|rate-overlimit/i.test(String(r.reason || '')));
  if (over) {
    st.intervalMin = Math.min(1440, Math.max(Number(st.intervalMin) || 90, 180));
    logger.logAviso(`[autodivbot] rate-overlimit — recua intervalo para ${st.intervalMin}min`);
    for (const uid of ids) applyInterval(uid, st.intervalMin);
  }
  saveState(st);
  const ok = all.some((r) => r.ok);
  logger.logInfo(
    `[autodivbot] disparo admins=${ids.length} ok=${ok} ` +
    all.map((r) => `${r.admin}/${r.tipo}:${r.ok ? 'ok' : r.reason}`).join(',')
  );
  return { ok, reason: ok ? undefined : (all[0] && all[0].reason) || 'fail', results: all };
}

async function tick() {
  const st = loadState();
  if (!st.on) return;
  const auto = require('../utils/divulgacaoAuto');
  for (const uid of adminIds()) {
    try {
      auto.restartIfEnabled(uid, { armMissing: true });
    } catch (e) {
      logger.logAviso(`[autodivbot] tick uid=${uid}: ${e.message}`);
    }
  }
}

module.exports = { loadState, setOn, status, fireOnce, tick, isOperatorTelegram, adminIds };
