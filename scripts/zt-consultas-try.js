#!/usr/bin/env node
'use strict';
require('dotenv').config();
const axios = require('axios');

const BASE = (
  process.env.HANORK_API_BASE ||
  process.env.ZEROTWO_API_BASE ||
  'https://zero-two-apis.store'
).replace(/\/$/, '');
const KEY = (process.env.HANORK_API_KEY || process.env.ZEROTWO_API_KEY || '').trim();

function classify(raw, status, ct) {
  const s = String(raw || '');
  if (/text\/html/i.test(ct) || /<!doctype html|<html[\s>]/i.test(s.slice(0, 400))) return 'HTML';
  try {
    const j = JSON.parse(s);
    const keys = Object.keys(j || {});
    const fail = status >= 400 || j.erro === true || j.error === true || j.status === false;
    const msg = String(j.mensagem || j.message || j.error || '').slice(0, 60);
    return `JSON status=${status} fail=${fail} keys=${keys.slice(0, 8).join(',')} msg=${msg}`;
  } catch (_) {
    return `NOTJSON status=${status} head=${s.slice(0, 40).replace(/\s+/g, ' ')}`;
  }
}

(async () => {
  const r = await axios.get(`${BASE}/docs`, {
    timeout: 25000,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d]
  });
  const raw = String(r.data || '');
  const idx = raw.indexOf('/consultas/serasa/cpf');
  if (idx >= 0) {
    const snip = raw.slice(Math.max(0, idx - 180), idx + 420).replace(/\s+/g, ' ');
    console.log('SNIP', snip.slice(0, 500));
  }
  const scripts = [...raw.matchAll(/src=["']([^"']+)["']/gi)].map((x) => x[1]).filter((u) => /swagger|openapi|redoc|docs/i.test(u));
  console.log('SCRIPTS', scripts.slice(0, 10).join(' | '));

  const tries = [
    ['GET', '/consultas/serasa/cpf', { query: '52998224725' }],
    ['GET', '/consultas/cpf', { query: '52998224725' }],
    ['GET', '/vip/cpf', { query: '52998224725' }],
    ['GET', '/consultas/serasa/cpf', { cpf: '52998224725' }],
    ['POST', '/consultas/serasa/cpf', { query: '52998224725', cpf: '52998224725' }],
    ['GET', '/consultas/serasa/cep', { query: '01001000', cep: '01001000' }],
    ['GET', '/consultas/cep', { query: '01001000' }],
    ['GET', '/consultas/serasa/cnpj', { query: '00000000000191', cnpj: '00000000000191' }],
    ['GET', '/consultas/serasa/fotorj', { query: '52998224725' }],
    ['GET', '/consultas/serasa/gerar-cpf', { q: '1' }]
  ];
  for (const [method, path, params] of tries) {
    try {
      const url = new URL(BASE + path);
      url.searchParams.set('apikey', KEY);
      let res;
      if (method === 'GET') {
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        res = await axios.get(url.toString(), {
          timeout: 12000,
          validateStatus: () => true,
          responseType: 'text',
          transformResponse: [(d) => d]
        });
      } else {
        res = await axios.post(url.toString(), params, {
          timeout: 12000,
          validateStatus: () => true,
          responseType: 'text',
          transformResponse: [(d) => d],
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const ct = String(res.headers?.['content-type'] || '');
      console.log(method, path, classify(res.data, res.status, ct));
    } catch (e) {
      console.log(method, path, 'ERR', String(e.message || e).slice(0, 80));
    }
  }
})().catch((e) => {
  console.error(String(e.message || e).slice(0, 200));
  process.exit(1);
});
