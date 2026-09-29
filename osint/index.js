'use strict';

module.exports = {
  run: (...args) => require('./core/orchestrator').run(...args),
  runCompare: (...args) => require('./core/orchestrator').runCompare(...args),
  guardrails: require('./core/guardrails'),
  buildPlan: (...args) => require('./core/plan').buildPlan(...args)
};
