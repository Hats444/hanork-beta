// core/router/intent/detectors/identifiers.js
// CPF / telefone / CNPJ / CEP / email isolados (alta confiança)

function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

function isValidCpf(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i], 10) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(digits[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits[i], 10) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === parseInt(digits[10], 10);
}

function isValidCnpj(digits) {
  if (!/^\d{14}$/.test(digits)) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;
  const calc = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += parseInt(base[i], 10) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calc(digits, w1);
  const d2 = calc(digits, w2);
  return d1 === parseInt(digits[12], 10) && d2 === parseInt(digits[13], 10);
}

/**
 * Só dispara se a mensagem inteira (trim) for o identificador — não em frase.
 */
function detect(text, opts = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Isolado: sem palavras extras (permite pontuação de formatacao)
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  const allowInSentence = opts.allowInSentence === true;
  if (!allowInSentence && wordCount > 3) return null;

  // Email isolado
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    return {
      route: 'consulta',
      confidence: 0.93,
      payload: raw,
      consultaTipo: 'email',
      priority: 80,
      kind: 'identifier'
    };
  }

  const digits = onlyDigits(raw);

  // CNPJ (antes de telefone)
  if ((/^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(raw) || digits.length === 14) && isValidCnpj(digits)) {
    if (!allowInSentence && wordCount > 1 && !/^[\d./\s-]+$/.test(raw)) return null;
    return {
      route: 'consulta',
      confidence: 0.96,
      payload: digits,
      consultaTipo: 'cnpj',
      priority: 95,
      kind: 'identifier'
    };
  }

  // CPF (11 digitos com checksum — antes de telefone)
  if ((/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(raw) || digits.length === 11) && isValidCpf(digits)) {
    if (!allowInSentence && wordCount > 1 && !/^[\d.\s-]+$/.test(raw)) return null;
    return {
      route: 'consulta',
      confidence: 0.96,
      payload: digits,
      consultaTipo: 'cpf',
      priority: 95,
      kind: 'identifier'
    };
  }

  // Telefone BR isolado (10-11 digitos, ou com +55) — so se NAO for CPF valido
  if (
    (/^(\+?55)?[\s().-]*\d{2}[\s().-]*\d{4,5}[\s().-]*\d{4}$/.test(raw) ||
      /^\d{10,11}$/.test(digits)) &&
    digits.length >= 10 &&
    digits.length <= 13
  ) {
    const phone = digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
    if (phone.length === 10 || phone.length === 11) {
      if (!allowInSentence && wordCount > 1 && !/^[\d\s+().-]+$/.test(raw)) return null;
      // 11 digitos sem checksum CPF → trata como telefone
      return {
        route: 'consulta',
        confidence: 0.94,
        payload: phone,
        consultaTipo: 'telefone',
        priority: 85,
        kind: 'identifier'
      };
    }
  }

  // CEP
  if (/^\d{5}-?\d{3}$/.test(raw) && digits.length === 8) {
    return {
      route: 'consulta',
      confidence: 0.92,
      payload: digits,
      consultaTipo: 'cep',
      priority: 75,
      kind: 'identifier'
    };
  }

  return null;
}

module.exports = { detect, isValidCpf, isValidCnpj };
