// commands/raikken.js — controle da host Raikken (Pterodactyl Client API)
'use strict';

const rk = require('../services/raikkenService');
const logger = require('../logger');

const commands = {};

function isPlatformAdminCtx(ctx) {
  return !!(
    ctx &&
    (ctx.isPlatformAdmin ||
      ctx.authRole === 'platform_admin' ||
      ctx.role === 'platform_admin')
  );
}

function hostOpsSecret() {
  return String(process.env.HANORK_HOST_OPS_SECRET || '').trim();
}

function rawArgsText(ctx) {
  return String(ctx.text || ctx.q || '').trim();
}

async function deny(conn, ctx, text) {
  await conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
  return false;
}

/**
 * Onda2.6: host* = so platform_admin (+ PIN se HANORK_HOST_OPS_SECRET setado).
 * Dono de sessao cliente nao controla o egg mesmo se gate de owner falhar no futuro.
 */
async function gate(conn, ctx) {
  if (!isPlatformAdminCtx(ctx)) {
    await deny(
      conn,
      ctx,
      'Host so TELEGRAM_ADMIN (platform_admin). Dono de sessao cliente nao controla o servidor.'
    );
    return false;
  }
  const secret = hostOpsSecret();
  if (secret) {
    const raw = rawArgsText(ctx);
    // Menu host / hoststatus sem args: ainda pedem PIN no texto da msg (ou q)
    // Aceita PIN em qualquer posicao; comandos sem texto livre usam ctx.q
    const blob = `${raw} ${String(ctx.args || '').trim()}`.trim();
    if (!blob.includes(secret)) {
      await deny(
        conn,
        ctx,
        'Falta o PIN da host. Inclua HANORK_HOST_OPS_SECRET no comando (2o fator).'
      );
      return false;
    }
  }
  if (!rk.isConfigured()) {
    await deny(
      conn,
      ctx,
      'Host nao configurada. No .env da host coloque:\nRAIKKEN_PANEL_URL=\nRAIKKEN_API_KEY=\nRAIKKEN_SERVER_ID='
    );
    return false;
  }
  return true;
}

async function reply(conn, ctx, text) {
  const body = String(text || '').slice(0, 3500);
  await conn.sendMessage(ctx.from, { text: body }, { quoted: ctx.info });
}

function argsText(ctx) {
  let t = rawArgsText(ctx);
  const secret = hostOpsSecret();
  if (secret && t.includes(secret)) {
    t = t.split(secret).join(' ').replace(/\s+/g, ' ').trim();
  }
  return t;
}

function splitArgs(ctx) {
  return argsText(ctx).split(/\s+/).filter(Boolean);
}

const MENU = [
  'HOST RAIKKEN (API Client)',
  '',
  'Status / energia:',
  '{p}hoststatus',
  '{p}hoststart | {p}hoststop | {p}hostrestart | {p}hostkill',
  '{p}hostconsole [linhas]',
  '{p}hostcmd <comando>',
  '',
  'Arquivos:',
  '{p}hostls [pasta]',
  '{p}hostcat <arquivo>',
  '{p}hostwrite <arquivo> <conteudo>',
  '{p}hostmkdir <pasta>',
  '{p}hostrm <arquivo|pasta>',
  '{p}hostrename <de> <para>',
  '{p}hostcp <arquivo>',
  '{p}hostzip <arquivo...>',
  '{p}hostunzip <arquivo.zip>',
  '{p}hostpull <url> [pasta]',
  '{p}hostdl <arquivo>',
  '',
  'Backup / rede / info:',
  '{p}hostbackups | {p}hostbackup [nome]',
  '{p}hostbackupdel <uuid>',
  '{p}hostbackuprestore <uuid> confirmar',
  '{p}hostnet | {p}hoststartup | {p}hostactivity',
  '{p}hostdb | {p}hostusers | {p}hostschedules',
  '{p}hostaccount | {p}hostservers | {p}hostapikeys',
  '{p}hostrenameserver <nome>',
  '{p}hostreinstall confirmar'
].join('\n');

