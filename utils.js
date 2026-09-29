const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const {
    lidToJid,
    resolveAll,
    sharedLidPhoneCache,
    isLidUser,
    isPnUser,
    jidNormalizedUser
} = require("@systemzero/baileys");

const localLidToPhone = new Map();
const localPhoneToLid = new Map();
const LID_MAP_FILE = path.join(__dirname, 'data', 'system', 'lid_phone.json');
let lidMapLoaded = false;
let lidMapTimer = null;

/**
 * Garante JID/chatId como string (evita "jid?.endsWith is not a function").
 * Aceita string, ou objetos comuns Baileys ({ user, server }, { id }, {_serialized}).
 */
function ensureJidString(jid, fallback = '') {
    if (jid == null || jid === '') return fallback;
    if (typeof jid === 'string') return jid;
    if (typeof jid === 'number' || typeof jid === 'bigint') return String(jid);
    if (typeof jid === 'object') {
        if (typeof jid.user === 'string' && jid.server != null) {
            return `${jid.user}@${jid.server}`;
        }
        if (typeof jid._serialized === 'string') return jid._serialized;
        if (typeof jid.id === 'string') return jid.id;
        if (typeof jid.remoteJid === 'string') return jid.remoteJid;
    }
    try {
        const s = String(jid);
        if (s && s !== '[object Object]') return s;
    } catch (_) { /* ignore */ }
    return fallback;
}

function normalizeJid(jid = "") {
    const s = ensureJidString(jid, '');
    if (!s) return '';
    if (s.includes('@lid')) return s;
    return s.split("@")[0];
}

function isGroup(jid) {
    const s = ensureJidString(jid, '');
    if (!s) return false;
    return s.endsWith("@g.us");
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getMessageText(message = {}) {
    const m = message.ephemeralMessage?.message
        || message.viewOnceMessageV2?.message
        || message.viewOnceMessage?.message
        || message.documentWithCaptionMessage?.message
        || message;
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.templateButtonReplyMessage?.selectedId ||
        ""
    );
}

function jsonReplacer() {
    const seen = new WeakSet();
    return (key, value) => {
        if (typeof value === "bigint") return value.toString() + "n";
        if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
        if (value instanceof Uint8Array) return `<Uint8Array ${value.length} bytes>`;
        if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[Circular]";
            seen.add(value);
        }
        return value;
    };
}

function findFields(obj, fields, found = new Set(), depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 12) return found;
    for (const key of Object.keys(obj)) {
        if (fields.includes(key)) found.add(key);
        if (typeof obj[key] === "object") {
            findFields(obj[key], fields, found, depth + 1);
        }
    }
    return found;
}

function uptime(startedAt) {
    let s = Math.floor((Date.now() - startedAt) / 1000);
    const d = Math.floor(s / 86400);
    s %= 86400;
    const h = Math.floor(s / 3600);
    s %= 3600;
    const m = Math.floor(s / 60);
    s %= 60;
    return `${d}d ${h}h ${m}m ${s}s`;
}

function generateMessageSecret() {
    return crypto.randomBytes(32);
}

async function getImageBuffer(source) {
    if (!source) return null;
    try {
        if (source.startsWith('http://') || source.startsWith('https://')) {
            const response = await axios.get(source, { responseType: 'arraybuffer' });
            return Buffer.from(response.data);
        }
        const filePath = path.join(__dirname, 'assets', source);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath);
        }
        if (fs.existsSync(source)) {
            return fs.readFileSync(source);
        }
        return null;
    } catch (e) {
        console.error(`[getImageBuffer] Erro: ${e.message}`);
        return null;
    }
}

function resolveLid(lid) {
    if (!lid || typeof lid !== 'string') return null;
    try {
        return lidToJid(lid) || lid;
    } catch (e) {
        console.warn(`[resolveLid] Erro ao resolver ${lid}:`, e.message);
        return lid;
    }
}

function resolveAllJids(jid) {
    if (!jid || typeof jid !== 'string') return null;
    try {
        return resolveAll(jid);
    } catch (e) {
        console.warn(`[resolveAllJids] Erro ao resolver ${jid}:`, e.message);
        return null;
    }
}

function lidUserPart(lid) {
    return String(lid || '').split('@')[0].split(':')[0];
}

