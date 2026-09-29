#!/usr/bin/env node
'use strict';
/**
 * CLI: verifica se contas Mind7 ainda logam.
 *
 * node scripts/verify-mind7-login.js email senha
 * node scripts/verify-mind7-login.js --file contas.json
 * node scripts/verify-mind7-login.js --file contas.csv
 *
 * JSON: [{"email":"a@example.com","password":"..."}]  ou  [["email","senha"]]
 * CSV:  email,password   (cabecalho opcional)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { verifyMind7Login, maskSecret } = require('../services/mind7Auth');
const { parseAccountsText } = require('../services/mind7Accounts');

function usage() {
  console.log('Uso:');
  console.log('  node scripts/verify-mind7-login.js <email> <senha>');
  console.log('  node scripts/verify-mind7-login.js --file <contas.json|contas.csv|contas.txt>');
  console.log('  txt: uma conta por linha no formato email:senha');
  process.exit(1);
}

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(/[,;]\s*/);
    if (!cols.length) continue;
    if (i === 0 && /email|usuario|user|login/i.test(cols[0])) continue;
    const email = cols[0];
    const password = cols.slice(1).join(',') || '';
    if (email) out.push({ email, password });
  }
  return out;
}

function parseFile(filePath) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  if (/\.json$/i.test(filePath)) {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) {
      return j.map((row) => {
        if (Array.isArray(row)) return { email: row[0], password: row[1] };
        return { email: row.email || row.user || row.login, password: row.password || row.senha || row.pass };
      });
    }
    throw new Error('JSON deve ser um array de contas');
  }
  return parseAccountsText(raw);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length) usage();
  if (args[0] === '--file' || args[0] === '-f') {
    if (!args[1]) usage();
    return parseFile(args[1]);
  }
  if (args.length < 2) usage();
  return [{ email: args[0], password: args.slice(1).join(' ') }];
}

(async () => {
  const accounts = parseArgs(process.argv);
  let valid = 0;
  let invalid = 0;
  let error = 0;
  for (const acc of accounts) {
    const email = String(acc.email || '').trim();
    const password = String(acc.password || '');
    const shown = `${email || '(sem-email)'} / ${maskSecret(password)}`;
    try {
      const r = await verifyMind7Login(email, password);
      if (r.status === 'valid') {
        valid += 1;
        console.log(`VALIDO   ${shown}`);
      } else if (r.status === 'invalid') {
        invalid += 1;
        console.log(`INVALIDO ${shown}  (${r.reason || 'credencial'})`);
      } else {
        error += 1;
        console.log(`ERRO     ${shown}  (${r.reason || 'erro'})`);
      }
    } catch (e) {
      error += 1;
      console.log(`ERRO     ${shown}  (${String(e.message || e).slice(0, 80)})`);
    }
  }
  console.log(`--- total=${accounts.length} validos=${valid} invalidos=${invalid} erros=${error}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
