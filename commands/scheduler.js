const logger = require("../logger");
const { createMessageScheduler } = require("@systemzero/baileys");

let schedulerInstance = null;

function getScheduler(conn) {
    if (!schedulerInstance) {
        schedulerInstance = createMessageScheduler(
            (jid, content) => conn.sendMessage(jid, content),
            {
                onSent: (entry, result) => logger.logInfo(`Agendamento enviado: ${entry.id} para ${entry.jid}`),
                onFailed: (entry, err) => logger.logErro("Scheduler", `Falha em ${entry.id}: ${err.message}`)
            }
        );
    }
    return schedulerInstance;
}

const commands = {};

commands.schedule = {
    description: "Agenda uma mensagem (data/hora)",
    usage: "schedule <YYYY-MM-DD HH:mm> <texto>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const match = q.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+)$/);
        if (!match) return conn.sendMessage(from, { text: "Formato: YYYY-MM-DD HH:mm <texto>" }, { quoted: info });
        const [_, timeStr, texto] = match;
        const date = new Date(timeStr);
        if (isNaN(date.getTime())) return conn.sendMessage(from, { text: "Data invalida." }, { quoted: info });
        const scheduler = getScheduler(conn);
        const entry = scheduler.schedule(from, { text: texto }, date);
        await conn.sendMessage(from, { text: `Agendado para ${timeStr}. ID: ${entry.id}` }, { quoted: info });
    }
};

commands.schedulelist = {
    description: "Lista agendamentos pendentes",
    usage: "schedulelist",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!schedulerInstance) return conn.sendMessage(from, { text: "Nenhum agendamento." }, { quoted: info });
        const pendentes = schedulerInstance.getPending();
        const list = pendentes.map(s => `${s.id}: ${s.scheduledTime.toLocaleString()} - ${s.content.text || 'midia'}`).join("\n");
        await conn.sendMessage(from, { text: list || "Nenhum agendamento." }, { quoted: info });
    }
};

commands.schedulecancel = {
    description: "Cancela um agendamento",
    usage: "schedulecancel <id>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!schedulerInstance) return conn.sendMessage(from, { text: "Nenhum agendamento." }, { quoted: info });
        const result = schedulerInstance.cancel(q);
        await conn.sendMessage(from, { text: result ? `Agendamento ${q} cancelado.` : "ID nao encontrado." }, { quoted: info });
    }
};

commands.scheduleclear = {
    description: "Cancela todos os agendamentos",
    usage: "scheduleclear",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!schedulerInstance) return conn.sendMessage(from, { text: "Nenhum agendamento." }, { quoted: info });
        schedulerInstance.clearAll();
        await conn.sendMessage(from, { text: "Todos os agendamentos cancelados." }, { quoted: info });
    }
};

module.exports = { commands };