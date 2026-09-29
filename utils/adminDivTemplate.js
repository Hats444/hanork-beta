'use strict';
/**
 * Registro unico SQL (admin_div_template) da divulgacao de admin.
 * Preco/vantagens/prova/link NUNCA ficam fixos no seed — so entram no assemble.
 * Fonte de preco: store.listPlans()/getPlan(). Fonte de vantagens: CAPABILITIES.
 * Cliente final nao passa daqui (isAdmin).
 */

const fs = require('fs');
const path = require('path');
const { isAdmin } = require('./userManager');
const { CAPABILITIES } = require('./productOffer');

const ROW_ID = 1;
const TEMPLATE_VERSION = 3;
const SITE_LABEL = 'Ver o site';

const PLACE_AFF = '{{affiliateLink}}';
const PLACE_INVITE = '{{groupInviteLink}}';

/** Resultado, nao feature crua. Chave = texto exato de CAPABILITIES. */
const CAPABILITY_OUTCOMES = {
  'Downloads (YouTube, TikTok, Instagram, Facebook, Spotify, Kwai...)':
    'O cliente pede um video — baixa no mesmo chip, sem outro app',
  'Hanork API (~750 comandos: logos, animes, IAs, pesquisas...)':
    'Logo, anime, IA e pesquisa no mesmo bot — voce nao monta outra stack',
  'Figurinhas e midia (sticker, toimg, attp...)':
    'Figurinha e midia saem do mesmo numero, sem voce virar estudio',
  'Consultas e ferramentas web/IA':
    'Consulta e ferramenta web no mesmo chip, na hora que o cliente pede',
  'Divulgacao em massa (grupos / close friends)':
    'A DIV segue sozinha (CTA, status, cobranca) — voce nao fica colando texto',
  'Protecao de grupo (antilink, antiflood, antiataque...)':
    'Anti-roubo, antilink, anti-fake, anti-PV: o sistema barra, voce nao vigia',
  'Menus com botoes interativos no WhatsApp':
    'O cliente clica no botao no Zap em vez de decifrar lista de comando',
  'Evolucao de uso (XP, niveis, tips A/B, quotas VIP)':
    'Quota e nivel de uso andam com o plano — sem planilha paralela',
  'Multi-sessao via Telegram (parear e controlar)':
    'Pareia o chip e controla pelo Telegram, sem viver no celular da operacao',
  'Host / admin / config (dono)':
    'Config de dono no mesmo bot — nao e painel de terceiro',
  'Versao FREE no Telegram: so logar e usar':
    'Da pra logar no Telegram e ver o bot antes de casar com o zip'
};

let cache = null;
let ensureP = null;

function invitePlaceholder() {
  try {
    return require('./divulgacaoInviteLink').PLACEHOLDER || PLACE_INVITE;
  } catch (_) {
    return PLACE_INVITE;
  }
}

function siteUrl() {
  const env = String(process.env.HANORK_SITE_URL || '').trim();
  if (/^https?:\/\//i.test(env)) return env.replace(/\/+$/, '');
  return 'https://hats444.github.io';
}

function demoInviteUrl() {
  const env = String(process.env.HANORK_DEMO_INVITE_URL || '').trim();
  if (/^https?:\/\//i.test(env)) return env.replace(/\/+$/, '');
  return '';
}

function demoOrSiteUrl() {
  return demoInviteUrl() || siteUrl();
}

function demoOrSiteLabel() {
  return demoInviteUrl() ? 'Ver o grupo demo' : SITE_LABEL;
}

function pickLine(val, salt) {
  if (Array.isArray(val)) {
    const list = val.map((x) => String(x || '').trim()).filter(Boolean);
    if (!list.length) return '';
    const hour = Math.floor(Date.now() / (15 * 60 * 1000));
    let h = 0;
    const key = String(salt || '') + ':' + hour;
    for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
    return list[h % list.length];
  }
  return String(val || '').trim();
}

function formatBrlCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n < 0) return '';
  const reais = n / 100;
  if (Math.abs(reais - Math.round(reais)) < 0.001) return 'R$' + Math.round(reais);
  return 'R$' + reais.toFixed(2).replace('.', ',');
}

function blocks(spec) {
  return {
    headline: spec.headline,
    pain: spec.pain,
    value: spec.value,
    authority: spec.authority,
    objection: spec.objection,
    urgency: spec.urgency,
    guarantee: spec.guarantee,
    ctaLine: spec.ctaLine
  };
}