commands.host = {
  useCtx: true,
  description: 'Menu da host Raikken',
  usage: 'host',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const { displayPrefix } = require('../utils/configManager');
    const p = displayPrefix(ctx.telegramUserId, { platform: ctx.platform || 'whatsapp', prefix: ctx.prefix });
    await reply(conn, ctx, MENU.replace(/\{p\}/g, p));
  }
};
commands.hostmenu = commands.host;
commands.raikken = commands.host;

commands.hoststatus = {
  useCtx: true,
  description: 'Status CPU/RAM/disco da host',
  usage: 'hoststatus',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      await reply(conn, ctx, await rk.statusReport());
    } catch (e) {
      await reply(conn, ctx, `Falha status: ${e.message}`);
    }
  }
};
commands.hostinfo = commands.hoststatus;
commands.hostres = commands.hoststatus;

function powerCmd(signal, label) {
  return {
    useCtx: true,
    description: `${label} servidor na host`,
    usage: `host${signal}`,
    execute: async (conn, ctx) => {
      if (!(await gate(conn, ctx))) return;
      try {
        await rk.power(signal);
        await reply(conn, ctx, `Host: sinal ${signal} enviado.`);
      } catch (e) {
        await reply(conn, ctx, `Falha ${signal}: ${e.message}`);
      }
    }
  };
}

commands.hoststart = powerCmd('start', 'Liga');
commands.hoststop = powerCmd('stop', 'Para');
commands.hostrestart = powerCmd('restart', 'Reinicia');
commands.hostkill = {
  useCtx: true,
  description: 'Kill forcado do processo na host',
  usage: 'hostkill confirmar',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    if (!/confirmar/i.test(argsText(ctx))) {
      return reply(conn, ctx, 'Kill e forcado. Use: hostkill confirmar');
    }
    try {
      await rk.power('kill');
      await reply(conn, ctx, 'Host: kill enviado.');
    } catch (e) {
      await reply(conn, ctx, `Falha kill: ${e.message}`);
    }
  }
};

commands.hostcmd = {
  useCtx: true,
  description: 'Envia comando ao console da host',
  usage: 'hostcmd <comando>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const cmd = argsText(ctx);
    if (!cmd) return reply(conn, ctx, 'Uso: hostcmd <comando>');
    try {
      await rk.sendCommand(cmd);
      await reply(conn, ctx, `Comando enviado ao console:\n${cmd.slice(0, 200)}`);
    } catch (e) {
      await reply(conn, ctx, `Falha cmd: ${e.message}`);
    }
  }
};

commands.hostconsole = {
  useCtx: true,
  description: 'Ultimas linhas do console da host',
  usage: 'hostconsole [linhas]',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const n = Math.min(80, Math.max(10, parseInt(splitArgs(ctx)[0], 10) || 40));
    try {
      await reply(conn, ctx, 'Lendo console...');
      const lines = await rk.fetchConsoleTail(n, 6000);
      const text = lines.length ? lines.join('') : '(console vazio ou sem saida em 6s)';
      await reply(conn, ctx, `CONSOLE HOST (ultimas ~${n})\n\n${text.slice(-3200)}`);
    } catch (e) {
      await reply(conn, ctx, `Falha console: ${e.message}`);
    }
  }
};
commands.hostclog = commands.hostconsole;

commands.hostls = {
  useCtx: true,
  description: 'Lista arquivos na host',
  usage: 'hostls [pasta]',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const dir = argsText(ctx) || '/';
    try {
      const data = await rk.listFiles(dir);
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        const tag = a.is_file ? 'F' : 'D';
        return `${tag} ${a.name} (${rk.fmtBytes(a.size || 0)})`;
      });
      await reply(conn, ctx, `LS ${rk.normPath(dir)}\n${rows.slice(0, 60).join('\n') || '(vazio)'}`);
    } catch (e) {
      await reply(conn, ctx, `Falha ls: ${e.message}`);
    }
  }
};

