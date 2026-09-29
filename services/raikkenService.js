// services/raikkenService.js — Client API Pterodactyl / Raikken Host
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

function loadEnvOnce() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (_) { /* ignore */ }
}

loadEnvOnce();

function cfg() {
  return {
    panel: String(process.env.RAIKKEN_PANEL_URL || '').replace(/\/$/, ''),
    key: String(process.env.RAIKKEN_API_KEY || '').trim(),
    serverId: String(process.env.RAIKKEN_SERVER_ID || '').trim()
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.key && c.serverId && c.panel);
}

function headers(extra = {}) {
  const { key } = cfg();
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'Application/vnd.pterodactyl.v1+json',
    ...extra
  };
}

async function request(method, urlPath, { body, contentType, raw, serverScoped = true } = {}) {
  const c = cfg();
  if (!c.key) throw new Error('RAIKKEN_API_KEY nao configurada no .env');
  if (serverScoped && !c.serverId) throw new Error('RAIKKEN_SERVER_ID nao configurado no .env');

  const base = serverScoped
    ? `${c.panel}/api/client/servers/${c.serverId}`
    : `${c.panel}/api/client`;
  const url = urlPath.startsWith('http') ? urlPath : `${base}${urlPath}`;

  const init = { method, headers: headers(contentType ? { 'Content-Type': contentType } : {}) };
  if (body !== undefined) {
    init.body = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
    if (!contentType && typeof body === 'object' && !Buffer.isBuffer(body)) {
      init.headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 240);
    try {
      const j = JSON.parse(text);
      msg = j?.errors?.[0]?.detail || j?.errors?.[0]?.code || msg;
    } catch (_) { /* keep */ }
    throw new Error(`Raikken ${method} ${urlPath} → ${res.status}: ${msg}`);
  }
  if (raw || res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return res.json();
  return res.text();
}

// ---- Account / servers ----
async function listServers() {
  return request('GET', '', { serverScoped: false });
}

async function getAccount() {
  return request('GET', '/account', { serverScoped: false });
}

async function listApiKeys() {
  return request('GET', '/account/api-keys', { serverScoped: false });
}

async function listSshKeys() {
  return request('GET', '/account/ssh-keys', { serverScoped: false });
}

async function getServer() {
  return request('GET', '');
}

async function getResources() {
  return request('GET', '/resources');
}

async function power(signal) {
  const allowed = new Set(['start', 'stop', 'restart', 'kill']);
  if (!allowed.has(signal)) throw new Error('Sinal invalido (start|stop|restart|kill)');
  logger.logAviso(`[RAIKKEN] power=${signal}`);
  return request('POST', '/power', { body: { signal }, raw: true });
}

async function sendCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('Comando vazio');
  logger.logAviso(`[RAIKKEN] command=${cmd.slice(0, 80)}`);
  return request('POST', '/command', { body: { command: cmd }, raw: true });
}

async function getWebsocket() {
  const data = await request('GET', '/websocket');
  return data?.data || data;
}

/** Captura ultimas linhas do console via WebSocket (Node 22+). */
async function fetchConsoleTail(maxLines = 50, timeoutMs = 5000) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket indisponivel neste Node — use hostcmd');
  }
  const creds = await getWebsocket();
  const token = creds.token;
  const socket = creds.socket;
  if (!token || !socket) throw new Error('Websocket sem token/socket');

  return new Promise((resolve, reject) => {
    const lines = [];
    let settled = false;
    const ws = new WebSocket(socket);
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* */ }
      if (err) reject(err);
      else resolve(lines.slice(-maxLines));
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ event: 'auth', args: [token] }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (data.event === 'auth success') {
          ws.send(JSON.stringify({ event: 'send logs', args: [null] }));
        } else if (data.event === 'console output') {
          for (const a of data.args || []) lines.push(String(a));
        } else if (data.event === 'token expired') {
          done(null);
        }
      } catch (_) { /* ignore */ }
    });
    ws.addEventListener('error', () => done(new Error('Falha no websocket do console')));
    ws.addEventListener('close', () => done(null));
  });
}

async function getActivity(page = 1) {
  return request('GET', `/activity?page=${page}`);
}

async function getStartup() {
  return request('GET', '/startup');
}

async function updateStartupVariable(key, value) {
  return request('PUT', '/startup/variable', { body: { key, value } });
}

async function renameServer(name) {
  return request('POST', '/settings/rename', { body: { name }, raw: true });
}

async function reinstallServer() {
  logger.logAviso('[RAIKKEN] reinstall solicitado');
  return request('POST', '/settings/reinstall', { raw: true });
}