function saleSlot(label, spec) {
  return {
    kind: 'sale',
    label: String(label || 'Comprar no Telegram').slice(0, 20),
    urlToken: 'affiliate',
    blocks: blocks(spec)
  };
}

function inviteSlot(label, spec) {
  return {
    kind: 'invite',
    label: String(label || 'Entrar').slice(0, 20),
    urlToken: 'invite',
    blocks: blocks(spec)
  };
}

/**
 * Skeleton / seed: tom do CTA custom do admin 8374207443 no slot CTA 1.
 * Sem preco, sem link, sem vantagem solta — so estrutura.
 */
function skeletonSlots() {
  return {
    version: TEMPLATE_VERSION,
    cta: {
      1: saleSlot('Abrir Telegram', {
        headline: [
          'Bot que segura o grupo da loja e manda o PIX/cardapio sozinho.',
          'Seu grupo de venda anda sozinho? Ou voce ainda vigia link um por um?',
          'Antilink, boas-vindas e cobranca no grupo — voce nao fica de plantao.'
        ],
        pain: [
          'Dono de loja, rifa ou comunidade vira seguranca 24h. Link, flood, Pix perdido.',
          'Voce some 10 minutos e o grupo esfria.',
          'Grupo de venda sem protecao vira plantao.'
        ],
        value: [
          'Paga no Telegram, conecta o numero, toca Proteger grupo. O grupo segura sozinho.',
          'Teste 1 dia. Se curtir, Pro da loja: protecao + divulgacao.',
          'Um bot no seu WhatsApp. Sem lista de 40 vantagens.'
        ],
        authority: [
          'Roda no seu WhatsApp, no seu numero.',
          'PIX no Telegram: pagou, conectou, usou.',
          'Feito pra dono de grupo. Nao pra fã de comando.'
        ],
        objection: [
          'Nao precisa entender de tecnico. Pagou, conectou, usou.',
          'Day pass pra testar o grupo. Pro se ficar.',
          'O segundo botao mostra o grupo demo ou o site.'
        ],
        urgency: [
          'Teste 1 dia: {{priceDaypass}}. Plano da loja: Pro {{priceProM}}/mes.',
          'Day pass {{priceDaypass}}. Pro {{priceProM}} no Telegram.',
          'Comeca pelo dia. Loja de verdade e o Pro.'
        ],
        guarantee: [
          'PIX no Telegram: pagou, liberou. Duvida no mesmo bot.',
          'Testa um dia no seu grupo. Se nao for, nao casa.',
          'Pagamento no Telegram. Sem enrolacao.'
        ],
        ctaLine: [
          'O primeiro botao abre o Telegram. O segundo e o demo ou o site.',
          'Clica no botao. Nao precisa copiar link.',
          'Telegram pra pagar. Demo pra ver o bot trabalhando.'
        ]
      }),
      2: saleSlot('Abrir Telegram', {
        headline: [
          'Segura o grupo da loja e manda o PIX/cardapio sozinho.',
          'Antilink e boas-vindas no grupo. Voce nao fica de plantao.',
          'Teste 1 dia. Se a loja ficar, o plano e o Pro.'
        ],
        pain: [
          'Grupo de venda sem protecao vira plantao.',
          'Voce some e o grupo esfria.',
          'Lista de comando nao segura o seu grupo.'
        ],
        value: [
          'Paga no Telegram, conecta o numero, toca Proteger grupo.',
          'Day pass testa o grupo. Pro da loja: protecao + divulgacao.',
          'Um bot no seu WhatsApp. Sem catalogo de 40 vantagens.'
        ],
        authority: [
          'Roda no seu WhatsApp, no seu numero.',
          'PIX no Telegram: pagou, conectou, usou.',
          'Feito pra dono de grupo.'
        ],
        objection: [
          'Nao precisa entender de tecnico. Pagou, conectou, usou.',
          'Day pass pra testar. Pro se ficar.',
          'O segundo botao e o demo ou o site.'
        ],
        urgency: [
          'Teste 1 dia: {{priceDaypass}}. Plano da loja: Pro {{priceProM}}/mes.',
          'Day pass {{priceDaypass}}. Pro {{priceProM}} no Telegram.',
          'Comeca pelo dia. Loja de verdade e o Pro.'
        ],
        guarantee: [
          'PIX no Telegram: pagou, liberou. Duvida no mesmo bot.',
          'Testa um dia no seu grupo.',
          'Pagamento no Telegram. Sem enrolacao. {{priceBot}}'
        ],
        ctaLine: [
          'O primeiro botao abre o Telegram. O segundo e o demo ou o site.',
          'Clica no botao. Nao precisa copiar link.',
          'Telegram pra pagar. Demo pra ver o bot trabalhando.'
        ]
      })
    },
    status: {
      1: {
        kind: 'channel',
        urlToken: 'site',
        blocks: blocks({
          headline: [
            'Bot que segura o grupo da loja e manda o PIX/cardapio sozinho.',
            'Antilink, boas-vindas e cobranca. Voce nao fica de plantao.',
            'Teste 1 dia. Plano da loja e o Pro.'
          ],
          pain: [
            'Dono de loja vira seguranca 24h.',
            'Link no grupo e Pix perdido enquanto voce nao olha o celular.',
            'Bot de catalogo nao segura o seu grupo.'
          ],
          value: [
            'Paga no Telegram, conecta o WhatsApp, toca Proteger grupo.',
            'Day pass testa um grupo. Pro: protecao + divulgacao.',
            'Prova: entra no demo e ve o bot trabalhar.'
          ],
          authority: [
            'Roda no seu numero.',
            'PIX no Telegram: pagou, conectou, usou.',
            'Feito pra dono de grupo de venda.'
          ],
          objection: '',
          urgency: 'Teste {{priceDaypass}} o dia. Pro {{priceProM}}/mes.',
          guarantee: '',
          ctaLine: [
            'Primeiro botao: Telegram. Segundo: demo ou site.',
            'Clica. Nao copia link.',
            'Paga no Telegram. Ve o grupo demo.'
          ]
        }),
        textoStatusFixed: null
      },
      2: saleSlot('', {
        headline: [
          'Hanork no WhatsApp: divulga, cuida do grupo e ajuda a vender.',
          'Bot no seu numero. Voce descansa, ele segue.',
          'Menos cola de texto. Mais grupo andando.'
        ],
        pain: 'Revender e cuidar de grupo sem ajuda vira segundo emprego.',
        value: 'No Telegram voce escolhe o plano e conecta. No Zap o bot trabalha.',
        authority: 'Roda no seu numero. Nao some no meio do expediente.',
        objection: 'Nao precisa saber comando. O menu e de botao.',
        urgency: 'Teste {{priceDaypass}} o dia. Pro {{priceProM}}/mes.',
        guarantee: 'Paga no Telegram. Libera na hora.',
        ctaLine: 'Quer ver o trabalho? Telegram no primeiro botao.'
      })
    },
    texto: saleSlot('', {
      headline: [
        'Grupo lotado, Pix pingando, e voce no meio de tudo.',
        'Se o WhatsApp parar, seu dia para. Dava pra ser o contrario.',
        'Voce nao precisava ser o bot do seu proprio grupo.'
      ],
      pain: [
        'Quem vende ou administra grupo fica preso no celular.',
        'Cliente espera. Grupo bagunca. Voce responde um por um.',
        'O dia vira Zap. O Zap nao vira dinheiro sozinho.'
      ],
      value: [
        'O Hanork assume o operacional no seu WhatsApp: avisa, cuida, ajuda a cobrar.',
        'Um bot no seu numero. Voce olha o Telegram e segue a vida.',
        'Divulga sozinho, segura bagunca, e o cliente se vira no menu.'
      ],
      authority: 'Nao e bot que some quando o grupo esquenta. Fica no seu chip.',
      objection: 'Nao precisa planilha nem curso. Pagou no Telegram, usou no Zap.',
        urgency: 'Day pass {{priceDaypass}}. Pro {{priceProM}}/mes.',
        guarantee: 'PIX no Telegram. Se quiser so olhar, o segundo botao e o demo ou o site.',
        ctaLine: 'Compra no Telegram. Os dois caminhos sao botao, nao link no texto.'
    }),
    textoPay: saleSlot('', {
      headline: [
        'Pix caiu. O cliente espera. Voce esta em outra conversa.',
        'Venda nao deveria depender de voce estar online na hora.',
        'Cobranca na mao perde gente.'
      ],
      pain: 'Quem vende no Zap perde venda quando a cobranca espera voce voltar pro celular.',
      value: 'O Hanork confirma e libera. A divulgacao segue. O grupo nao fica na sua mao.',
      authority: 'A cobranca nao espera voce desbloquear a tela.',
      objection: 'Nao precisa entender de sistema. Abre o Telegram e paga.',
      urgency: 'Teste {{priceDaypass}} o dia. Pro {{priceProM}}/mes.',
      guarantee: 'PIX no Telegram: pagou, liberou. {{priceBot}}',
      ctaLine: 'Primeiro botao: Telegram. Segundo: demo ou site.'
    })
  };
}

