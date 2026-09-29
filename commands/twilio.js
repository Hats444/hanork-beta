const { requireSessionOwner } = require('../utils/authorization');
// commands/twilio.js
const logger = require('../logger');
const {
    enviarSMS,
    enviarOTP,
    enviarChamada,
    enviarEmail,
} = require('../utils/notificacoes');
const {
    iniciarLoop,
    pararLoop,
    statusLoop,
    adicionarDestinatario,
    removerDestinatario,
    listarDestinatarios,
} = require('../utils/twilio-scheduler');
const { sendButtonsWithImage } = require('../helpers');
const { peelPhoneAndRest } = require('../utils/phoneTarget');

const commands = {};

// Envio único de SMS
commands.sms = {
    useCtx: true,
    description: 'Envia um SMS via Twilio',
    usage: 'sms <numero> <mensagem>',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const peeled = peelPhoneAndRest(ctx.text || '');
        if (!peeled || !peeled.rest) {
            return conn.sendMessage(ctx.from, { text: 'Uso: sms <numero> <mensagem>\nEx: sms +55 51 8205-2118 ola' }, { quoted: ctx.info });
        }
        const numero = peeled.e164;
        const mensagem = peeled.rest;
        const resultado = await enviarSMS(numero, mensagem);
        await conn.sendMessage(ctx.from, {
            text: resultado.sucesso
                ? `SMS enviado para ${numero} (SID: ${resultado.sid})`
                : `Erro: ${resultado.erro}`
        }, { quoted: ctx.info });
    }
};

// Envio de OTP
commands.otp = {
    useCtx: true,
    description: 'Envia um codigo OTP via SMS ou chamada',
    usage: 'otp <numero> [sms|call]',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const peeled = peelPhoneAndRest(ctx.text || '');
        if (!peeled) {
            return conn.sendMessage(ctx.from, { text: 'Uso: otp <numero> [sms|call]' }, { quoted: ctx.info });
        }
        const numero = peeled.e164;
        const metodo = (peeled.rest.split(/\s+/)[0] || 'sms').toLowerCase();
        const resultado = await enviarOTP(numero, metodo === 'call' ? 'call' : 'sms');
        await conn.sendMessage(ctx.from, {
            text: resultado.sucesso
                ? `OTP enviado para ${numero} via ${metodo} (SID: ${resultado.sid})`
                : `Erro: ${resultado.erro}`
        }, { quoted: ctx.info });
    }
};

// Chamada de voz
commands.call = {
    useCtx: true,
    description: 'Faz uma chamada de voz com TTS',
    usage: 'call <numero> <mensagem>',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const peeled = peelPhoneAndRest(ctx.text || '');
        if (!peeled || !peeled.rest) {
            return conn.sendMessage(ctx.from, { text: 'Uso: call <numero> <mensagem>' }, { quoted: ctx.info });
        }
        const numero = peeled.e164;
        const mensagem = peeled.rest;
        const resultado = await enviarChamada(numero, mensagem);
        await conn.sendMessage(ctx.from, {
            text: resultado.sucesso
                ? `Chamada iniciada para ${numero} (SID: ${resultado.sid})`
                : `Erro: ${resultado.erro}`
        }, { quoted: ctx.info });
    }
};

// E-mail (exige SendGrid configurado)
commands.email = {
    useCtx: true,
    description: 'Envia um e-mail via SendGrid',
    usage: 'email <destino> <assunto> <corpo>',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const args = ctx.args || [];
        if (args.length < 3) {
            return conn.sendMessage(ctx.from, { text: 'Uso: email <destino> <assunto> <corpo>' }, { quoted: ctx.info });
        }
        const destino = args[0];
        const assunto = args[1];
        const corpo = args.slice(2).join(' ');
        const resultado = await enviarEmail(destino, assunto, corpo);
        await conn.sendMessage(ctx.from, {
            text: resultado.sucesso
                ? `E-mail enviado para ${destino}`
                : `Erro: ${resultado.erro}`
        }, { quoted: ctx.info });
    }
};

