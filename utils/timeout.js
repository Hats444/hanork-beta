// utils/timeout.js
// Utilitário de timeout global para operações críticas com cancelamento seguro

const logger = require('../logger');

// Timeout padrão para operações críticas (30 segundos)
const DEFAULT_TIMEOUT_MS = 30000;
const HANDLER_TIMEOUT_MS = Number(process.env.HANORK_HANDLER_TIMEOUT_MS || 120000);

// Mapa de timeouts ativos para cancelamento
const activeTimeouts = new Map();

/**
 * Executa uma função com timeout, garantindo limpeza adequada
 * @param {Function} fn - Função a executar
 * @param {number} timeoutMs - Timeout em milissegundos
 * @param {string} operationName - Nome da operação para logs
 * @returns {Promise} - Promise que resolve com o resultado ou rejeita com timeout
 */
async function withTimeout(fn, timeoutMs = DEFAULT_TIMEOUT_MS, operationName = 'operation') {
    const timeoutId = `timeout_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const wait = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    
    const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout: ${operationName} excedeu ${wait}ms`));
        }, wait);
        
        activeTimeouts.set(timeoutId, { timer, operationName, startTime: Date.now() });
    });
    
    try {
        const result = await Promise.race([
            fn(),
            timeoutPromise
        ]);
        
        // Limpa timeout se a função completou
        const timeoutData = activeTimeouts.get(timeoutId);
        if (timeoutData) {
            clearTimeout(timeoutData.timer);
            activeTimeouts.delete(timeoutId);
        }
        
        return result;
    } catch (error) {
        // Limpa timeout mesmo em caso de erro
        const timeoutData = activeTimeouts.get(timeoutId);
        if (timeoutData) {
            clearTimeout(timeoutData.timer);
            activeTimeouts.delete(timeoutId);
        }
        
        if (error.message.includes('Timeout')) {
            logger.logAviso(`[TIMEOUT] ${operationName} excedeu ${timeoutMs}ms`);
        }
        
        throw error;
    }
}

/**
 * Cancela todos os timeouts ativos (útil no shutdown)
 */
function cancelAllTimeouts() {
    let cancelled = 0;
    for (const [id, data] of activeTimeouts.entries()) {
        try {
            clearTimeout(data.timer);
            cancelled++;
        } catch (e) {
            logger.logErro('TIMEOUT_CANCEL', `Erro ao cancelar timeout ${id}: ${e.message}`);
        }
    }
    activeTimeouts.clear();
    
    if (cancelled > 0) {
        logger.logInfo(`[TIMEOUT] ${cancelled} timeouts cancelados`);
    }
}

/**
 * Obtém estatísticas dos timeouts ativos
 */
function getTimeoutStats() {
    const stats = {
        active: activeTimeouts.size,
        operations: []
    };
    
    const now = Date.now();
    for (const [id, data] of activeTimeouts.entries()) {
        const elapsed = now - data.startTime;
        stats.operations.push({
            id,
            operation: data.operation,
            elapsedMs: elapsed
        });
    }
    
    return stats;
}

/**
 * Limpa timeouts que estão ativos há muito tempo (>5 minutos)
 * Útil para limpar timeouts órfãos
 */
function cleanupStaleTimeouts() {
    const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutos
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, data] of activeTimeouts.entries()) {
        if (now - data.startTime > STALE_THRESHOLD) {
            try {
                clearTimeout(data.timer);
                activeTimeouts.delete(id);
                cleaned++;
                logger.logAviso(`[TIMEOUT] Timeout órfão limpo: ${data.operation} (ativo por ${Math.floor((now - data.startTime)/1000)}s)`);
            } catch (e) {
                logger.logErro('TIMEOUT_CLEANUP', `Erro ao limpar timeout ${id}: ${e.message}`);
            }
        }
    }
    
    if (cleaned > 0) {
        logger.logInfo(`[TIMEOUT] ${cleaned} timeouts órfãos limpos`);
    }
}

// Cleanup periódico de timeouts órfãos (a cada 10 minutos)
setInterval(cleanupStaleTimeouts, 10 * 60 * 1000);

// Cleanup no shutdown
process.on('exit', () => {
    cancelAllTimeouts();
});

process.on('SIGINT', () => {
    cancelAllTimeouts();
});

process.on('SIGTERM', () => {
    cancelAllTimeouts();
});

module.exports = {
    withTimeout,
    cancelAllTimeouts,
    getTimeoutStats,
    cleanupStaleTimeouts,
    DEFAULT_TIMEOUT_MS,
    HANDLER_TIMEOUT_MS
};