// ---- Files ----
function normPath(p) {
  let s = String(p || '/').replace(/\\/g, '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+/g, '/');
}

async function listFiles(directory = '/') {
  const dir = normPath(directory);
  return request('GET', `/files/list?directory=${encodeURIComponent(dir)}`);
}

async function readFile(filePath) {
  const file = normPath(filePath);
  return request('GET', `/files/contents?file=${encodeURIComponent(file)}`);
}

async function writeFile(filePath, content) {
  const file = normPath(filePath);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  logger.logAviso(`[RAIKKEN] write ${file} (${body.length}b)`);
  return request('POST', `/files/write?file=${encodeURIComponent(file)}`, {
    body,
    contentType: 'text/plain',
    raw: true
  });
}

async function createFolder(root, name) {
  return request('POST', '/files/create-folder', {
    body: { root: normPath(root), name: String(name).replace(/^\/+|\/+$/g, '') },
    raw: true
  });
}

async function deleteFiles(root, files) {
  const list = Array.isArray(files) ? files : [files];
  logger.logAviso(`[RAIKKEN] delete root=${root} n=${list.length}`);
  return request('POST', '/files/delete', {
    body: { root: normPath(root), files: list.map(String) },
    raw: true
  });
}

async function renameFiles(root, files) {
  // files: [{ from, to }]
  return request('PUT', '/files/rename', {
    body: { root: normPath(root), files },
    raw: true
  });
}

async function copyFile(location) {
  return request('POST', '/files/copy', { body: { location: normPath(location) }, raw: true });
}

async function compressFiles(root, files) {
  return request('POST', '/files/compress', {
    body: { root: normPath(root), files: (Array.isArray(files) ? files : [files]).map(String) }
  });
}

async function decompressFile(root, file) {
  return request('POST', '/files/decompress', {
    body: { root: normPath(root), file: String(file) },
    raw: true
  });
}

async function chmodFiles(root, files) {
  // files: [{ file, mode }]
  return request('POST', '/files/chmod', { body: { root: normPath(root), files }, raw: true });
}

async function pullRemoteFile(url, directory = '/', filename = null) {
  const body = { url: String(url), directory: normPath(directory) };
  if (filename) body.filename = String(filename);
  return request('POST', '/files/pull', { body, raw: true });
}

async function getDownloadUrl(filePath) {
  const file = normPath(filePath);
  return request('GET', `/files/download?file=${encodeURIComponent(file)}`);
}

async function getUploadUrl(directory = '/') {
  const dir = normPath(directory);
  return request('GET', `/files/upload?directory=${encodeURIComponent(dir)}`);
}

// ---- Backups / network / db / schedules / users ----
async function listBackups() {
  return request('GET', '/backups');
}

async function createBackup(name = null) {
  logger.logAviso('[RAIKKEN] backup create');
  const body = name ? { name: String(name) } : {};
  return request('POST', '/backups', { body });
}

async function deleteBackup(uuid) {
  logger.logAviso(`[RAIKKEN] backup delete ${String(uuid).slice(0, 8)}…`);
  return request('DELETE', `/backups/${uuid}`, { raw: true });
}

async function restoreBackup(uuid) {
  logger.logAviso(`[RAIKKEN] backup restore ${String(uuid).slice(0, 8)}…`);
  return request('POST', `/backups/${uuid}/restore`, { body: {}, raw: true });
}

async function getBackupDownload(uuid) {
  return request('GET', `/backups/${uuid}/download`);
}

async function listAllocations() {
  return request('GET', '/network/allocations');
}

async function listDatabases() {
  return request('GET', '/databases');
}

async function listSchedules() {
  return request('GET', '/schedules');
}

async function listSubusers() {
  return request('GET', '/users');
}

// ---- Format helpers (ASCII) ----
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KiB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MiB`;
  return `${(v / 1024 ** 3).toFixed(2)} GiB`;
}

function fmtUptime(msOrSec) {
  let sec = Number(msOrSec) || 0;
  if (sec > 1e6) sec = Math.floor(sec / 1000); // ms → s
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 2) return '***';
  return s[0] + '***' + s.slice(at);
}

async function statusReport() {
  const [server, res] = await Promise.all([getServer(), getResources()]);
  const a = server.attributes || {};
  const r = res.attributes || {};
  const resu = r.resources || {};
  const lim = a.limits || {};
  return [
    'HOST RAIKKEN',
    `Nome: ${a.name || '-'}`,
    `ID: ${a.identifier || cfg().serverId}`,
    `Node: ${a.node || '-'}`,
    `Estado: ${r.current_state || '-'}`,
    `Suspenso: ${r.is_suspended ? 'sim' : 'nao'}`,
    `CPU: ${(resu.cpu_absolute || 0).toFixed?.(1) ?? resu.cpu_absolute}% / limite ${lim.cpu || '-'}%`,
    `RAM: ${fmtBytes(resu.memory_bytes)} / ${lim.memory || '-'} MiB`,
    `Disco: ${fmtBytes(resu.disk_bytes)} / ${lim.disk || '-'} MiB`,
    `Rede RX/TX: ${fmtBytes(resu.network_rx_bytes)} / ${fmtBytes(resu.network_tx_bytes)}`,
    `Uptime: ${fmtUptime(resu.uptime)}`,
    `SFTP: ${(a.sftp_details && a.sftp_details.ip) || '-'} : ${(a.sftp_details && a.sftp_details.port) || '-'}`,
    `Docker: ${a.docker_image || '-'}`,
    `Painel: ${cfg().panel}/server/${cfg().serverId}`
  ].join('\n');
}

module.exports = {
  isConfigured,
  cfg,
  listServers,
  getAccount,
  listApiKeys,
  listSshKeys,
  getServer,
  getResources,
  power,
  sendCommand,
  getWebsocket,
  fetchConsoleTail,
  getActivity,
  getStartup,
  updateStartupVariable,
  renameServer,
  reinstallServer,
  listFiles,
  readFile,
  writeFile,
  createFolder,
  deleteFiles,
  renameFiles,
  copyFile,
  compressFiles,
  decompressFile,
  chmodFiles,
  pullRemoteFile,
  getDownloadUrl,
  getUploadUrl,
  listBackups,
  createBackup,
  deleteBackup,
  restoreBackup,
  getBackupDownload,
  listAllocations,
  listDatabases,
  listSchedules,
  listSubusers,
  statusReport,
  fmtBytes,
  fmtUptime,
  maskEmail,
  normPath
};
