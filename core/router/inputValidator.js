// core/router/inputValidator.js
// Validação e sanitização de input para comandos

/**
 * Valida e sanitiza input de comando
 */
function validateInput(args, config) {
    if (!args || !Array.isArray(args)) {
        return { valid: true, sanitized: [] };
    }
    
    const sanitized = [];
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const argConfig = config[i] || config.default || {};
        
        // Validação de tipo
        if (argConfig.type === 'number') {
            const num = parseFloat(arg);
            if (isNaN(num)) {
                return { valid: false, reason: `Argumento ${i} deve ser número` };
            }
            if (argConfig.min !== undefined && num < argConfig.min) {
                return { valid: false, reason: `Argumento ${i} deve ser >= ${argConfig.min}` };
            }
            if (argConfig.max !== undefined && num > argConfig.max) {
                return { valid: false, reason: `Argumento ${i} deve ser <= ${argConfig.max}` };
            }
            sanitized.push(num);
            continue;
        }
        
        if (argConfig.type === 'url') {
            const sanitizedUrl = sanitizeUrl(arg);
            if (!sanitizedUrl) {
                return { valid: false, reason: `Argumento ${i} URL inválida` };
            }
            sanitized.push(sanitizedUrl);
            continue;
        }
        
        if (argConfig.type === 'jid') {
            const sanitizedJid = sanitizeJid(arg);
            if (!sanitizedJid) {
                return { valid: false, reason: `Argumento ${i} JID inválido` };
            }
            sanitized.push(sanitizedJid);
            continue;
        }
        
        // Sanitização de texto padrão
        const sanitizedText = sanitizeText(arg, argConfig);
        sanitized.push(sanitizedText);
    }
    
    return { valid: true, sanitized };
}

/**
 * Sanitiza URL (previne SSRF)
 */
function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    
    // Remove protocolo para validação
    const cleanUrl = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // Validação básica
    if (!/^[a-zA-Z0-9.-]+$/.test(cleanUrl)) {
        return null;
    }
    
    // Bloqueia localhost e IPs privados
    if (cleanUrl === 'localhost' || cleanUrl === '127.0.0.1') {
        return null;
    }
    if (cleanUrl.startsWith('192.168.') || cleanUrl.startsWith('10.')) {
        return null;
    }
    
    return `https://${cleanUrl}`;
}

/**
 * Sanitiza JID
 */
function sanitizeJid(jid) {
    if (!jid || typeof jid !== 'string') return null;
    
    // Remove caracteres não numéricos
    const cleanJid = jid.replace(/[^0-9@]/g, '');
    
    if (!cleanJid.includes('@')) {
        return cleanJid + '@s.whatsapp.net';
    }
    
    return cleanJid;
}

/**
 * Sanitiza texto
 */
function sanitizeText(text, config = {}) {
    if (!text || typeof text !== 'string') return '';
    
    let sanitized = text.trim();
    
    // Limite de tamanho
    const maxLength = config.maxLength || 1000;
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength);
    }
    
    // Remove caracteres perigosos para injeção
    sanitized = sanitized
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Controles de controle
        .replace(/[\u0000-\u001F]/g, ''); // Unicode controls
    
    return sanitized;
}

/**
 * Sanitiza CPF/CNPJ (aplica máscara)
 */
function sanitizeCpfCnpj(value) {
    if (!value || typeof value !== 'string') return '';
    
    const clean = value.replace(/\D/g, '');
    
    if (clean.length === 11) {
        return clean.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    
    if (clean.length === 14) {
        return clean.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
    
    return clean;
}

/**
 * Sanitiza telefone
 */
function sanitizePhone(value) {
    if (!value || typeof value !== 'string') return '';
    
    const clean = value.replace(/\D/g, '');
    
    if (clean.length === 11) {
        return clean.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    }
    
    if (clean.length === 10) {
        return clean.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
    }
    
    return clean;
}

module.exports = {
    validateInput,
    sanitizeUrl,
    sanitizeJid,
    sanitizeText,
    sanitizeCpfCnpj,
    sanitizePhone
};
