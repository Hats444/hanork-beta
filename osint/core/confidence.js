'use strict';

/** Familias independentes de fonte (WHOIS porta 43 != RDAP HTTP). */
const FAMILY = {
  dns: 'dns',
  rdap: 'rdap',
  whois: 'whois',
  certificate_transparency: 'ct',
  github: 'github',
  web: 'web',
  search: 'search',
  wiki: 'search',
  archive: 'archive',
  username: 'username',
  email: 'email',
  gravatar: 'email',
  pastes: 'pastes',
  media: 'media',
  crypto: 'crypto',
  decode: 'decode'
};

function families(sources) {
  const set = new Set();
  for (const s of sources || []) {
    set.add(FAMILY[s] || s);
  }
  return set;
}

function score(sources) {
  const n = families(sources).size;
  if (n >= 3) return 0.9;
  if (n >= 2) return 0.75;
  if (n === 1) return 0.45;
  return 0.2;
}

module.exports = { families, score, FAMILY };