function outcomeLine(cap) {
  const mapped = CAPABILITY_OUTCOMES[cap];
  if (mapped) return mapped;
  const name = String(cap || '').replace(/\s*\(.*\)\s*$/, '').trim();
  if (!name) return '';
  return name + ' — no mesmo numero, sem voce ficar de atendente';
}

function formatBenefits() {
  return [
    '• Segura o grupo da loja (antilink, boas-vindas)',
    '• Manda o PIX/cardapio sem voce de plantao',
    '• Teste 1 dia. Plano da loja e o Pro'
  ].join('\n');
}

function formatProof(cfg) {
  return '';
}

function planCents(plan) {
  if (!plan) return '';
  return formatBrlCents(plan.price_cents);
}

async function loadPrices() {
  const out = {
    priceDaypass: '',
    priceBot: '',
    priceStarterM: '',
    priceProM: '',
    priceEntM: ''
  };
  try {
    const store = require('../services/billing/store');
    const list = await store.listPlans();
    const byId = {};
    for (const p of list || []) {
      if (p && p.id) byId[String(p.id)] = p;
    }
    const pick = async (id) => {
      if (byId[id]) return byId[id];
      try {
        return await store.getPlan(id);
      } catch (_) {
        return null;
      }
    };
    const daypass = await pick('daypass');
    const bot = await pick('bot');
    const starter = await pick('pro_m');
    const pro = await pick('pro_m');
    const ent = await pick('pro_y');
    out.priceDaypass = planCents(daypass);
    out.priceBot = planCents(bot);
    out.priceStarterM = planCents(starter);
    out.priceProM = planCents(pro);
    out.priceEntM = planCents(ent);
  } catch (_) { /* store off: omite preco */ }
  return out;
}

