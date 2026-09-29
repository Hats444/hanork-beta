// utils/invisibleQueue.js
// Gerenciamento de filas isoladas por sessão/grupo para divulgação invisível (técnica ValleyInvisible)

const logger = require('../logger');

// Estrutura: Map<sessionId, Map<groupJid, QueueData>>
// QueueData = { pendingParticipants: Set<string>, messageText: string, startTime: number, lastAccess: number }
const invisibleQueues = new Map();

// Locks para evitar processamento concorrente do mesmo participante
const participantLocks = new Map();

const QUEUE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h — nao acumula dezenas de milhares
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const MAX_QUEUE_PARTICIPANTS = 80;

// Cleanup periódico de filas órfãs
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [sessionId, sessionQueues] of invisibleQueues.entries()) {
        for (const [groupJid, queue] of sessionQueues.entries()) {
            // Se a fila não foi acessada há mais de 24 horas, limpa
            if (now - queue.lastAccess > QUEUE_TIMEOUT_MS) {
                logger.logInfo(`[INVISIBLE_QUEUE] Limpando fila órfã - sessionId=${sessionId}, groupJid=${groupJid}, idle=${Math.floor((now - queue.lastAccess)/1000/60)}min`);
                sessionQueues.delete(groupJid);
                cleanedCount++;
            }
        }
        
        // Limpa sessão se não houver mais filas
        if (sessionQueues.size === 0) {
            invisibleQueues.delete(sessionId);
        }
    }
    
    if (cleanedCount > 0) {
        logger.logInfo(`[INVISIBLE_QUEUE] Cleanup concluído: ${cleanedCount} filas órfãs removidas`);
    }
}, CLEANUP_INTERVAL_MS);

function getQueueKey(sessionId, groupJid) {
    return `${sessionId}:${groupJid}`;
}

function getGroupQueue(sessionId, groupJid) {
    if (!invisibleQueues.has(sessionId)) {
        invisibleQueues.set(sessionId, new Map());
    }
    const sessionQueues = invisibleQueues.get(sessionId);
    if (!sessionQueues.has(groupJid)) {
        sessionQueues.set(groupJid, {
            pendingParticipants: new Set(),
            mentionJids: [],
            messageText: '',
            startTime: 0,
            lastAccess: Date.now()
        });
    }
    const queue = sessionQueues.get(groupJid);
    queue.lastAccess = Date.now(); // Atualiza timestamp de acesso
    return queue;
}

function createQueue(sessionId, groupJid, participants, messageText) {
    const queue = getGroupQueue(sessionId, groupJid);
    const all = Array.isArray(participants) ? [...new Set(participants.filter(Boolean))] : [];
    const list = all.slice(0, MAX_QUEUE_PARTICIPANTS);
    queue.pendingParticipants = new Set(list);
    queue.mentionJids = all;
    queue.messageText = messageText;
    queue.startTime = Date.now();
    queue.lastAccess = Date.now();
    logger.logInfo(
      `[INVISIBLE_QUEUE] Fila criada group=${String(groupJid).slice(0, 22)} n=${list.length} mencoes=${all.length}` +
      (all.length > list.length ? ` cap=${MAX_QUEUE_PARTICIPANTS}` : '')
    );
}

function getQueue(sessionId, groupJid) {
    if (!invisibleQueues.has(sessionId)) return null;
    const sessionQueues = invisibleQueues.get(sessionId);
    return sessionQueues.get(groupJid) || null;
}

function isParticipantPending(sessionId, groupJid, participantJid) {
    const queue = getQueue(sessionId, groupJid);
    if (!queue) return false;

    try {
        const { sameUser } = require('./directedGroupRelay');
        for (const pending of queue.pendingParticipants) {
            if (sameUser(pending, participantJid)) return true;
        }
        return false;
    } catch (_) {
        // fallback legado
        const normalizedParticipant = String(participantJid || '').split(':')[0];
        for (const pending of queue.pendingParticipants) {
            const normalizedPending = String(pending || '').split(':')[0];
            if (normalizedPending === normalizedParticipant) return true;
            if (
                normalizedPending.replace(/@.+$/, '') === normalizedParticipant.replace(/@.+$/, '')
            ) return true;
        }
        return false;
    }
}

