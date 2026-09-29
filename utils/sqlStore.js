// utils/sqlStore.js — persistencia SQL (sqlite3); JSON fica so como backup
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const DB_PATH = path.join(__dirname, '../data/hanork.sqlite');
let db = null;
let ready = false;
let healInFlight = false;
let healBlockedLogged = false;
let cacheOnlyLogged = false;
let kvWarmed = false;
/** Cache RAM: uid|gid -> flags */
const flagCache = new Map();
/** Cache RAM: scope|key -> parsed value */
const kvCache = new Map();

function isKvWarmed() {
  if (!ready) return true;
  return kvWarmed;
}

function markKvWarmed() {
  kvWarmed = true;
}

function kvKey(scope, key) {
  return `${String(scope)}|${String(key)}`;
}

function tryRequireSqlite3() {
  // eslint-disable-next-line import/no-extraneous-dependencies
  return require('sqlite3');
}

/** Binario nativo de outro OS (Windows .node no WSL /mnt/c) — npm install so piora. */
function isNativeArchMismatch(reason) {
  return /invalid\s*ELF|ELF\s*headr|ELF\s*header|wrong\s*ELF|not a valid Win32|ERROR_BAD_EXE_FORMAT|cannot\s*open\s*shared\s*object/i.test(
    String(reason || '')
  );
}

function scheduleSqliteHeal(reason) {
  const msg = String(reason || '');
  if (process.env.HANORK_SQL_HEAL === '0' || process.env.HANORK_SQL_HEAL === 'false') {
    return;
  }
  if (isNativeArchMismatch(msg)) {
    if (!healBlockedLogged) {
      healBlockedLogged = true;
      logger.logAviso(
        '[sqlStore] sqlite3 nativo incompativel neste OS (ex: bin Windows no WSL). Cache/JSON only; host Linux usa SQL. Sem npm install automatico.'
      );
    }
    return;
  }
  if (healInFlight) return;
  healInFlight = true;
  logger.logAviso(`[sqlStore] agendando npm install sqlite3 (${msg.slice(0, 60)})`);
  setImmediate(() => {
    try {
      const { execFile } = require('child_process');
      const child = execFile(
        'npm',
        ['install', 'sqlite3@6', '--no-audit', '--no-fund'],
        {
          cwd: path.join(__dirname, '..'),
          timeout: 180000,
          env: { ...process.env, npm_config_update_notifier: 'false' }
        },
        (err) => {
          healInFlight = false;
          if (err) {
            logger.logAviso(`[sqlStore] npm install sqlite3 falhou: ${err.message}`);
            return;
          }
          try {
            Object.keys(require.cache).forEach((k) => {
              if (k.includes(`${path.sep}sqlite3${path.sep}`) || k.endsWith(`${path.sep}sqlite3`)) {
                delete require.cache[k];
              }
            });
            tryRequireSqlite3();
            getDb();
            logger.logInfo('[sqlStore] sqlite3 reinstalado + DB aberto');
            migrateAllUserData().catch((e) =>
              logger.logAviso(`[sqlStore] migrateAll: ${e.message}`)
            );
          } catch (e2) {
            logger.logAviso(`[sqlStore] apos install ainda falhou: ${e2.message}`);
          }
        }
      );
      child.unref?.();
    } catch (e) {
      healInFlight = false;
      logger.logAviso(`[sqlStore] heal spawn falhou: ${e.message}`);
    }
  });
}

function cacheKey(uid, gid) {
  return `${String(uid)}|${String(gid)}`;
}

function parseFlagValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(String(raw))) return Number(raw);
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

function parseKvValue(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

function getDb() {
  if (db) return db;
  let sqlite3;
  try {
    sqlite3 = tryRequireSqlite3().verbose();
  } catch (e) {
    scheduleSqliteHeal(e.message);
    throw e;
  }
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA synchronous = NORMAL');
    db.run(`CREATE TABLE IF NOT EXISTS group_flags (
      telegram_user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      flag TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (telegram_user_id, group_id, flag)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS kv_store (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS figurinha_posted (
      hash TEXT PRIMARY KEY,
      fonte TEXT,
      canal_jid TEXT,
      posted_at TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_figurinha_posted_at ON figurinha_posted(posted_at)`);
    db.run(`CREATE TABLE IF NOT EXISTS osint_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT,
      collected_at TEXT NOT NULL,
      confidence REAL,
      status TEXT NOT NULL,
      extra TEXT,
      owner_key TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_osint_evidence_run ON osint_evidence(run_id)`);
    db.run(`CREATE TABLE IF NOT EXISTS osint_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      value TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL,
      sources TEXT,
      UNIQUE(run_id, entity_type, value)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS osint_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_type TEXT NOT NULL,
      from_value TEXT NOT NULL,
      rel TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_value TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS osint_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      target TEXT NOT NULL,
      modules TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS group_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_key TEXT NOT NULL,
      invite_code TEXT NOT NULL,
      invite_url TEXT,
      source_jid TEXT,
      source_session TEXT,
      join_session TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      group_jid TEXT,
      group_name TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      joined_at TEXT,
      last_error TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_key, invite_code)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ginv_owner_status ON group_invites(owner_key, status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ginv_status_created ON group_invites(status, created_at)`);
    ensureBillingTables(db);
    ensureGroupTheftTables(db);
    ensureProtectionTables(db);
    ensureAdminDivTemplateTable(db);
    ensurePermissionTables(db);
    ensureBotUsersTable(db);
    ensureLojaTables(db);
    ensureGroupModTables(db);
    ensureDkTables(db);
  });
  ready = true;
  logger.logInfo(`[sqlStore] aberto ${DB_PATH}`);
  return db;
}

