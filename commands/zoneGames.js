'use strict';
// Jogos e diversao: forca, ppt, dado, roleta, minado, plantar, casar, eununca, vdb, piada.

const { prefixFromCtx } = require('../utils/configManager');
const { ensureJidString } = require('../utils');
const { szBase, szKey, pickImageUrl, httpGet, replyText, replyImage, runJob, argText } = require('../utils/zoneClient');

const commands = {};

const forcaGames = new Map();
const minadoGames = new Map();
const plantarGames = new Map();
const casais = new Map();

const WORDS = [
    'banana', 'foguete', 'janela', 'cavalo', 'planeta', 'escola', 'guitarra', 'floresta',
    'abajur', 'pipoca', 'castelo', 'oceano', 'caneta', 'travesseiro', 'bicicleta', 'laranja',
    'montanha', 'telefone', 'chocolate', 'estrela', 'cachorro', 'borboleta', 'ventilador', 'mochila'
];

const EUNUNCA = [
    'Eu nunca apaguei msg errada no grupo errado.',
    'Eu nunca finji que tava digitando e desisti.',
    'Eu nunca ri de meme no silencio absoluto.',
    'Eu nunca entrei no Zap so pra ver quem tava online.',
    'Eu nunca mandei figurinha no lugar de responder.',
    'Eu nunca marquei todo mundo sem querer.',
    'Eu nunca deixei o dono do grupo no vazio.',
    'Eu nunca usei o bot pra resolver discussao.',
    'Eu nunca vi a msg e nao respondi de proposito.',
    'Eu nunca mudei o nick no meio da conversa.'
];

const PIADAS = [
    'Por que o livro de matematica se suicidou? Porque tinha problemas demais.',
    'O que o pato falou pra pata? Vem qua.',
    'Qual o contrario de volatel? Vemca.',
    'Por que o semaforo nao luta? Porque ele prefere o transito.',
    'O que e um pontinho amarelo no canto? Uma yellowinha.',
    'Por que o computador foi ao medico? Porque tava com virus.',
    'Qual o cafe preferido do computador? Java.',
    'Por que a planta nao usa Zap? Porque so tem celular.',
    'O que a impressora falou pro papel? Esse relatorio esta saindo da minha impressao.',
    'Por que o fantasma nao mente? Porque e transparente.'
];

const VERDADES = [
    'Qual foi a ultima coisa que voce pesquisou?',
    'Quem do grupo voce salvaria primeiro?',
    'Qual seu vicio secreto de serie?',
    'Ja fingiu que nao viu uma msg?',
    'Qual comida voce defende com unhas e dentes?',
    'Quem aqui te irrita e voce nao admite?',
    'Qual seu maior arrependimento bobo?'
];

const DESAFIOS = [
    'Mande uma figurinha aleatoria agora.',
    'Elogie a proxima pessoa que falar.',
    'Fale um fato aleatorio sobre voce.',
    'Troque seu recado do Zap por 5 min (se quiser).',
    'Invente um slogan pro grupo.',
    'Conte uma historia em 1 linha.',
    'Mande um oi pra alguem que nao fala faz tempo (no grupo).'
];

function playerKey(ctx) {
    return `${ctx.from}|${ensureJidString(ctx.sender || ctx.from, '')}`;
}

function maskWord(word, hits) {
    return word.split('').map((ch) => (hits.has(ch) ? ch : '_')).join(' ');
}

commands.forca = {
    useCtx: true,
    description: 'Jogo da forca',
    usage: 'forca [letra]',
    execute: async (conn, ctx) => {
        const key = playerKey(ctx);
        const letter = String(argText(ctx) || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 1);
        let g = forcaGames.get(key);
        if (!g || !letter) {
            const word = WORDS[Math.floor(Math.random() * WORDS.length)];
            g = { word, hits: new Set(), miss: 0 };
            forcaGames.set(key, g);
            await replyText(conn, ctx, `FORCA\n${maskWord(word, g.hits)}\nErros 0/6\nMande ${prefixFromCtx(ctx)}forca a`);
            return;
        }
        if (g.hits.has(letter) || [...g.word].every((c) => g.hits.has(c))) {
            await replyText(conn, ctx, 'Essa letra ja foi, ou o jogo acabou. Mande .forca pra nova.');
            return;
        }
        if (g.word.includes(letter)) g.hits.add(letter);
        else g.miss += 1;
        const won = [...g.word].every((c) => g.hits.has(c));
        const lost = g.miss >= 6;
        let body = `FORCA\n${maskWord(g.word, g.hits)}\nErros ${g.miss}/6`;
        if (won) {
            body += `\nAcertou: ${g.word}`;
            forcaGames.delete(key);
        } else if (lost) {
            body += `\nEnforcado. Era: ${g.word}`;
            forcaGames.delete(key);
        }
        await replyText(conn, ctx, body);
    }
};

const PPT = { pedra: 'tesoura', papel: 'pedra', tesoura: 'papel' };

