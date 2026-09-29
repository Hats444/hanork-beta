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

const SAMPLE = {
  cpf: '01065963220',
  rg: '123456789',
  nome: 'MARIA SILVA',
  telefone: '11940028922',
  cnpj: '00000000000191',
  cep: '01001000',
  ddd: '11',
  placa: 'ABC1D23',
  chassi: '9BWZZZ377VT004251',
  cnh: '12345678901',
  bin: '411111',
  q: '1'
};

const ROUTES = [
  ['cpf', '/consultas/serasa/cpf', 'cpf'],
  ['cpf2', '/consultas/serasa/cpf2', 'cpf'],
  ['cpf3', '/consultas/serasa/cpf3', 'cpf'],
  ['cpf4', '/consultas/serasa/cpf4', 'cpf'],
  ['cpf5', '/consultas/serasa/cpf5', 'cpf'],
  ['rg', '/consultas/serasa/rg', 'rg'],
  ['nome', '/consultas/serasa/nome', 'nome'],
  ['nome2', '/consultas/serasa/nome2', 'nome'],
  ['mae', '/consultas/serasa/mae', 'nome'],
  ['telefone', '/consultas/serasa/telefone', 'telefone'],
  ['telefone3', '/consultas/serasa/telefone3', 'telefone'],
  ['score', '/consultas/serasa/score', 'cpf'],
  ['cnpj', '/consultas/serasa/cnpj', 'cnpj'],
  ['cep', '/consultas/serasa/cep', 'cep'],
  ['ddd', '/consultas/serasa/ddd', 'ddd'],
  ['placa', '/consultas/serasa/placa', 'placa'],
  ['chassi', '/consultas/serasa/chassi', 'chassi'],
  ['cnh', '/consultas/serasa/cnh', 'cnh'],
  ['abreviado', '/consultas/serasa/abreviado', 'cpf'],
  ['srs', '/consultas/serasa/srs', 'cpf'],
  ['fotorj', '/consultas/serasa/fotorj', 'cpf'],
  ['obito', '/consultas/serasa/obito', 'cpf'],
  ['parentes', '/consultas/serasa/parentes', 'cpf'],
  ['bin2', '/consultas/serasa/bin2', 'bin']
];

function payloadShape(data) {
  const root = data?.resultado != null ? data.resultado : data;
  if (root == null) return { n: 0, kind: 'null' };
  if (Array.isArray(root)) return { n: root.length, kind: 'array' };
  if (typeof root === 'object') {
    const keys = Object.keys(root).filter((k) => root[k] != null && root[k] !== '');
    return { n: keys.length, kind: 'object' };
  }
  return { n: String(root).length ? 1 : 0, kind: typeof root };
}

async function hit(path, params) {
  const u = new URL(BASE + path);
  u.searchParams.set('apikey', KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const t0 = Date.now();
  const res = await axios.get(u.toString(), {
    timeout: 18000,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d]
  });
  const raw = String(res.data || '');
  const ct = String(res.headers?.['content-type'] || '');
  const ms = Date.now() - t0;
  if (/text\/html/i.test(ct) || /<!doctype html|<html[\s>]/i.test(raw.slice(0, 200))) {
    return { tag: 'HTML', http: res.status, ms, n: 0 };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return { tag: 'NOTJSON', http: res.status, ms, n: 0 };
  }
  const fail = res.status >= 400 || data?.erro === true || data?.error === true || data?.status === false;
  const shape = payloadShape(data);
  if (!fail && shape.n > 0) return { tag: 'HAS_DATA', http: res.status, ms, n: shape.n, kind: shape.kind };
  return { tag: 'EMPTY', http: res.status, ms, n: shape.n };
}

(async () => {
  const live = [];
  for (const [name, path, param] of ROUTES) {
    const val = SAMPLE[param] || SAMPLE.cpf;
    let best = null;
    for (const params of [{ query: val }, { [param]: val }]) {
      try {
        const r = await hit(path, params);
        const mode = params.query ? 'query' : param;
        console.log(`${String(r.tag).padEnd(8)} ${name.padEnd(10)} mode=${mode.padEnd(9)} http=${r.http} n=${r.n} ms=${r.ms}`);
        if (r.tag === 'HAS_DATA') best = r;
        if (!best || (r.tag === 'HAS_DATA' && best.tag !== 'HAS_DATA')) best = r;
      } catch (e) {
        console.log(`ERR      ${name.padEnd(10)} ${String(e.message || e).slice(0, 60)}`);
      }
    }
    if (best && best.tag === 'HAS_DATA') live.push(name);
  }
  console.log('HAS_DATA=' + live.join(','));
})().catch((e) => {
  console.error(String(e.message || e).slice(0, 200));
  process.exit(1);
});
