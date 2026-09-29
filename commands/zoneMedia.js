'use strict';
// Logos ephoto (1 lista nativa), flux, nano/edits, upscale, tourl, shazam.

const { sendInteractiveList } = require('../helpers');
const { setStep } = require('../utils/stepHandlers');
const { prefixFromCtx } = require('../utils/configManager');
const {
    szBase,
    szKey,
    zoneBase,
    zoneKey,
    missingKeyText,
    pickImageUrl,
    httpGet,
    httpGetBuffer,
    httpPostForm,
    downloadQuotedMedia,
    replyText,
    replyImage,
    runJob,
    argText
} = require('../utils/zoneClient');

const commands = {};

const EPHOTO_THEMES = [
    { id: 'glittergold', title: 'Glitter gold', texts: 1 },
    { id: 'luxurygold', title: 'Luxury gold', texts: 1 },
    { id: 'neonlight', title: 'Neon', texts: 1 },
    { id: 'wetglass', title: 'Vidro molhado', texts: 1 },
    { id: 'glitchtext', title: 'Glitch', texts: 1 },
    { id: 'graffititext', title: 'Grafite', texts: 1 },
    { id: 'brokenglass', title: 'Vidro quebrado', texts: 1 },
    { id: 'watercolor', title: 'Aquarela', texts: 1 },
    { id: 'cloudtext', title: 'Nuvem', texts: 1 },
    { id: 'sandwriting', title: 'Areia', texts: 1 },
    { id: '1917style', title: '1917', texts: 1 },
    { id: 'comicstyle', title: 'HQ / comic', texts: 1 },
    { id: 'metalic', title: 'Metal', texts: 1 },
    { id: 'circuitboard', title: 'Circuito', texts: 1 },
    { id: 'harrypotter', title: 'Harry Potter', texts: 1 },
    { id: 'dragonball', title: 'Dragon Ball', texts: 1 },
    { id: 'narutobanner', title: 'Naruto', texts: 2 },
    { id: 'pubglogo', title: 'PUBG', texts: 2 }
];

function findTheme(id) {
    const n = String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return EPHOTO_THEMES.find((t) => t.id === n) || null;
}

async function sendEphotoMenu(conn, ctx) {
    const p = prefixFromCtx(ctx);
    const half = Math.ceil(EPHOTO_THEMES.length / 2);
    const sections = [
        {
            title: 'Estilos 1',
            rows: EPHOTO_THEMES.slice(0, half).map((t) => ({
                id: `zn_eph_${t.id}`,
                title: t.title,
                description: t.texts > 1 ? '2 textos' : '1 texto'
            }))
        },
        {
            title: 'Estilos 2',
            rows: EPHOTO_THEMES.slice(half).map((t) => ({
                id: `zn_eph_${t.id}`,
                title: t.title,
                description: t.texts > 1 ? '2 textos' : '1 texto'
            }))
        }
    ];
    await sendInteractiveList(
        conn,
        ctx.from,
        `Ephoto — escolha o estilo e depois envie o texto.\nAtalho: ${p}ephoto <estilo> texto`,
        sections,
        'Hanork',
        ctx.info,
        null,
        ctx.telegramUserId,
        ctx.sessionId
    );
}

async function renderEphoto(conn, ctx, theme, textRaw) {
    const key = szKey();
    if (!key) {
        await replyText(conn, ctx, missingKeyText('SYSTEMZONE_API_KEY'));
        return;
    }
    const parts = String(textRaw || '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) {
        const p = prefixFromCtx(ctx);
        const hint = theme.texts > 1
            ? `${p}ephoto ${theme.id} texto1 | texto2`
            : `${p}ephoto ${theme.id} seu texto`;
        await replyText(conn, ctx, `Falta o texto.\nUso: ${hint}`);
        return;
    }
    runJob(conn, ctx, 'ephoto', async () => {
        const params = { apikey: key, text: parts[0] };
        if (theme.texts > 1) {
            params.text1 = parts[0];
            params.text2 = parts[1] || parts[0];
        }
        const res = await httpGet(`${szBase()}/api/ephoto/${theme.id}`, { params, timeout: 25000 });
        if (res.status === 401 || res.status === 403) {
            await replyText(conn, ctx, 'Chave SystemZone recusada. Confira SYSTEMZONE_API_KEY.');
            return;
        }
        if (res.status === 404) {
            await replyText(conn, ctx, 'Esse estilo nao esta disponivel na API agora.');
            return;
        }
        const url = pickImageUrl(res.data);
        if (!url) {
            await replyText(conn, ctx, 'A API nao devolveu imagem. Tente outro estilo.');
            return;
        }
        await replyImage(conn, ctx, url, theme.title);
    });
}

