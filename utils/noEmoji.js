// utils/noEmoji.js
// Regra ulfi: sem emoji em comando, menu, funcao ou mensagem

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{FE0F}\u{200D}\u{20E3}]/gu;

function stripEmojis(input) {
    if (input == null) return input;
    if (typeof input !== 'string') return input;
    return input
        .replace(EMOJI_RE, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Texto seguro pra botao inline do Telegram.
 * Telegram exige UTF-8 valido; nomes de grupo WA frequentemente quebram → 400.
 * Por padrao mantem Unicode valido (menus). Use asciiOnly=true p/ nomes externos.
 */
function safeTelegramButtonText(input, maxLen = 64, fallback = 'OK', opts = {}) {
    const limit = Math.max(1, Math.min(64, Number(maxLen) || 64));
    const asciiOnly = !!(opts && opts.asciiOnly);
    let s = '';
    try {
        if (Buffer.isBuffer(input)) s = input.toString('utf8');
        else if (input == null) s = '';
        else s = String(input);
        // round-trip: descarta bytes invalidos
        s = Buffer.from(s, 'utf8').toString('utf8');
    } catch (_) {
        s = '';
    }
    s = s
        .replace(/\uFFFD/g, '')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        // NAO remover \uD800-\uDFFF: sao pares UTF-16 de chars >BMP (ex: fonte mono).
        // Surrogates orfaos ja viram U+FFFD no round-trip acima.
        .replace(EMOJI_RE, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (asciiOnly) {
        s = s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
    }

    // Se ficou vazio apos limpeza, fallback ASCII
    if (!s) {
        s = String(fallback || 'OK').replace(/[^\x20-\x7E]/g, '').trim() || 'OK';
    }
    if (s.length > limit) s = s.slice(0, limit);
    return s || 'OK';
}

function sanitizeTelegramButtons(buttons) {
    if (!Array.isArray(buttons)) return buttons;
    return buttons.map((row) => {
        if (!Array.isArray(row)) return row;
        return row.map((btn) => {
            if (!btn || typeof btn !== 'object') return btn;
            const next = { ...btn };
            if (typeof next.text === 'string' || Buffer.isBuffer(next.text)) {
                // Menus: Unicode OK. Nao forcar ASCII (isso virava "OK" com previewText mono).
                next.text = safeTelegramButtonText(next.text, 64, 'OK', { asciiOnly: false });
            }
            if (typeof next.callback_data === 'string') {
                let cd = next.callback_data.replace(/[\u0000-\u001F\u007F]/g, '');
                try {
                    cd = Buffer.from(cd, 'utf8').toString('utf8');
                } catch (_) {
                    cd = 'noop';
                }
                const bytes = Buffer.from(cd, 'utf8');
                next.callback_data = bytes.length > 64
                    ? bytes.slice(0, 64).toString('utf8').replace(/\uFFFD$/, '')
                    : cd;
                if (!next.callback_data) next.callback_data = 'noop';
            }
            return next;
        });
    });
}

function sanitizeReplyMarkup(markup) {
    if (!markup || typeof markup !== 'object') return markup;
    const next = { ...markup };
    if (Array.isArray(next.inline_keyboard)) {
        next.inline_keyboard = sanitizeTelegramButtons(next.inline_keyboard);
    }
    if (Array.isArray(next.keyboard)) {
        next.keyboard = sanitizeTelegramButtons(next.keyboard);
    }
    return next;
}

module.exports = {
    stripEmojis,
    safeTelegramButtonText,
    sanitizeTelegramButtons,
    sanitizeReplyMarkup,
    EMOJI_RE
};