function initSqlStore() {
  try {
    getDb();
    setImmediate(() => {
      migrateAllUserData()
        .catch((e) => logger.logAviso(`[sqlStore] migrateAll: ${e.message}`))
        .finally(() => markKvWarmed());
      stripHostPurchaseData().catch((e) =>
        logger.logAviso(`[sqlStore] strip billing: ${e.message}`)
      );
      try {
        require('./adminDivTemplate').ensureTemplate().catch((e) =>
          logger.logAviso(`[sqlStore] admin_div_template: ${e.message}`)
        );
      } catch (e) {
        logger.logAviso(`[sqlStore] admin_div_template: ${e.message}`);
      }
      try {
        require('./groupModStore').warmBlockedCmds().catch((e) =>
          logger.logAviso(`[sqlStore] groupMod warm: ${e.message}`)
        );
      } catch (e) {
        logger.logAviso(`[sqlStore] groupMod warm: ${e.message}`);
      }
      try {
        require('./dkStore').consumeLinkPatch().catch((e) =>
          logger.logAviso(`[dkStore] link patch: ${e.message}`)
        );
      } catch (e) {
        logger.logAviso(`[dkStore] link patch: ${e.message}`);
      }
    });
    return true;
  } catch (e) {
    logger.logAviso(`[sqlStore] init falhou (continua JSON backup): ${e.message}`);
    ready = false;
    markKvWarmed();
    scheduleSqliteHeal(e.message);
    return false;
  }
}

function ensureLojaTables(database) {
  if (!database) return;
  database.run(`CREATE TABLE IF NOT EXISTS shop_group_text (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid, kind)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS shop_sorteio (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    names TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS shop_activity (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    member_jid TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid, member_jid)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS shop_hours (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    open_hm TEXT NOT NULL,
    close_hm TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_apply TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS shop_welcome_media (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid, kind)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS shop_ausente (
    owner_key TEXT NOT NULL,
    user_jid TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    since TEXT NOT NULL,
    PRIMARY KEY (owner_key, user_jid)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS shop_raffle (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    msg_id TEXT NOT NULL DEFAULT '',
    winners_n INTEGER NOT NULL DEFAULT 1,
    prompt TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid)
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_shop_act_group ON shop_activity(owner_key, group_jid, n)`);
}

function ensurePermissionTables(database) {
  if (!database) return;
  database.run(`CREATE TABLE IF NOT EXISTS command_registry (
    command TEXT PRIMARY KEY,
    min_role TEXT NOT NULL,
    category TEXT,
    is_targeted INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    updated_at TEXT NOT NULL
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS command_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    platform TEXT,
    command TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    target_role TEXT,
    group_jid TEXT,
    allowed INTEGER NOT NULL,
    deny_reason TEXT,
    created_at TEXT NOT NULL
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_command_audit_time ON command_audit(created_at DESC)`);
}

function upsertCommandRegistry(command, minRole, extra = {}) {
  if (!ready || !db) return;
  const name = String(command || '').toLowerCase().trim();
  if (!name) return;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO command_registry(command, min_role, category, is_targeted, enabled, notes, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(command) DO UPDATE SET
       min_role=excluded.min_role,
       category=excluded.category,
       is_targeted=excluded.is_targeted,
       notes=excluded.notes,
       updated_at=excluded.updated_at`,
    [
      name,
      String(minRole || 'owner'),
      String(extra.category || ''),
      extra.isTargeted ? 1 : 0,
      extra.enabled === false ? 0 : 1,
      String(extra.notes || ''),
      now
    ]
  );
}

const botUserCache = new Map();

function botUserCacheKey(platform, userKey) {
  return `${String(platform || '')}|${String(userKey || '')}`;
}

function ensureBotUsersTable(database) {
  const d = database || db;
  if (!d) return;
  d.run(`CREATE TABLE IF NOT EXISTS bot_users (
    platform TEXT NOT NULL,
    user_key TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    push_name TEXT NOT NULL DEFAULT '',
    banned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (platform, user_key)
  )`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_bot_users_seen ON bot_users(last_seen_at DESC)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_bot_users_banned ON bot_users(banned)`);
  d.all(`SELECT * FROM bot_users`, [], (err, rows) => {
    if (err || !rows) return;
    for (const r of rows) {
      botUserCache.set(botUserCacheKey(r.platform, r.user_key), packBotUserRow(r));
    }
  });
}

