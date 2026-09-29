const logger = require("../logger");
const { delay } = require("../utils");
const { parsePhoneAndQty } = require("../utils/phoneTarget");

const commands = {};

commands.pair = {
    description: "Gera um codigo de pareamento manualmente",
    usage: "pair <numero>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const raw = String(q || (Array.isArray(args) ? args.join(' ') : args[0]) || '').trim();
        if (!raw) return conn.sendMessage(from, { text: "Numero (ex: +1 202 555 1234 ou +55 11 99999-9999)" }, { quoted: info });
        const parsed = parsePhoneAndQty(raw, { defaultQty: 1, maxQty: 1 });
        const numero = parsed?.digits || '';
        if (!numero || numero.length < 8 || numero.length > 15) {
            return conn.sendMessage(from, { text: "Numero invalido. Use DDI+numero com + (ex: +351 912 345 678)." }, { quoted: info });
        }
        try {
            if (conn.authState.creds.registered) {
                return conn.sendMessage(from, { text: "Ja autenticado. Nao e necessario parear." }, { quoted: info });
            }
            const code = await conn.requestPairingCode(numero);
            await conn.sendMessage(from, { text: `Codigo: ${code}\nUse no WhatsApp > Dispositivos Vinculados > Vincular com Numero` }, { quoted: info });
            logger.logInfo(`Pairing code gerado para ${numero}: ${code}`);
        } catch (e) {
            logger.logErro("pair", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.paircancel = {
    description: "Cancela a geracao de pairing (se aplicavel)",
    usage: "paircancel",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        try {
            await conn.end();
            await conn.sendMessage(from, { text: "Conexao encerrada. Reinicie para novo pairing." }, { quoted: info });
        } catch (e) {
            logger.logErro("paircancel", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.pairstatus = {
    description: "Verifica status do pareamento",
    usage: "pairstatus",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const registered = conn.authState.creds.registered;
        await conn.sendMessage(from, { text: `Status: ${registered ? "Autenticado" : "Nao autenticado"}` }, { quoted: info });
    }
};

module.exports = { commands };