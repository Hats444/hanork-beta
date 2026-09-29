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
const PANEL = String(process.env.RAIKKEN_PANEL_URL || '').replace(/\/$/, '');
const KEY = String(process.env.RAIKKEN_API_KEY || '').trim();
const SERVER = String(process.env.RAIKKEN_SERVER_ID || '').trim();
const RX = /ANTIPV|ANTIPV|PV_OK|PV_OK|tiktok|COMMAND_STARTED|ROUTER_HANDLED|updateBlockStatus|wa-block|PV bloqueado/i;

async function contents(file) {
  const url = `${PANEL}/api/client/servers/${SERVER}/files/contents?file=${encodeURIComponent(file)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'Application/vnd.pterodactyl.v1+json' }
  });
  const txt = await r.text();
  return { ok: r.ok, status: r.status, txt };
}

(async () => {
  const day = '2026-08-23';
  const files = [`/logs/bot_${day}.log`, `/logs/bot.log`, `/logs/out.log`];
  for (const f of files) {
    const d = await contents(f);
    console.log(`\n===== ${f} ${d.status} bytes=${(d.txt || '').length} =====`);
    if (!d.ok) {
      console.log(d.txt.slice(0, 200));
      continue;
    }
    const lines = d.txt.split(/\r?\n/);
    const hits = lines.filter((ln) => RX.test(ln));
    console.log(`hits=${hits.length}`);
    console.log(hits.slice(-80).join('\n') || '(none)');
    console.log('-- tail --');
    console.log(lines.slice(-25).join('\n'));
  }
})().catch((e) => { console.error(e); process.exit(1); });