// Gerenciar destinatarios do loop
commands.adddest = {
    useCtx: true,
    description: 'Adiciona um numero a lista de destinatarios do loop',
    usage: 'adddest <numero>',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const peeled = peelPhoneAndRest(ctx.text || '');
        if (!peeled) {
            return conn.sendMessage(ctx.from, { text: 'Uso: adddest <numero>' }, { quoted: ctx.info });
        }
        const numero = peeled.e164;
        const ok = adicionarDestinatario(numero);
        await conn.sendMessage(ctx.from, {
            text: ok ? `Numero ${numero} adicionado.` : `Ja esta na lista.`
        }, { quoted: ctx.info });
    }
};

commands.remdest = {
    useCtx: true,
    description: 'Remove um numero da lista de destinatarios',
    usage: 'remdest <numero>',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const peeled = peelPhoneAndRest(ctx.text || '');
        if (!peeled) {
            return conn.sendMessage(ctx.from, { text: 'Uso: remdest <numero>' }, { quoted: ctx.info });
        }
        const numero = peeled.e164;
        const ok = removerDestinatario(numero);
        await conn.sendMessage(ctx.from, {
            text: ok ? `Numero ${numero} removido.` : `Nao estava na lista.`
        }, { quoted: ctx.info });
    }
};

commands.lista = {
    useCtx: true,
    description: 'Lista os destinatarios do loop',
    usage: 'lista',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const lista = listarDestinatarios();
        const texto = lista.length ? lista.join('\n') : 'Nenhum destinatario cadastrado.';
        await conn.sendMessage(ctx.from, { text: `📋 Destinatarios:\n${texto}` }, { quoted: ctx.info });
    }
};

// Loop continuo
commands.startloop = {
    useCtx: true,
    description: 'Inicia o loop de envio continuo',
    usage: 'startloop [intervaloMs] [tipo] [mensagem]',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const args = ctx.args || [];
        const intervalo = parseInt(args[0]) || 10000;
        const tipo = args[1] || 'sms';
        const mensagem = args.slice(2).join(' ') || 'Notificacao automatica';
        const resultado = iniciarLoop(intervalo, tipo, mensagem);
        await conn.sendMessage(ctx.from, {
            text: resultado.sucesso
                ? `Loop iniciado (intervalo: ${intervalo}ms, tipo: ${tipo})`
                : `Erro: ${resultado.erro}`
        }, { quoted: ctx.info });
    }
};

commands.stoploop = {
    useCtx: true,
    description: 'Para o loop de envio continuo',
    usage: 'stoploop',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const resultado = pararLoop();
        await conn.sendMessage(ctx.from, {
            text: resultado.sucesso ? 'Loop parado.' : `Erro: ${resultado.erro}`
        }, { quoted: ctx.info });
    }
};

commands.statusloop = {
    useCtx: true,
    description: 'Verifica o status do loop',
    usage: 'statusloop',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const status = statusLoop();
        await conn.sendMessage(ctx.from, {
            text: `Loop: ${status.ativo ? 'ATIVO' : 'INATIVO'}\nIntervalo: ${status.intervalo}`
        }, { quoted: ctx.info });
    }
};

// Menu de comandos Twilio (opcional)
commands.twiliomenu = {
    useCtx: true,
    description: 'Menu de comandos Twilio',
    usage: 'twiliomenu',
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await sendButtonsWithImage(
            conn,
            ctx.from,
            '📡 COMANDOS TWILIO\n\n' +
            '• sms <numero> <msg>\n' +
            '• otp <numero> [sms|call]\n' +
            '• call <numero> <msg>\n' +
            '• email <destino> <assunto> <corpo>\n' +
            '• adddest <numero>\n' +
            '• remdest <numero>\n' +
            '• lista\n' +
            '• startloop [ms] [tipo] [msg]\n' +
            '• stoploop\n' +
            '• statusloop',
            [
                { id: 'menu', label: 'Voltar ao Menu' }
            ],
            'Hanork Bot',
            ctx.info,
            'menu.jpg',
            'TWILIO',
            'Clique abaixo',
            ctx.telegramUserId
        );
    }
};

module.exports = { commands };