function upsertBotUser(row = {}) {
  const platform = String(row.platform || 'telegram');
  const userKey = String(row.user_key || '').trim();
  if (!userKey) return false;
  const now = new Date().toISOString();
  const packed = {
    platform,
    user_key: userKey,
    username: String(row.username || ''),
    first_name: String(row.first_name || ''),
    last_name: String(row.last_name || ''),
    push_name: String(row.push_name || ''),
    banned: row.banned ? 1 : 0,
    created_at: String(row.created_at || now),
    last_seen_at: String(row.last_seen_at || now)
  };
  botUserCache.set(botUserCacheKey(platform, userKey), packed);
  if (!ready || !db) {
    try { getDb(); } catch (_) { return true; }
  }
  try { ensureBotUsersTable(db); } catch (_) { /* */ }
  db.run(
    `INSERT INTO bot_users(platform, user_key, username, first_name, last_name, push_name, banned, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform, user_key) DO UPDATE SET
       username=CASE WHEN excluded.username='' THEN bot_users.username ELSE excluded.username END,
       first_name=CASE WHEN excluded.first_name='' THEN bot_users.first_name ELSE excluded.first_name END,
       last_name=CASE WHEN excluded.last_name='' THEN bot_users.last_name ELSE excluded.last_name END,
       push_name=CASE WHEN excluded.push_name='' THEN bot_users.push_name ELSE excluded.push_name END,
       banned=excluded.banned,
       last_seen_at=CASE
         WHEN excluded.last_seen_at='' THEN bot_users.last_seen_at
         WHEN bot_users.last_seen_at='' THEN excluded.last_seen_at
         WHEN excluded.last_seen_at > bot_users.last_seen_at THEN excluded.last_seen_at
         ELSE bot_users.last_seen_at
       END`,
    [
      packed.platform,
      packed.user_key,
      packed.username,
      packed.first_name,
      packed.last_name,
      packed.push_name,
      packed.banned,
      packed.created_at,
      packed.last_seen_at
    ]
  );
  return true;
}

function packBotUserRow(row) {
  return {
    platform: String(row.platform || 'telegram'),
    user_key: String(row.user_key || ''),
    username: String(row.username || ''),
    first_name: String(row.first_name || ''),
    last_name: String(row.last_name || ''),
    push_name: String(row.push_name || ''),
    banned: row.banned ? 1 : 0,
    created_at: String(row.created_at || ''),
    last_seen_at: String(row.last_seen_at || '')
  };
}

function getBotUser(platform, userKey) {
  const k = botUserCacheKey(platform, userKey);
  if (botUserCache.has(k)) return { ...botUserCache.get(k) };
  return null;
}

function listBotUsers() {
  const out = [];
  for (const row of botUserCache.values()) out.push({ ...row });
  return out;
}

async function listBotUsersAsync() {
  try {
    ensureBotUsersTable(getDb());
    const rows = await allAsync('SELECT * FROM bot_users ORDER BY last_seen_at DESC');
    const packed = [];
    for (const r of rows || []) {
      const p = packBotUserRow(r);
      if (!p.user_key) continue;
      botUserCache.set(botUserCacheKey(p.platform, p.user_key), p);
      packed.push(p);
    }
    if (packed.length) return packed;
  } catch (_) { /* */ }
  return listBotUsers();
}