async function loadAffiliate(telegramUserId) {
  const uid = String(telegramUserId || '');
  const { telegramRefLink, telegramStartLink } = require('./productOffer');
  let url = telegramStartLink('comprar');
  if (!uid || !isAdmin(uid)) return url;
  try {
    const store = require('../services/billing/store');
    const customer = await store.upsertCustomer('telegram', uid);
    const aff = customer && customer.id ? await store.getOrCreateAffiliate(customer.id) : null;
    const code = String(aff && aff.code ? aff.code : '');
    url = code ? telegramRefLink(code) : telegramStartLink('comprar');
  } catch (_) { /* store off */ }
  return url;
}

function dropUnresolvedPriceLines(text) {
  return String(text || '')
    .replace(/[^\n]*\{\{price\w+\}\}[^\n]*\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fillTokens(text, runtime) {
  let t = String(text || '');
  const map = {
    '{{priceDaypass}}': runtime.priceDaypass || '',
    '{{priceBot}}': runtime.priceBot || '',
    '{{priceStarterM}}': runtime.priceStarterM || '',
    '{{priceProM}}': runtime.priceProM || '',
    '{{priceEntM}}': runtime.priceEntM || '',
    [PLACE_AFF]: runtime.affiliateUrl || ''
  };
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue;
    t = t.split(k).join(v);
  }
  t = dropUnresolvedPriceLines(t);
  t = t.split(PLACE_AFF).join(runtime.affiliateUrl || '');
  return t.trim();
}

function joinBlocks(slot, runtime) {
  const b = (slot && slot.blocks) || {};
  const parts = [];
  const salt = String((slot && slot.kind) || 'x') + ':' + String((slot && slot.label) || '');
  const push = (s, key) => {
    const t = fillTokens(pickLine(s, salt + ':' + key), runtime).trim();
    if (t) parts.push(t);
  };
  push(b.headline, 'h');
  push(b.value, 'v');
  push(b.urgency, 'u');
  push(b.ctaLine, 'c');
  return parts
    .join('\n')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slotUrl(slot, runtime) {
  if (!slot) return '';
  if (slot.urlToken === 'site') return siteUrl();
  if (slot.urlToken === 'invite') return invitePlaceholder();
  if (slot.urlToken === 'affiliate') return runtime.affiliateUrl || PLACE_AFF;
  return '';
}

function packedFromSlots(slots, runtime) {
  const s = slots || skeletonSlots();
  const cta1 = s.cta && s.cta[1];
  const cta2 = s.cta && s.cta[2];
  const st1 = s.status && s.status[1];
  const st2 = s.status && s.status[2];
  const texto = joinBlocks(s.texto, runtime);
  const textoPay = joinBlocks(s.textoPay, runtime);
  const textoStatus = joinBlocks(st1, runtime);
  const emptyCta = (slot) => ({
    texto: joinBlocks(slot, runtime),
    label: slot && slot.label ? String(slot.label).slice(0, 20) : 'Abrir Telegram',
    url: slotUrl(slot, runtime) || (runtime.affiliateUrl || PLACE_AFF),
    label2: demoOrSiteLabel(),
    url2: demoOrSiteUrl(),
    midia: null,
    midiaFile: null,
    midiaTipo: null,
    midiaMimetype: null
  });
  const emptyStatus = (slot) => ({
    textoStatus: joinBlocks(slot, runtime),
    statusMidiaFile: null,
    statusMidiaTipo: null,
    statusMidiaMimetype: null,
    statusMidiaNome: null
  });
  return {
    texto,
    textoPay,
    textoStatus,
    cta: emptyCta(cta1),
    divSlots: {
      cta: { 1: emptyCta(cta1), 2: emptyCta(cta2) },
      status: { 1: emptyStatus(st1), 2: emptyStatus(st2) }
    }
  };
}

function mergeMedia(sessionSlot, packedSlot) {
  if (!packedSlot || typeof packedSlot !== 'object') return packedSlot;
  const src = sessionSlot && typeof sessionSlot === 'object' ? sessionSlot : {};
  const out = { ...packedSlot };
  for (const k of Object.keys(src)) {
    if (/midia/i.test(k) && src[k]) out[k] = src[k];
  }
  return out;
}

function overlayPacked(cfg, packed) {
  if (!cfg || !packed) return cfg;
  cfg.texto = packed.texto;
  cfg.textoPay = packed.textoPay;
  cfg.textoStatus = packed.textoStatus;
  cfg.cta = mergeMedia(cfg.cta, packed.cta);
  if (!cfg.divSlots || typeof cfg.divSlots !== 'object') cfg.divSlots = {};
  if (!cfg.divSlots.cta || typeof cfg.divSlots.cta !== 'object') cfg.divSlots.cta = {};
  if (!cfg.divSlots.status || typeof cfg.divSlots.status !== 'object') cfg.divSlots.status = {};
  cfg.divSlots.cta[1] = mergeMedia(cfg.divSlots.cta[1], packed.divSlots.cta[1]);
  cfg.divSlots.cta[2] = mergeMedia(cfg.divSlots.cta[2], packed.divSlots.cta[2]);
  cfg.divSlots.status[1] = mergeMedia(cfg.divSlots.status[1], packed.divSlots.status[1]);
  cfg.divSlots.status[2] = mergeMedia(cfg.divSlots.status[2], packed.divSlots.status[2]);
  cfg.activeSlot = { cta: 1, status: 1, ...(cfg.activeSlot || {}) };
  cfg.configurado = true;
  return cfg;
}

function placeholderRuntime() {
  return {
    priceDaypass: '{{priceDaypass}}',
    priceBot: '{{priceBot}}',
    priceStarterM: '{{priceStarterM}}',
    priceProM: '{{priceProM}}',
    priceEntM: '{{priceEntM}}',
    affiliateUrl: PLACE_AFF,
    benefits: '{{benefits}}',
    proof: '{{proofSocial}}'
  };
}

function readLegacyAutoDivBot() {
  try {
    const p = path.join(__dirname, '..', 'data', 'autoDivBot.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      enabled: !!j.on,
      intervalMin: Math.min(1440, Math.max(45, parseInt(j.intervalMin, 10) || 90)),
      lastAt: Number(j.lastAt) || 0
    };
  } catch (_) {
    return { enabled: false, intervalMin: 30, lastAt: 0 };
  }
}

function parseRow(row) {
  let slots = skeletonSlots();
  try {
    const j = JSON.parse(row.slots_json || '{}');
    if (j && typeof j === 'object' && j.cta) slots = j;
  } catch (_) { /* seed */ }
  return {
    fromSql: true,
    enabled: !!Number(row.enabled),
    intervalMin: Math.min(1440, Math.max(45, parseInt(row.interval_min, 10) || 90)),
    lastAt: Number(row.last_at) || 0,
    slots,
    updatedAt: row.updated_at || '',
    updatedBy: row.updated_by || ''
  };
}

function getTemplateSync() {
  if (cache) return cache;
  return {
    fromSql: false,
    enabled: readLegacyAutoDivBot().enabled,
    intervalMin: readLegacyAutoDivBot().intervalMin,
    lastAt: readLegacyAutoDivBot().lastAt,
    slots: skeletonSlots(),
    updatedAt: '',
    updatedBy: ''
  };
}

function slotsJsonEmpty(raw) {
  const s = String(raw || '').trim();
  return !s || s === '{}' || s === 'null';
}

function slotsNeedRefresh(raw) {
  if (slotsJsonEmpty(raw)) return true;
  try {
    const j = JSON.parse(raw);
    return !j || Number(j.version || 0) < TEMPLATE_VERSION;
  } catch (_) {
    return true;
  }
}

async function ensureTemplate() {
  if (cache && cache.fromSql) return cache;
  if (ensureP) return ensureP;
  ensureP = (async () => {
    const sql = require('./sqlStore');
    if (!sql.isReady()) {
      try { sql.initSqlStore(); } catch (_) { /* json fallback */ }
    }
    if (!sql.isReady()) {
      cache = getTemplateSync();
      return cache;
    }
    await sql.runAsync(
      `CREATE TABLE IF NOT EXISTS admin_div_template (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_min INTEGER NOT NULL DEFAULT 90,
        last_at INTEGER NOT NULL DEFAULT 0,
        slots_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )`
    );
    let row = await sql.getAsync(`SELECT * FROM admin_div_template WHERE id=?`, [ROW_ID]);
    if (!row) {
      const legacy = readLegacyAutoDivBot();
      const now = new Date().toISOString();
      await sql.runAsync(
        `INSERT INTO admin_div_template (id, enabled, interval_min, last_at, slots_json, updated_at, updated_by)
         VALUES (?,?,?,?,?,?,?)`,
        [
          ROW_ID,
          legacy.enabled ? 1 : 0,
          legacy.intervalMin,
          legacy.lastAt,
          JSON.stringify(skeletonSlots()),
          now,
          'seed'
        ]
      );
      row = await sql.getAsync(`SELECT * FROM admin_div_template WHERE id=?`, [ROW_ID]);
    } else if (slotsNeedRefresh(row.slots_json)) {
      const now = new Date().toISOString();
      await sql.runAsync(
        `UPDATE admin_div_template SET slots_json=?, updated_at=?, updated_by=? WHERE id=?`,
        [JSON.stringify(skeletonSlots()), now, 'seed-v' + TEMPLATE_VERSION, ROW_ID]
      );
      row = await sql.getAsync(`SELECT * FROM admin_div_template WHERE id=?`, [ROW_ID]);
    }
    cache = parseRow(row);
    return cache;
  })().finally(() => { ensureP = null; });
  return ensureP;
}

async function saveTemplatePatch(patch, updatedBy) {
  const cur = await ensureTemplate();
  const next = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    intervalMin: patch.intervalMin != null
      ? Math.min(1440, Math.max(45, parseInt(patch.intervalMin, 10) || cur.intervalMin))
      : cur.intervalMin,
    lastAt: patch.lastAt != null ? Number(patch.lastAt) || 0 : cur.lastAt,
    slots: patch.slots || cur.slots
  };
  const sql = require('./sqlStore');
  if (!sql.isReady()) {
    cache = { ...cur, ...next, fromSql: false };
    return cache;
  }
  const now = new Date().toISOString();
  await sql.runAsync(
    `INSERT INTO admin_div_template (id, enabled, interval_min, last_at, slots_json, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       enabled=excluded.enabled,
       interval_min=excluded.interval_min,
       last_at=excluded.last_at,
       slots_json=excluded.slots_json,
       updated_at=excluded.updated_at,
       updated_by=excluded.updated_by`,
    [
      ROW_ID,
      next.enabled ? 1 : 0,
      next.intervalMin,
      next.lastAt,
      JSON.stringify(next.slots),
      now,
      String(updatedBy || '')
    ]
  );
  cache = {
    fromSql: true,
    ...next,
    updatedAt: now,
    updatedBy: String(updatedBy || '')
  };
  return cache;
}

function overlayRuntime() {
  return {
    priceDaypass: '',
    priceBot: '',
    priceStarterM: '',
    priceProM: '',
    priceEntM: '',
    affiliateUrl: PLACE_AFF,
    benefits: formatBenefits(),
    proof: ''
  };
}

function applyAdminOverlay(telegramUserId, cfg) {
  const uid = String(telegramUserId || '');
  const out = cfg && typeof cfg === 'object' ? cfg : {};
  if (!uid || !isAdmin(uid)) return { cfg: out, changed: false };
  const tpl = getTemplateSync();
  const packed = packedFromSlots(tpl.slots, overlayRuntime());
  overlayPacked(out, packed);
  return { cfg: out, changed: false };
}

async function hydrateRuntime(config, telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!config || !uid || !isAdmin(uid)) return config;
  await ensureTemplate();
  const tpl = getTemplateSync();
  const prices = await loadPrices();
  const affiliateUrl = await loadAffiliate(uid);
  const runtime = {
    ...prices,
    affiliateUrl,
    benefits: formatBenefits(),
    proof: formatProof(config)
  };
  const packed = packedFromSlots(tpl.slots, runtime);
  overlayPacked(config, packed);
  return config;
}

