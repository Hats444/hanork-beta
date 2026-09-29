// commands/divulgar/index.js
const config = require("./config");
const div = require("./div");
const grupos = require("./grupos");

const commands = {};
Object.assign(commands, config.commands);
Object.assign(commands, div.commands);
Object.assign(commands, grupos.commands);
Object.assign(commands, require('./inviteLive').commands);

module.exports = { commands, stepHandlers: config.stepHandlers || {} };