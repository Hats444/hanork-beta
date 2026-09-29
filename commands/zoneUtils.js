'use strict';
// Cotacao, encurta, QR, calc, wa.me, grok, fatos, placar.

const QRCode = require('qrcode');
const { prefixFromCtx } = require('../utils/configManager');
const {
    zoneBase,
    zoneKey,
    szBase,
    szKey,
    missingKeyText,
    pickText,
    pickImageUrl,
    httpGet,
    replyText,
    replyImage,
    runJob,
    argText
} = require('../utils/zoneClient');

const commands = {};

function safeCalc(expr) {
    const raw = String(expr || '').trim().replace(/,/g, '.').replace(/\s+/g, '');
    if (!raw || raw.length > 80) throw new Error('expressao grande');
    if (!/^[0-9+\-*/().%]+$/.test(raw)) throw new Error('so numeros e + - * / ( ) %');
    if (/[+\-*/.%]{2,}/.test(raw.replace(/^\+/, ''))) throw new Error('operadores invalidos');
    // eslint-disable-next-line no-new-func
    const val = Function(`"use strict"; return (${raw})`)();
    if (typeof val !== 'number' || !Number.isFinite(val)) throw new Error('resultado invalido');
    return val;
}

commands.cotacao = {
    useCtx: true,
    description: 'Dolar / euro / BTC em BRL',
    usage: 'cotacao [USD|EUR|BTC]',
    execute: async (conn, ctx) => {
        const q = (argText(ctx) || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'USD';
        const pair = q === 'BTC' ? 'BTC-BRL' : q === 'EUR' ? 'EUR-BRL' : 'USD-BRL';
        runJob(conn, ctx, 'cotacao', async () => {
            const res = await httpGet(`https://economia.awesomeapi.com.br/json/last/${pair}`, { timeout: 12000 });
            const row = res.data && Object.values(res.data)[0];
            if (!row || !row.bid) {
                await replyText(conn, ctx, 'Cotacao indisponivel agora.');
                return;
            }
            const lines = [
                `COTACAO ${row.code || q}/BRL`,
                `Compra: ${row.bid}`,
                `Venda: ${row.ask || row.bid}`,
                `Var: ${row.pctChange || '-'}%`,
                `Atual: ${row.create_date || '-'}`
            ];
            await replyText(conn, ctx, lines.join('\n'));
        });
    }
};
commands.dolar = commands.cotacao;

commands.encurta = {
    useCtx: true,
    description: 'Encurta URL (is.gd)',
    usage: 'encurta <url>',
    execute: async (conn, ctx) => {
        const url = argText(ctx);
        if (!/^https?:\/\//i.test(url)) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}encurta https://exemplo.com`);
            return;
        }
        runJob(conn, ctx, 'encurta', async () => {
            const res = await httpGet('https://is.gd/create.php', {
                params: { format: 'simple', url },
                timeout: 12000
            });
            const out = String(res.data || '').trim();
            if (!/^https?:\/\//i.test(out)) {
                await replyText(conn, ctx, 'Nao deu pra encurtar esse link.');
                return;
            }
            await replyText(conn, ctx, out);
        });
    }
};
commands.encurtar = commands.encurta;

commands.qr = {
    useCtx: true,
    description: 'Gera QR Code do texto/link',
    usage: 'qr <texto>',
    execute: async (conn, ctx) => {
        const text = argText(ctx);
        if (!text) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}qr seu texto ou link`);
            return;
        }
        runJob(conn, ctx, 'qr', async () => {
            const buf = await QRCode.toBuffer(text.slice(0, 800), { type: 'png', margin: 1, width: 400 });
            await replyImage(conn, ctx, buf, text.slice(0, 120));
        });
    }
};
commands.qrcode = commands.qr;

commands.lerqr = {
    useCtx: true,
    description: 'Le QR de uma foto (responda)',
    usage: 'lerqr (responda foto)',
    execute: async (conn, ctx) => {
        const { downloadQuotedMedia } = require('../utils/zoneClient');
        const media = await downloadQuotedMedia(ctx, ['image']);
        if (!media) {
            await replyText(conn, ctx, `Responda a foto do QR e use ${prefixFromCtx(ctx)}lerqr`);
            return;
        }
        runJob(conn, ctx, 'lerqr', async () => {
            const form = new FormData();
            form.append('file', new Blob([media.buffer], { type: 'image/jpeg' }), 'qr.jpg');
            const axios = require('axios');
            const res = await axios.post('https://api.qrserver.com/v1/read-qr-code/', form, {
                timeout: 20000,
                validateStatus: () => true
            });
            const payload = Array.isArray(res.data) ? res.data[0] : res.data;
            const text = payload?.symbol?.[0]?.data || payload?.data || '';
            const err = payload?.symbol?.[0]?.error;
            if (!text) {
                await replyText(conn, ctx, err ? 'QR ilegivel.' : 'Nao achei QR nessa foto.');
                return;
            }
            await replyText(conn, ctx, String(text).slice(0, 1500));
        });
    }
};

commands.calc = {
    useCtx: true,
    description: 'Calculadora (+ - * / %)',
    usage: 'calc <expressao>',
    execute: async (conn, ctx) => {
        const expr = argText(ctx);
        if (!expr) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}calc 12*8+3`);
            return;
        }
        try {
            const val = safeCalc(expr);
            await replyText(conn, ctx, `${expr} = ${val}`);
        } catch (_) {
            await replyText(conn, ctx, 'Expressao invalida. So numeros e + - * / ( ) %.');
        }
    }
};
commands.calcular = commands.calc;