const TEXT_UPDATE_KEYS = ['texto', 'textoPay', 'textoStatus', 'cta', 'divSlots'];

function updatesTouchTemplate(updates) {
  if (!updates || typeof updates !== 'object') return false;
  return TEXT_UPDATE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(updates, k));
}

function stripDynamicTokens(text) {
  let t = String(text || '');
  t = t.replace(/https?:\/\/t\.me\/[A-Za-z0-9_]+\/?\?start=ref_[A-Za-z0-9]+/gi, PLACE_AFF);
  t = t.replace(/https?:\/\/t\.me\/[A-Za-z0-9_]+\?start=comprar/gi, PLACE_AFF);
  return t;
}

function slotFromRawTexto(prev, texto, urlToken) {
  const raw = stripDynamicTokens(texto);
  const next = prev && typeof prev === 'object' ? { ...prev } : saleSlot('', {});
  next.blocks = blocks({
    ...(next.blocks || {}),
    headline: raw.split('\n')[0] || (next.blocks && next.blocks.headline) || '',
    pain: next.blocks && next.blocks.pain,
    value: raw,
    authority: next.blocks && next.blocks.authority,
    objection: next.blocks && next.blocks.objection,
    urgency: next.blocks && next.blocks.urgency,
    guarantee: next.blocks && next.blocks.guarantee,
    ctaLine: next.blocks && next.blocks.ctaLine
  });
  if (urlToken) next.urlToken = urlToken;
  return next;
}

