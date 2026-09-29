#!/usr/bin/env node
'use strict';
// Gera core/intent/commands-schema.json a partir do Universal Router + menuCatalog

const fs = require('fs');
const path = require('path');
const { buildCatalog } = require('../core/router/intent/catalog');
const { getCommandMinLevel, roleCanAccess } = require('../core/router/registeredCommands');
const { isFreeTextCommand } = require('../utils/commandTextParse');

const OUT = path.join(__dirname, '../core/intent/commands-schema.json');

function parseUsageParams(usage, command) {
  const u = String(usage || command || '').trim();
  const params = [];
  const angle = u.match(/<([^>]+)>/g) || [];
  const bracket = u.match(/\[([^\]]+)\]/g) || [];

  for (const m of angle) {
    const name = m.slice(1, -1).trim().toLowerCase().replace(/\s+/g, '_');
    params.push({ name, type: 'string', required: true });
  }
  for (const m of bracket) {
    const name = m.slice(1, -1).trim().toLowerCase().replace(/\s+/g, '_');
    params.push({ name, type: 'string', required: false });
  }

  if (!params.length && isFreeTextCommand(command)) {
    params.push({ name: 'query', type: 'string', required: true });
  }
  if (!params.length && /\s/.test(u.replace(command, '').trim())) {
    params.push({ name: 'args', type: 'string', required: false });
  }
  return params;
}

function main() {
  const catalog = buildCatalog(true);
  const schema = {
    generatedAt: new Date().toISOString(),
    count: 0,
    commands: []
  };

  for (const entry of catalog) {
    const permission = getCommandMinLevel(entry.command);
    const examples = Array.isArray(entry.phrases) ? entry.phrases.slice(0, 8) : [];
    schema.commands.push({
      command: entry.command,
      description: entry.description || entry.command,
      usage: entry.usage || entry.command,
      category: entry.category || 'extra',
      permission,
      sensitive: !!entry.sensitive,
      destructive: !!entry.destructive || !!entry.sensitive && /^(nuke|ban|apagar|apaga|delete|leave|banall|bangp)/i.test(entry.command),
      platforms: entry.platforms || ['whatsapp', 'telegram'],
      params: parseUsageParams(entry.usage, entry.command),
      needsArgs: !!entry.needsArgs,
      examples
    });
  }

  schema.count = schema.commands.length;
  schema.commands.sort((a, b) => a.command.localeCompare(b.command));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(schema, null, 2), 'utf8');
  console.log(`commands-schema.json: ${schema.count} comandos -> ${OUT}`);
}

main();