function maskJid(jid) {
    const s = String(jid || '');
    return s.replace(/\d(?=\d{4})/g, '*');
}

function markParticipantProcessed(sessionId, groupJid, participantJid) {
    const queue = getQueue(sessionId, groupJid);
    if (!queue) return false;

    try {
        const { sameUser } = require('./directedGroupRelay');
        for (const pending of queue.pendingParticipants) {
            if (sameUser(pending, participantJid)) {
                queue.pendingParticipants.delete(pending);
                return true;
            }
        }
        return false;
    } catch (_) {
        const normalizedParticipant = String(participantJid || '').split(':')[0];
        for (const pending of queue.pendingParticipants) {
            const normalizedPending = String(pending || '').split(':')[0];
            if (
                normalizedPending === normalizedParticipant ||
                normalizedPending.replace(/@.+$/, '') === normalizedParticipant.replace(/@.+$/, '')
            ) {
                queue.pendingParticipants.delete(pending);
                return true;
            }
        }
        return false;
    }
}

function getPendingCount(sessionId, groupJid) {
    const queue = getQueue(sessionId, groupJid);
    return queue ? queue.pendingParticipants.size : 0;
}

function getMessageText(sessionId, groupJid) {
    const queue = getQueue(sessionId, groupJid);
    return queue ? queue.messageText : '';
}

function getMentionJids(sessionId, groupJid) {
    const queue = getQueue(sessionId, groupJid);
    return queue && Array.isArray(queue.mentionJids) ? queue.mentionJids : [];
}

function clearQueue(sessionId, groupJid) {
    if (!invisibleQueues.has(sessionId)) return;
    const sessionQueues = invisibleQueues.get(sessionId);
    const queue = sessionQueues.get(groupJid);
    if (queue) {
        logger.logInfo(`[INVISIBLE_QUEUE] Fila limpa - sessionId=${sessionId}, groupJid=${groupJid}`);
        sessionQueues.delete(groupJid);
    }
    
    // Limpa sessão se não houver mais filas
    if (sessionQueues.size === 0) {
        invisibleQueues.delete(sessionId);
    }
}

function clearSessionQueues(sessionId) {
    logger.logInfo(`[INVISIBLE_QUEUE] Todas as filas da sessão limpas - sessionId=${sessionId}`);
    invisibleQueues.delete(sessionId);
}

// Lock para evitar processamento concorrente
async function withParticipantLock(sessionId, groupJid, participantJid, fn) {
    const lockKey = getQueueKey(sessionId, groupJid) + ':' + participantJid;
    
    if (participantLocks.has(lockKey)) {
        logger.logAviso(`[INVISIBLE_QUEUE] Lock já existe para participante - ${maskJid(participantJid)}`);
        return false;
    }
    
    participantLocks.set(lockKey, true);
    try {
        await fn();
        return true;
    } finally {
        participantLocks.delete(lockKey);
    }
}

function getQueueStats() {
    const stats = {};
    for (const [sessionId, sessionQueues] of invisibleQueues.entries()) {
        stats[sessionId] = {};
        for (const [groupJid, queue] of sessionQueues.entries()) {
            stats[sessionId][groupJid] = {
                pending: queue.pendingParticipants.size,
                messageText: queue.messageText.substring(0, 50) + (queue.messageText.length > 50 ? '...' : ''),
                startTime: queue.startTime
            };
        }
    }
    return stats;
}

module.exports = {
    createQueue,
    getQueue,
    isParticipantPending,
    markParticipantProcessed,
    getPendingCount,
    getMessageText,
    getMentionJids,
    clearQueue,
    clearSessionQueues,
    withParticipantLock,
    getQueueStats
};
