// core/router/sessionStore.js
// Isolamento de sessão e dados (anti-vazamento)

// Armazenamento isolado por sessionId + userId
const sessionData = new Map();

// TTL padrão para dados temporários (30 minutos)
const DEFAULT_TTL = 30 * 60 * 1000;

/**
 * Obtém dado isolado por sessão e usuário
 */
function get(sessionId, userId, key) {
    const compositeKey = `${sessionId}:${userId}:${key}`;
    const entry = sessionData.get(compositeKey);
    
    if (!entry) return null;
    
    // Verifica TTL
    if (Date.now() > entry.expiresAt) {
        sessionData.delete(compositeKey);
        return null;
    }
    
    return entry.value;
}

/**
 * Define dado isolado por sessão e usuário
 */
function set(sessionId, userId, key, value, ttl = DEFAULT_TTL) {
    const compositeKey = `${sessionId}:${userId}:${key}`;
    
    sessionData.set(compositeKey, {
        value,
        expiresAt: Date.now() + ttl,
        createdAt: Date.now()
    });
}

/**
 * Remove dado isolado
 */
function remove(sessionId, userId, key) {
    const compositeKey = `${sessionId}:${userId}:${key}`;
    sessionData.delete(compositeKey);
}

/**
 * Limpa todos os dados de um usuário em uma sessão
 */
function clearUserSession(sessionId, userId) {
    const prefix = `${sessionId}:${userId}:`;
    
    for (const key of sessionData.keys()) {
        if (key.startsWith(prefix)) {
            sessionData.delete(key);
        }
    }
}

/**
 * Limpa todos os dados de uma sessão
 */
function clearSession(sessionId) {
    const prefix = `${sessionId}:`;
    
    for (const key of sessionData.keys()) {
        if (key.startsWith(prefix)) {
            sessionData.delete(key);
        }
    }
}

/**
 * Limpa dados expirados (chamado periodicamente)
 */
function cleanupExpired() {
    const now = Date.now();
    
    for (const [key, entry] of sessionData.entries()) {
        if (now > entry.expiresAt) {
            sessionData.delete(key);
        }
    }
}

// Limpeza automática a cada 5 minutos
setInterval(cleanupExpired, 300000);

/**
 * Obtém dados sensíveis mascarados (para logs)
 */
function getMasked(sessionId, userId, key) {
    const value = get(sessionId, userId, key);
    
    if (!value) return null;
    
    // Mascarar dados sensíveis
    if (typeof value === 'string') {
        if (value.length > 10) {
            return value.substring(0, 4) + '****' + value.substring(value.length - 4);
        }
        return '****';
    }
    
    if (typeof value === 'object') {
        return '[MASKED_OBJECT]';
    }
    
    return '[MASKED]';
}

module.exports = {
    sessionStore: {
        get,
        set,
        remove,
        clearUserSession,
        clearSession,
        getMasked
    },
    cleanupExpired
};