commands.hostcat = {
  useCtx: true,
  description: 'Le arquivo da host',
  usage: 'hostcat <arquivo>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const file = argsText(ctx);
    if (!file) return reply(conn, ctx, 'Uso: hostcat <arquivo>');
    if (/\.env($|\.)/i.test(file) || /credentials|token/i.test(file)) {
      return reply(conn, ctx, 'Leitura bloqueada neste path (segredo).');
    }
    try {
      const body = await rk.readFile(file);
      const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      await reply(conn, ctx, `${rk.normPath(file)}\n\n${text.slice(0, 3200)}`);
    } catch (e) {
      await reply(conn, ctx, `Falha cat: ${e.message}`);
    }
  }
};
commands.hostread = commands.hostcat;

commands.hostwrite = {
  useCtx: true,
  description: 'Escreve arquivo na host',
  usage: 'hostwrite <arquivo> <conteudo>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const raw = argsText(ctx);
    const m = raw.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return reply(conn, ctx, 'Uso: hostwrite <arquivo> <conteudo>');
    const file = m[1];
    const content = m[2];
    if (/\.env($|\.)/i.test(file)) {
      return reply(conn, ctx, 'Escrita em .env bloqueada pelo bot (edite no painel).');
    }
    try {
      await rk.writeFile(file, content);
      await reply(conn, ctx, `Escrito: ${rk.normPath(file)} (${Buffer.byteLength(content)} bytes)`);
    } catch (e) {
      await reply(conn, ctx, `Falha write: ${e.message}`);
    }
  }
};

commands.hostmkdir = {
  useCtx: true,
  description: 'Cria pasta na host',
  usage: 'hostmkdir <pasta>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const p = rk.normPath(argsText(ctx));
    if (!p || p === '/') return reply(conn, ctx, 'Uso: hostmkdir <pasta>');
    const parts = p.split('/').filter(Boolean);
    const name = parts.pop();
    const root = '/' + parts.join('/');
    try {
      await rk.createFolder(root || '/', name);
      await reply(conn, ctx, `Pasta criada: ${p}`);
    } catch (e) {
      await reply(conn, ctx, `Falha mkdir: ${e.message}`);
    }
  }
};

commands.hostrm = {
  useCtx: true,
  description: 'Apaga arquivo/pasta na host',
  usage: 'hostrm <path> confirmar',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const parts = splitArgs(ctx);
    if (parts.length < 2 || !/confirmar/i.test(parts[parts.length - 1])) {
      return reply(conn, ctx, 'Uso: hostrm <path> confirmar');
    }
    const target = parts.slice(0, -1).join(' ');
    const full = rk.normPath(target);
    if (full === '/' || full === '/.env' || /^\/(session|data|node_modules)(\/|$)/i.test(full)) {
      return reply(conn, ctx, 'Path protegido — apague pelo painel se precisar.');
    }
    const root = full.split('/').slice(0, -1).join('/') || '/';
    const name = full.split('/').pop();
    try {
      await rk.deleteFiles(root, [name]);
      await reply(conn, ctx, `Apagado: ${full}`);
    } catch (e) {
      await reply(conn, ctx, `Falha rm: ${e.message}`);
    }
  }
};

commands.hostrename = {
  useCtx: true,
  description: 'Renomeia arquivo na host',
  usage: 'hostrename <de> <para>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const parts = splitArgs(ctx);
    if (parts.length < 2) return reply(conn, ctx, 'Uso: hostrename <de> <para>');
    const from = rk.normPath(parts[0]);
    const toName = parts[1].replace(/^\/+/, '');
    const root = from.split('/').slice(0, -1).join('/') || '/';
    const fromName = from.split('/').pop();
    try {
      await rk.renameFiles(root, [{ from: fromName, to: toName }]);
      await reply(conn, ctx, `Renomeado: ${fromName} → ${toName}`);
    } catch (e) {
      await reply(conn, ctx, `Falha rename: ${e.message}`);
    }
  }
};

commands.hostcp = {
  useCtx: true,
  description: 'Copia arquivo na host',
  usage: 'hostcp <arquivo>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const file = argsText(ctx);
    if (!file) return reply(conn, ctx, 'Uso: hostcp <arquivo>');
    try {
      await rk.copyFile(file);
      await reply(conn, ctx, `Copia criada de ${rk.normPath(file)}`);
    } catch (e) {
      await reply(conn, ctx, `Falha cp: ${e.message}`);
    }
  }
};

