#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const OUT = path.join(__dirname, '..', 'logs', 'mind7-diag.txt');
const BASE = String(process.env.MIND7_BASE || 'https://mind-7.org').replace(/\/$/, '');
const cookie = String(process.env.MIND7_COOKIE || '').trim();

async function get(url) {
  return axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    responseType: 'text'
  });
}

async function main() {
  const lines = [];
  const log = (s) => lines.push(s);
  log('ts=' + new Date().toISOString());
  log('cookieLen=' + cookie.length);

  const painel = await get(`${BASE}/painel/`);
  const ph = String(painel.data || '');
  log(`painel http=${painel.status} cf=${/Just a moment/.test(ph)} modulos=${/consultas/i.test(ph)} token=${/var T=/i.test(ph)}`);

  const mods = ['cpf', 'emprego', 'nome', 'celular', 'placa'];
  for (const m of mods) {
    const r = await get(`${BASE}/painel/consultas/${m}/`);
    const h = String(r.data || '');
    log(`mod ${m} http=${r.status} cf=${/Just a moment/.test(h)} form=${/documento|meu-formulario|form-control/i.test(h)} tok=${/var T=/i.test(h)} len=${h.length}`);
  }

  try {
    const mind7 = require('../services/mind7Client');
    const r = await mind7.consultar('score', '00000000000');
    log(`consulta score ok=${r.success} msg=${String(r.message || r.text || '').slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (e) {
    log('consulta err=' + e.message);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'));
}

main().catch((e) => {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, 'fatal: ' + e.message);
  } catch (_) {}
  process.exit(1);
});
