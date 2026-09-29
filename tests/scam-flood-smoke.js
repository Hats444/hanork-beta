'use strict';
const assert = require('assert');
const {
  classifyScamInviteFlood,
  isAdminVisibleOnlyStatus,
  isPaymentMessage,
  isGroupStatusLike,
  isDivulgacaoPaymentPayload
} = require('../utils/moderation');

const payFlood = {
  key: { id: 'PAY1', remoteJid: '120363000000000000@g.us', fromMe: false, participant: '123@lid' },
  message: {
    requestPaymentMessage: {
      currencyCodeIso4217: 'BRL',
      amount1000: '0',
      noteMessage: {
        extendedTextMessage: {
          text: 'grupo vai fechar https://chat.whatsapp.com/AbCdEfGhIjK',
          contextInfo: { mentionedJid: Array.from({ length: 12 }, (_, i) => `${i}@s.whatsapp.net`) }
        }
      }
    }
  }
};

const adminStatusFlood = {
  key: { id: 'ST1', remoteJid: '120363000000000000@g.us', fromMe: false, participant: '123@lid' },
  message: {
    extendedTextMessage: {
      text: 'comunicado https://whatsapp.com/channel/0123456789abcdef',
      contextInfo: { statusSourceType: 4, isGroupStatus: true }
    }
  }
};

const normalText = {
  key: { id: 'N1', remoteJid: '120363000000000000@g.us', fromMe: false, participant: '123@lid' },
  message: { conversation: 'oi gente, pix na bio depois' }
};

const replyToStatus = {
  key: { id: 'R1', remoteJid: '120363000000000000@g.us', fromMe: false, participant: '123@lid' },
  message: {
    extendedTextMessage: {
      text: 'ok',
      contextInfo: {
        statusSourceType: 4,
        isGroupStatus: true,
        stanzaId: 'ST1',
        quotedMessage: { conversation: 'status antigo' }
      }
    }
  }
};

assert.ok(isPaymentMessage(payFlood), 'PIX nativo');
assert.ok(isDivulgacaoPaymentPayload(payFlood), 'divulgacao payment');
assert.strictEqual(classifyScamInviteFlood(payFlood).reason, 'scam_pay_invite');

assert.ok(isAdminVisibleOnlyStatus(adminStatusFlood), 'status so admin');
assert.ok(isGroupStatusLike(adminStatusFlood), 'group status like');
assert.strictEqual(classifyScamInviteFlood(adminStatusFlood).reason, 'scam_status_invite');

assert.strictEqual(classifyScamInviteFlood(normalText), null, 'texto comum nao e scam');
assert.strictEqual(isAdminVisibleOnlyStatus(replyToStatus), false, 'reply nao e status da bandeja');
assert.strictEqual(classifyScamInviteFlood(replyToStatus), null, 'reply sem convite');

console.log('scam-flood-smoke ok');
