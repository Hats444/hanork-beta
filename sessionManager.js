// sessionManager.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getSessionDir } = require('./utils/sessionRegistry');

// Função auxiliar para obter o caminho da sessão
function getSessionPath(sessionId) {
  if (!sessionId) {
    return path.join(__dirname, 'session');
  }
  return getSessionDir(sessionId);
}

function sessionExists(sessionId) {
  const dir = getSessionPath(sessionId);
  return fs.existsSync(path.join(dir, 'creds.json'));
}

function clearSession(sessionId) {
  const dir = getSessionPath(sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.logInfo(`Sessão ${sessionId || 'padrão'} limpa.`);
    return true;
  }
  return false;
}

function repairSession(sessionId, silent = false) {
  if (!sessionExists(sessionId)) {
    if (!silent) {
      logger.logAviso(`Nenhuma sessão para reparar (${sessionId || 'padrão'}).`);
    }
    return false;
  }
  try {
    const dir = getSessionPath(sessionId);
    const creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf-8'));
    if (!creds || !creds.me) {
      if (!silent) {
        logger.logAviso(`Sessão ${sessionId || 'padrão'} corrompida. Reparando...`);
      }
      clearSession(sessionId);
      return false;
    }
    if (!silent) {
      logger.logInfo(`Sessão ${sessionId || 'padrão'} válida.`);
    }
    return true;
  } catch (e) {
    logger.logErro('Repair', e.message);
    clearSession(sessionId);
    return false;
  }
}

const MAX_BACKUPS_PER_USER = 2;

// Mantem no maximo MAX_BACKUPS_PER_USER arquivos de backup na pasta do
// usuario, removendo os mais antigos. Mais que isso so ocupa espaco em
// disco sem necessidade real (o backup mais recente e o unico que
// realmente importa para restauracao).
function pruneOldBackups(backupDir) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const full = path.join(backupDir, f);
        return { file: full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const excedentes = files.slice(MAX_BACKUPS_PER_USER);
    for (const f of excedentes) {
      try {
        fs.unlinkSync(f.file);
        logger.logInfo(`Backup antigo removido: ${f.file}`);
      } catch (e) {
        logger.logErro('BACKUP_PRUNE', e.message);
      }
    }
  } catch (e) {
    logger.logErro('BACKUP_PRUNE', e.message);
  }
}

function backupSession(sessionId) {
  if (!sessionExists(sessionId)) {
    logger.logAviso(`Nenhuma sessão para backup (${sessionId || 'padrão'}).`);
    return false;
  }
  try {
    const dir = getSessionPath(sessionId);
    const backupDir = path.join(path.dirname(dir), '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Corrige prefixo duplicado session_session_ (P11)
    const safeSessionId = sessionId || 'default';
    const backupFile = path.join(backupDir, `${safeSessionId}_${timestamp}.zip`);
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addLocalFolder(dir);
    zip.writeZip(backupFile);
    logger.logInfo(`Backup criado: ${backupFile}`);
    pruneOldBackups(backupDir);
    return true;
  } catch (e) {
    logger.logErro('Backup', e.message);
    return false;
  }
}

function restoreSession(sessionId, backupFile) {
  if (!fs.existsSync(backupFile)) {
    logger.logAviso(`Arquivo de backup não encontrado: ${backupFile}`);
    return false;
  }
  try {
    const dir = getSessionPath(sessionId);
    clearSession(sessionId);
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(backupFile);
    zip.extractAllTo(dir, true);
    logger.logInfo(`Sessão ${sessionId || 'padrão'} restaurada de ${backupFile}`);
    return true;
  } catch (e) {
    logger.logErro('Restore', e.message);
    return false;
  }
}

function exportSession(sessionId) {
  if (!sessionExists(sessionId)) {
    logger.logAviso(`Nenhuma sessão para exportar (${sessionId || 'padrão'}).`);
    return null;
  }
  try {
    const dir = getSessionPath(sessionId);
    return fs.readFileSync(path.join(dir, 'creds.json'), 'utf-8');
  } catch (e) {
    logger.logErro('Export', e.message);
    return null;
  }
}

function importSession(sessionId, credsJson) {
  try {
    if (typeof credsJson === 'object') credsJson = JSON.stringify(credsJson);
    const dir = getSessionPath(sessionId);
    clearSession(sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), credsJson);
    logger.logInfo(`Sessão ${sessionId || 'padrão'} importada.`);
    return true;
  } catch (e) {
    logger.logErro('Import', e.message);
    return false;
  }
}

module.exports = {
  sessionExists,
  clearSession,
  repairSession,
  backupSession,
  restoreSession,
  exportSession,
  importSession,
  getSessionPath,
};