commands.hostzip = {
  useCtx: true,
  description: 'Compacta arquivos na host',
  usage: 'hostzip <arquivo...>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const files = splitArgs(ctx);
    if (!files.length) return reply(conn, ctx, 'Uso: hostzip <arquivo...>');
    try {
      const r = await rk.compressFiles('/', files);
      const name = r?.attributes?.name || 'arquivo.zip';
      await reply(conn, ctx, `Compactado: ${name}`);
    } catch (e) {
      await reply(conn, ctx, `Falha zip: ${e.message}`);
    }
  }
};

commands.hostunzip = {
  useCtx: true,
  description: 'Descompacta zip na host',
  usage: 'hostunzip <arquivo.zip>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const file = argsText(ctx);
    if (!file) return reply(conn, ctx, 'Uso: hostunzip <arquivo.zip>');
    const full = rk.normPath(file);
    const root = full.split('/').slice(0, -1).join('/') || '/';
    const name = full.split('/').pop();
    try {
      await rk.decompressFile(root, name);
      await reply(conn, ctx, `Descompactado: ${full}`);
    } catch (e) {
      await reply(conn, ctx, `Falha unzip: ${e.message}`);
    }
  }
};

commands.hostpull = {
  useCtx: true,
  description: 'Baixa URL direto pra host',
  usage: 'hostpull <url> [pasta]',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const parts = splitArgs(ctx);
    if (!parts[0] || !/^https?:\/\//i.test(parts[0])) {
      return reply(conn, ctx, 'Uso: hostpull <url> [pasta]');
    }
    try {
      await rk.pullRemoteFile(parts[0], parts[1] || '/');
      await reply(conn, ctx, `Pull iniciado: ${parts[0]}`);
    } catch (e) {
      await reply(conn, ctx, `Falha pull: ${e.message}`);
    }
  }
};

commands.hostdl = {
  useCtx: true,
  description: 'Baixa arquivo da host pro chat',
  usage: 'hostdl <arquivo>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const file = argsText(ctx);
    if (!file) return reply(conn, ctx, 'Uso: hostdl <arquivo>');
    if (/\.env($|\.)/i.test(file)) return reply(conn, ctx, 'Download de .env bloqueado.');
    try {
      const data = await rk.getDownloadUrl(file);
      const url = data?.attributes?.url || data?.url;
      if (!url) return reply(conn, ctx, 'URL de download indisponivel.');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) {
        return reply(conn, ctx, `Arquivo grande (${rk.fmtBytes(buf.length)}). Link (expira):\n${url}`);
      }
      const name = rk.normPath(file).split('/').pop() || 'file.bin';
      await conn.sendMessage(
        ctx.from,
        { document: buf, fileName: name, mimetype: 'application/octet-stream' },
        { quoted: ctx.info }
      );
    } catch (e) {
      await reply(conn, ctx, `Falha dl: ${e.message}`);
    }
  }
};

commands.hostbackups = {
  useCtx: true,
  description: 'Lista backups da host',
  usage: 'hostbackups',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.listBackups();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        return `${(a.uuid || '').slice(0, 8)}… ${a.name || 'backup'} ${a.is_successful === false ? 'FAIL' : 'OK'} ${rk.fmtBytes(a.bytes || 0)}`;
      });
      const meta = data.meta || {};
      await reply(
        conn,
        ctx,
        `BACKUPS (${meta.backup_count ?? rows.length})\n${rows.join('\n') || '(nenhum)'}\n\nCriar: hostbackup [nome]`
      );
    } catch (e) {
      await reply(conn, ctx, `Falha backups: ${e.message}`);
    }
  }
};

