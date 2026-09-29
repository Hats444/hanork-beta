'use strict';
const sqlStore = require('./sqlStore');
const channelSend = require('./channelSend');
const dbRun = sqlStore['runAsync'] || dbRun;
const dbGet = sqlStore['getAsync'] || dbGet;
const dbAll = sqlStore['allAsync'] || dbAll;

const SEED = [
  { invite: '0029VbD5uob9sBII0YCT8d30', hint: '' },
  { invite: '0029Vb8B3PpCXC3QMGRiTW22', hint: '' },
  { invite: '0029Vb8h9aL3WHTPN4pllG2I', hint: 'Pins - Figs | Raven' },
  { invite: '0029VbCcH0qHLHQU2jKEh046', hint: '' },
  { invite: '0029VbDqUSsKQuJL2Ay5oS1j', hint: '' },
  { invite: '0029VbAt0EdJUM2fMmDUVb2I', hint: 'Lawliet Channel' }
];

const TYPES = new Set(['fixa', 'troca']);

function nowIso() {
  return new Date().toISOString();
}

function inviteLink(code) {
  return code ? 'https://whatsapp.com/channel/' + code : '';
}

async function ensureTable() {
  await dbRun(
    'CREATE TABLE IF NOT EXISTS channel_partners (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    "owner_key TEXT NOT NULL DEFAULT 'global'," +
    'channel_jid TEXT,' +
    'invite_code TEXT NOT NULL,' +
    'name_hint TEXT,' +
    'owner_name TEXT,' +
    "partner_type TEXT NOT NULL DEFAULT 'fixa'," +
    "status TEXT NOT NULL DEFAULT 'active'," +
    'created_at TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL,' +
    'UNIQUE(owner_key, invite_code)' +
    ')'
  );
}

async function seedIfEmpty() {
  await ensureTable();
  const row = await dbGet('SELECT COUNT(*) AS n FROM channel_partners');
  if (Number((row && row.n) || 0) > 0) return;
  const ts = nowIso();
  for (let i = 0; i < SEED.length; i++) {
    const s = SEED[i];
    await dbRun(
      'INSERT OR IGNORE INTO channel_partners ' +
      '(owner_key, channel_jid, invite_code, name_hint, owner_name, partner_type, status, created_at, updated_at) ' +
      "VALUES ('global', NULL, ?, ?, '', 'fixa', 'active', ?, ?)",
      [s.invite, s.hint || '', ts, ts]
    );
  }
}

function rowView(r) {
  return {
    id: r.id,
    jid: r.channel_jid || '',
    invite: r.invite_code,
    link: inviteLink(r.invite_code),
    name: r.name_hint || '',
    ownerName: r.owner_name || '',
    type: r.partner_type || 'fixa',
    status: r.status || 'active',
    createdAt: r.created_at
  };
}

async function listPartners(includeInactive) {
  await seedIfEmpty();
  const sql = includeInactive === false
    ? "SELECT * FROM channel_partners WHERE status='active' ORDER BY id ASC"
    : 'SELECT * FROM channel_partners ORDER BY id ASC';
  const rows = await dbAll(sql);
  return (rows || []).map(rowView);
}

async function getById(id) {
  await ensureTable();
  const r = await dbGet('SELECT * FROM channel_partners WHERE id=?', [Number(id)]);
  return r ? rowView(r) : null;
}

async function getByInviteOrJid(input) {
  await ensureTable();
  const code = channelSend.inviteCodeFrom(input);
  if (code) {
    const r = await dbGet('SELECT * FROM channel_partners WHERE invite_code=?', [code]);
    if (r) return rowView(r);
  }
  const jid = String(input || '').trim();
  if (jid) {
    const r = await dbGet('SELECT * FROM channel_partners WHERE channel_jid=?', [jid]);
    if (r) return rowView(r);
  }
  return null;
}

