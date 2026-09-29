'use strict';
/** Wikipedia/Wikidata: reusa search.js (Person/Org so com Q-id). */

const search = require('./search');

module.exports = {
  collect: search.collect,
  name: 'wiki',
  phase: 2,
  wikiHits: search.wikiHits
};
