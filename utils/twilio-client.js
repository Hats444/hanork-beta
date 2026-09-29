// utils/twilio-client.js
require('dotenv').config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

let client = null;
let errorMsg = null;

if (!accountSid || !accountSid.startsWith('AC')) {
    errorMsg = 'TWILIO_ACCOUNT_SID nao configurado ou invalido (deve comecar com AC)';
} else if (!authToken) {
    errorMsg = 'TWILIO_AUTH_TOKEN nao configurado';
} else {
    try {
        const twilio = require('twilio');
        client = twilio(accountSid, authToken);
    } catch (e) {
        errorMsg = 'Erro ao instanciar Twilio: ' + e.message;
    }
}

if (errorMsg) {
    console.warn('[TWILIO]', errorMsg);
    console.warn('[TWILIO] Os comandos Twilio nao estarao disponiveis.');
}

module.exports = {
    client,
    twilioPhone: process.env.TWILIO_PHONE_NUMBER || null,
    isAvailable: !!client,
    error: errorMsg
};