commands.ppt = {
    useCtx: true,
    description: 'Pedra papel tesoura',
    usage: 'ppt pedra|papel|tesoura',
    execute: async (conn, ctx) => {
        const pick = String(argText(ctx) || '').toLowerCase();
        if (!PPT[pick]) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}ppt pedra|papel|tesoura`);
            return;
        }
        const opts = Object.keys(PPT);
        const bot = opts[Math.floor(Math.random() * opts.length)];
        let result = 'empate';
        if (PPT[pick] === bot) result = 'voce ganhou';
        else if (PPT[bot] === pick) result = 'eu ganhei';
        await replyText(conn, ctx, `Voce: ${pick}\nBot: ${bot}\n${result}`);
    }
};
commands.jokenpo = commands.ppt;

commands.dado = {
    useCtx: true,
    description: 'Rola um dado de 6',
    usage: 'dado',
    execute: async (conn, ctx) => {
        await replyText(conn, ctx, `Dado: ${1 + Math.floor(Math.random() * 6)}`);
    }
};

commands.roleta = {
    useCtx: true,
    description: 'Roleta com nomes (separe por |)',
    usage: 'roleta a | b | c',
    execute: async (conn, ctx) => {
        const parts = argText(ctx).split('|').map((s) => s.trim()).filter(Boolean);
        if (parts.length < 2) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}roleta ana | bia | caio`);
            return;
        }
        const win = parts[Math.floor(Math.random() * parts.length)];
        const key = szKey();
        if (key) {
            runJob(conn, ctx, 'roleta', async () => {
                const res = await httpGet(`${szBase()}/api/canvas/roleta`, {
                    params: { apikey: key, text: parts.join(',') },
                    timeout: 15000
                });
                const url = pickImageUrl(res.data);
                if (url) {
                    await replyImage(conn, ctx, url, `Saiu: ${win}`);
                    return;
                }
                await replyText(conn, ctx, `Saiu: ${win}`);
            });
            return;
        }
        await replyText(conn, ctx, `Saiu: ${win}`);
    }
};

function newMine() {
    const size = 5;
    const bombs = new Set();
    while (bombs.size < 5) bombs.add(Math.floor(Math.random() * size * size));
    return { size, bombs, open: new Set() };
}

function renderMine(g) {
    const letters = 'ABCDE';
    const rows = ['  1 2 3 4 5'];
    for (let y = 0; y < g.size; y++) {
        let line = letters[y] + ' ';
        for (let x = 0; x < g.size; x++) {
            const i = y * g.size + x;
            if (!g.open.has(i)) line += '. ';
            else if (g.bombs.has(i)) line += '* ';
            else line += 'o ';
        }
        rows.push(line.trimEnd());
    }
    return rows.join('\n');
}

commands.minado = {
    useCtx: true,
    description: 'Campo minado 5x5',
    usage: 'minado [A1]',
    execute: async (conn, ctx) => {
        const key = playerKey(ctx);
        const cell = String(argText(ctx) || '').toUpperCase().replace(/\s+/g, '');
        let g = minadoGames.get(key);
        if (!g || !cell) {
            g = newMine();
            minadoGames.set(key, g);
            await replyText(conn, ctx, `MINADO\n${renderMine(g)}\nAbra com ${prefixFromCtx(ctx)}minado A3`);
            return;
        }
        const m = cell.match(/^([A-E])([1-5])$/);
        if (!m) {
            await replyText(conn, ctx, 'Celula invalida. Ex: A1 ate E5.');
            return;
        }
        const y = m[1].charCodeAt(0) - 65;
        const x = Number(m[2]) - 1;
        const i = y * g.size + x;
        if (g.open.has(i)) {
            await replyText(conn, ctx, 'Essa ja abriu.');
            return;
        }
        g.open.add(i);
        if (g.bombs.has(i)) {
            for (const b of g.bombs) g.open.add(b);
            minadoGames.delete(key);
            await replyText(conn, ctx, `BOOM\n${renderMine(g)}\nNovo: ${prefixFromCtx(ctx)}minado`);
            return;
        }
        const safe = g.size * g.size - g.bombs.size;
        if (g.open.size >= safe) {
            minadoGames.delete(key);
            await replyText(conn, ctx, `Limpou o campo!\n${renderMine(g)}`);
            return;
        }
        await replyText(conn, ctx, `MINADO\n${renderMine(g)}`);
    }
};

