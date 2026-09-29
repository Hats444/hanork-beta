// utils/fileUtils.js
// Utilitários para operações de arquivo assíncronas com tratamento de erros
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('../logger');

/**
 * Lê arquivo JSON de forma assíncrona com tratamento de erros
 */
async function readJSON(filePath, defaultValue = null) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        if (e.code === 'ENOENT') {
            return defaultValue;
        }
        logger.logErro('READ_JSON', `Erro ao ler ${filePath}: ${e.message}`);
        return defaultValue;
    }
}

/**
 * Escreve arquivo JSON de forma assíncrona com tratamento de erros
 */
async function writeJSON(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (e) {
        logger.logErro('WRITE_JSON', `Erro ao escrever ${filePath}: ${e.message}`);
        return false;
    }
}

/**
 * Verifica se arquivo existe de forma assíncrona
 */
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Lê arquivo de forma assíncrona
 */
async function readFile(filePath, encoding = 'utf-8') {
    try {
        return await fs.readFile(filePath, encoding);
    } catch (e) {
        logger.logErro('READ_FILE', `Erro ao ler ${filePath}: ${e.message}`);
        return null;
    }
}

/**
 * Escreve arquivo de forma assíncrona
 */
async function writeFile(filePath, content, encoding = 'utf-8') {
    try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content, encoding);
        return true;
    } catch (e) {
        logger.logErro('WRITE_FILE', `Erro ao escrever ${filePath}: ${e.message}`);
        return false;
    }
}

/**
 * Remove arquivo ou diretório de forma assíncrona
 */
async function remove(filePath) {
    try {
        await fs.rm(filePath, { recursive: true, force: true });
        return true;
    } catch (e) {
        logger.logErro('REMOVE', `Erro ao remover ${filePath}: ${e.message}`);
        return false;
    }
}

/**
 * Cria diretório de forma assíncrona
 */
async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        return true;
    } catch (e) {
        logger.logErro('ENSURE_DIR', `Erro ao criar diretório ${dirPath}: ${e.message}`);
        return false;
    }
}

/**
 * Lê arquivo JSON de forma síncrona (use apenas em inicialização)
 */
function readJSONSync(filePath, defaultValue = null) {
    try {
        if (fsSync.existsSync(filePath)) {
            const content = fsSync.readFileSync(filePath, 'utf-8');
            return JSON.parse(content);
        }
        return defaultValue;
    } catch (e) {
        logger.logErro('READ_JSON_SYNC', `Erro ao ler ${filePath}: ${e.message}`);
        return defaultValue;
    }
}

/**
 * Escreve arquivo JSON de forma síncrona (use apenas em shutdown crítico)
 */
function writeJSONSync(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fsSync.existsSync(dir)) {
            fsSync.mkdirSync(dir, { recursive: true });
        }
        fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (e) {
        logger.logErro('WRITE_JSON_SYNC', `Erro ao escrever ${filePath}: ${e.message}`);
        return false;
    }
}

module.exports = {
    readJSON,
    writeJSON,
    fileExists,
    readFile,
    writeFile,
    remove,
    ensureDir,
    readJSONSync,
    writeJSONSync
};