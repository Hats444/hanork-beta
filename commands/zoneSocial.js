'use strict';
// TikTok stalk, Free Fire info/likes. Sem CPF. likeff = VIP (custa token).

const { prefixFromCtx } = require('../utils/configManager');
const {
    szBase,
    szKey,
    nyxToken,
    missingKeyText,
    pickText,
    pickImageUrl,
    httpGet,
    replyText,
    replyImage,
    runJob,
    argText
} = require('../utils/zoneClient');
const logger = require('../logger');

const commands = {};

async function requireConsultaAccess(conn, ctx) {
    const { canUseConsulta } = require('./consultas');
    if (canUseConsulta(ctx)) return true;
    await replyText(conn, ctx, 'Consultas so dono e VIP.');
    return false;
}

function scrubUser(s) {
    return String(s || '').trim().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '').slice(0, 32);
}

function uidOnly(s) {
    return String(s || '').replace(/\D/g, '').slice(0, 16);
}

function objLines(obj, keys) {
    const lines = [];
    for (const k of keys) {
        const v = obj?.[k];
        if (v == null || v === '') continue;
        const s = String(v).trim();
        if (!s || s === '[object Object]') continue;
        lines.push(`${k}: ${s.slice(0, 120)}`);
    }
    return lines;
}

commands.ttkstalk = {
    useCtx: true,
    description: 'Perfil publico TikTok',
    usage: 'ttkstalk <user>',
    execute: async (conn, ctx) => {
        if (!(await requireConsultaAccess(conn, ctx))) return;
        const user = scrubUser(argText(ctx));
        if (!user) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}ttkstalk usuario`);
            return;
        }
        const key = szKey();
        if (!key) {
            await replyText(conn, ctx, missingKeyText('SYSTEMZONE_API_KEY'));
            return;
        }
        runJob(conn, ctx, 'ttkstalk', async () => {
            const res = await httpGet(`${szBase()}/api/tiktok/stalk`, {
                params: { apikey: key, user },
                timeout: 20000
            });
            if (res.status === 404) {
                await replyText(conn, ctx, 'Usuario nao encontrado.');
                return;
            }
            if (res.status === 401 || res.status === 403) {
                await replyText(conn, ctx, 'Chave SystemZone recusada.');
                return;
            }
            const d = res.data?.resultado || res.data?.result || res.data || {};
            logger.logAviso('[ZONE] ttkstalk ok');
            const lines = objLines(d, ['nickname', 'uniqueId', 'signature', 'followers', 'following', 'likes', 'video']);
            const avatar = pickImageUrl(d) || d.avatar || d.avatarLarger || '';
            const body = lines.length ? lines.join('\n') : (pickText(res.data) || 'Sem dados publicos.');
            if (typeof avatar === 'string' && /^https?:\/\//i.test(avatar)) {
                await replyImage(conn, ctx, avatar, body);
                return;
            }
            await replyText(conn, ctx, body);
        });
    }
};
commands.tiktokstalk = commands.ttkstalk;

commands.infoff = {
    useCtx: true,
    description: 'Info publica Free Fire (UID)',
    usage: 'infoff <uid>',
    execute: async (conn, ctx) => {
        if (!(await requireConsultaAccess(conn, ctx))) return;
        const uid = uidOnly(argText(ctx));
        if (uid.length < 8) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}infoff 123456789`);
            return;
        }
        const token = nyxToken();
        if (!token) {
            await replyText(conn, ctx, missingKeyText('NYX_FF_TOKEN'));
            return;
        }
        runJob(conn, ctx, 'infoff', async () => {
            const res = await httpGet('https://nyxlikesff.store/info', {
                params: { uid, token },
                timeout: 20000
            });
            if (res.status >= 400) {
                logger.logAviso(`[ZONE] infoff http=${res.status}`);
                await replyText(conn, ctx, 'UID nao encontrado ou API fora.');
                return;
            }
            const d = res.data?.resultado || res.data?.result || res.data || {};
            const lines = objLines(d, ['nickname', 'name', 'region', 'level', 'likes', 'exp', 'rank']);
            await replyText(conn, ctx, lines.length ? lines.join('\n') : (pickText(res.data) || 'Sem info.'));
        });
    }
};
commands.ffinfo = commands.infoff;

commands.likeff = {
    useCtx: true,
    description: 'Envia likes FF (VIP). Precisa NYX_FF_TOKEN no host',
    usage: 'likeff <uid> [regiao]',
    execute: async (conn, ctx) => {
        const raw = argText(ctx);
        const parts = String(raw || '').trim().split(/\s+/);
        const uid = uidOnly(parts[0] || '');
        const { enviarLike, REGIOES } = require('../utils/ffLikes');
        const region = String(parts[1] || 'br').toLowerCase();
        if (uid.length < 8) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}likeff 123456789 [br]`);
            return;
        }
        if (parts[1] && !REGIOES.includes(region)) {
            await replyText(conn, ctx, `Regiao invalida. Use: ${REGIOES.join(', ')}`);
            return;
        }
        runJob(conn, ctx, 'likeff', async () => {
            const out = await enviarLike(uid, region);
            if (out.ok) {
                await replyText(conn, ctx, out.message);
                return;
            }
            const hint = Array.isArray(out.tries) && out.tries.length
                ? `\n${out.tries.slice(0, 6).join('\n')}`
                : '';
            await replyText(conn, ctx, `${out.message}${hint}`.slice(0, 500));
        });
    }
};
commands.curtirff = commands.likeff;

module.exports = { commands };
