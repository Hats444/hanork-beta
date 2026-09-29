// core/zt/pathRemap.js — paths/params da API que mudaram (catalogo legado → vivo)
'use strict';

/**
 * Paths mortos (404 HTML) → rota atual na zero-two-apis.store
 * Atualizar quando a API mudar de novo.
 */
const PATH_REMAP = {
  // IA legado → vivo
  '/api/ia/chatgpt': '/api/ia/zerotwo',
  '/api/ia/chatgpt4': '/api/ia/gpt',
  '/api/ia/gpt4': '/api/ia/gpt',
  '/api/ia/imagine': '/api/ia/animagine',
  '/api/ia/gemini': '/api/ia2/geminipro',
  '/api/ia/gemini-image': '/gemini/imagem',
  '/api/ia/pollinations': '/api/ia/gpt',
  '/api/ia/premium': '/api/ia/gpt',
  '/api/ia/flux': '/api/ia/animagine',
  '/api/ia/sdxl': '/api/ia/animagine',
  '/api/ia/nano-banana': '/api/ia/animagine',
  '/api/ia/gpt-video': '/api/ia/gpt',
  '/api/ia/transcribe': '/api/transcrever',
  // IA2 aliases (gpt4 e claude existem no catalogo vivo /api/ia2/modelos — nao remapeia)
  '/api/ia2/chatgpt': '/api/ia2/chatgpt_5_5',
  // Canvas / makers
  '/api/canvas/brat': '/api/maker/brat',
  '/api/canvas/brat-video': '/api/maker/brat',
  '/api/canvas/ping': '/api/canvas/welcome',
  '/api/canvas/ping2': '/api/canvas/welcome'
};

/** Aliases de querystring exigidos pela API atual */
const PARAM_ALIASES = {
  prompt: ['query', 'text', 'q', 'texto'],
  texto: ['query', 'text', 'q', 'prompt', 'titulo'],
  text: ['query', 'q', 'texto', 'titulo', 'prompt'],
  q: ['query', 'text'],
  query: ['text', 'q', 'texto', 'prompt', 'topico'],
  topico: ['query', 'text', 'prompt', 'q'],
  titulo: ['title', 'nome'],
  nome: ['name', 'titulo', 'title'],
  url: ['link'],
  link: ['url'],
  language: ['lang', 'linguagem'],
  lang: ['language']
};

function remapPath(apiPath) {
  const p = String(apiPath || '');
  if (!p) return p;
  const norm = p.startsWith('/') ? p : `/${p}`;
  return PATH_REMAP[norm] || PATH_REMAP[p] || norm;
}

/**
 * Espalha aliases de parametros sem apagar o original.
 * Ex: { prompt: 'oi' } → { prompt, query, text, q }
 */
function expandParams(params = {}) {
  const out = { ...(params || {}) };
  for (let pass = 0; pass < 3; pass++) {
    let added = false;
    for (const [key, val] of Object.entries(out)) {
      if (val === undefined || val === null || val === '') continue;
      const aliases = PARAM_ALIASES[key];
      if (!aliases) continue;
      for (const a of aliases) {
        if (out[a] === undefined || out[a] === null || out[a] === '') {
          out[a] = val;
          added = true;
        }
      }
    }
    if (!added) break;
  }
  return out;
}

function remapRequest(apiPath, params = {}) {
  return {
    path: remapPath(apiPath),
    params: expandParams(params)
  };
}

module.exports = {
  PATH_REMAP,
  PARAM_ALIASES,
  remapPath,
  expandParams,
  remapRequest
};