async function addPartner(opts) {
  await seedIfEmpty();
  const invite = opts && opts.invite;
  const jid = opts && opts.jid;
  const nameHint = (opts && opts.nameHint) || '';
  const ownerName = (opts && opts.ownerName) || '';
  const type = opts && opts.type;
  const code = channelSend.inviteCodeFrom(invite) || channelSend.inviteCodeFrom(jid);
  if (!code && !jid) throw new Error('informe link ou jid do canal');
  const partnerType = TYPES.has(type) ? type : 'fixa';
  const ts = nowIso();
  const existing = code
    ? await dbGet('SELECT * FROM channel_partners WHERE invite_code=?', [code])
    : null;
  if (existing) {
    await dbRun(
      'UPDATE channel_partners SET ' +
      'channel_jid=COALESCE(?, channel_jid), ' +
      "name_hint=CASE WHEN ? != '' THEN ? ELSE name_hint END, " +
      "owner_name=CASE WHEN ? != '' THEN ? ELSE owner_name END, " +
      "partner_type=?, status='active', updated_at=? WHERE id=?",
      [jid || null, nameHint, nameHint, ownerName, ownerName, partnerType, ts, existing.id]
    );
    return getById(existing.id);
  }
  const ins = await dbRun(
    'INSERT INTO channel_partners ' +
    '(owner_key, channel_jid, invite_code, name_hint, owner_name, partner_type, status, created_at, updated_at) ' +
    "VALUES ('global', ?, ?, ?, ?, ?, 'active', ?, ?)",
    [jid || null, code || String(jid), nameHint, ownerName, partnerType, ts, ts]
  );
  return getById(ins.lastID);
}

async function updatePartner(id, patch) {
  const cur = await getById(id);
  if (!cur) return null;
  const p = patch || {};
  const ownerName = p.ownerName != null ? String(p.ownerName) : cur.ownerName;
  const type = p.type && TYPES.has(p.type) ? p.type : cur.type;
  const status = p.status === 'inactive' ? 'inactive' : (p.status === 'active' ? 'active' : cur.status);
  const nameHint = p.nameHint != null ? String(p.nameHint) : cur.name;
  const jid = p.jid != null ? p.jid : cur.jid;
  await dbRun(
    'UPDATE channel_partners SET owner_name=?, partner_type=?, status=?, name_hint=?, channel_jid=?, updated_at=? WHERE id=?',
    [ownerName, type, status, nameHint, jid || null, nowIso(), Number(id)]
  );
  return getById(id);
}

async function deactivatePartner(id) {
  return updatePartner(id, { status: 'inactive' });
}

async function syncLiveNames(conn, rows) {
  const out = [];
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    let name = r.name;
    let jid = r.jid;
    if (conn) {
      if (!jid && r.invite && typeof conn.newsletterMetadata === 'function') {
        try {
          const meta = await conn.newsletterMetadata('invite', r.invite);
          jid = channelSend.metaJid(meta) || jid;
          name = channelSend.metaName(meta) || name;
        } catch (_) { /* sem follow ainda */ }
      }
      if (jid) name = (await channelSend.liveName(conn, jid, name)) || name;
      if (jid !== r.jid || (name && name !== r.name)) {
        await dbRun(
          'UPDATE channel_partners SET channel_jid=?, name_hint=?, updated_at=? WHERE id=?',
          [jid || r.jid || null, name || r.name, nowIso(), r.id]
        );
      }
    }
    out.push(Object.assign({}, r, { jid: jid, name: name, link: inviteLink(r.invite) }));
  }
  return out;
}

function parseIdList(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map(function (s) { return Number(s); })
    .filter(function (n) { return Number.isFinite(n) && n > 0; });
}

function typeLabel(t) {
  return t === 'troca' ? 'troca pontual' : 'fixa';
}

const exported = {
  SEED: SEED,
  TYPES: TYPES,
  inviteLink: inviteLink,
  seedIfEmpty: seedIfEmpty,
  listPartners: listPartners,
  getById: getById,
  getByInviteOrJid: getByInviteOrJid,
  addPartner: addPartner,
  updatePartner: updatePartner,
  deactivatePartner: deactivatePartner,
  syncLiveNames: syncLiveNames,
  parseIdList: parseIdList,
  typeLabel: typeLabel
};
exported['seedIfEmpty'] = seedIfEmpty;
exported['seedIfEmpty'] = seedIfEmpty;
exported['listPartners'] = listPartners;
exported['listPartners'] = listPartners;
exported['getById'] = getById;
exported['getByInviteOrJid'] = getByInviteOrJid;
exported['getByInviteOrJid'] = getByInviteOrJid;
exported['addPartner'] = addPartner;
exported['updatePartner'] = updatePartner;
exported['deactivatePartner'] = deactivatePartner;
exported['syncLiveNames'] = syncLiveNames;
exported['syncLiveNames'] = syncLiveNames;
exported['parseIdList'] = parseIdList;
exported['parseIdList'] = parseIdList;
exported['typeLabel'] = typeLabel;
exported['typeLabel'] = typeLabel;
module.exports = exported;
