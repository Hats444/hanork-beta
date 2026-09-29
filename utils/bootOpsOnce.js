'use strict';

/**
 * Gancho de boot opcional. A versao local antiga trazia identificadores
 * fixos e nao entra no repositorio publico. Sem flag, nao altera donos.
 */
function runBootOpsOnce() {
  return { ran: false };
}

module.exports = { runBootOpsOnce };
