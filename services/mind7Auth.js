'use strict';
/**
 * Check de login Mind7 isolado da UI/consulta.
 * Reusa o cliente HTTP (POST /acesso/ + GET /painel/).
 */
const { verifyCredentials, maskSecret } = require('./mind7Client');

async function verifyMind7Login(email, senha) {
  return verifyCredentials(email, senha);
}

module.exports = { verifyMind7Login, maskSecret };
