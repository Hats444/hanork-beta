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

async function api(p) {
  const url = `${PANEL}/api/client/servers/${SERVER}${p}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'Application/vnd.pterodactyl.v1+json' }
  });
  return { ok: r.ok, status: r.status, txt: await r.text() };
}

(async () => {
  const listed = await api('/files/list?directory=' + encodeURIComponent('/logs'));
  console.log('list', listed.status);
  try {
    const j = JSON.parse(listed.txt);
    const files = (j.data || []).map((x) => x.attributes || x).map((a) => `${a.name} ${a.size} ${a.modified_at}`);
    console.log(files.slice(0, 12).join('\n'));
  } catch (e) { console.log(listed.txt.slice(0, 200)); }

  const rx = /GROUP_JOIN|GROUP_JOIN_BATCH|GROUP_JOIN_FAILED|GROUP_JOIN_SUCCESS|GROUP_JOIN_STARTED|already_member|join_sem_jid|not_in_div_list|registry_failed|claimPending|Entrando em|grupoentrar/i;
  for (const file of ['/logs/bot_2026-08-23.log', '/logs/bot_2026-08-22.log']) {
    const r = await api(`/files/contents?file=${encodeURIComponent(file)}`);
    console.log('\nFILE', file, r.status, 'len', r.txt.length);
    if (!r.ok) { console.log(r.txt.slice(0, 180)); continue; }
    const hits = r.txt.split(/\r?\n/).filter((ln) => rx.test(ln));
    console.log('hits', hits.length);
    console.log(hits.slice(-80).join('\n'));
  }
})().catch((e) => { console.error(e); process.exit(1); });