async function persistEditsFromUpdates(telegramUserId, updates) {
  const uid = String(telegramUserId || '');
  if (!uid || !isAdmin(uid) || !updatesTouchTemplate(updates)) return;
  const tpl = await ensureTemplate();
  const slots = JSON.parse(JSON.stringify(tpl.slots || skeletonSlots()));
  if (updates.texto != null) slots.texto = slotFromRawTexto(slots.texto, updates.texto, 'affiliate');
  if (updates.textoPay != null) slots.textoPay = slotFromRawTexto(slots.textoPay, updates.textoPay, 'affiliate');
  if (updates.cta && typeof updates.cta === 'object' && updates.cta.texto != null) {
    slots.cta[1] = slotFromRawTexto(slots.cta[1], updates.cta.texto, 'affiliate');
    if (updates.cta.label) slots.cta[1].label = String(updates.cta.label).slice(0, 20);
  }
  if (updates.divSlots && updates.divSlots.cta) {
    for (const k of ['1', '2', 1, 2]) {
      const slot = updates.divSlots.cta[k];
      if (slot && slot.texto != null) {
        const id = Number(k) === 2 ? 2 : 1;
        const token = id === 2 ? 'invite' : 'affiliate';
        slots.cta[id] = slotFromRawTexto(slots.cta[id], slot.texto, token);
        if (slot.label) slots.cta[id].label = String(slot.label).slice(0, 20);
      }
    }
  }
  if (updates.divSlots && updates.divSlots.status) {
    for (const k of ['1', '2', 1, 2]) {
      const slot = updates.divSlots.status[k];
      if (slot && slot.textoStatus != null) {
        const id = Number(k) === 2 ? 2 : 1;
        const token = id === 1 ? 'invite' : 'affiliate';
        slots.status[id] = slotFromRawTexto(slots.status[id], slot.textoStatus, token);
      }
    }
  }
  if (updates.textoStatus != null) {
    slots.status[1] = slotFromRawTexto(slots.status[1], updates.textoStatus, 'invite');
  }
  await saveTemplatePatch({ slots }, uid);
}