function loadPersistedLidMap() {
    if (lidMapLoaded) return;
    lidMapLoaded = true;
    const apply = (lidU, digits) => {
        const d = String(digits || '').replace(/\D/g, '');
        if (!/^\d{10,15}$/.test(d)) return;
        const u = lidUserPart(lidU);
        if (!u) return;
        const lidJ = String(lidU).includes('@lid') ? String(lidU) : `${u}@lid`;
        localLidToPhone.set(lidJ, d);
        localLidToPhone.set(u, d);
        localPhoneToLid.set(d, lidJ);
    };
    try {
        if (fs.existsSync(LID_MAP_FILE)) {
            const obj = JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8'));
            for (const [k, v] of Object.entries(obj || {})) apply(k, v);
        }
    } catch (_) { /* arquivo opcional */ }
}

function schedulePersistLidMap() {
    if (lidMapTimer) return;
    lidMapTimer = setTimeout(() => {
        lidMapTimer = null;
        try {
            const dir = path.dirname(LID_MAP_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const obj = {};
            for (const [k, v] of localLidToPhone.entries()) {
                if (String(k).includes('@lid') && /^\d{10,15}$/.test(String(v))) {
                    obj[lidUserPart(k)] = String(v);
                }
            }
            const tmp = LID_MAP_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(obj));
            fs.renameSync(tmp, LID_MAP_FILE);
        } catch (_) { /* ignore */ }
    }, 1500);
    if (lidMapTimer && typeof lidMapTimer.unref === 'function') lidMapTimer.unref();
}

function getPhoneForLid(lid) {
    if (!lid || typeof lid !== 'string') return null;
    try {
        loadPersistedLidMap();
        const local = localLidToPhone.get(lid) || localLidToPhone.get(lid.split('@')[0]);
        if (local) return local;
        return sharedLidPhoneCache.getPhoneForLid(lid) || null;
    } catch (e) {
        console.warn(`[getPhoneForLid] Erro:`, e.message);
        return null;
    }
}

function getLidForPhone(phone) {
    if (!phone || typeof phone !== 'string') return null;
    try {
        loadPersistedLidMap();
        const d = String(phone).replace(/\D/g, '');
        if (d && localPhoneToLid.has(d)) return localPhoneToLid.get(d);
        return sharedLidPhoneCache.getLidForPhone(phone) || null;
    } catch (e) {
        console.warn(`[getLidForPhone] Erro:`, e.message);
        return null;
    }
}

/**
 * Destino de envio 1:1. Chat LID sem PN some no Zap; grupo @g.us segue igual.
 * Prefere remoteJidAlt / cache / lidToJid da lib.
 */
/**
 * Chat 1:1 em que a msg chegou. LID e PN sao o MESMO PV — nao converter.
 * Grupo/canal/status nao mudam.
 */
function keepInboundChatJid(jid, key = null) {
    const inbound = ensureJidString(key?.remoteJid, '');
    if (
        inbound &&
        !inbound.endsWith('@g.us') &&
        !inbound.endsWith('@newsletter') &&
        !inbound.endsWith('@broadcast') &&
        inbound !== 'status@broadcast'
    ) {
        return inbound;
    }
    return ensureJidString(jid, inbound);
}

