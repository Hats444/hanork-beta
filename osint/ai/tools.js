'use strict';

/**
 * Ferramentas pre-definidas executadas pelo backend, nunca pelo modelo.
 * Fase 1: registradas; Ollama nao chama (enabled=false).
 */
const ALLOWED = [
  'query_dns',
  'query_rdap',
  'query_certificate',
  'query_github_public',
  'fetch_public_page',
  'analyze_entities',
  'verify_finding'
];

async function runTool(name, args) {
  const n = String(name || '');
  if (!ALLOWED.includes(n)) throw new Error('tool bloqueada');
  if (n === 'query_dns') return require('../collectors/dns').collect(args.target);
  if (n === 'query_rdap') return require('../collectors/rdap').collect(args.target);
  if (n === 'query_certificate') return require('../collectors/certificates').collect(args.target);
  if (n === 'query_github_public') return require('../collectors/github').collect(args.target);
  if (n === 'fetch_public_page') return require('../collectors/web').collect(args.target);
  if (n === 'analyze_entities' || n === 'verify_finding') {
    return { ok: true, note: 'use orchestrator' };
  }
  throw new Error('tool desconhecida');
}

module.exports = { ALLOWED, runTool };