function restoreDiskTexts(target, disk) {
  if (!target || !disk) return target;
  target.texto = disk.texto;
  target.textoPay = disk.textoPay;
  target.textoStatus = disk.textoStatus;
  if (disk.cta && typeof disk.cta === 'object') {
    target.cta = {
      ...(target.cta || {}),
      texto: disk.cta.texto,
      url: disk.cta.url,
      url2: disk.cta.url2,
      label: disk.cta.label,
      label2: disk.cta.label2
    };
  }
  if (disk.divSlots && typeof disk.divSlots === 'object') {
    if (!target.divSlots) target.divSlots = {};
    for (const track of ['cta', 'status']) {
      if (!disk.divSlots[track]) continue;
      if (!target.divSlots[track]) target.divSlots[track] = {};
      for (const id of Object.keys(disk.divSlots[track])) {
        const d = disk.divSlots[track][id];
        const t = target.divSlots[track][id] || {};
        target.divSlots[track][id] = {
          ...t,
          texto: d.texto,
          url: d.url,
          url2: d.url2,
          label: d.label,
          label2: d.label2,
          textoStatus: d.textoStatus
        };
      }
    }
  }
  if (disk.adminMarketingVersion != null) target.adminMarketingVersion = disk.adminMarketingVersion;
  if (disk.adminMarketingCustom != null) target.adminMarketingCustom = disk.adminMarketingCustom;
  return target;
}

