// utils/database.js
// Banco de dados JSON para clientes (compatível com WSL/Windows)
const fs = require('fs');
const path = require('path');
const logger = require("../logger");

const DB_DIR = path.join(__dirname, '../data');
const CLIENTS_FILE = path.join(DB_DIR, 'clients.json');
const SESSIONS_FILE = path.join(DB_DIR, 'sessions.json');
const USAGE_FILE = path.join(DB_DIR, 'usage_stats.json');

let clients = {};
let sessions = {};
let usageStats = {};

// Inicializar banco de dados
function initDatabase() {
    return new Promise((resolve, reject) => {
        try {
            if (!fs.existsSync(DB_DIR)) {
                fs.mkdirSync(DB_DIR, { recursive: true });
            }

            // SQL-first
            try {
                const store = require('./sqlStore');
                if (store.isReady()) {
                    const c = store.getCachedKv('db', 'clients');
                    const s = store.getCachedKv('db', 'sessions');
                    const u = store.getCachedKv('db', 'usage_stats');
                    if (c && typeof c === 'object') clients = c;
                    if (s && typeof s === 'object') sessions = s;
                    if (u && typeof u === 'object') usageStats = u;
                }
            } catch (_) { /* fallback JSON */ }

            if (!Object.keys(clients).length && fs.existsSync(CLIENTS_FILE)) {
                clients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf-8'));
            }
            if (!Object.keys(sessions).length && fs.existsSync(SESSIONS_FILE)) {
                sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
            }
            if (!Object.keys(usageStats).length && fs.existsSync(USAGE_FILE)) {
                usageStats = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
            }

            // Espelha no SQL
            try {
                const store = require('./sqlStore');
                store.upsertKv('db', 'clients', clients);
                store.upsertKv('db', 'sessions', sessions);
                store.upsertKv('db', 'usage_stats', usageStats);
            } catch (_) { /* */ }

            logger.logInfo('Banco de dados inicializado (SQL+JSON backup).');
            resolve();
        } catch (err) {
            logger.logErro('DATABASE_INIT', err.message);
            reject(err);
        }
    });
}

// Salvar dados
function saveData() {
    try {
        try {
            const store = require('./sqlStore');
            store.upsertKv('db', 'clients', clients);
            store.upsertKv('db', 'sessions', sessions);
            store.upsertKv('db', 'usage_stats', usageStats);
        } catch (_) { /* */ }
        fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
        fs.writeFileSync(USAGE_FILE, JSON.stringify(usageStats, null, 2));
    } catch (err) {
        logger.logErro('SAVE_DATA', err.message);
    }
}

// Adicionar cliente
function addClient(telegramId, phone = null, jid = null) {
    const id = String(telegramId);
    if (!clients[id]) {
        clients[id] = {
            telegram_id: id,
            phone: phone,
            jid: jid,
            prefix: '.',
            is_vip: false,
            is_owner: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        logger.logInfo(`Cliente ${id} adicionado.`);
        saveData();
    } else {
        clients[id].phone = phone;
        clients[id].jid = jid;
        clients[id].updated_at = new Date().toISOString();
        logger.logInfo(`Cliente ${id} atualizado.`);
        saveData();
    }
    return Promise.resolve(clients[id]);
}

// Obter cliente
function getClient(telegramId) {
    const id = String(telegramId);
    return Promise.resolve(clients[id] || null);
}

// Atualizar prefixo do cliente
function updateClientPrefix(telegramId, prefix) {
    const id = String(telegramId);
    if (clients[id]) {
        clients[id].prefix = prefix;
        clients[id].updated_at = new Date().toISOString();
        logger.logInfo(`Prefixo do cliente ${id} atualizado para ${prefix}.`);
        saveData();
        return Promise.resolve(true);
    }
    return Promise.resolve(false);
}

// Definir VIP
function setClientVip(telegramId, isVip) {
    const id = String(telegramId);
    if (clients[id]) {
        clients[id].is_vip = isVip;
        clients[id].updated_at = new Date().toISOString();
        logger.logInfo(`VIP do cliente ${id} definido como ${isVip}.`);
        saveData();
        return Promise.resolve(true);
    }
    return Promise.resolve(false);
}

// Definir Owner
function setClientOwner(telegramId, isOwner) {
    const id = String(telegramId);
    if (clients[id]) {
        clients[id].is_owner = isOwner;
        clients[id].updated_at = new Date().toISOString();
        logger.logInfo(`Owner do cliente ${id} definido como ${isOwner}.`);
        saveData();
        return Promise.resolve(true);
    }
    return Promise.resolve(false);
}

// Listar todos os clientes
function getAllClients() {
    return Promise.resolve(Object.values(clients).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
}

// Registrar uso de comando
function logCommandUsage(telegramId, command) {
    const id = String(telegramId);
    const key = `${id}_${command}`;
    
    if (!usageStats[key]) {
        usageStats[key] = {
            telegram_id: id,
            command: command,
            count: 0,
            last_used: null
        };
    }
    
    usageStats[key].count++;
    usageStats[key].last_used = new Date().toISOString();
    saveData();
    
    return Promise.resolve();
}

// Obter estatísticas de uso
function getUsageStats(telegramId) {
    const id = String(telegramId);
    const stats = Object.values(usageStats)
        .filter(s => s.telegram_id === id)
        .sort((a, b) => b.count - a.count);
    return Promise.resolve(stats);
}

// Fechar conexão
function closeDatabase() {
    saveData();
    logger.logInfo('Banco de dados fechado.');
    return Promise.resolve();
}

module.exports = {
    initDatabase,
    addClient,
    getClient,
    updateClientPrefix,
    setClientVip,
    setClientOwner,
    getAllClients,
    logCommandUsage,
    getUsageStats,
    closeDatabase
};