commands.hostbackup = {
  useCtx: true,
  description: 'Cria backup na host',
  usage: 'hostbackup [nome]',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const r = await rk.createBackup(argsText(ctx) || null);
      const a = r?.attributes || {};
      await reply(conn, ctx, `Backup iniciado: ${(a.uuid || '').slice(0, 8)}… ${a.name || ''}`);
    } catch (e) {
      await reply(conn, ctx, `Falha backup: ${e.message}`);
    }
  }
};

commands.hostbackupdel = {
  useCtx: true,
  description: 'Apaga backup da host',
  usage: 'hostbackupdel <uuid> confirmar',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const parts = splitArgs(ctx);
    if (parts.length < 2 || !/confirmar/i.test(parts[1])) {
      return reply(conn, ctx, 'Uso: hostbackupdel <uuid> confirmar');
    }
    try {
      await rk.deleteBackup(parts[0]);
      await reply(conn, ctx, 'Backup apagado.');
    } catch (e) {
      await reply(conn, ctx, `Falha: ${e.message}`);
    }
  }
};

commands.hostbackuprestore = {
  useCtx: true,
  description: 'Restaura backup (perigoso)',
  usage: 'hostbackuprestore <uuid> confirmar',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const parts = splitArgs(ctx);
    if (parts.length < 2 || !/confirmar/i.test(parts[1])) {
      return reply(conn, ctx, 'PERIGO: sobrescreve arquivos.\nUso: hostbackuprestore <uuid> confirmar');
    }
    try {
      await rk.restoreBackup(parts[0]);
      await reply(conn, ctx, 'Restore iniciado. Aguarde o painel.');
    } catch (e) {
      await reply(conn, ctx, `Falha restore: ${e.message}`);
    }
  }
};

commands.hostnet = {
  useCtx: true,
  description: 'Alocacoes de rede da host',
  usage: 'hostnet',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.listAllocations();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        return `${a.ip_alias || a.ip}:${a.port}${a.is_default ? ' (default)' : ''}`;
      });
      await reply(conn, ctx, `REDE\n${rows.join('\n') || '(vazio)'}`);
    } catch (e) {
      await reply(conn, ctx, `Falha net: ${e.message}`);
    }
  }
};

commands.hoststartup = {
  useCtx: true,
  description: 'Variaveis de startup da host',
  usage: 'hoststartup',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.getStartup();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        const val = String(a.server_value ?? a.default_value ?? '').slice(0, 80);
        return `${a.env_variable || a.name}=${val}`;
      });
      await reply(
        conn,
        ctx,
        `STARTUP\n${rows.slice(0, 40).join('\n') || '(vazio)'}\n\nAlterar: hostsetvar NOME valor`
      );
    } catch (e) {
      await reply(conn, ctx, `Falha startup: ${e.message}`);
    }
  }
};

commands.hostsetvar = {
  useCtx: true,
  description: 'Altera variavel de startup',
  usage: 'hostsetvar <NOME> <valor>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const parts = splitArgs(ctx);
    if (parts.length < 2) return reply(conn, ctx, 'Uso: hostsetvar <NOME> <valor>');
    const key = parts[0];
    const value = parts.slice(1).join(' ');
    try {
      await rk.updateStartupVariable(key, value);
      await reply(conn, ctx, `Variavel ${key} atualizada.`);
    } catch (e) {
      await reply(conn, ctx, `Falha setvar: ${e.message}`);
    }
  }
};

commands.hostactivity = {
  useCtx: true,
  description: 'Log de atividade do painel',
  usage: 'hostactivity',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.getActivity(1);
      const rows = (data.data || []).slice(0, 15).map((x) => {
        const a = x.attributes || {};
        const ev = a.event || a.event_type || '?';
        const when = (a.timestamp || a.created_at || '').toString().slice(0, 19);
        return `${when} ${ev}`;
      });
      await reply(conn, ctx, `ACTIVITY\n${rows.join('\n') || '(vazio)'}`);
    } catch (e) {
      await reply(conn, ctx, `Falha activity: ${e.message}`);
    }
  }
};