function resolvePeerJid(jid, key = null, conn = null) {
    const s = ensureJidString(jid, '');
    if (!s) return s;
    if (
        s.endsWith('@g.us') ||
        s.endsWith('@newsletter') ||
        s.endsWith('@broadcast') ||
        s === 'status@broadcast'
    ) {
        return s;
    }
    if (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) return s;

    const k = key && typeof key === 'object' ? key : {};
    const alts = [
        k.remoteJidAlt,
        k.participantAlt,
        k.senderPn,
        k.participantPn,
        k.peerRecipientPn
    ].filter(Boolean).map((v) => ensureJidString(v, ''));
    for (const a of alts) {
        if (!a || a.includes('@lid')) continue;
        if (a.endsWith('@s.whatsapp.net') || a.endsWith('@c.us')) {
            if (s.includes('@lid')) rememberLidPhonePair(s, a);
            return a;
        }
        const user = a.split('@')[0].split(':')[0];
        const d = user.replace(/\D/g, '');
        if (d.length >= 10 && d.length <= 15) {
            const pn = `${d}@s.whatsapp.net`;
            if (s.includes('@lid')) rememberLidPhonePair(s, pn);
            return pn;
        }
    }

    if (s.includes('@lid')) {
        const phone = getPhoneForLid(s);
        if (phone) {
            const d = String(phone).split('@')[0].split(':')[0].replace(/\D/g, '');
            if (d.length >= 10) return `${d}@s.whatsapp.net`;
        }
        try {
            const pn = lidToJid(s);
            const pns = ensureJidString(pn, '');
            if (pns && (pns.endsWith('@s.whatsapp.net') || pns.endsWith('@c.us'))) {
                rememberLidPhonePair(s, pns);
                return pns;
            }
        } catch (_) { /* lib opcional */ }
        try {
            const map = conn?.signalRepository?.lidMapping;
            const mapped =
                (typeof map?.getPNForLID === 'function' && map.getPNForLID(s)) ||
                (typeof map?.lidToPn === 'function' && map.lidToPn(s)) ||
                (typeof map?.get === 'function' && map.get(s));
            const ms = ensureJidString(mapped, '');
            if (ms && !ms.includes('@lid')) {
                const user = ms.split('@')[0].split(':')[0];
                const d = user.replace(/\D/g, '');
                const pn = ms.includes('@s.whatsapp.net') || ms.includes('@c.us')
                    ? ms
                    : (d.length >= 10 ? `${d}@s.whatsapp.net` : '');
                if (pn) {
                    rememberLidPhonePair(s, pn);
                    return pn;
                }
            }
        } catch (_) { /* mapping opcional */ }
        try {
            const contact =
                conn?.store?.contacts?.[s] ||
                conn?.contacts?.[s] ||
                conn?.store?.contacts?.[s.split('@')[0]];
            const cand = contact?.phoneNumber || contact?.jid || contact?.id || contact?.notify;
            const cs = ensureJidString(cand, '');
            if (cs && (cs.endsWith('@s.whatsapp.net') || cs.endsWith('@c.us'))) {
                rememberLidPhonePair(s, cs);
                return cs;
            }
            const d = String(cand || '').replace(/\D/g, '');
            if (d.length >= 10 && d.length <= 15) {
                const pn = `${d}@s.whatsapp.net`;
                rememberLidPhonePair(s, pn);
                return pn;
            }
        } catch (_) { /* contacts opcional */ }
    }
    return s;
}

/** Guarda par LID ↔ telefone quando os dois aparecem na mesma mensagem. */
function rememberLidPhonePair(lid, phone) {
    loadPersistedLidMap();
    const lidS = ensureJidString(lid, '');
    const phoneS = ensureJidString(phone, '');
    if (!lidS.includes('@lid')) return false;
    const digits = String(phoneS).replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return false;
    localLidToPhone.set(lidS, digits);
    localLidToPhone.set(lidS.split('@')[0], digits);
    localPhoneToLid.set(digits, lidS);
    schedulePersistLidMap();
    try {
        require('./utils/sqlStore').upsertKv('lidmap', lidS.split('@')[0], digits);
    } catch (_) { /* sql opcional */ }
    try {
        const c = sharedLidPhoneCache;
        if (c && typeof c.set === 'function') {
            c.set(lidS, `${digits}@s.whatsapp.net`);
        }
    } catch (_) { /* cache da lib opcional */ }
    return true;
}

function checkIsLidUser(jid) {
    if (!jid || typeof jid !== 'string') return false;
    try {
        return isLidUser(jid);
    } catch (e) {
        return false;
    }
}

function checkIsPnUser(jid) {
    if (!jid || typeof jid !== 'string') return false;
    try {
        return isPnUser(jid);
    } catch (e) {
        return false;
    }
}

module.exports = {
    ensureJidString,
    normalizeJid,
    isGroup,
    delay,
    getMessageText,
    jsonReplacer,
    findFields,
    uptime,
    generateMessageSecret,
    getImageBuffer,
    resolveLid,
    resolveAllJids,
    getPhoneForLid,
    getLidForPhone,
    rememberLidPhonePair,
    keepInboundChatJid,
    resolvePeerJid,
    checkIsLidUser,
    checkIsPnUser
};