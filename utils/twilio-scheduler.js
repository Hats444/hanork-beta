// utils/twilio-scheduler.js
const { enviarSMS, enviarChamada, enviarOTP } = require('./notificacoes');
const logger = require('../logger');
const { readJSON, writeJSON, fileExists } = require('./fileUtils');

const DESTINATARIOS_FILE = '../database/twilio_destinatarios.json';
let loopAtivo = false;
let intervaloId = null;

// Graceful shutdown - limpa intervalo ao encerrar
process.on('exit', () => {
    if (intervaloId) {
        clearInterval(intervaloId);
        intervaloId = null;
    }
});

process.on('SIGINT', () => {
    if (intervaloId) {
        clearInterval(intervaloId);
        intervaloId = null;
        loopAtivo = false;
        logger.logInfo('[TWILIO_SCHEDULER] Loop parado via SIGINT');
    }
});

process.on('SIGTERM', () => {
    if (intervaloId) {
        clearInterval(intervaloId);
        intervaloId = null;
        loopAtivo = false;
        logger.logInfo('[TWILIO_SCHEDULER] Loop parado via SIGTERM');
    }
});

async function carregarDestinatarios() {
    const lista = await readJSON(DESTINATARIOS_FILE, []);
    return lista;
}

async function salvarDestinatarios(lista) {
    return await writeJSON(DESTINATARIOS_FILE, lista);
}

async function adicionarDestinatario(numero) {
    const lista = await carregarDestinatarios();
    if (!lista.includes(numero)) {
        lista.push(numero);
        await salvarDestinatarios(lista);
        return true;
    }
    return false;
}

async function removerDestinatario(numero) {
    const lista = await carregarDestinatarios();
    const index = lista.indexOf(numero);
    if (index !== -1) {
        lista.splice(index, 1);
        await salvarDestinatarios(lista);
        return true;
    }
    return false;
}

async function listarDestinatarios() {
    return await carregarDestinatarios();
}

// Inicia o loop de envio contínuo (a cada X ms)
async function iniciarLoop(intervaloMs = 10000, tipo = 'sms', mensagem = 'Notificacao automatica') {
    if (loopAtivo) {
        return { sucesso: false, erro: 'Loop ja esta ativo' };
    }
    loopAtivo = true;
    let contador = 0;
    intervaloId = setInterval(async () => {
        try {
            const destinatarios = await carregarDestinatarios();
            if (destinatarios.length === 0) return;
            const destino = destinatarios[Math.floor(Math.random() * destinatarios.length)];
            let resultado;
            switch (tipo) {
                case 'sms':
                    resultado = await enviarSMS(destino, mensagem + ` (${++contador})`);
                    break;
                case 'call':
                    resultado = await enviarChamada(destino, mensagem);
                    break;
                case 'otp':
                    resultado = await enviarOTP(destino, 'sms');
                    break;
                default:
                    resultado = { sucesso: false, erro: 'Tipo invalido' };
            }
            logger.logInfo(`[LOOP] ${tipo} para ${destino}: ${resultado.sucesso ? 'OK' : 'FALHA'}`);
        } catch (e) {
            logger.logErro('LOOP', e.message);
        }
    }, intervaloMs);
    return { sucesso: true };
}

// Para o loop
function pararLoop() {
    if (intervaloId) {
        clearInterval(intervaloId);
        intervaloId = null;
        loopAtivo = false;
        return { sucesso: true };
    }
    return { sucesso: false, erro: 'Loop nao esta ativo' };
}

function statusLoop() {
    return { ativo: loopAtivo, intervalo: intervaloId ? 'ativo' : 'parado' };
}

module.exports = {
    iniciarLoop,
    pararLoop,
    statusLoop,
    adicionarDestinatario,
    removerDestinatario,
    listarDestinatarios,
};