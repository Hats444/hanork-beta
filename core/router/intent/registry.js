// core/router/intent/registry.js
const urls = require('./detectors/urls');
const identifiers = require('./detectors/identifiers');
const search = require('./detectors/search');

/**
 * Lista ordenada por prioridade (maior primeiro).
 * Cada item: { name, priority, enabledKey, detect(text, opts) }
 */
const DETECTORS = [
  {
    name: 'urls',
    priority: 100,
    enabledKey: 'allowUrls',
    detect: (text, opts) => urls.detect(text, opts)
  },
  {
    name: 'identifiers',
    priority: 90,
    enabledKey: 'allowIdentifiers',
    detect: (text, opts) => identifiers.detect(text, opts)
  },
  {
    name: 'search',
    priority: 10,
    enabledKey: 'allowSearch',
    detect: (text, opts) => search.detect(text, opts)
  }
];

function listDetectors() {
  return DETECTORS.slice().sort((a, b) => b.priority - a.priority);
}

module.exports = {
  DETECTORS,
  listDetectors
};