commands.plantar = {
    useCtx: true,
    description: 'Planta, rega e colhe (jogo curto)',
    usage: 'plantar | regar | colher',
    execute: async (conn, ctx) => {
        const key = playerKey(ctx);
        const act = String(ctx.command || 'plantar').toLowerCase();
        const now = Date.now();
        let g = plantarGames.get(key);
        if (act === 'plantar' && String(argText(ctx) || '').toLowerCase() === 'status' && g) {
            const left = Math.max(0, Math.ceil((g.readyAt - now) / 1000));
            await replyText(conn, ctx, g.readyAt <= now ? 'Pronto pra colher.' : `Falta ${left}s. Regou: ${g.watered ? 'sim' : 'nao'}`);
            return;
        }
        if (act === 'plantar') {
            g = { plantedAt: now, watered: false, readyAt: now + 45000 };
            plantarGames.set(key, g);
            await replyText(conn, ctx, `Plantou. Use ${prefixFromCtx(ctx)}regar e depois ${prefixFromCtx(ctx)}colher (45s).`);
            return;
        }
        if (!g) {
            await replyText(conn, ctx, `Nada plantado. ${prefixFromCtx(ctx)}plantar`);
            return;
        }
        if (act === 'regar') {
            g.watered = true;
            g.readyAt = Math.min(g.readyAt, now + 20000);
            await replyText(conn, ctx, 'Regou. Colheita mais rapida.');
            return;
        }
        if (now < g.readyAt) {
            const left = Math.ceil((g.readyAt - now) / 1000);
            await replyText(conn, ctx, `Ainda verde. Falta ${left}s.`);
            return;
        }
        plantarGames.delete(key);
        const bonus = g.watered ? 2 : 1;
        await replyText(conn, ctx, `Colheu! +${bonus} ponto${bonus > 1 ? 's' : ''}.`);
    }
};
commands.regar = commands.plantar;
commands.colher = commands.plantar;

function mentionTarget(ctx) {
    const list = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
    const fromList = list.map((j) => ensureJidString(j, '')).filter(Boolean)[0];
    if (fromList) return fromList;
    const q = ctx.quoted?.sender || ctx.quoted?.participant;
    return ensureJidString(q, '') || '';
}

commands.casar = {
    useCtx: true,
    description: 'Casa com alguem (marque ou responda)',
    usage: 'casar @alguem',
    execute: async (conn, ctx) => {
        const a = ensureJidString(ctx.sender || '', '');
        const b = mentionTarget(ctx);
        if (!a || !b || a === b) {
            await replyText(conn, ctx, `Marque ou responda alguem. ${prefixFromCtx(ctx)}casar @fulano`);
            return;
        }
        casais.set(`${ctx.from}|${a}`, b);
        casais.set(`${ctx.from}|${b}`, a);
        await conn.sendMessage(ctx.from, {
            text: `@${a.split('@')[0]} casou com @${b.split('@')[0]}. Parabens.`,
            mentions: [a, b]
        }, { quoted: ctx.info });
    }
};
commands.namoro = commands.casar;

commands.beijar = {
    useCtx: true,
    description: 'Beija (marque ou responda)',
    usage: 'beijar @alguem',
    execute: async (conn, ctx) => {
        const a = ensureJidString(ctx.sender || '', '');
        const b = mentionTarget(ctx);
        if (!a || !b) {
            await replyText(conn, ctx, `Marque ou responda. ${prefixFromCtx(ctx)}beijar @fulano`);
            return;
        }
        await conn.sendMessage(ctx.from, {
            text: `@${a.split('@')[0]} beijou @${b.split('@')[0]}.`,
            mentions: [a, b]
        }, { quoted: ctx.info });
    }
};

commands.flerte = {
    useCtx: true,
    description: 'Flerte aleatorio',
    usage: 'flerte [@alguem]',
    execute: async (conn, ctx) => {
        const lines = [
            'Se fosse figurinha, eu salvava no pack favorito.',
            'Seu oi desbloqueou um nivel secreto.',
            'O Zap ficou mais rapido quando voce entrou.',
            'Cuidado que o bot tambem tem crush.'
        ];
        const pick = lines[Math.floor(Math.random() * lines.length)];
        const b = mentionTarget(ctx);
        if (b) {
            await conn.sendMessage(ctx.from, {
                text: `@${b.split('@')[0]} ${pick}`,
                mentions: [b]
            }, { quoted: ctx.info });
            return;
        }
        await replyText(conn, ctx, pick);
    }
};

commands.eununca = {
    useCtx: true,
    description: 'Eu nunca (pergunta aleatoria)',
    usage: 'eununca',
    execute: async (conn, ctx) => {
        await replyText(conn, ctx, EUNUNCA[Math.floor(Math.random() * EUNUNCA.length)]);
    }
};

commands.vdb = {
    useCtx: true,
    description: 'Verdade ou desafio',
    usage: 'vdb verdade|desafio',
    execute: async (conn, ctx) => {
        const q = String(argText(ctx) || '').toLowerCase();
        const pool = q.startsWith('d') ? DESAFIOS : q.startsWith('v') ? VERDADES : (Math.random() < 0.5 ? VERDADES : DESAFIOS);
        const label = pool === DESAFIOS ? 'DESAFIO' : 'VERDADE';
        await replyText(conn, ctx, `${label}\n${pool[Math.floor(Math.random() * pool.length)]}`);
    }
};
commands.vdd = commands.vdb;
commands.verdade = commands.vdb;

commands.piada = {
    useCtx: true,
    description: 'Piada curta',
    usage: 'piada',
    execute: async (conn, ctx) => {
        await replyText(conn, ctx, PIADAS[Math.floor(Math.random() * PIADAS.length)]);
    }
};

module.exports = { commands };
