#!/usr/bin/env node
'use strict';
/** Extrai action + campos do formulario de cada modulo Mind7 (sem POST com PII). */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const cheerio = require('cheerio');
const { MODULES } = require('../services/mind7Catalog');

const BASE = String(process.env.MIND7_BASE || 'https://mind-7.org').replace(/\/$/, '');
const cookie = String(process.env.MIND7_COOKIE || '').trim();

async function fetchMod(mod) {
  const pathMod = String(mod.path || '').startsWith('.')
    ? `/painel/${String(mod.path).replace(/^\.\.\//, '')}`
    : `/painel/consultas/${mod.path}/`;
  const url = `${BASE}${pathMod}${pathMod.endsWith('/') ? '' : '/'}`;
  const res = await axios.get(url, {
    timeout: 25000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    responseType: 'text'
  });
  return { url, status: res.status, html: String(res.data || '') };
}

function parseForm(html) {
  const $ = cheerio.load(html);
  const form = $('#meu-formulario').length ? $('#meu-formulario') : $('form').first();
  if (!form.length) return null;
  const action = form.attr('action') || 'search.php';
  const fields = {};
  form.find('input,select,textarea').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    const type = String($(el).attr('type') || '').toLowerCase();
    if (type === 'submit' || type === 'button') return;
    let val = $(el).attr('value') || '';
    if ($(el).is('select')) {
      const sel = $(el).find('option[selected]').first();
      val = sel.attr('value') || $(el).find('option').first().attr('value') || '';
    }
    if (type === 'checkbox' && !$(el).attr('checked')) val = '';
    fields[name] = val;
  });
  return { action, fields: Object.keys(fields).sort(), defaults: fields };
}

async function main() {
  if (!cookie) {
    console.error('MIND7_COOKIE vazio');
    process.exit(1);
  }
  console.log('Mind7 form scan\n');
  for (const mod of MODULES) {
    if (mod.unavailable) continue;
    try {
      const { status, html } = await fetchMod(mod);
      const cf = /Just a moment/.test(html);
      if (cf) {
        console.log(`${mod.id.padEnd(18)} CF blocked`);
        continue;
      }
      const form = parseForm(html);
      if (!form) {
        console.log(`${mod.id.padEnd(18)} http=${status} NO FORM`);
        continue;
      }
      const catExtra = mod.extra ? JSON.stringify(mod.extra) : '{}';
      console.log(
        `${mod.id.padEnd(18)} http=${status} action=${form.action} fields=${form.fields.join(',')} catalog=${catExtra}`
      );
    } catch (e) {
      console.log(`${mod.id.padEnd(18)} err=${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
