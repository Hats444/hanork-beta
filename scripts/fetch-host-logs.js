'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
const rk = require('../services/raikkenService');

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

(async () => {
  if (!rk.isConfigured()) {
    console.error('Raikken nao configurada');
    process.exit(1);
  }
  const day = todayStamp();
  const files = [`/logs/bot_${day}.log`, '/logs/bot.log', '/logs/out.log'];
  const rx = /owners|AUTH|DIV|divulgar|channelpost|DONO|owner/i;
  for (const f of files) {
    try {
      const txt = String(await rk.readFile(f) || '');
      const lines = txt.split(/\r?\n/);
      const hits = lines.filter((ln) => rx.test(ln));
      console.log(`\n===== ${f} bytes=${txt.length} hits=${hits.length} =====`);
      console.log((hits.slice(-40).join('\n') || '(sem hits)'));
      console.log('-- tail --');
      console.log(lines.slice(-20).join('\n'));
    } catch (e) {
      console.log(`\n===== ${f} FAIL ${e.message} =====`);
    }
  }
  try {
    const listing = await rk.listFiles('/data/users');
    const items = listing?.data || listing || [];
    const dirs = (Array.isArray(items) ? items : []).filter((x) => x.attributes?.is_file === false || x.is_file === false);
    console.log('\n===== data/users dirs =====');
    console.log(JSON.stringify(dirs.slice(0, 30), null, 0).slice(0, 2000));
  } catch (e) {
    console.log('list users FAIL', e.message);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
