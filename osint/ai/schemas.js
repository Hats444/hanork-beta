'use strict';

const ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['facts', 'hypotheses', 'contradictions', 'unverifiable'],
  properties: {
    facts: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, source: { type: 'string' } } } },
    hypotheses: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    unverifiable: { type: 'array', items: { type: 'string' } }
  }
};

module.exports = { ANALYSIS_SCHEMA };