commands.ephoto = {
    useCtx: true,
    description: 'Logo / texto em estilo (lista nativa)',
    usage: 'ephoto [estilo] [texto]',
    execute: async (conn, ctx) => {
        const raw = argText(ctx);
        if (!raw) return sendEphotoMenu(conn, ctx);
        const parts = raw.split(/\s+/);
        const theme = findTheme(parts[0]);
        if (!theme) return sendEphotoMenu(conn, ctx);
        return renderEphoto(conn, ctx, theme, parts.slice(1).join(' '));
    }
};
commands.logo = commands.ephoto;
commands.logos = commands.ephoto;

commands.flux = {
    useCtx: true,
    description: 'Gera imagem (Pollinations flux)',
    usage: 'flux <prompt>',
    execute: async (conn, ctx) => {
        const prompt = argText(ctx);
        if (!prompt) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}flux um gato astronauta`);
            return;
        }
        runJob(conn, ctx, 'flux', async () => {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&model=flux&nologo=true`;
            const buf = await httpGetBuffer(url, { timeout: 40000 });
            await replyImage(conn, ctx, buf, prompt.slice(0, 200));
        });
    }
};

async function runImageEdit(conn, ctx, mode) {
    const prompt = argText(ctx);
    const media = await downloadQuotedMedia(ctx, ['image']);
    if (!media) {
        await replyText(conn, ctx, `Responda uma foto e use ${prefixFromCtx(ctx)}${mode} <o que mudar>`);
        return;
    }
    if (!prompt) {
        await replyText(conn, ctx, 'Falta o prompt (o que fazer na foto).');
        return;
    }
    const zKey = zoneKey();
    const sKey = szKey();
    if (mode === 'nano' && !zKey) {
        await replyText(conn, ctx, missingKeyText('ZONE_API_KEY'));
        return;
    }
    if (mode !== 'nano' && !sKey && !zKey) {
        await replyText(conn, ctx, missingKeyText('SYSTEMZONE_API_KEY'));
        return;
    }
    runJob(conn, ctx, mode, async () => {
        let res;
        if (mode === 'nano') {
            res = await httpPostForm(
                `${zoneBase()}/api/v2/nano-banana`,
                { apikey: zKey, prompt, text: prompt },
                [{ field: 'image', buffer: media.buffer, filename: 'photo.jpg', type: 'image/jpeg' }],
                { timeout: 60000 }
            );
        } else {
            res = await httpPostForm(
                `${szBase()}/api/v2/edit/deepai`,
                { apikey: sKey || zKey, prompt, text: prompt },
                [{ field: 'image', buffer: media.buffer, filename: 'photo.jpg', type: 'image/jpeg' }],
                { timeout: 60000 }
            );
        }
        if (res.status === 401 || res.status === 403) {
            await replyText(conn, ctx, 'Chave da API recusada.');
            return;
        }
        const url = pickImageUrl(res.data);
        if (!url) {
            await replyText(conn, ctx, 'A API nao devolveu a imagem editada.');
            return;
        }
        await replyImage(conn, ctx, url, prompt.slice(0, 200));
    });
}

commands.nano = {
    useCtx: true,
    description: 'Edita foto com nano-banana (responda a imagem)',
    usage: 'nano <prompt> (responda foto)',
    execute: (conn, ctx) => runImageEdit(conn, ctx, 'nano')
};
commands.nanobanana = commands.nano;
commands.edits = {
    useCtx: true,
    description: 'Edita foto (DeepAI / SystemZone)',
    usage: 'edits <prompt> (responda foto)',
    execute: (conn, ctx) => runImageEdit(conn, ctx, 'edits')
};
commands.editarimg = commands.edits;

commands.upscale = {
    useCtx: true,
    description: 'Aumenta resolucao da foto (responda)',
    usage: 'upscale (responda foto)',
    execute: async (conn, ctx) => {
        const media = await downloadQuotedMedia(ctx, ['image']);
        if (!media) {
            await replyText(conn, ctx, `Responda uma foto e use ${prefixFromCtx(ctx)}upscale`);
            return;
        }
        const key = szKey() || zoneKey();
        if (!key) {
            await replyText(conn, ctx, missingKeyText('SYSTEMZONE_API_KEY'));
            return;
        }
        runJob(conn, ctx, 'upscale', async () => {
            const res = await httpPostForm(
                `${szBase()}/api/v2/upscale`,
                { apikey: key },
                [{ field: 'image', buffer: media.buffer, filename: 'photo.jpg', type: 'image/jpeg' }],
                { timeout: 60000 }
            );
            const url = pickImageUrl(res.data);
            if (!url) {
                await replyText(conn, ctx, 'Upscale indisponivel nesta API agora.');
                return;
            }
            await replyImage(conn, ctx, url, 'Upscale');
        });
    }
};

