# hanork-beta

Bot multiusuário de WhatsApp e Telegram para loja, grupo, divulgação e cobrança. O painel fica no Telegram. Cada usuário pareia o próprio WhatsApp. A lógica de comando, permissão e venda é a mesma nos dois canais.

Versão do pacote: `hanork-bot` 2.0.0. Entrada: `index.js`. Node.js 18 ou superior.

## Índice

- [O que o projeto faz](#o-que-o-projeto-faz)
- [Instalação e execução](#instalação-e-execução)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Arquitetura](#arquitetura)
- [Módulos e comandos](#módulos-e-comandos)
- [Permissões](#permissões)
- [Integrações](#integrações)
- [Operação](#operação)
- [Segurança](#segurança)
- [Dívidas e riscos](#dívidas-e-riscos)
- [Changelog](#changelog)
- [Uso responsável](#uso-responsável)
- [Licença](#licença)

## O que o projeto faz

- Pareia várias sessões de WhatsApp a partir de um bot de Telegram (`/start`, conectar por QR ou código).
- Protege grupo (antilink, boas-vindas, anti-roubo de admin, listas).
- Divulga em grupos e status, com painel e fila.
- Cobra PIX e cartão da loja do dono da sessão (Mercado Pago), sem misturar isso com plano do próprio bot.
- Downloads, figurinhas, menus e um roteador de comandos com níveis de acesso.
- Consultas e OSINT existem no código. Trate dados pessoais conforme a LGPD. Não use isso para consultar terceiros sem base legal.

O bot não é um catálogo infinito de comandos. O menu público mostra o que a sessão pode usar.

## Instalação e execução

```bash
npm ci
cp .env.example .env
npm start
```

No Windows, `start.bat` sobe o mesmo processo. `start-supervised.bat` reinicia se o processo cair.

Docker (API + Redis opcional):

```bash
docker compose up --build
```

Atalhos úteis:

| Comando | Função |
|---|---|
| `npm start` | Sobe o bot (`node index.js`) |
| `npm test` | Checagem de sintaxe dos entrypoints e smokes leves |
| `npm run pg:schema` | Aplica o schema Postgres, se `HANORK_PG_URL` existir |
| `npm run intent:smoke` | Smoke do roteador de intenção |

Sem `TELEGRAM_BOT_TOKEN` válido o processo chega a subir o health e falha na API do Telegram. Isso é esperado com valor falso. `Cannot find module` não é esperado.

Pastas `data/` e `logs/` são criadas em runtime e não entram no Git (só `.gitkeep`). Sessões WhatsApp, SQLite e `.env` ficam só na máquina.

## Variáveis de ambiente

A lista completa, com comentários, está no [`.env.example`](.env.example). Nenhum valor real vai no repositório. Copie o arquivo para `.env` e preencha localmente.

Grupos que o código lê via `process.env`:

| Grupo | Nomes |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_IDS`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_CHANNEL_LINK` |
| WhatsApp / sessão | `MAX_SESSIONS`, `WHATSAPP_CANAL_ID`, `WHATSAPP_CANAL_LINK`, `HANORK_CONTACT_WA`, `META_AI_JID` |
| Mercado Pago | `MP_ACCESS_TOKEN` ou `TOKEN_MP`, `MP_WEBHOOK_SECRET`, `MP_PUBLIC_URL`, `MP_PAYER_EMAIL`, `MP_PAYER_CPF` |
| Postgres / Redis | `HANORK_PG_URL`, `HANORK_DB_DRIVER`, `REDIS_URL`, `ENABLE_BULL` |
| IA | `ZEROTWO_API_KEY`, `ZEROTWO_API_BASE`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_ENABLED` |
| Host opcional | `RAIKKEN_PANEL_URL`, `RAIKKEN_API_KEY`, `RAIKKEN_SERVER_ID` |
| Cobrança do produto | `HANORK_PAYWALL` (padrão desligado) |

`HANORK_PAYWALL` permanece desligado até você ligar de propósito. Não commite o `.env`.

## Arquitetura

```
Telegram (painel) -> telegramBot.js -> activeConnections
                         |
                         v
              restoreAllSessions / pareamento
                         |
WhatsApp (Baileys) <- connection.js <- sessionRegistry
                         |
                         v
                   messageHandler
                         |
                         v
              Universal Router -> commands/*
```

| Peça | Onde | Papel |
|---|---|---|
| Boot | `index.js` | Health cedo, restaura sessões, sobe o polling do Telegram, desliga com SIGINT/SIGTERM |
| WhatsApp | `connection.js` | Socket Baileys, reconexão com teto, eventos open/close |
| Telegram | `telegramBot.js` | Bot de controle, lock de instância em `data/.telegram_bot.lock` |
| Registry | `utils/sessionRegistry.js` | Metadados das sessões. O socket não fica no JSON |
| Usuários | `utils/userManager.js` | `data/users/<id>/` |
| Router | `core/router/` | Normaliza mensagem, permissão, rate limit |
| Fila | `services/jobQueue.js` | Bull se houver Redis. Senão, fila no processo |
| Health | `services/healthServer.js` | `GET /health` e `GET /ready` |
| Banco | `database/`, `sql/` | SQLite no dia a dia. Postgres é cutover opcional (`HANORK_PG_*`) |

Estado crítico de sessão do Baileys fica em disco (`session/`, ignorado pelo Git). Fila sem Redis não sobrevive a restart. Pagamento confirmado fica no SQL, com idempotência no fluxo do Mercado Pago.

## Módulos e comandos

Há centenas de chaves registradas. A classificação vigente é `classify()` em `registeredCommands.js`, não uma lista solta. Resumo por arquivo:

| Área | Arquivo | Exemplos |
|---|---|---|
| Geral | `commands/general.js`, `commands/help.js` | menu, ping, stats, sobre |
| Config | `commands/config.js` | prefixo, donos, botões |
| Grupos | `commands/groups.js`, `commands/groupMod.js` | admin de grupo, nuke |
| Proteção | `commands/groupsecurity.js`, `utils/moderation.js` | antilink, anti-admin, listas |
| Mensagens | `commands/messages.js`, `commands/interactive.js` | envio, botões, listas |
| Divulgação | `commands/divulgar/`, `divulgacao.js` | divmenu, slots, status |
| Downloads | `commands/downloads.js` | play, tiktok, instagram, spotify |
| Figurinhas | `commands/figurinhaCanal.js` e serviços | figurinha, canal |
| Consultas | `commands/consultas.js` | menu de consultas (só no privado do dono) |
| Billing | `services/billing/` | PIX, preferência, webhook, poll |
| IA | `core/intent/`, `core/router/intent/` | roteamento e fallback |
| Admin | `commands/admin.js` | sessão, saúde, dono |

Prefixo padrão no WhatsApp: `.` (configurável por sessão). No Telegram os comandos de painel usam `/`.

## Permissões

Fonte: `utils/permissionEngine.js`.

| Nível | Quem | Uso |
|---|---|---|
| platform_admin | IDs em `TELEGRAM_ADMIN_IDS` | Operação da plataforma |
| owner | Dono da sessão | Comandos da própria sessão |
| vip | Lista VIP / plano | Comandos VIP |
| adm | Admin nativo daquele grupo | Moderação daquele grupo |
| user | Padrão | Comandos públicos |

Admin de um grupo não vira dono do bot. Comandos sensíveis (nuke, divulgação em massa, addvip, sessão, cobrança) não descem para `user`.

## Integrações

| Serviço | Uso |
|---|---|
| `@systemzero/baileys` | Sessão WhatsApp |
| `node-telegram-bot-api` | Painel Telegram (polling) |
| Mercado Pago | PIX e checkout. Webhook em `MP_PUBLIC_URL`. Poll de PIX como rede de segurança |
| Redis + Bull | Fila opcional (`REDIS_URL`, `ENABLE_BULL`) |
| Postgres | Espelho / cutover (`HANORK_PG_URL`). Sem a URL, o runtime segue no SQLite |
| Ollama / Zero Two | IA local ou API. Sem chave, o caminho de IA fica desligado |
| CheckData, Zone, Duck, Mind7 | Consultas externas. Só com token no `.env` |
| Twilio / SendGrid | SMS e e-mail opcionais |
| Raikken | Client API do painel, opcional, só com as três variáveis `RAIKKEN_*` |

Não espalhe token de Mercado Pago pelo código. O cliente HTTP está em `services/billing/mercadoPagoService.js`.

## Operação

Health:

- Com `SERVER_PORT` definido (ambiente gerenciado), escuta nesse porto.
- Sem `SERVER_PORT`, o padrão local é `127.0.0.1` e `HEALTH_PORT` (3847 se vazio).
- `GET /health` agrega grau, memória e comandos. Não devolve token nem id de usuário.

Backup:

- `HANORK_DB_BACKUP=1` gera snapshot do SQLite em `data/backups`.
- O snapshot não inclui `.env` nem pastas de sessão do Baileys.
- Para restaurar, pare o processo, troque o arquivo do banco pelo snapshot e suba de novo. Sessões WhatsApp continuam nas pastas de auth, que você copia à parte.

Reinício:

- SIGINT/SIGTERM soltam o lock do Telegram e fecham o health.
- Sessões são restauradas no boot a partir do registry. QR expirado marca a sessão para parear de novo em vez de ficar em `connecting` para sempre.

Runbook curto:

1. Confira `/health`.
2. Se o Telegram não responde, veja se outro processo segurou `data/.telegram_bot.lock`.
3. Se o WhatsApp caiu, pareie de novo pelo painel. Não apague a pasta de sessão sem querer.
4. Pagamento duplicado: o fluxo de entrega usa o id do pagamento. Um webhook repetido não deve entregar duas vezes. Se suspeitar, olhe a tabela de billing antes de reenviar produto.

## Segurança

- Segredos só no `.env`, fora do Git.
- Webhook do Mercado Pago exige assinatura fora do sandbox. `MP_ALLOW_UNSIGNED_WEBHOOK` não deve ficar ligado em produção.
- Consulta com dado pessoal não responde no grupo. Vai para o privado de quem tem permissão.
- Logs não devem imprimir token, senha, cookie ou credencial de sessão.
- Identificadores de grupo, telefone e canal vêm do ambiente (`HANORK_DIV_INVITE_GROUP`, `HANORK_CONTACT_WA`, `TELEGRAM_CHANNEL_ID`, `META_AI_JID`), não do código.
- Scripts `scripts/deploy-raikken.js` e `scripts/fetch-*.js` só falam com o painel se `RAIKKEN_*` estiver preenchido. Não há id de servidor padrão.

## Dívidas e riscos

- SQLite ainda é o banco do dia a dia. Postgres está preparado e o cutover é parcial.
- Parte do estado (mapa de conexões, alguns rate limits) vive em RAM e se perde no restart.
- Fila sem Redis não tem retry durável nem dead letter.
- Um processo concentra as sessões WhatsApp. Uma sessão travada ainda pode pressionar o mesmo processo. Há teto de concorrência e watchdog de memória.
- OSINT e consultas de CPF/telefone são superfície sensível. Mantenha desligadas se não houver necessidade e base legal.
- Comandos de travamento/exploit não são ferramenta de uso geral. Ficam no nível `platform_admin`.

## Changelog

Condensado do histórico de produto, sem notas de host:

- Menus de dono e admin, proteção de grupo e anti-roubo com reversão.
- Billing Mercado Pago (PIX, cartão, poll, webhook com assinatura).
- Divulgação automática, slots CTA/status e convite do grupo resolvido na hora.
- Universal Router, intenção, circuit breaker e alertas de operação.
- Backup diário do SQLite, health `/health` e `/ready`, shutdown sem derrubar o processo em erro solto de WhatsApp.
- Identidade LID/telefone unificada para não promover usuário comum a dono.
- Postgres: schema e dual-write opcionais, atrás de flag.

## Uso responsável

Use o bot dentro dos termos do WhatsApp e do Telegram e da LGPD. Não use divulgação, consulta ou moderação para spam, fraude, coleta de dados de terceiros ou invasão de grupos. Quem opera a sessão é responsável pelos números pareados e pelos dados que o bot processar.

## Licença

MIT. Veja [LICENSE](LICENSE).
