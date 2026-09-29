'use strict';
// Consultas CEP (ViaCEP), CNPJ (BrasilAPI), IP (ipwho.is). Dono/VIP.

const { prefixFromCtx } = require('../utils/configManager');
const { httpGet, replyText, runJob, argText } = require('../utils/zoneClient');
const logger = require('../logger');

const commands = {};

function onlyDigits(s, max) {
    return String(s || '').replace(/\D/g, '').slice(0, max || 20);
}

async function requireConsultaAccess(conn, ctx) {
    const { canUseConsulta } = require('./consultas');
    if (canUseConsulta(ctx)) return true;
    await replyText(conn, ctx, 'Consultas so dono e VIP.');
    return false;
}

commands.cep = {
    useCtx: true,
    description: 'Consulta CEP (ViaCEP)',
    usage: 'cep <8 digitos>',
    execute: async (conn, ctx) => {
        if (!(await requireConsultaAccess(conn, ctx))) return;
        const cep = onlyDigits(argText(ctx), 8);
        if (cep.length !== 8) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}cep 01001000`);
            return;
        }
        runJob(conn, ctx, 'cep', async () => {
            const res = await httpGet(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 12000 });
            const d = res.data || {};
            if (d.erro || res.status >= 400) {
                logger.logAviso('[ZONE] cep miss');
                await replyText(conn, ctx, 'CEP nao encontrado.');
                return;
            }
            const lines = [
                'CEP',
                d.logradouro || '-',
                [d.bairro, d.localidade, d.uf].filter(Boolean).join(' / '),
                d.ddd ? `DDD ${d.ddd}` : ''
            ].filter(Boolean);
            await replyText(conn, ctx, lines.join('\n'));
        });
    }
};

commands.cnpj = {
    useCtx: true,
    description: 'Consulta CNPJ (BrasilAPI, dados publicos da empresa)',
    usage: 'cnpj <14 digitos>',
    execute: async (conn, ctx) => {
        if (!(await requireConsultaAccess(conn, ctx))) return;
        const cnpj = onlyDigits(argText(ctx), 14);
        if (cnpj.length !== 14) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}cnpj 00000000000000`);
            return;
        }
        runJob(conn, ctx, 'cnpj', async () => {
            const res = await httpGet(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { timeout: 15000 });
            if (res.status === 404) {
                await replyText(conn, ctx, 'CNPJ nao encontrado.');
                return;
            }
            if (res.status >= 400) {
                logger.logAviso(`[ZONE] cnpj http=${res.status}`);
                await replyText(conn, ctx, 'BrasilAPI ocupada. Tente de novo.');
                return;
            }
            const d = res.data || {};
            const lines = [
                'CNPJ (publico)',
                d.razao_social || d.nome || '-',
                d.nome_fantasia ? `Fantasia: ${d.nome_fantasia}` : '',
                d.descricao_situacao_cadastral ? `Sit: ${d.descricao_situacao_cadastral}` : '',
                d.cnae_fiscal_descricao ? `CNAE: ${d.cnae_fiscal_descricao}` : '',
                [d.municipio, d.uf].filter(Boolean).join(' / ')
            ].filter(Boolean);
            await replyText(conn, ctx, lines.join('\n'));
        });
    }
};

commands.ip = {
    useCtx: true,
    description: 'Geo/ASN de IP publico',
    usage: 'ip <ipv4>',
    execute: async (conn, ctx) => {
        if (!(await requireConsultaAccess(conn, ctx))) return;
        const q = String(argText(ctx) || '').trim();
        if (!q || !/^[0-9a-fA-F.:]+$/.test(q) || q.length > 45) {
            await replyText(conn, ctx, `Uso: ${prefixFromCtx(ctx)}ip 8.8.8.8`);
            return;
        }
        runJob(conn, ctx, 'ip', async () => {
            const res = await httpGet(`https://ipwho.is/${encodeURIComponent(q)}`, { timeout: 12000 });
            const d = res.data || {};
            if (d.success === false) {
                await replyText(conn, ctx, 'IP nao encontrado.');
                return;
            }
            const lines = [
                `IP ${d.ip || q}`,
                [d.city, d.region, d.country].filter(Boolean).join(' / ') || '-',
                d.connection?.isp || d.isp || d.org || '',
                d.connection?.asn ? `ASN ${d.connection.asn}` : ''
            ].filter(Boolean);
            await replyText(conn, ctx, lines.join('\n'));
        });
    }
};

module.exports = { commands };
