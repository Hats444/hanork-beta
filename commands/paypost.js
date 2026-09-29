'use strict';
/**
 * paypost — pagamento nativo com renderização seletiva (hide-admin).
 * Usa a mesma lógica de groupStatusV2.sendGroupPaymentMembers:
 * - Admins não recebem a mensagem (modo membros + hide-admin)
 * - Membros são mencionados (silent tagging) sem expor a lista visualmente
 * - Modo: membros (padrão), todos (inclui admins), canal (newsletter)
 */

const { sendGroupPaymentMembers, parseStatusMode, stripModeArgs, formatPaymentResult } = require('../utils/groupStatusV2');
const logger = require('../logger');

module.exports = {
  commands: {
    paypost: {
      info: 'Envia cobrança nativa no grupo com renderização seletiva (membros só, admin fora)',
      usage: '.paypost <texto> [membros|todos|canal]',
      category: 'admin',
      ownerOnly: true,
      handler: async (ctx) => {
        const { conn, args, from, prefix } = ctx;
        const mode = parseStatusMode(args);
        const cleanArgs = stripModeArgs(args);
        const texto = cleanArgs.join(' ').trim();

        if (!texto) {
          return await ctx.reply(`Uso: ${prefix}paypost <texto> [membros|todos|canal]\nModos:\n- membros (padrão): só membros recebem, admin fora\n- todos: todos recebem\n- canal: envia para canal`);
        }

        if (!from.endsWith('@g.us')) {
          return await ctx.reply('Este comando só funciona em grupos.');
        }

        try {
          const result = await sendGroupPaymentMembers(conn, from, {
            texto,
            mode,
            hideAdmin: mode === 'membros'
          });

          const resposta = formatPaymentResult(result);
          await ctx.reply(resposta);
        } catch (e) {
          logger.logErro('paypost', e.message);
          await ctx.reply(`Erro ao enviar pagamento: ${e.message}`);
        }
      }
    }
  }
};
