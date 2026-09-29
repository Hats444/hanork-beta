'use strict';
/**
 * Detecta resposta de assistente generico (modelo pequeno / ZT fora do schema).
 * Esses textos NAO executam o que o usuario pediu — devem ser descartados.
 */

function looksGenericAssistantReply(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const compact = t.replace(/\s+/g, ' ');
  if (compact.length < 4) return true;

  if (
    /^(ola|olá|oi|hey|eai|e ae|e aí|hello|hi)[!.,]?\s*(sou|eu sou|como (posso|posso te)|em que|estou aqui|claro|certo)/i.test(
      compact
    )
  ) {
    return true;
  }

  if (
    /\b(como posso ajudar|em que posso (ajudar|ser util)|estou aqui para ajudar|posso te ajudar|como posso te ajudar|how can i help|i can help|i('m| am) (an? )?(ai|assistant|language model))\b/i.test(
      compact
    )
  ) {
    return true;
  }

  if (
    /^(claro|com certeza|certo|ok|okay|tudo bem|entend[io]|beleza|show|sure|of course|absolutely)[!.,]?\s*$/i.test(
      compact
    )
  ) {
    return true;
  }

  if (
    /^(claro!?|certo!?)\s+(aqui (est[aá]|vai)|posso|vou te|vamos)/i.test(compact) &&
    compact.length < 140
  ) {
    return true;
  }

  if (/^sou uma (ia|intelig[eê]ncia|assistente)/i.test(compact)) return true;

  // JSON de intent vazado como prosa
  if (/^\s*\{[\s\S]*"(tipo|type|comando|command)"\s*:/.test(t) && t.length < 400) {
    return true;
  }

  return false;
}

module.exports = {
  looksGenericAssistantReply
};
