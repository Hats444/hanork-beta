// core/router/eventNormalizer.js
// Normalização de eventos de WhatsApp e Telegram para formato único interno

const { isJidGroup, isJidNewsletter } = require('@systemzero/baileys');
const { getMessageText, ensureJidString } = require('../../utils');
const { isGroup: isGroupUtil } = require('../../utils');

/**
 * Normaliza evento de WhatsApp
 */
function normalizeWhatsAppEvent(rawEvent, conn) {
    try {
        const info = rawEvent;
        const key = info?.key || {};
        const message = info?.message || {};
        
        const sessionId = conn?._sessionId || 'default';
        const chatId = ensureJidString(key?.remoteJid, '');
        const userId = ensureJidString(key?.participant || key?.remoteJid, '');
        const pushName = info?.pushName || '';
        
        // Validação de tipo (após coerce)
        if (!chatId || !userId) {
            throw new Error('chatId ou userId inválido');
        }
        
        const isGroup = isJidGroup(chatId);
        const isNewsletter = isJidNewsletter(chatId);
        
        const fullText = getMessageText(message) || '';
        const { parsePrefixedCommand } = require('../../utils/commandTextParse');
        let userPrefix = '';
        try {
          const tid = conn?._telegramUserId || null;
          if (tid) userPrefix = require('../../utils/configManager').getPrefix(tid);
        } catch (_) {}
        const parsed = parsePrefixedCommand(fullText, userPrefix || '.', { platform: 'whatsapp' });
        const prefix = parsed.prefix;
        const command = parsed.command;
        const args = parsed.args;
        const text = parsed.text;
        
        // Detectar tipo de mídia
        const mediaType = detectMediaType(message);
        
        return {
            platform: 'whatsapp',
            sessionId,
            chatId: String(chatId),
            userId: String(userId),
            pushName,
            isGroup,
            isNewsletter,
            text,
            fullText,
            prefix,
            command,
            args,
            mediaType,
            fromMe: !!key?.fromMe,
            raw: rawEvent
        };
    } catch (e) {
        require('../../logger').logException('eventNormalizer', e, { platform: 'whatsapp' });
        return null;
    }
}

/**
 * Normaliza evento de Telegram
 */
function normalizeTelegramEvent(rawEvent, conn) {
    try {
        // Aceita: { message }, { callback_query }, OU a mensagem crua do node-telegram-bot-api
        const bareMsg =
            rawEvent &&
            typeof rawEvent === 'object' &&
            rawEvent.chat &&
            (rawEvent.from || rawEvent.text != null || rawEvent.caption != null)
                ? rawEvent
                : null;
        const msg =
            rawEvent?.message ||
            rawEvent?.callback_query?.message ||
            bareMsg ||
            {};
        const chat = msg.chat || {};
        const from = msg.from || rawEvent.callback_query?.from || {};
        const user = rawEvent.callback_query?.from || from;
        
        const sessionId = rawEvent.sessionId || 'default';
        const chatId = String(chat.id || rawEvent.chatId || '');
        const userId = String(user.id || rawEvent.userId || '');
        const username = user.username || '';
        
        // Validação de tipo
        if (!chatId || !userId) {
            throw new Error('chatId ou userId invalido (ausente)');
        }
        if (typeof chatId !== 'string' || typeof userId !== 'string') {
            throw new Error('chatId ou userId inválido');
        }
        
        const isGroup = chat.type === 'group' || chat.type === 'supergroup';
        
        let text = msg.text || msg.caption || '';
        let command = '';
        let args = [];
        
        // Extrair comando de texto — resto da linha INTEIRO (sem cortar)
        if (text.startsWith('/')) {
            const sp = text.search(/\s/);
            let cmdPart;
            let rest;
            if (sp === -1) {
                cmdPart = text.slice(1);
                rest = '';
            } else {
                cmdPart = text.slice(1, sp);
                rest = text.slice(sp + 1).trim();
            }
            // /play@BotName → play
            command = cmdPart.split('@')[0].toLowerCase();
            text = rest;
            args = rest ? rest.split(/\s+/).filter(Boolean) : [];
        }
        
        // Callback query
        if (rawEvent.callback_query) {
            const callbackData = rawEvent.callback_query.data || '';
            const dataParts = callbackData.split(':');
            command = dataParts[0] || '';
            args = dataParts.slice(1);
            text = args.join(' ');
        }
        
        return {
            platform: 'telegram',
            sessionId,
            chatId,
            userId,
            username,
            isGroup,
            text,
            command,
            args,
            raw: rawEvent
        };
    } catch (e) {
        require('../../logger').logException('eventNormalizer', e, { platform: 'telegram' });
        return null;
    }
}

/**
 * Detecta tipo de mídia em mensagem WhatsApp
 */
function detectMediaType(message) {
    if (!message) return null;
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.stickerMessage) return 'sticker';
    return null;
}

/**
 * Normaliza evento (rota para plataforma específica)
 */
function normalizeEvent(rawEvent, platform, conn) {
    if (platform === 'whatsapp') {
        return normalizeWhatsAppEvent(rawEvent, conn);
    } else if (platform === 'telegram') {
        return normalizeTelegramEvent(rawEvent, conn);
    }
    
    throw new Error(`Plataforma não suportada: ${platform}`);
}

module.exports = {
    normalizeEvent,
    normalizeWhatsAppEvent,
    normalizeTelegramEvent
};
