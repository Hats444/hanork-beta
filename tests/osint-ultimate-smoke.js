'use strict';
const assert = require('assert');
const { parseOsintTarget, pickModulesFor, parseCompare, extractFlags } = require('../osint/core/target');
const { assertPassiveTarget, stripForbiddenPii, looksLikeBrCpf, isOnionHost } = require('../osint/core/guardrails');
const { buildPlan } = require('../osint/core/plan');
const { verify } = require('../osint/core/verifier');
const { toMarkdown } = require('../osint/reports/markdown');
const { correlate } = require('../osint/core/correlate');

{
  const p = parseOsintTarget('joao silva');
  assert.strictEqual(p.kind, 'text');
  const mods = pickModulesFor('all', p);
  assert.ok(mods.includes('search'), 'texto inclui search');
  assert.ok(mods.includes('github'));
  assert.ok(mods.includes('web'), 'texto inclui web');
  assert.ok(mods.includes('pastes'), 'texto inclui pastes publicos');
  assert.ok(!mods.includes('dns'));
}

{
  const p = parseOsintTarget('https://github.com/foo/bar');
  assert.strictEqual(p.kind, 'github');
  assert.deepStrictEqual(pickModulesFor('all', p), ['github']);
  assert.deepStrictEqual(pickModulesFor('', p), ['github']);
}

{
  let threw = false;
  try { assertPassiveTarget('haveibeenpwned x'); } catch (e) {
    threw = true;
    assert.ok(/vazad/i.test(e.message));
  }
  assert.ok(threw, 'leak bloqueado');
}

{
  const cpf = 'cpf-ficticio';
  if (looksLikeBrCpf(cpf)) {
    let threw = false;
    try { assertPassiveTarget(cpf); } catch (_) { threw = true; }
    assert.ok(threw, 'CPF checksum valido bloqueado');
  }
}

{
  assert.ok(isOnionHost('abcxyz.onion'));
  const p = parseOsintTarget('http://abcxyz.onion/foo');
  assert.strictEqual(p.kind, 'onion');
  assert.deepStrictEqual(pickModulesFor('all', p), []);
  const plan = buildPlan(p, 'all');
  assert.strictEqual(plan.collectors.length, 0);
  const md = toMarkdown({
    target: p.label,
    modules: [],
    overallConfidence: 0,
    skipped: plan.skipped,
    summary: 'Alvo .onion nao e coletado neste bot (so http/https publico).',
    entities: [],
    evidence: [],
    facts: { confirmed: [], probable: [], conflict: [], unverified: [], stale: [] },
    ai: { note: 'onion_skip', text: 'nao coletado' }
  });
  assert.ok(/PULADO/i.test(md));
  assert.ok(/onion/i.test(md));
}

{
  const one = verify([{
    entityType: 'Domain',
    value: 'a.com',
    sources: ['dns'],
    evidences: [{ source: 'dns', collectedAt: new Date().toISOString() }],
    confidence: 0.7
  }]);
  assert.notStrictEqual(one[0].status, 'VERIFIED');
}

{
  const two = verify([{
    entityType: 'IP',
    value: '1.2.3.4',
    sources: ['dns', 'rdap'],
    evidences: [
      { source: 'dns', collectedAt: new Date().toISOString() },
      { source: 'rdap', collectedAt: new Date().toISOString() }
    ],
    confidence: 0.7
  }]);
  assert.strictEqual(two[0].status, 'VERIFIED');
}

{
  const red = stripForbiddenPii('cpf cpf-ficticio e fone 11987654321');
  assert.ok(!/529\.982\.247-25/.test(red) || /redacted/.test(red));
}

{
  const cmp = parseCompare('compare a.com | b.org');
  assert.ok(cmp);
  assert.strictEqual(cmp.a, 'a.com');
  assert.strictEqual(cmp.b, 'b.org');
}

{
  const f = extractFlags('exemplo.com lang=pt since=2024');
  assert.strictEqual(f.flags.lang, 'pt');
  assert.strictEqual(f.flags.since, '2024');
  assert.ok(f.raw.includes('exemplo.com'));
}

{
  const p = parseOsintTarget('user@example.com');
  assert.strictEqual(p.kind, 'email');
  const mods = pickModulesFor('all', p);
  assert.ok(mods.includes('email'));
}

{
  const p = parseOsintTarget('@fulano');
  assert.strictEqual(p.kind, 'username');
  assert.ok(pickModulesFor('all', p).includes('username'));
}

{
  const p = parseOsintTarget('example.com');
  assert.strictEqual(p.kind, 'domain');
  const mods = pickModulesFor('all', p);
  assert.ok(mods.includes('dns'));
  assert.ok(mods.includes('archive'));
  assert.ok(mods.includes('search'));
  assert.ok(mods.includes('pastes'));
  const plan = buildPlan(p, 'all');
  assert.ok(plan.collectors.includes('whois') || plan.collectors.includes('rdap'));
  assert.ok((plan.skipped || []).some((s) => s.reason === 'policy_public_web'));
}

{
  const cpf = 'cpf-ficticio';
  if (looksLikeBrCpf(cpf)) {
    let threw = false;
    try { assertPassiveTarget(cpf); } catch (_) { threw = true; }
    assert.ok(threw, 'CPF cpf-ficticio bloqueado se checksum valido');
  }
}

