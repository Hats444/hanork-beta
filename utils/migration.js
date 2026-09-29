// utils/migration.js
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { ADMIN_IDS, ensureUserDir } = require('./userManager');
const { registerSession } = require('./sessionRegistry');
const { getConfigPath, salvarConfig } = require('./configManager');

function migrateLegacySession() {
  const legacySessionPath = path.join(__dirname, '../session');
  const legacyConfigPath = path.join(__dirname, '../database/config.json');
  const legacyDivulgacaoPath = path.join(__dirname, '../database/divulgacao.json');

  const adminId = ADMIN_IDS[0];
  if (!adminId) {
    logger.logAviso('Nenhum ADMIN definido, migração ignorada.');
    return;
  }

  // Verifica se já existe sessão no admin
  const adminDir = ensureUserDir(adminId);
  const sessionsDir = path.join(adminDir, 'sessions');
  const existingSessions = fs.readdirSync(sessionsDir).filter(f => fs.statSync(path.join(sessionsDir, f)).isDirectory());

  // Se já houver sessões, não migrar (para não sobrescrever)
  if (existingSessions.length > 0) {
    logger.logInfo('Já existem sessões para o admin. Migração ignorada.');
    return;
  }

  // 1. Migrar creds.json
  if (fs.existsSync(path.join(legacySessionPath, 'creds.json'))) {
    const sessionId = 'session_legacy_admin';
    const targetDir = path.join(sessionsDir, sessionId);
    fs.mkdirSync(targetDir, { recursive: true });
    // Copia todo o conteúdo da sessão antiga
    const files = fs.readdirSync(legacySessionPath);
    for (const file of files) {
      const src = path.join(legacySessionPath, file);
      const dest = path.join(targetDir, file);
      if (fs.statSync(src).isDirectory()) {
        // Copiar subdiretórios (ex: app-state-sync)
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
    }
    // Registrar a sessão no registry
    registerSession(adminId, sessionId, { method: 'legacy', phone: 'migrado' });
    logger.logSucesso(`Sessão legada migrada para ${sessionId}`);
  }

  // 2. Migrar config.json
  if (fs.existsSync(legacyConfigPath)) {
    const oldConfig = JSON.parse(fs.readFileSync(legacyConfigPath, 'utf-8'));
    const newConfigPath = getConfigPath(adminId);
    // Se não existir config no admin, copia
    if (!fs.existsSync(newConfigPath)) {
      fs.copyFileSync(legacyConfigPath, newConfigPath);
      logger.logSucesso(`Config legada migrada para admin.`);
    }
  }

  // 3. Migrar divulgacao.json
  if (fs.existsSync(legacyDivulgacaoPath)) {
    const newDivulgacaoPath = path.join(path.dirname(getConfigPath(adminId)), 'divulgacao.json');
    if (!fs.existsSync(newDivulgacaoPath)) {
      fs.copyFileSync(legacyDivulgacaoPath, newDivulgacaoPath);
      logger.logSucesso(`Divulgação legada migrada para admin.`);
    }
  }
}

module.exports = { migrateLegacySession };