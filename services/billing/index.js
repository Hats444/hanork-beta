'use strict';

const store = require('./store');
const mp = require('./mercadoPagoService');
const jobs = require('./jobs');
const webhook = require('./webhookService');
const notify = require('./notify');
const logic = require('./logic');

module.exports = {
  store,
  mp,
  jobs,
  webhook,
  notify,
  logic,
  startJobs: jobs.startJobs || jobs.startJobs,
  isConfigured: mp.isConfigured
};