{
  let threw = false;
  try { parseOsintTarget('127.0.0.1'); } catch (_) { threw = true; }
  assert.ok(threw, 'IP loopback bloqueado');
}

{
  let threw = false;
  try { assertPassiveTarget('https://t.me/+abc123xyz'); } catch (_) { threw = true; }
  assert.ok(threw, 'convite privado bloqueado');
}

{
  const one = verify([{
    entityType: 'Domain',
    value: 'a.com',
    sources: ['dns'],
    evidences: [{ source: 'dns', url: 'dns:A:a.com', collectedAt: new Date().toISOString() }],
    confidence: 0.7
  }]);
  assert.ok(Array.isArray(one[0].evidencePath));
  assert.ok(one[0].evidencePath.length >= 1);
}

{
  const md = toMarkdown({
    target: 'x',
    modules: ['dns'],
    overallConfidence: 0,
    skipped: [{ name: 'tor/onion', reason: 'policy_public_web' }],
    summary: 'teste cpf cpf-ficticio',
    entities: [{ entityType: 'Person', value: 'cpf-ficticio', status: 'UNVERIFIED', independentSources: 0, confidence: 0.1 }],
    evidence: [],
    facts: { confirmed: [], probable: [], conflict: [], unverified: [], stale: [] },
    ai: { note: 'off', text: '' }
  });
  assert.ok(/PULADO/i.test(md));
  assert.ok(!/529\.982\.247-25/.test(md), 'CPF nao vaza no markdown');
}

{
  const facts = correlate({
    parsed: { host: 'a.com' },
    entities: [
      { entityType: 'IP', value: '1.1.1.1', status: 'VERIFIED', independentSources: 2, confidence: 0.75 },
      { entityType: 'Domain', value: 'a.com', status: 'UNVERIFIED', independentSources: 1, confidence: 0.4 }
    ],
    evidence: [],
    relations: []
  }).facts;
  assert.strictEqual(facts.confirmed.length, 1);
  assert.ok(facts.unverified.length >= 1);
}

{
  let threw = false;
  try { assertPassiveTarget('ip real atras cloudflare origin'); } catch (_) { threw = true; }
  assert.ok(threw);
}

{
  const { buildSearchQueries, isLeakDumpHit, parseDdgHtml } = require('../osint/collectors/search');
  const qs = buildSearchQueries({ query: 'exemplo.com', host: 'exemplo.com', kind: 'domain' });
  assert.ok(qs.some((q) => /filetype:pdf/i.test(q)));
  assert.ok(qs.some((q) => /pastebin\.com/i.test(q)), 'busca inclui paste publico');
  assert.ok(isLeakDumpHit('password dump combo list', 'https://example.net/x'));
  assert.ok(isLeakDumpHit('x', 'https://haveibeenpwned.com/'));
  assert.ok(!isLeakDumpHit('nota publica', 'https://pastebin.com/abc123'));
  const fake = parseDdgHtml(
    '<a class="result__a" href="https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fpastebin.com%2Fabc123">Nota publica</a>',
    { source: 'pastes', limit: 5, q: 'exemplo.com' }
  );
  assert.ok(fake.some((e) => /pastebin\.com\/abc123/i.test(e.url)), 'parser DDG extrai uddg');
}

{
  const { pasteQueries, PASTE_SITES } = require('../osint/collectors/pastes');
  const pq = pasteQueries({ host: 'exemplo.com', kind: 'domain' });
  assert.ok(pq.some((q) => /site:pastebin\.com/i.test(q)));
  assert.ok(pq.some((q) => /site:gist\.github\.com/i.test(q)));
  assert.ok(PASTE_SITES.includes('paste.ee'));
  assert.ok(pq.some((q) => /paste\.ee/i.test(q)));
}

{
  const { huntInBlobs } = require('../osint/collectors/email');
  const hits = huntInBlobs(['contato foo@exemplo.com no rodape']);
  assert.ok(hits.some((e) => e.value === 'foo@exemplo.com'));
}

{
  const p = parseOsintTarget('t.me/canalpublico');
  assert.strictEqual(p.kind, 'url');
  assert.ok((p.urls || []).some((u) => /t\.me\/canalpublico/i.test(u)));
}

{
  const p = parseOsintTarget('https://discord.com/users/123456789');
  assert.strictEqual(p.kind, 'url');
  assert.strictEqual(p.host, 'discord.com');
  const mods = pickModulesFor('all', p);
  assert.ok(mods.includes('web'));
  assert.ok(!mods.includes('dns'), 'perfil discord publico nao varre DNS do discord.com');
}

{
  const { assertPublicUrl, isRawPasteUrl } = require('../osint/core/guardrails');
  let threw = false;
  try { assertPublicUrl('https://pastebin.com/raw/abcdef'); } catch (_) { threw = true; }
  assert.ok(threw, 'paste raw bloqueado');
  assert.ok(isRawPasteUrl('https://gist.githubusercontent.com/foo/bar/raw/x'));
  assert.ok(!isRawPasteUrl('https://pastebin.com/abc123'));
}

console.log('osint-ultimate-smoke: ok');
