// utils/notificacoes.js
const { client, twilioPhone } = require('./twilio-client');
const axios = require('axios');
const logger = require('../logger');

// Envia SMS
async function enviarSMS(destino, mensagem) {
    try {
        const msg = await client.messages.create({
            body: mensagem,
            from: twilioPhone,
            to: destino,
        });
        return { sucesso: true, sid: msg.sid };
    } catch (error) {
        logger.logErro('TWILIO_SMS', error.message);
        return { sucesso: false, erro: error.message };
    }
}

// Envia OTP (via SMS ou chamada)
async function enviarOTP(destino, metodo = 'sms') {
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const mensagem = `Seu codigo de verificacao e: ${codigo}`;
    if (metodo === 'sms') {
        return await enviarSMS(destino, mensagem);
    } else if (metodo === 'call') {
        try {
            const call = await client.calls.create({
                twiml: `<Response><Say>${mensagem}</Say></Response>`,
                to: destino,
                from: twilioPhone,
            });
            return { sucesso: true, sid: call.sid };
        } catch (error) {
            logger.logErro('TWILIO_CALL', error.message);
            return { sucesso: false, erro: error.message };
        }
    }
    return { sucesso: false, erro: 'Metodo invalido' };
}

// Envia chamada de voz com mensagem personalizada (TTS)
async function enviarChamada(destino, mensagem) {
    try {
        const call = await client.calls.create({
            twiml: `<Response><Say>${mensagem}</Say></Response>`,
            to: destino,
            from: twilioPhone,
        });
        return { sucesso: true, sid: call.sid };
    } catch (error) {
        logger.logErro('TWILIO_CALL', error.message);
        return { sucesso: false, erro: error.message };
    }
}

// Envia e-mail (usando SendGrid ou outro serviço)
async function enviarEmail(destino, assunto, corpo) {
    try {
        const response = await axios.post(
            'https://api.sendgrid.com/v3/mail/send',
            {
                personalizations: [{ to: [{ email: destino }] }],
                from: { email: process.env.EMAIL_FROM || 'no-reply@seudominio.com' },
                subject: assunto,
                content: [{ type: 'text/plain', value: corpo }],
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
                },
            }
        );
        return { sucesso: true };
    } catch (error) {
        logger.logErro('TWILIO_EMAIL', error.message);
        return { sucesso: false, erro: error.message };
    }
}

module.exports = {
    enviarSMS,
    enviarOTP,
    enviarChamada,
    enviarEmail,
};