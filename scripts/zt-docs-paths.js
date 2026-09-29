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

(async () => {
  const r = await axios.get(`${BASE}/docs`, {
    timeout: 25000,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d]
  });
  const raw = String(r.data || '');
  const paths = new Set();
  const re = /["'`](\/(?:consultas|vip|api)[^"'`\s<>?]{0,90})/gi;
  let m;
  while ((m = re.exec(raw))) paths.add(m[1]);
  const hits = [...paths].filter((p) =>
    /consulta|serasa|cpf|cnpj|cep|placa|telefone|nome|score|cnh|chassi/i.test(p)
  );
  console.log('docs_len', raw.length, 'paths', paths.size, 'hits', hits.length);
  console.log(hits.slice(0, 120).join('\n'));
  const swagger = raw.match(/url:\s*["']([^"']+)["']/);
  if (swagger) console.log('spec_url', swagger[1]);
  const spec2 = raw.match(/["'](\/docs\/[^"']+\.json)["']/);
  if (spec2) console.log('spec2', spec2[1]);
})().catch((e) => {
  console.error(String(e.message || e).slice(0, 200));
  process.exit(1);
});