commands.tourl = {
    useCtx: true,
    description: 'Sobe midia e devolve URL (catbox)',
    usage: 'tourl (responda midia)',
    execute: async (conn, ctx) => {
        const media = await downloadQuotedMedia(ctx, ['image', 'video', 'audio', 'sticker', 'document']);
        if (!media) {
            await replyText(conn, ctx, `Responda uma midia e use ${prefixFromCtx(ctx)}tourl`);
            return;
        }
        runJob(conn, ctx, 'tourl', async () => {
            const res = await httpPostForm(
                'https://catbox.moe/user/api.php',
                { reqtype: 'fileupload' },
                [{ field: 'fileToUpload', buffer: media.buffer, filename: 'upload.bin' }],
                { timeout: 40000 }
            );
            const url = String(res.data || '').trim();
            if (!/^https?:\/\//i.test(url)) {
                await replyText(conn, ctx, 'Upload falhou. Tente outra midia.');
                return;
            }
            await replyText(conn, ctx, url);
        });
    }
};

commands.shazam = {
    useCtx: true,
    description: 'Identifica musica (responda audio)',
    usage: 'shazam (responda audio)',
    execute: async (conn, ctx) => {
        const media = await downloadQuotedMedia(ctx, ['audio']);
        if (!media) {
            await replyText(conn, ctx, `Responda um audio e use ${prefixFromCtx(ctx)}shazam`);
            return;
        }
        const key = szKey();
        if (!key) {
            await replyText(conn, ctx, missingKeyText('SYSTEMZONE_API_KEY'));
            return;
        }
        runJob(conn, ctx, 'shazam', async () => {
            const res = await httpPostForm(
                `${szBase()}/api/shazam`,
                { apikey: key },
                [{ field: 'audio', buffer: media.buffer, filename: 'audio.ogg', type: 'audio/ogg' }],
                { timeout: 40000 }
            );
            const data = res.data || {};
            const title = data.resultado?.title || data.result?.title || data.title || '';
            const artist = data.resultado?.artist || data.result?.artist || data.artist || '';
            const extra = pickImageUrl(data);
            const line = [title, artist].filter(Boolean).join(' — ') || 'Nao reconheci essa faixa.';
            if (extra) await replyImage(conn, ctx, extra, line);
            else await replyText(conn, ctx, line);
        });
    }
};

async function handleZoneClick(conn, ctx, id) {
    const raw = String(id || '').trim();
    if (raw.startsWith('zn_eph_')) {
        const theme = findTheme(raw.slice('zn_eph_'.length));
        if (!theme) {
            await sendEphotoMenu(conn, ctx);
            return;
        }
        if (!ctx.session || typeof ctx.session !== 'object') {
            try {
                const { getConversationSession } = require('../utils/conversationSession');
                ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
            } catch (_) {
                ctx.session = { step: null };
            }
        }
        ctx.session.zoneEphotoTheme = theme.id;
        setStep(ctx, 'zone_ephoto');
        const hint = theme.texts > 1
            ? 'Envie os dois textos separados por |'
            : 'Envie o texto da logo';
        await replyText(conn, ctx, `${theme.title}: ${hint}.\nDigite cancelar pra abortar.`);
        return;
    }
}

const stepHandlers = {
    zone_ephoto: async (conn, ctx, text) => {
        const t = String(text || '').trim();
        if (/^cancelar$/i.test(t)) {
            ctx.session.zoneEphotoTheme = null;
            await replyText(conn, ctx, 'Ephoto cancelado.');
            return true;
        }
        const theme = findTheme(ctx.session?.zoneEphotoTheme);
        if (!theme) {
            await sendEphotoMenu(conn, ctx);
            return true;
        }
        ctx.session.zoneEphotoTheme = null;
        await renderEphoto(conn, ctx, theme, t);
        return true;
    }
};

module.exports = { commands, stepHandlers, handleZoneClick, EPHOTO_THEMES };
