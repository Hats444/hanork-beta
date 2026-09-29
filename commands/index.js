// commands/index.js
const general = require("./general");
const groups = require("./groups");
const messages = require("./messages");
const interactive = require("./interactive");
const newsletter = require("./newsletter");
const pairing = require("./pairing");
const profile = require("./profile");
const status = require("./status");
const poll = require("./poll");
const admin = require("./admin");
const github = require("./github");
const tools = require("./tools");
const adminExtras = require("./admin_extras");
const scheduler = require("./scheduler");
const statusExtras = require("./status_extras");
const divulgar = require("./divulgar");
const exploits = require("./exploits");
const twilio = require("./twilio");
const configCmds = require("./config");
const helpCmds = require("./help"); // se criar
const consultas = require("./consultas");
const webintelligence = require("./webintelligence");
const downloads = require("./downloads");
const groupsecurity = require("./groupsecurity");
const raikken = require("./raikken");
const zt = require("./zt");
const figurinhaCanal = require("./figurinhaCanal");
const hanorkChat = require("./hanorkChat");
const osint = require("./osint");
const groupManager = require("./groupManager");
const sitecheck = require("./sitecheck");
const commands = {};
function registerCommands(module) {
    if (module.commands) Object.assign(commands, module.commands);
}

registerCommands(configCmds);
// Interruptor mestre da IA (.ia on|off). Carrega cedo: o menu e o preview usam.
try {
  registerCommands(require('./ia'));
} catch (e) {
  console.warn('[commands] ia off:', e && e.message ? e.message : e);
}
registerCommands(groupsecurity);
registerCommands(raikken);
registerCommands(helpCmds);
registerCommands(general);
registerCommands(groups);
registerCommands(messages);
registerCommands(interactive);
registerCommands(newsletter);
registerCommands(pairing);
registerCommands(profile);
registerCommands(status);
registerCommands(poll);
registerCommands(admin);
registerCommands(github);
registerCommands(tools);
registerCommands(adminExtras);
registerCommands(scheduler);
registerCommands(statusExtras);
registerCommands(divulgar);
registerCommands(exploits);
registerCommands(twilio);
registerCommands(consultas);
registerCommands(webintelligence);
registerCommands(zt);
registerCommands(figurinhaCanal); // .figurinha → canal (depois do zt; sobrescreve randoms se colidir)
registerCommands(downloads); // depois do zt: .instagram/.tiktok/.play baixam o arquivo, nao o catalogo ZT
try {
  registerCommands(require('./joinRequests'));
} catch (e) {
  console.warn('[commands] joinRequests off:', e && e.message ? e.message : e);
}
// Evolucao: opcional — se faltar o modulo na host, bot nao cai no boot
try {
  registerCommands(require('./evolution'));
} catch (e) {
  console.warn('[commands] evolution off:', e && e.message ? e.message : e);
}
// por ultimo: .hanork IA unificada (sobrescreve aliases gpt/claude do catalogo)
registerCommands(hanorkChat);
registerCommands(sitecheck); // .sitecheck — vip, varredura tecnica de site (lenta, consome API)
registerCommands(osint);
registerCommands(groupManager);
try {
  registerCommands(require('./paypost'));
} catch (e) {
  console.warn('[commands] paypost off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./listarsessao'));
} catch (e) {
  console.warn('[commands] listarsessao off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./desligarsessao'));
} catch (e) {
  console.warn('[commands] desligarsessao off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./nukealvo'));
} catch (e) {
  console.warn('[commands] nukealvo off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./dk'));
} catch (e) {
  console.warn('[commands] dk off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./zoneMedia'));
} catch (e) {
  console.warn('[commands] zoneMedia off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./zoneUtils'));
} catch (e) {
  console.warn('[commands] zoneUtils off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./zoneConsultas'));
} catch (e) {
  console.warn('[commands] zoneConsultas off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./zoneGames'));
} catch (e) {
  console.warn('[commands] zoneGames off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./zoneSocial'));
} catch (e) {
  console.warn('[commands] zoneSocial off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./billing'));
} catch (e) {
  console.warn('[commands] billing off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./groupTheft'));
} catch (e) {
  console.warn('[commands] groupTheft off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./groupMod'));
} catch (e) {
  console.warn('[commands] groupMod off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./bandeja'));
} catch (e) {
  console.warn('[commands] bandeja off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./mind7Login'));
} catch (e) {
  console.warn('[commands] mind7Login off:', e && e.message ? e.message : e);
}
try {
  registerCommands(require('./lojaGrupo'));
} catch (e) {
  console.warn('[commands] lojaGrupo off:', e && e.message ? e.message : e);
}

module.exports = { commands, getCommand, listCommands: () => Object.keys(commands) };

function getCommand(name) {
  const raw = String(name || '').toLowerCase().trim();
  let key = raw;
  try {
    const { resolveKnownCommand } = require('../utils/commandTextParse');
    key = resolveKnownCommand(raw) || raw;
  } catch (_) { /* parse opcional */ }
  if (commands[key]) return commands[key];
  if (commands[raw]) return commands[raw];
  try {
    const { isHanorkIaAlias } = require('./hanorkChat');
    if (isHanorkIaAlias(key) && commands.hanork) return commands.hanork;
  } catch (_) { /* */ }
  return null;
}