/** Texto final de um slot (pra preview/aprovacao). */
async function previewAssembled(telegramUserId, which = 'cta1') {
  const tpl = await ensureTemplate();
  const prices = await loadPrices();
  const affiliateUrl = telegramUserId ? await loadAffiliate(telegramUserId) : PLACE_AFF;
  const runtime = {
    ...prices,
    affiliateUrl,
    benefits: formatBenefits(),
    proof: formatProof(null)
  };
  const packed = packedFromSlots(tpl.slots, runtime);
  if (which === 'cta1') return packed.cta.texto;
  if (which === 'cta2') return packed.divSlots.cta[2].texto;
  if (which === 'texto') return packed.texto;
  if (which === 'pay') return packed.textoPay;
  if (which === 'status1') return packed.divSlots.status[1].textoStatus;
  if (which === 'status2') return packed.divSlots.status[2].textoStatus;
  return packed;
}

function schemaSql() {
  return `CREATE TABLE IF NOT EXISTS admin_div_template (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_min INTEGER NOT NULL DEFAULT 90,
  last_at INTEGER NOT NULL DEFAULT 0,
  slots_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT
)`;
}

module.exports = {
  TEMPLATE_VERSION,
  PLACE_AFF,
  skeletonSlots,
  formatBenefits,
  formatProof,
  fillTokens,
  packedFromSlots,
  placeholderRuntime,
  getTemplateSync,
  ensureTemplate,
  saveTemplatePatch,
  applyAdminOverlay,
  hydrateRuntime,
  siteUrl,
  demoInviteUrl,
  demoOrSiteUrl,
  demoOrSiteLabel,
  SITE_LABEL,
  persistEditsFromUpdates,
  updatesTouchTemplate,
  restoreDiskTexts,
  previewAssembled,
  schemaSql,
  loadPrices,
  loadAffiliate
};