commands.hostdb = {
  useCtx: true,
  description: 'Lista databases da host',
  usage: 'hostdb',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.listDatabases();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        return `${a.name || a.database} @ ${a.host?.address || a.host || '?'}`;
      });
      await reply(conn, ctx, `DATABASES\n${rows.join('\n') || '(nenhuma)'}`);
    } catch (e) {
      await reply(conn, ctx, `Falha db: ${e.message}`);
    }
  }
};

commands.hostusers = {
  useCtx: true,
  description: 'Subusuarios da host',
  usage: 'hostusers',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.listSubusers();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        return `${a.username || a.email || a.uuid}`;
      });
      await reply(conn, ctx, `SUBUSERS\n${rows.join('\n') || '(nenhum)'}`);
    } catch (e) {
      await reply(conn, ctx, `Falha users: ${e.message}`);
    }
  }
};

commands.hostschedules = {
  useCtx: true,
  description: 'Agendamentos da host',
  usage: 'hostschedules',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.listSchedules();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        return `${a.name || a.id} active=${a.is_active}`;
      });
      await reply(conn, ctx, `SCHEDULES\n${rows.join('\n') || '(nenhum)'}`);
    } catch (e) {
      await reply(conn, ctx, `Falha schedules: ${e.message}`);
    }
  }
};

commands.hostaccount = {
  useCtx: true,
  description: 'Conta do painel (sem senha)',
  usage: 'hostaccount',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.getAccount();
      const a = data.attributes || {};
      await reply(
        conn,
        ctx,
        [
          'CONTA PAINEL',
          `User: ${a.username || '-'}`,
          `Email: ${rk.maskEmail(a.email)}`,
          `Admin painel: ${a.admin ? 'sim' : 'nao'}`,
          `Nome: ${a.first_name || ''} ${a.last_name || ''}`.trim()
        ].join('\n')
      );
    } catch (e) {
      await reply(conn, ctx, `Falha account: ${e.message}`);
    }
  }
};

commands.hostservers = {
  useCtx: true,
  description: 'Lista servidores da conta',
  usage: 'hostservers',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.listServers();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        return `${a.identifier} ${a.name} (${a.node})`;
      });
      await reply(conn, ctx, `SERVERS\n${rows.join('\n') || '(vazio)'}`);
    } catch (e) {
      await reply(conn, ctx, `Falha servers: ${e.message}`);
    }
  }
};

commands.hostapikeys = {
  useCtx: true,
  description: 'Lista API keys (so identificador)',
  usage: 'hostapikeys',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    try {
      const data = await rk.listApiKeys();
      const rows = (data.data || []).map((x) => {
        const a = x.attributes || {};
        return `${a.identifier} — ${a.description || 'sem desc'} (${(a.created_at || '').toString().slice(0, 10)})`;
      });
      await reply(conn, ctx, `API KEYS (prefixo)\n${rows.join('\n') || '(vazio)'}\n\nChave completa so no painel.`);
    } catch (e) {
      await reply(conn, ctx, `Falha apikeys: ${e.message}`);
    }
  }
};

commands.hostrenameserver = {
  useCtx: true,
  description: 'Renomeia servidor no painel',
  usage: 'hostrenameserver <nome>',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    const name = argsText(ctx);
    if (!name) return reply(conn, ctx, 'Uso: hostrenameserver <nome>');
    try {
      await rk.renameServer(name);
      await reply(conn, ctx, `Nome do servidor: ${name}`);
    } catch (e) {
      await reply(conn, ctx, `Falha rename server: ${e.message}`);
    }
  }
};

commands.hostreinstall = {
  useCtx: true,
  description: 'Reinstala egg (APAGA arquivos)',
  usage: 'hostreinstall confirmar',
  execute: async (conn, ctx) => {
    if (!(await gate(conn, ctx))) return;
    if (!/confirmar/i.test(argsText(ctx))) {
      return reply(conn, ctx, 'PERIGO: apaga o disco do container.\nUso: hostreinstall confirmar');
    }
    try {
      await rk.reinstallServer();
      await reply(conn, ctx, 'Reinstall iniciado no painel.');
    } catch (e) {
      await reply(conn, ctx, `Falha reinstall: ${e.message}`);
    }
  }
};

module.exports = { commands };