commands.walink = {
    useCtx: true,
    description: 'Monta wa.me a partir do numero',
    usage: 'walink <numero> [texto]',
    execute: async (conn, ctx) => {
        const raw = argText(ctx);
        if (!raw) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}walink 11999999999 oi`);
            return;
        }
        const parts = raw.split(/\s+/);
        const digits = String(parts[0] || '').replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) {
            await replyText(conn, ctx, 'Numero invalido.');
            return;
        }
        const text = parts.slice(1).join(' ');
        let url = `https://wa.me/${digits}`;
        if (text) url += `?text=${encodeURIComponent(text)}`;
        await replyText(conn, ctx, url);
    }
};
commands.wame = commands.walink;

commands.grok = {
    useCtx: true,
    description: 'Pergunta no Grok (Zone API)',
    usage: 'grok <pergunta>',
    execute: async (conn, ctx) => {
        const text = argText(ctx);
        if (!text) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}grok explique gravidade`);
            return;
        }
        const key = zoneKey();
        if (!key) {
            await replyText(conn, ctx, missingKeyText('ZONE_API_KEY'));
            return;
        }
        runJob(conn, ctx, 'grok', async () => {
            const res = await httpGet(`${zoneBase()}/api/ia/grok-4-5`, {
                params: { apikey: key, text },
                timeout: 40000
            });
            if (res.status === 401 || res.status === 403) {
                await replyText(conn, ctx, 'Chave Zone recusada. Confira ZONE_API_KEY.');
                return;
            }
            const out = pickText(res.data);
            if (!out) {
                await replyText(conn, ctx, 'Grok nao respondeu agora.');
                return;
            }
            await replyText(conn, ctx, out.slice(0, 3500));
        });
    }
};
commands.grokia = commands.grok;

commands.fdc = {
    useCtx: true,
    description: 'Fato desconhecido',
    usage: 'fdc',
    execute: async (conn, ctx) => {
        runJob(conn, ctx, 'fdc', async () => {
            const res = await httpGet(`${zoneBase()}/api/fatosdesconhecidos`, {
                params: zoneKey() ? { apikey: zoneKey() } : {},
                timeout: 15000
            });
            const out = pickText(res.data);
            await replyText(conn, ctx, out || 'Sem fato agora. Tente de novo.');
        });
    }
};
commands.fatos = commands.fdc;

commands.placar = {
    useCtx: true,
    description: 'Placar de jogo / time',
    usage: 'placar <time ou jogo>',
    execute: async (conn, ctx) => {
        const q = argText(ctx);
        if (!q) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}placar flamengo`);
            return;
        }
        const key = szKey();
        if (!key) {
            await replyText(conn, ctx, missingKeyText('SYSTEMZONE_API_KEY'));
            return;
        }
        runJob(conn, ctx, 'placar', async () => {
            const res = await httpGet(`${szBase()}/api/placar`, {
                params: { apikey: key, search: q },
                timeout: 15000
            });
            const data = res.data || {};
            const url = pickImageUrl(data);
            const text = pickText(data);
            if (url) {
                await replyImage(conn, ctx, url, text || q);
                return;
            }
            await replyText(conn, ctx, text || 'Placar nao encontrado.');
        });
    }
};

module.exports = { commands };