function insertCommandAudit(row = {}) {
  if (!ready || !db) return;
  db.run(
    `INSERT INTO command_audit
      (session_id, platform, command, actor_role, target_role, group_jid, allowed, deny_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      String(row.sessionId || ''),
      String(row.platform || 'whatsapp'),
      String(row.command || ''),
      String(row.actorRole || 'user'),
      row.targetRole ? String(row.targetRole) : null,
      row.groupJid ? String(row.groupJid) : null,
      row.allowed ? 1 : 0,
      row.denyReason ? String(row.denyReason) : null,
      new Date().toISOString()
    ]
  );
}

function ensureAdminDivTemplateTable(database) {
  if (!database) return;
  database.run(`CREATE TABLE IF NOT EXISTS admin_div_template (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_min INTEGER NOT NULL DEFAULT 30,
    last_at INTEGER NOT NULL DEFAULT 0,
    slots_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT '',
    updated_by TEXT
  )`);
}

function ensureBillingTables(database) {
  if (!database) return;
  database.run(`CREATE TABLE IF NOT EXISTS billing_plan (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    duration_days INTEGER NOT NULL,
    quota_tier TEXT NOT NULL DEFAULT 'entry',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_customer (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_user TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(platform, platform_user)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_order (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL,
    mp_preference_id TEXT,
    mp_payment_id TEXT,
    session_owner TEXT,
    chat_jid TEXT,
    platform TEXT,
    poll_count INTEGER NOT NULL DEFAULT 0,
    tenant_id TEXT,
    session_owner_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_bill_order_status ON billing_order(status)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_bill_order_pay ON billing_order(mp_payment_id)`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_payment (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    mp_payment_id TEXT,
    status TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(mp_payment_id)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_subscription (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    expires_at TEXT,
    last_order_id TEXT
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_bill_sub_cust ON billing_subscription(customer_id, status)`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_entitlement (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'vip',
    status TEXT NOT NULL,
    quota_tier TEXT,
    product_tier TEXT,
    expires_at TEXT,
    session_owner TEXT,
    tenant_id TEXT,
    session_owner_id TEXT,
    UNIQUE(customer_id, kind)
  )`);
  database.run(`ALTER TABLE billing_entitlement ADD COLUMN product_tier TEXT`, () => {});
  database.run(`ALTER TABLE billing_entitlement ADD COLUMN tenant_id TEXT`, () => {});
  database.run(`ALTER TABLE billing_entitlement ADD COLUMN session_owner_id TEXT`, () => {});
  database.run(`ALTER TABLE billing_order ADD COLUMN tenant_id TEXT`, () => {});
  database.run(`ALTER TABLE billing_order ADD COLUMN session_owner_id TEXT`, () => {});
  database.run(`CREATE INDEX IF NOT EXISTS idx_bill_ent_exp ON billing_entitlement(status, expires_at)`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_delivery (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    delivered_at TEXT
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_webhook_event (
    id TEXT PRIMARY KEY,
    mp_payment_id TEXT NOT NULL UNIQUE,
    processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_ticket (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    body TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_identity (
    platform TEXT NOT NULL,
    platform_user TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (platform, platform_user)
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_bill_ident_cust ON billing_identity(customer_id)`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_link_code (
    code TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_affiliate (
    code TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    conversions INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_bill_aff_cust ON billing_affiliate(customer_id)`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_referral (
    customer_id TEXT PRIMARY KEY,
    referrer_code TEXT NOT NULL,
    converted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS billing_affiliate_ledger (
    id TEXT PRIMARY KEY,
    affiliate_code TEXT NOT NULL,
    referrer_customer_id TEXT NOT NULL,
    buyer_customer_id TEXT NOT NULL,
    order_id TEXT,
    plan_id TEXT,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    paid_at TEXT
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_bill_aff_led ON billing_affiliate_ledger(referrer_customer_id, status)`);
}

const BILLING_PII_TABLES = [
  'billing_order',
  'billing_payment',
  'billing_customer',
  'billing_subscription',
  'billing_entitlement',
  'billing_delivery',
  'billing_webhook_event',
  'billing_ticket',
  'billing_identity',
  'billing_link_code'
];

/**
 * Host sem token de pagamento: apaga pedidos/clientes/PIX.
 * Catalogo billing_plan (precos) fica. Marker evita repetir.
 * Nao toca divulgacao.json nem sessoes.
 */
async function stripHostPurchaseData() {
  const ownerOnly = /^(1|true|on|yes)$/i.test(String(process.env.HANORK_OWNER_ONLY || '').trim());
  const force = /^(1|true|on|yes)$/i.test(String(process.env.HANORK_STRIP_HOST_BILLING || '').trim());
  if (!ownerOnly && !force) return { skipped: true };
  if (!ready || !db) return { skipped: true, reason: 'no-db' };
  const marker = path.join(path.dirname(DB_PATH), '.billing-stripped');
  if (fs.existsSync(marker) && !force) return { skipped: true, reason: 'already' };
  let n = 0;
  for (const t of BILLING_PII_TABLES) {
    try {
      const r = await runAsync(`DELETE FROM ${t}`);
      n += Number(r && r.changes) || 0;
    } catch (_) { /* tabela pode nao existir */ }
  }
  try {
    fs.writeFileSync(marker, new Date().toISOString() + '\n');
  } catch (_) { /* */ }
  logger.logAviso(`[sqlStore] compra/PII removidos desta host rows~${n} (planos ok)`);
  return { ok: true, rows: n };
}

function ensureGroupModTables(database) {
  if (!database) return;
  database.run(`CREATE TABLE IF NOT EXISTS group_temp_ban (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    member_jid TEXT NOT NULL,
    restore_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid, member_jid)
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_gtb_restore ON group_temp_ban(restore_at)`);
  database.run(`CREATE TABLE IF NOT EXISTS group_once_schedule (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    action TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, group_jid, action)
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_gos_fire ON group_once_schedule(fire_at)`);
  database.run(`CREATE TABLE IF NOT EXISTS session_blocked_cmds (
    owner_key TEXT NOT NULL,
    cmd TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_key, cmd)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS group_join_auto (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    cooldown_sec INTEGER NOT NULL DEFAULT 10,
    last_apply INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_key, group_jid)
  )`);
}

function ensureDkTables(database) {
  let db = database;
  if (!db) {
    try { db = getDb(); } catch (_) { return; }
  }
  if (!db) return;
  db.run(`CREATE TABLE IF NOT EXISTS dk_config (
    owner_key TEXT NOT NULL PRIMARY KEY,
    pay_text TEXT NOT NULL DEFAULT '',
    repeat_text TEXT NOT NULL DEFAULT '',
    repeat_file TEXT,
    repeat_tipo TEXT,
    repeat_mime TEXT,
    qtd INTEGER NOT NULL DEFAULT 5,
    group_link TEXT NOT NULL DEFAULT '',
    texto TEXT NOT NULL DEFAULT '',
    media_file TEXT,
    media_tipo TEXT,
    media_mime TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.run(`ALTER TABLE dk_config ADD COLUMN pay_text TEXT NOT NULL DEFAULT ''`, () => {});
  db.run(`ALTER TABLE dk_config ADD COLUMN repeat_text TEXT NOT NULL DEFAULT ''`, () => {});
  db.run(`ALTER TABLE dk_config ADD COLUMN repeat_file TEXT`, () => {});
  db.run(`ALTER TABLE dk_config ADD COLUMN repeat_tipo TEXT`, () => {});
  db.run(`ALTER TABLE dk_config ADD COLUMN repeat_mime TEXT`, () => {});
  db.run(`ALTER TABLE dk_config ADD COLUMN group_link TEXT NOT NULL DEFAULT ''`, () => {});
  db.run(
    `UPDATE dk_config SET pay_text = texto
     WHERE (pay_text IS NULL OR pay_text = '') AND texto IS NOT NULL AND texto != ''`,
    () => {}
  );
  db.run(
    `UPDATE dk_config SET repeat_text = texto
     WHERE (repeat_text IS NULL OR repeat_text = '') AND texto IS NOT NULL AND texto != ''`,
    () => {}
  );
  db.run(
    `UPDATE dk_config SET repeat_file = media_file
     WHERE (repeat_file IS NULL OR repeat_file = '') AND media_file IS NOT NULL AND media_file != ''`,
    () => {}
  );
  db.run(
    `UPDATE dk_config SET repeat_tipo = media_tipo
     WHERE (repeat_tipo IS NULL OR repeat_tipo = '') AND media_tipo IS NOT NULL`,
    () => {}
  );
  db.run(
    `UPDATE dk_config SET repeat_mime = media_mime
     WHERE (repeat_mime IS NULL OR repeat_mime = '') AND media_mime IS NOT NULL`,
    () => {}
  );
  db.run(`CREATE TABLE IF NOT EXISTS dk_status_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    tipo TEXT,
    mime TEXT,
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dk_status_owner ON dk_status_media(owner_key)`, () => {});
}

function ensureGroupTheftTables(database) {
  if (!database) return;
  database.run(`CREATE TABLE IF NOT EXISTS group_security (
    group_jid TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    native_owner_jid TEXT,
    registered_owner_jid TEXT,
    protection_enabled INTEGER NOT NULL DEFAULT 0,
    audit_enabled INTEGER NOT NULL DEFAULT 0,
    revert_enabled INTEGER NOT NULL DEFAULT 1,
    alert_enabled INTEGER NOT NULL DEFAULT 0,
    alert_dest TEXT NOT NULL DEFAULT 'silent',
    attack_detect INTEGER NOT NULL DEFAULT 1,
    threshold INTEGER NOT NULL DEFAULT 5,
    window_ms INTEGER NOT NULL DEFAULT 10000,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (group_jid, owner_key)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS group_trusted_admins (
    group_jid TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    jid TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'OWNER_TRUSTED',
    added_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (group_jid, owner_key, jid)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS group_security_events (
    id TEXT PRIMARY KEY,
    group_jid TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    actor_jid TEXT,
    target_jid TEXT,
    action TEXT NOT NULL,
    actor_role TEXT,
    target_role TEXT,
    detected INTEGER NOT NULL DEFAULT 1,
    reverted INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    risk INTEGER NOT NULL DEFAULT 0,
    risk_class TEXT,
    created_at TEXT NOT NULL
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_gse_group ON group_security_events(group_jid, created_at)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_gse_owner_created ON group_security_events(owner_key, created_at)`);
  database.run(`CREATE TABLE IF NOT EXISTS group_owner_transfers (
    id TEXT PRIMARY KEY,
    group_jid TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    previous_owner TEXT,
    new_owner TEXT,
    transferred_by TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  )`);
}

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      getDb().run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve(this);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      getDb().all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      getDb().get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function upsertGroupFlag(telegramUserId, groupId, flag, value) {
  upsertGroupFlagAsync(telegramUserId, groupId, flag, value).catch((e) =>
    logger.logAviso(`[sqlStore] upsert flag: ${e.message}`)
  );
  return true;
}

async function upsertGroupFlagAsync(telegramUserId, groupId, flag, value) {
  const uid = String(telegramUserId || '');
  const gid = String(groupId || '');
  const f = String(flag || '');
  if (!uid || !gid || !f) return false;
  if (!ready) getDb();
  const v = typeof value === 'boolean' || typeof value === 'number'
    ? String(value)
    : JSON.stringify(value);
  const ts = new Date().toISOString();

  const k = cacheKey(uid, gid);
  const bag = flagCache.get(k) || {};
  bag[f] = typeof value === 'boolean' || typeof value === 'number'
    ? value
    : parseFlagValue(v);
  flagCache.set(k, bag);

  await runAsync(
    `INSERT INTO group_flags (telegram_user_id, group_id, flag, value, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(telegram_user_id, group_id, flag)
     DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [uid, gid, f, v, ts]
  );
  try {
    const pg = require('../services/pgClient');
    if (pg.isDualWrite()) {
      Promise.resolve(
        pg.upsert(
          'group_flags',
          {
            telegram_user_id: uid,
            group_id: gid,
            flag: f,
            value: v,
            updated_at: ts
          },
          ['telegram_user_id', 'group_id', 'flag']
        )
      ).catch(() => {});
    }
  } catch (_) { /* pg opcional */ }
  return true;
}

async function loadGroupFlags(telegramUserId, groupId) {
  const rows = await allAsync(
    `SELECT flag, value FROM group_flags WHERE telegram_user_id=? AND group_id=?`,
    [String(telegramUserId), String(groupId)]
  );
  const out = {};
  for (const r of rows) out[r.flag] = parseFlagValue(r.value);
  flagCache.set(cacheKey(telegramUserId, groupId), out);
  return out;
}

function getCachedGroupFlags(telegramUserId, groupId) {
  const hit = flagCache.get(cacheKey(telegramUserId, groupId));
  return hit ? { ...hit } : null;
}

function ensureProtectionTables(database) {
  if (!database) return;
  database.run(`CREATE TABLE IF NOT EXISTS group_protections (
    telegram_user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    flags_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (telegram_user_id, group_id)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS group_protection_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    flag TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    actor_id TEXT,
    created_at TEXT NOT NULL
  )`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_prot_changes_gid ON group_protection_changes(telegram_user_id, group_id)`);
  migrateAntirouboQuiet(database);
}

/** One-shot: anti-roubo deixa de postar no grupo (default era ON). Nao reexecuta se a chave existir. */
function migrateAntirouboQuiet(database) {
  if (!database) return;
  database.run(
    `UPDATE group_security SET alert_enabled=0, alert_dest='silent', protection_enabled=0, audit_enabled=0
     WHERE NOT EXISTS (SELECT 1 FROM kv_store WHERE scope='system' AND key='antiroubo_quiet_v1')`
  );
  database.run(
    `UPDATE group_protections SET flags_json = REPLACE(REPLACE(REPLACE(
        IFNULL(flags_json,'{}'),
        '"antiadmin":true', '"antiadmin":false'),
        '"antiadminAlert":true', '"antiadminAlert":false'),
        '"antiadminAudit":true', '"antiadminAudit":false')
     WHERE NOT EXISTS (SELECT 1 FROM kv_store WHERE scope='system' AND key='antiroubo_quiet_v1')`
  );
  const ts = new Date().toISOString();
  database.run(
    `INSERT OR IGNORE INTO kv_store (scope,key,value,updated_at) VALUES (?,?,?,?)`,
    ['system', 'antiroubo_quiet_v1', JSON.stringify({ at: ts }), ts]
  );
}

const protBlobCache = new Map();

function listCachedGroupProtections(telegramUserId) {
  const uid = String(telegramUserId || '');
  const prefix = `${uid}|`;
  const out = [];
  for (const [k, blob] of protBlobCache) {
    if (!String(k).startsWith(prefix)) continue;
    out.push({ groupId: String(k).slice(prefix.length), flags: { ...(blob || {}) } });
  }
  return out;
}

function getCachedGroupProtections(telegramUserId, groupId) {
  const k = cacheKey(telegramUserId, groupId);
  const blob = protBlobCache.get(k);
  if (blob && typeof blob === 'object') return { ...blob };
  const eav = getCachedGroupFlags(telegramUserId, groupId);
  return eav ? { ...eav } : null;
}

async function upsertGroupProtectionsAsync(telegramUserId, groupId, stored) {
  const uid = String(telegramUserId || '');
  const gid = String(groupId || '');
  if (!uid || !gid || uid === 'undefined' || uid === 'null') return false;
  const flags = stored && typeof stored === 'object' ? stored : {};
  const k = cacheKey(uid, gid);
  protBlobCache.set(k, { ...flags });
  flagCache.set(k, { ...(flagCache.get(k) || {}), ...flags });
  if (!ready) {
    try { getDb(); } catch (_) { return true; }
  }
  const ts = new Date().toISOString();
  try {
    await runAsync(
      `INSERT INTO group_protections (telegram_user_id, group_id, flags_json, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(telegram_user_id, group_id)
       DO UPDATE SET flags_json=excluded.flags_json, updated_at=excluded.updated_at`,
      [uid, gid, JSON.stringify(flags), ts]
    );
  } catch (e) {
    logger.logAviso(`[sqlStore] upsert protections: ${e.message}`);
  }
  return true;
}

async function insertProtectionChange(row = {}) {
  const uid = String(row.telegramUserId || '');
  const gid = String(row.groupId || '');
  const flag = String(row.flag || '');
  if (!uid || !gid || !flag) return false;
  if (!ready) {
    try { getDb(); } catch (_) { return false; }
  }
  try {
    await runAsync(
      `INSERT INTO group_protection_changes
        (telegram_user_id, group_id, flag, old_value, new_value, actor_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        uid,
        gid,
        flag,
        String(row.oldValue == null ? '' : row.oldValue),
        String(row.newValue == null ? '' : row.newValue),
        String(row.actorId || ''),
        new Date().toISOString()
      ]
    );
  } catch (e) {
    logger.logAviso(`[sqlStore] protection change: ${e.message}`);
  }
  return true;
}

async function migrateModerationFromJson(telegramUserId, moderationConfig) {
  const flagsMap = moderationConfig?.groupFlags || {};
  let n = 0;
  for (const [gid, flags] of Object.entries(flagsMap)) {
    for (const [k, v] of Object.entries(flags || {})) {
      upsertGroupFlag(telegramUserId, gid, k, v);
      n++;
    }
  }
  return n;
}

function slimDivulgacao(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const slim = { ...cfg };
  if (slim.midiaFile) {
    slim.midia = null;
  } else if (slim.midia && (Buffer.isBuffer(slim.midia) || (typeof slim.midia === 'string' && slim.midia.length > 400))) {
    slim.midia = slim.midiaTipo ? `[file:${slim.midiaTipo}]` : '[omitted]';
  }
  if (slim.cta && typeof slim.cta === 'object') {
    if (slim.cta.midiaFile) {
      slim.cta = { ...slim.cta, midia: null };
    } else if (slim.cta.midia &&
        (Buffer.isBuffer(slim.cta.midia) || (typeof slim.cta.midia === 'string' && slim.cta.midia.length > 400))) {
      slim.cta = {
        ...slim.cta,
        midia: slim.cta.midiaTipo ? `[file:${slim.cta.midiaTipo}]` : '[omitted]'
      };
    }
  }
  return slim;
}

function upsertKv(scope, key, value) {
  const sc = String(scope || '');
  const k = String(key || '');
  if (!sc || !k || k === 'undefined' || k === 'null') return false;
  const parsed = value;
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  const ts = new Date().toISOString();
  kvCache.set(kvKey(sc, k), typeof parsed === 'string' ? parseKvValue(parsed) : parsed);
  try {
    if (!ready) getDb();
  } catch (e) {
    if (!cacheOnlyLogged) {
      cacheOnlyLogged = true;
      logger.logAviso(`[sqlStore] upsert kv (so cache): ${e.message}`);
    }
    return true;
  }
  runAsync(
    `INSERT INTO kv_store (scope, key, value, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(scope, key)
     DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [sc, k, v, ts]
  ).catch((e) => logger.logAviso(`[sqlStore] upsert kv: ${e.message}`));
  // Dual-write PG (nao bloqueia; SQLite primario)
  try {
    const pg = require('../services/pgClient');
    if (pg.isDualWrite()) {
      Promise.resolve(pg.upsert('kv_store', { scope: sc, key: k, value: v, updated_at: ts }, ['scope', 'key'])).catch(() => {});
    }
  } catch (_) { /* pg opcional */ }
  return true;
}

async function upsertKvAsync(scope, key, value) {
  const sc = String(scope || '');
  const k = String(key || '');
  if (!sc || !k) return false;
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  const ts = new Date().toISOString();
  kvCache.set(kvKey(sc, k), typeof value === 'string' ? parseKvValue(value) : value);
  if (!ready) getDb();
  await runAsync(
    `INSERT INTO kv_store (scope, key, value, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(scope, key)
     DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [sc, k, v, ts]
  );
  try {
    const pg = require('../services/pgClient');
    if (pg.isDualWrite()) {
      await pg.upsert('kv_store', { scope: sc, key: k, value: v, updated_at: ts }, ['scope', 'key']);
    }
  } catch (_) { /* pg opcional */ }
  return true;
}

function getKv(scope, key) {
  return new Promise(async (resolve, reject) => {
    try {
      // Cutover: tenta PG primeiro; fallback SQLite se vazio/erro
      try {
        const pg = require('../services/pgClient');
        if (pg.isReadFromPg()) {
          const raw = await pg.getKv(scope, key);
          if (raw != null) {
            const parsed = parseKvValue(raw);
            if (parsed != null) kvCache.set(kvKey(scope, key), parsed);
            return resolve(parsed);
          }
        }
      } catch (_) { /* fallback sqlite */ }
      getDb().get(
        `SELECT value FROM kv_store WHERE scope=? AND key=?`,
        [String(scope), String(key)],
        (err, row) => {
          if (err) reject(err);
          else {
            const parsed = row ? parseKvValue(row.value) : null;
            if (parsed != null) kvCache.set(kvKey(scope, key), parsed);
            resolve(parsed);
          }
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

/** Leitura sync do cache SQL (apos migrate/upsert) */
function getCachedKv(scope, key) {
  if (!kvCache.has(kvKey(scope, key))) return null;
  const v = kvCache.get(kvKey(scope, key));
  if (Array.isArray(v)) return v.slice();
  if (v && typeof v === 'object') return { ...v };
  return v;
}

async function warmKvCache() {
  if (!ready) return 0;
  const rows = await allAsync(`SELECT scope, key, value FROM kv_store`);
  let n = 0;
  for (const r of rows) {
    const k = kvKey(r.scope, r.key);
    // Nao sobrescrever upserts recentes em memoria (evita race com migrate)
    if (kvCache.has(k)) continue;
    kvCache.set(k, parseKvValue(r.value));
    n++;
  }
  return n;
}

function mirrorModerationBlob(telegramUserId, moderationConfig) {
  return upsertKv('moderation', String(telegramUserId), moderationConfig || {});
}

/** Migra JSON → SQL (flags + config + divulgacao + bans) e esquenta cache */
async function migrateAllUserData() {
  const usersDir = path.join(__dirname, '../data/users');
  let totalFlags = 0;
  let totalCfg = 0;

  // bans + registry + db blobs
  try {
    const bansPath = path.join(__dirname, '../banned.json');
    if (fs.existsSync(bansPath)) {
      const list = JSON.parse(fs.readFileSync(bansPath, 'utf8'));
      upsertKv('bans', 'global', Array.isArray(list) ? list : []);
    }
  } catch (e) {
    logger.logAviso(`[sqlStore] migrate bans: ${e.message}`);
  }
  try {
    const regPath = path.join(__dirname, '../data/system/registry.json');
    if (fs.existsSync(regPath)) {
      upsertKv('system', 'registry', JSON.parse(fs.readFileSync(regPath, 'utf8')));
    }
  } catch (e) {
    logger.logAviso(`[sqlStore] migrate registry: ${e.message}`);
  }
  try {
    for (const [scopeKey, file] of [
      ['clients', path.join(__dirname, '../data/clients.json')],
      ['sessions', path.join(__dirname, '../data/sessions.json')],
      ['usage_stats', path.join(__dirname, '../data/usage_stats.json')]
    ]) {
      if (fs.existsSync(file)) {
        upsertKv('db', scopeKey, JSON.parse(fs.readFileSync(file, 'utf8')));
      }
    }
  } catch (e) {
    logger.logAviso(`[sqlStore] migrate db: ${e.message}`);
  }

  if (fs.existsSync(usersDir)) {
    for (const uid of fs.readdirSync(usersDir)) {
      try {
        const cfgPath = path.join(usersDir, uid, 'config', 'config.json');
        if (fs.existsSync(cfgPath)) {
          const day = new Date().toISOString().slice(0, 10);
          const bakPath = path.join(path.dirname(cfgPath), `config.json.sqlbak.${day}`);
          if (!fs.existsSync(bakPath)) {
            try { fs.copyFileSync(cfgPath, bakPath); } catch (_) { /* ignore */ }
          }
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          totalFlags += await migrateModerationFromJson(uid, cfg.moderation || {});
          upsertKv('config', String(uid), cfg);
          upsertKv('moderation', String(uid), cfg.moderation || {});
          totalCfg++;
        }
        const divPath = path.join(usersDir, uid, 'config', 'divulgacao.json');
        if (fs.existsSync(divPath)) {
          const div = JSON.parse(fs.readFileSync(divPath, 'utf8'));
          upsertKv('divulgacao', String(uid), slimDivulgacao(div));
        }
        const metaPath = path.join(usersDir, uid, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          upsertKv('user_meta', String(uid), meta);
        }
      } catch (e) {
        logger.logAviso(`[sqlStore] migrate user ${uid}: ${e.message}`);
      }
    }
  }

  const warmed = await warmKvCache().catch(() => 0);
  markKvWarmed();
  logger.logInfo(
    `[sqlStore] migrate OK flags=${totalFlags} configs=${totalCfg} kvCache=${warmed}`
  );
  return totalFlags;
}

// alias legado
const migrateAllUsersGroupFlags = migrateAllUserData;

/** Copia o SQLite pra .bak (heartbeat). Nao loga caminho. */
function snapshotBackup() {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(DB_PATH)) return resolve(false);
      const dest = `${DB_PATH}.bak`;
      const tmp = `${dest}.tmp`;
      fs.copyFileSync(DB_PATH, tmp);
      try {
        const wal = `${DB_PATH}-wal`;
        if (fs.existsSync(wal)) fs.copyFileSync(wal, `${dest}-wal`);
      } catch (_) { /* wal opcional */ }
      fs.renameSync(tmp, dest);
      resolve(true);
    } catch (e) {
      logger.logAviso(`[SQL] snapshotBackup: ${e.message}`);
      resolve(false);
    }
  });
}

module.exports = {
  initSqlStore,
  upsertGroupFlag,
  upsertGroupFlagAsync,
  loadGroupFlags,
  getCachedGroupFlags,
  getCachedGroupProtections,
  listCachedGroupProtections,
  upsertGroupProtectionsAsync,
  insertProtectionChange,
  ensureProtectionTables,
  upsertKv,
  upsertKvAsync,
  getKv,
  getCachedKv,
  isKvWarmed,
  markKvWarmed,
  warmKvCache,
  mirrorModerationBlob,
  migrateModerationFromJson,
  migrateAllUsersGroupFlags,
  migrateAllUserData,
  slimDivulgacao,
  runAsync,
  allAsync,
  getAsync,
  ensureBillingTables,
  stripHostPurchaseData,
  BILLING_PII_TABLES,
  ensureAdminDivTemplateTable,
  ensurePermissionTables,
  ensureBotUsersTable,
  upsertBotUser,
  getBotUser,
  listBotUsers,
  listBotUsersAsync,
  ensureDkTables,
  upsertCommandRegistry,
  insertCommandAudit,
  ensureGroupTheftTables,
  ensureGroupModTables,
  ensureLojaTables,
  isReady: () => ready,
  DB_PATH,
  snapshotBackup
};
