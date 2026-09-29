// utils/divulgacaoGate.js — cmds de divulgacao so em grupos com flag
'use strict';

const DIV_ONLY = /^(div|divbotao|divctaenvio|divpay|divmark|divstatus|divcf|divfull|divconfirmar|divstop|parardiv|divparar|stopdiv|msgdivul|msgdivulpay|msgdivulstatus|fotodivul|fotodivulcta|fotodivulstatus|videodivulstatus|ctafoto|divctafoto|fotodivcta|fotocta|divfotocta|apagafotodivulcta|videodivul|gifdivul|audiodivul|documentodivul|apagardivul|previewdivul|divcta|div_cta_wizard|div_cta_texto|div_cta_label|div_cta_url|div_cta_label2|div_cta_url2|div_cta_btn2_rm|divmenu|divconfig|divhelp|divajuda|divgrupos)$/i;

function isDivulgacaoCommand(command) {
  return DIV_ONLY.test(String(command || ''));
}

/**
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function checkDivulgacaoAllowed(command, { isGroup, groupId, telegramUserId } = {}) {
  if (!isDivulgacaoCommand(command)) return { ok: true };
  if (!isGroup) return { ok: true };
  const gid = String(groupId || '');
  if (!gid.endsWith('@g.us')) return { ok: true };
  try {
    const { getGroupSecurity } = require('./moderation');
    const gf = getGroupSecurity(gid, telegramUserId);
    if (gf.grupoDivulgacao) return { ok: true };
  } catch (_) { /* ignore */ }
  try {
    const { getGruposParaDivulgar } = require('./divulgacao');
    const data = getGruposParaDivulgar(telegramUserId);
    const list = (data && data.grupos) || [];
    if (list.map(String).includes(gid)) return { ok: true };
  } catch (_) { /* ignore */ }
  return {
    ok: false,
    message: require('./configManager').applyLivePrefix(
      'Este grupo ainda nao esta marcado pra divulgacao.\n' +
      'No grupo, use {p}addgrupo — eu te respondo aqui no PV (o grupo nao ve o bot).',
      require('./configManager').displayPrefix(telegramUserId)
    )
  };
}

module.exports = {
  DIV_ONLY,
  isDivulgacaoCommand,
  checkDivulgacaoAllowed
};
