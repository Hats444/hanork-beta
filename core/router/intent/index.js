// core/router/intent/index.js
// Intent Router — deteccao local (URL/ID) + NLU Ollama (cobertura total via menuCatalog)

const logger = require('../../../logger');
const { listDetectors } = require('./registry');
const { applyConfidence, maskSensitive } = require('./confidence');
const { getIntentConfig, roleMeetsMinLevel } = require('../../../utils/configManager');
const { prefilterCandidates } = require('./prefilter');
const { classifyWithOllama } = require('./nlu');
const { getEntry } = require('./catalog');
const { auditSensitiveIntent } = require('./audit');
const { isSensitiveCommand } = require('./sensitive');
const { extractFreeTextArg, isFreeTextCommand } = require('../../../utils/commandTextParse');
const { normalizeText, phraseSpecificity } = require('../../../utils/phraseMatch');
const { applyIntentSafety } = require('./safety');
const { looksGenericAssistantReply } = require('../../intent/genericReply');

const intentMinLevelLogAt = new Map();

/**
 * Resolve role para o gate minLevel do Intent (antes de prefilter/Ollama).
 * WA: waCtx.authRole / ctxExtras.authRole.
 * TG PV: dono do painel (= owner); TG admin = platform_admin.
 */
function resolveIntentCallerRole(event, ctxExtras = {}) {
  if (ctxExtras.authRole) return String(ctxExtras.authRole);
  if (ctxExtras.waCtx?.authRole) return String(ctxExtras.waCtx.authRole);
  if (ctxExtras.waCtx) {
    try {
      const { isFreshSessionOwner } = require('../../../utils/authorization');
      if (isFreshSessionOwner(ctxExtras.waCtx)) return 'owner';
    } catch (_) { /* ignore */ }
    if (ctxExtras.waCtx.isVip) return 'vip';
  }

  const platform = String(event?.platform || '').toLowerCase();
  const uid = String(ctxExtras.telegramUserId || event?.telegramUserId || event?.userId || '');
  if (platform === 'telegram' && uid) {
    try {
      const { isAdmin } = require('../../../utils/userManager');
      if (isAdmin(uid)) return 'platform_admin';
    } catch (_) {}
    // Painel TG: quem fala no PV e o dono da conta
    const isGroup = !!(event.isGroup || event.raw?.chat?.type === 'group' || event.raw?.chat?.type === 'supergroup');
    if (!isGroup) return 'owner';
    return 'user';
  }
  return 'user';
}

/**
 * Match por frase alias / nome do comando / score do prefiltro — funciona sem Ollama.
 * Prefere a frase MAIS LONGA (mais especifica) entre todos os candidatos.
 */
function matchLocalPhraseIntent(userText, candidates, { minScore = 1.5 } = {}) {
  if (!candidates?.length) return null;
  const textNorm = normalizeText(userText);
  const tokens = textNorm.split(/\s+/).filter(Boolean);

  // Nome do comando exato (ex: "antilinkgp" sem prefixo)
  for (const c of candidates) {
    const cmd = normalizeText(c.command);
    if (!cmd) continue;
    if (textNorm === cmd || (tokens[0] === cmd && tokens.length <= 3)) {
      let query = '';
      if (isFreeTextCommand(c.command) && tokens.length > 1) {
        query = extractFreeTextArg(c.command, userText) || tokens.slice(1).join(' ');
      } else if (tokens.length > 1 && tokens[0] === cmd) {
        query = tokens.slice(1).join(' ');
      }
      return {
        command: c.command,
        confidence: 0.98,
        args: query ? query.split(/\s+/).filter(Boolean) : [],
        query,
        local: true
      };
    }
  }

  let best = null;
  for (const c of candidates) {
    for (const phrase of c.phrases || []) {
      const specificity = phraseSpecificity(textNorm, phrase);
      if (specificity < 0) continue;

      if (!best || specificity > best.specificity) {
        let query = '';
        if (isFreeTextCommand(c.command)) {
          query = extractFreeTextArg(c.command, userText);
        }
        best = {
          command: c.command,
          confidence: 0.97,
          args: query ? query.split(/\s+/).filter(Boolean) : [],
          query,
          local: true,
          specificity,
          phrase: normalizeText(phrase)
        };
      }
    }
  }

  if (best) {
    const { specificity, phrase, ...hit } = best;
    return hit;
  }

  // Score do prefiltro — limiar mais baixo quando Ollama offline/timeout
  const top = candidates[0];
  if (top && top.score >= minScore) {
    // Evita executar sensivel so por keyword fraca
    if (top.sensitive && top.score < 1.2) return null;
    let query = '';
    if (isFreeTextCommand(top.command)) {
      query = extractFreeTextArg(top.command, userText);
    }
    return {
      command: top.command,
      confidence: Math.min(0.94, 0.75 + top.score * 0.1),
      args: query ? query.split(/\s+/).filter(Boolean) : [],
      query,
      local: true
    };
  }

  return null;
}

/** Texto que parece output/erro do proprio bot — nao deve virar Intent/chat */
function looksLikeBotInternalNoise(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^(pensando\.{0,3}|erro\s*:|ia indisponivel)/i.test(t)) return true;
  if (/\b(invalid\s*url|kwai\s*-|rate-overlimit|econnrefused|timeout of \d+ms)\b/i.test(t)) return true;
  if (/^(alerta|banimento automatico|aviso)\b/i.test(t)) return true;
  if (/\bessa mensagem parece ser propaganda\b/i.test(t)) return true;
  // Status progress / blocos tipografados do bot
  if (/^[A-Z][A-Z0-9 _-]{2,20}\n/.test(t) && /\n(Estado|Erro|Consulta|Total)\s*[:=]/m.test(t)) return true;
  if (/^este comando e restrito/i.test(t)) return true;
  if (/^apenas o dono da sessao/i.test(t)) return true;
  if (/^OSINT\b/i.test(t) && t.includes('\n')) return true;
  return false;
}

/**
 * @param {object} event - evento normalizado (eventNormalizer)
 * @param {object} ctxExtras - { conn, bot, telegramUserId, waCtx }
 * @returns {Promise<{ handled: boolean, route?: string, confidence?: number, error?: string }>}
 */
async function processIntentCore(event, ctxExtras = {}) {
  if (!event) return { handled: false };

  // Nunca processar mensagem propria (loop)
  if (event.fromMe || ctxExtras.waCtx?.fromMe) return { handled: false };

  try {
    const wa = ctxExtras.waCtx;
    if (wa) {
      const { isPrivatePersonChat, pvAntiWouldBlock } = require('../../../utils/moderation');
      const tid = ctxExtras.telegramUserId || event.telegramUserId;
      if (isPrivatePersonChat(wa) && pvAntiWouldBlock(wa, tid)) return { handled: true, route: 'antipv' };
    }
  } catch (e) {
    try { require('../../../logger').logAviso(`[ANTIPV] intent: ${e.message}`); } catch (_) {}
  }

  const telegramUserId = ctxExtras.telegramUserId || event.telegramUserId || event.userId || null;
  const cfg = getIntentConfig(telegramUserId);

  if (!cfg.enabled) return { handled: false };
  try {
    const { isOwnerOnlyMode, allowOwnerOnlyActor } = require('../../../utils/ownerOnlyMode');
    if (isOwnerOnlyMode() && !allowOwnerOnlyActor({
      telegramUserId,
      sender: event.userId,
      platform: event.platform,
      isTelegram: event.platform === 'telegram',
      isOwner: !!(ctxExtras.waCtx?.isOwner),
      authRole: ctxExtras.authRole || ctxExtras.waCtx?.authRole,
      conn: ctxExtras.conn
    })) {
      return { handled: true };
    }
  } catch (_) { /* */ }
  if (cfg.explicitCommandsFirst !== false) {
    if (event.command || event.prefix) return { handled: false };
    const full = String(event.fullText || event.text || '').trim();
    if (full.startsWith('/')) return { handled: false };
  }

  const textRaw = String(event.fullText || event.text || '').trim();
  if (!textRaw) return { handled: false };

  let text = textRaw;
  try {
    const {
      inspectInjection,
      sanitizeUserText,
      logInjectionAttempt
    } = require('../../../utils/promptInjection');
    const inj = inspectInjection(textRaw);
    if (inj.hit) {
      logInjectionAttempt({
        telegramUserId,
        sender: event.userId || ctxExtras.waCtx?.sender,
        chatId: event.chatId,
        isGroup: !!(event.isGroup || ctxExtras.waCtx?.isGroup),
        reasons: inj.reasons,
        text: textRaw
      });
      const callerPeek = resolveIntentCallerRole(event, ctxExtras);
      if (!roleMeetsMinLevel(callerPeek, 'vip')) {
        logger.logInfo('[IntentRouter] injection drop (user comum)');
        return { handled: false, miss: { reason: 'injection_drop', topScore: 0, candidates: [] } };
      }
      text = sanitizeUserText(textRaw);
      event.fullText = text;
      event.text = text;
    }
  } catch (e) {
    logger.logAviso(`[IntentRouter] inject gate: ${e.message}`);
  }

  // P0: nao interpretar ruido interno / erros do proprio bot (evita "propaganda" falso)
  if (looksLikeBotInternalNoise(text)) {
    logger.logInfo('[IntentRouter] skip ruido interno do bot');
    return { handled: false, miss: { reason: 'bot_noise', topScore: 0, candidates: [] } };
  }

  // Gate de nivel: Intent NL so vip/dono (configuravel via intentRouter.minLevel)
  const callerRole = resolveIntentCallerRole(event, ctxExtras);
  const minLevel = cfg.minLevel || 'vip';
  if (!roleMeetsMinLevel(callerRole, minLevel)) {
    const uid = String(event.userId || '?');
    const now = Date.now();
    const prev = intentMinLevelLogAt.get(uid) || 0;
    if (now - prev > 30000) {
      intentMinLevelLogAt.set(uid, now);
      logger.logInfo(
        `[IntentRouter] bloqueado por nivel role=${callerRole} minLevel=${minLevel} user=${uid}`
      );
    }
    return {
      handled: false,
      miss: { reason: 'min_level', topScore: 0, candidates: [], role: callerRole, minLevel }
    };
  }

  // Confirmacao pendente (intencao ambigua / sensivel)
  try {
    const { getConversationSession } = require('../../../utils/conversationSession');
    const sid = event.sessionId || ctxExtras.sessionId || 'default';
    const sess = getConversationSession(sid, event.userId);
    if (sess.step === 'intent_confirm' && sess.pendingIntent) {
      const pending = sess.pendingIntent;
      if (Date.now() > (pending.expires || 0)) {
        sess.step = null;
        delete sess.pendingIntent;
      } else if (/^(s|sim|yes|ok|confirma|confirmar)\b/i.test(text)) {
        sess.step = null;
        delete sess.pendingIntent;
        return executeMatch(
          {
            command: pending.command,
            confidence: 1,
            query: pending.query || '',
            args: pending.args || []
          },
          event,
          ctxExtras,
          cfg,
          text
        );
      } else if (/^(n|nao|não|cancel|cancela|cancelar)\b/i.test(text)) {
        sess.step = null;
        delete sess.pendingIntent;
        try { await replyError(event, ctxExtras, 'Cancelado.'); } catch (_) {}
        return { handled: true, route: 'intent_confirm_cancel' };
      }
    }
  } catch (e) {
    logger.logAviso(`[IntentRouter] confirm session: ${e.message}`);
  }

  // P0: em grupo sem prefixo/mencao — so detectores (URL/CPF/tel).
  // NLU/chat livre so via .hanork (allowGroupNlu) ou PV.
  const inGroupEarly = !!(event.isGroup || ctxExtras.waCtx?.isGroup);
  if (inGroupEarly && ctxExtras.allowGroupNlu !== true) {
    const maybeId = /(?:https?:\/\/|chat\.whatsapp|wa\.me\/)|(?:\d[\d.\-\s]{7,}\d)/i.test(text);
    if (!maybeId) {
      return {
        handled: false,
        miss: { reason: 'group_no_explicit_trigger', topScore: 0, candidates: [] }
      };
    }
  }

  // 1) Detectores locais rapidos (URL / identificador) — sem Ollama
  const local = await tryLocalDetectors(text, cfg);
  if (local) {
    return executeMatch(local, event, ctxExtras, cfg, text);
  }

  if (inGroupEarly && ctxExtras.allowGroupNlu !== true) {
    return {
      handled: false,
      miss: { reason: 'group_no_explicit_trigger', topScore: 0, candidates: [] }
    };
  }

  // 2) NLU: prefiltro + atalho local (frase clara) + Ollama
  if (cfg.allowNlu === false) return { handled: false };

  try {
    const candidates = prefilterCandidates(text, {
      topN: cfg.prefilterTopN || 10,
      platform: event.platform || null
    });

    if (!candidates.length) {
      logger.logInfo('[IntentRouter] sem candidato — mensagem ignorada');
      return {
        handled: false,
        miss: { reason: 'no_candidates', topScore: 0, candidates: [] }
      };
    }

    logger.logInfo(`[IntentRouter] candidatos=${candidates.length}`);

    // 1) LOCAL forte primeiro (frase alias / nome do cmd / score alto) — sem inventar
    let classified = matchLocalPhraseIntent(text, candidates, { minScore: 1.2 });

    // 2) Ollama/pool so se local falhou E remotos+Ollama nao estiverem todos indisponiveis
    if (!classified?.command) {
      const { allRemotesOnCooldown } = require('../../intent/providerPool');
      const { isIntentOnCooldown } = require('../../../services/ollamaService');
      const poolDown = allRemotesOnCooldown() && isIntentOnCooldown();
      if (poolDown) {
        logger.logInfo('[IntentRouter] pool+Ollama indisponiveis — so match local forte');
        classified = matchLocalPhraseIntent(text, candidates, { minScore: 999 });
      } else {
        const nluBudget = Math.max(2500, Number(process.env.HANORK_NLU_BUDGET_MS || 5000));
        classified = await Promise.race([
          classifyWithOllama(text, candidates, {
            senderRole: callerRole,
            platform: event.platform || null,
            isGroup: !!(event.isGroup || ctxExtras.waCtx?.isGroup),
            quotedText: ctxExtras.quotedText || event.quotedText || null
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), nluBudget))
        ]);
        if (classified?.command) {
          logger.logInfo(
            `[IntentRouter] NLU -> comando=${classified.command} confidence=${classified.confidence}`
          );
        } else if (classified?.notFound) {
          const inGroup = !!(event.isGroup || ctxExtras.waCtx?.isGroup);
          if (ctxExtras.allowChatReply === true) {
            return {
              handled: false,
              miss: { reason: 'not_found_chat_fallback', topScore: 0, candidates: [] }
            };
          }
          if (inGroup && ctxExtras.allowGroupNlu !== true) {
            return {
              handled: false,
              miss: { reason: 'not_found_blocked_group', topScore: 0, candidates: [] }
            };
          }
          const { applyLivePrefix, displayPrefix } = require('../../../utils/configManager');
          const msg = applyLivePrefix(
            'Nao tenho esse comando. Usa {p}menu ou {p}hanorkapi pra ver o que da pra fazer.',
            displayPrefix(telegramUserId)
          );
          logger.logInfo('[IntentRouter] NLU -> nao_encontrado');
          try {
            await replyError(event, ctxExtras, msg);
          } catch (_) {}
          return { handled: true, route: 'not_found', confidence: 0 };
        } else if (classified?.chatReply) {
          if (looksGenericAssistantReply(classified.chatReply)) {
            logger.logInfo('[IntentRouter] chat_reply generico descartado — tenta match local');
            classified = matchLocalPhraseIntent(text, candidates, { minScore: 999 });
            if (classified?.command) {
              logger.logInfo(
                `[IntentRouter] LOCAL pos-generico -> comando=${classified.command}`
              );
            }
          } else {
          const inGroup = !!(event.isGroup || ctxExtras.waCtx?.isGroup);
          if (ctxExtras.allowChatReply === true) {
            return {
              handled: false,
              miss: { reason: 'chat_reply_use_pool', topScore: 0, candidates: [] }
            };
          }
          if (inGroup) {
            logger.logInfo(
              '[IntentRouter] chat_reply BLOQUEADO em grupo (sem gatilho explicito)'
            );
            return {
              handled: false,
              miss: { reason: 'chat_reply_blocked_group', topScore: 0, candidates: [] }
            };
          }
          logger.logInfo('[IntentRouter] NLU -> resposta livre');
          try {
            const { previewText } = require('../../../utils/typography');
            await replyError(event, ctxExtras, previewText(classified.chatReply));
          } catch (_) {}
          return { handled: true, route: 'chat_reply', confidence: 0 };
          }
        } else {
          classified = matchLocalPhraseIntent(text, candidates, { minScore: 999 });
          if (classified?.command) {
            logger.logInfo(
              `[IntentRouter] LOCAL forte (pos-NLU) -> comando=${classified.command} confidence=${classified.confidence}`
            );
          } else {
            logger.logInfo('[IntentRouter] NLU falhou — sem execucao; fluxo normal');
          }
        }
      }
    } else {
      logger.logInfo(
        `[IntentRouter] LOCAL -> comando=${classified.command} confidence=${classified.confidence}`
      );
    }

    if (!classified?.command) {
      const top = candidates[0];
      logger.logInfo(
        `[IntentRouter] sem match — mensagem ignorada (top=${top?.command || '-'} score=${top?.score || 0})`
      );
      return {
        handled: false,
        miss: {
          reason: 'no_match',
          topScore: top?.score || 0,
          topCommand: top?.command || null,
          candidates: candidates.slice(0, 3).map((c) => ({
            command: c.command,
            score: c.score,
            usage: c.usage || c.command
          }))
        }
      };
    }

    // Gate AUTOMATICO de seguranca (depois da IA / atalho local)
    const safe = applyIntentSafety(classified, text, {
      category: (getEntry(classified.command) || {}).category,
      minConfidenceSensitive: cfg.minConfidenceSensitive,
      minConfidence: cfg.minConfidence
    });
    if (safe.blocked || !safe.command) {
      logger.logInfo(`[IntentRouter] SAFETY block reason=${safe.reason || '?'} cmd=${classified.command}`);
      return { handled: false, error: safe.reason || 'safety_block' };
    }
    if (safe.remapped) {
      classified = { ...classified, command: safe.command, confidence: safe.confidence };
    } else {
      classified.confidence = safe.confidence;
      classified.command = safe.command;
    }

    try {
      const { isKnownBotCommand } = require('../../../utils/promptInjection');
      if (classified.command && !isKnownBotCommand(classified.command)) {
        logger.logAviso(`[IntentRouter] comando inventado rejeitado: ${classified.command}`);
        return { handled: false, miss: { reason: 'invented_command', topScore: 0, candidates: [] } };
      }
    } catch (_) { /* */ }

    if (safe.needConfirm) {
      return askIntentConfirm(event, ctxExtras, classified, safe.reason || 'need_confirm');
    }

    const entry = getEntry(classified.command) || candidates.find((c) => c.command === classified.command);
    const sensitive = !!(entry?.sensitive || isSensitiveCommand(classified.command, entry?.category));
    const minConf = sensitive
      ? (typeof cfg.minConfidenceSensitive === 'number' ? cfg.minConfidenceSensitive : 0.93)
      : (typeof cfg.minConfidence === 'number' ? cfg.minConfidence : 0.85);

    if (classified.confidence < minConf) {
      // Seguro com confianca media → pede confirmacao curta (nao silencia)
      if (!sensitive && classified.confidence >= 0.55) {
        return askIntentConfirm(event, ctxExtras, classified, 'low_confidence_confirm');
      }
      logger.logInfo(
        `[IntentRouter] abaixo do limiar cmd=${classified.command} conf=${classified.confidence} min=${minConf}`
      );
      return {
        handled: false,
        miss: {
          reason: 'low_confidence',
          topScore: classified.confidence,
          topCommand: classified.command,
          candidates: [
            {
              command: classified.command,
              score: classified.confidence,
              usage: (entry && entry.usage) || classified.command
            },
            ...candidates.slice(0, 2).map((c) => ({
              command: c.command,
              score: c.score,
              usage: c.usage || c.command
            }))
          ]
        }
      };
    }

    const argText = String(classified.query || classified.args?.join(' ') || '').trim();
    if (argText) {
      logger.logInfo(`[IntentRouter] args="${argText.slice(0, 60)}" sensitive=${sensitive}`);
    }

    // 3) Permissao + rate-limit (mesmo sistema do Universal Router) ANTES de executar
    const perm = await checkIntentPermission(classified.command, event, ctxExtras);
    if (!perm.allowed) {
      return denyIntentPermission(perm, event, ctxExtras, classified.command);
    }

    try {
      const { getCommandConfig } = require('../universalRouter');
      const { checkRateLimit, checkGlobalRateLimit } = require('../permissionManager');
      const cmdCfg = getCommandConfig(classified.command);
      const role = perm.role || ctxExtras.authRole || 'user';
      const globalRl = await checkGlobalRateLimit(event.userId, {
        role,
        command: classified.command
      });
      if (!globalRl.allowed) {
        logger.logAviso(`[IntentRouter] rate-limit global user=${event.userId}`);
        return {
          handled: true,
          route: classified.command,
          error: 'rate_limit',
          retryAfter: globalRl.retryAfter || 5000,
          userMessage: 'rate_limit'
        };
      }
      const rl = await checkRateLimit(
        event.userId,
        classified.command,
        cmdCfg?.rateLimit || { max: 45, window: 60000 }
      );
      if (!rl.allowed) {
        logger.logAviso(`[IntentRouter] rate-limit cmd=${classified.command}`);
        return {
          handled: true,
          route: classified.command,
          error: 'rate_limit',
          retryAfter: rl.retryAfter || 5000,
          userMessage: 'rate_limit'
        };
      }
    } catch (rlErr) {
      logger.logAviso(`[IntentRouter] rate-limit check: ${rlErr.message}`);
    }

    if (sensitive) {
      auditSensitiveIntent({
        command: classified.command,
        confidence: classified.confidence,
        userId: event.userId,
        sessionId: event.sessionId,
        platform: event.platform,
        text,
        telegramUserId
      });
    }

    const match = {
      route: classified.command,
      confidence: classified.confidence,
      payload: argText,
      args: argText ? argText.split(/\s+/).filter(Boolean) : [],
      kind: 'nlu',
      sensitive,
      priority: 50
    };

    return executeMatch(match, event, ctxExtras, cfg, text, perm);
  } catch (e) {
    logger.logAviso(`[IntentRouter] NLU erro=${e.message}`);
    return { handled: false };
  }
}

async function tryLocalDetectors(text, cfg) {
  const opts = {
    allowSearch: !!cfg.allowSearch,
    allowInSentence: !!cfg.allowInSentence
  };

  let best = null;
  for (const det of listDetectors()) {
    if (cfg[det.enabledKey] === false) continue;
    try {
      const raw = det.detect(text, opts);
      const scored = applyConfidence(raw, raw?.kind || det.name, cfg.minConfidence);
      if (!scored) continue;
      if (!best || (scored.priority || 0) > (best.priority || 0)) {
        best = { ...scored, detector: det.name };
      }
    } catch (e) {
      logger.logAviso(`[IntentRouter] detector=${det.name} erro=${e.message}`);
    }
  }
  return best;
}

async function denyIntentPermission(perm, event, ctxExtras, commandName) {
  logger.logAviso(
    `[IntentRouter] permissao negada cmd=${commandName} reason=${perm?.reason || '?'}`
  );
  if (perm && (perm.reason === 'owner_only' || perm.silent)) {
    return { handled: true, route: commandName, error: 'owner_only' };
  }
  const isGroup = !!(event.isGroup || ctxExtras.waCtx?.isGroup);
  console.log(
    `[${isGroup ? 'AUTH_SILENT' : 'AUTH_DM'}] INTENT cmd=${commandName} user=${event.userId} reason=${perm?.reason || '?'}`
  );
  if (perm && perm.reason === 'paywall') {
    try {
      const wa = ctxExtras.waCtx || {};
      const ctx = {
        ...wa,
        from: event.chatId || wa.from,
        sender: event.userId || wa.sender,
        telegramUserId: ctxExtras.telegramUserId || event.telegramUserId || event.userId,
        platform: event.platform,
        isTelegram: event.platform === 'telegram',
        info: event.raw || wa.info
      };
      const gated = { ok: false, reason: 'paywall', message: perm.message };
      if (event.platform === 'telegram' && ctxExtras.bot && (ctxExtras.chatId || event.chatId)) {
        const paywall = require('../../../utils/paywall');
        await ctxExtras.bot.sendMessage(
          ctxExtras.chatId || event.chatId,
          perm.message || paywall.denyText(ctx, commandName)
        );
      } else {
        await require('../../../utils/paywall').maybeReplyDeny(ctxExtras.conn, ctx, gated);
      }
    } catch (_) { /* ignore */ }
    return { handled: true, route: commandName, error: 'paywall', userMessage: perm.message };
  }
  return {
    handled: true,
    route: commandName,
    error: 'permission_denied',
    userMessage: isGroup ? null : 'restricted'
  };
}

async function executeMatch(match, event, ctxExtras, cfg, text, perm = null) {
  if (!match.route && match.command) match.route = match.command;
  let livePerm = perm;
  if (!livePerm || livePerm.allowed == null) {
    livePerm = await checkIntentPermission(match.route, event, ctxExtras);
  }
  if (!livePerm.allowed) {
    return denyIntentPermission(livePerm, event, ctxExtras, match.route);
  }
  const logPayload =
    match.kind === 'identifier'
      ? maskSensitive(match.payload)
      : String(match.payload || text || '').slice(0, 80);

  if (match.kind !== 'nlu') {
    logger.logInfo(
      `[IntentRouter] Detectado: ${match.route} | confidence=${match.confidence} | handler=${match.route} | ${logPayload}`
    );
  }

  try {
    const { checkDivulgacaoAllowed } = require('../../../utils/divulgacaoGate');
    const divGate = checkDivulgacaoAllowed(match.route, {
      isGroup: !!(event.isGroup || ctxExtras.waCtx?.isGroup),
      groupId: event.chatId || ctxExtras.waCtx?.from,
      telegramUserId: ctxExtras.telegramUserId || event.telegramUserId || event.userId
    });
    if (!divGate.ok) {
      const waCtx = ctxExtras.waCtx || {};
      try {
        const { sendDivulgacaoMessage } = require('../../../utils/divulgacaoReply');
        await sendDivulgacaoMessage(ctxExtras.conn, {
          from: event.chatId || waCtx.from,
          isGroup: !!(event.isGroup || waCtx.isGroup),
          sender: event.userId || waCtx.sender,
          senderAlt: waCtx.senderAlt,
          info: event.raw || waCtx.info,
          platform: event.platform
        }, { text: divGate.message });
      } catch (_) {
        await replyError(event, ctxExtras, divGate.message);
      }
      return { handled: true, route: match.route, error: 'divulgacao_blocked' };
    }
  } catch (_) { /* ignore */ }

  logger.logInfo('[IntentRouter] Executando...');

  try {
    await dispatchToHandler(match, event, ctxExtras, livePerm);
    return { handled: true, route: match.route, confidence: match.confidence };
  } catch (e) {
    logger.logErro(`[IntentRouter] handler=${match.route} erro=${e.message}`);
    try {
      const { stripAccents } = require('../../../utils/typography');
      await replyError(event, ctxExtras, stripAccents('Nao foi possivel processar automaticamente.'));
    } catch (_) {}
    return { handled: true, route: match.route, error: e.message };
  }
}

async function checkIntentPermission(commandName, event, ctxExtras) {
  try {
    const { getCommandConfig } = require('../universalRouter');
    const { checkPermission } = require('../permissionManager');
    const config = getCommandConfig(commandName);
    const required = config?.permission || 'owner';
    const conn = ctxExtras.conn || null;
    const enriched = {
      ...event,
      telegramUserId: ctxExtras.telegramUserId || event.telegramUserId || event.userId
    };
    const perm = await checkPermission(
      event.userId,
      required,
      event.sessionId,
      conn,
      {
        ...enriched,
        isGroup: !!(event.isGroup || ctxExtras.waCtx?.isGroup),
        isAdmin: !!(event.isAdmin || ctxExtras.waCtx?.isAdmin),
        from: event.chatId || ctxExtras.waCtx?.from,
        chatId: event.chatId || ctxExtras.waCtx?.from,
        sender: event.userId || ctxExtras.waCtx?.sender,
        senderAlt: ctxExtras.waCtx?.senderAlt,
        raw: event.raw || ctxExtras.waCtx?.info,
        authRole: event.authRole || ctxExtras.waCtx?.authRole
      }
    );
    try {
      const { assertCommand } = require('../../../utils/commandGate');
      const wa = ctxExtras.waCtx || {};
      const gated = assertCommand({
        ...wa,
        sender: event.userId || wa.sender,
        from: event.chatId || wa.from,
        isGroup: !!(event.isGroup || wa.isGroup),
        isAdmin: !!(event.isAdmin || wa.isAdmin),
        telegramUserId: enriched.telegramUserId,
        conn,
        platform: event.platform
      }, commandName);
      if (!gated.ok) {
        if (gated.reason === 'owner_only' || gated.silent) {
          return { allowed: false, reason: 'owner_only', silent: true, role: gated.role };
        }
        if (gated.reason === 'paywall') {
          return {
            allowed: false,
            reason: 'paywall',
            message: gated.message,
            role: gated.role
          };
        }
        if (!perm.allowed) return perm;
        return { allowed: false, reason: 'commandGate', role: gated.role };
      }
      return { allowed: true, role: gated.role };
    } catch (_) {
      if (!perm.allowed) return perm;
      return { allowed: false, reason: 'commandGate' };
    }
  } catch (e) {
    return { allowed: false, reason: 'erro ao verificar permissao' };
  }
}

/** Rotas que o Telegram executa nativo (sem sessao WA / sem chatId WA) */
const TG_NATIVE_ROUTES = new Set([
  'consulta', 'google', 'pesquisar', 'web', 'search',
  'play', 'playvideo', 'ytmp3', 'ytmp4',
  'tiktok', 'instagram', 'facebook', 'spotify', 'soundcloud',
  'mediafire', 'twitter', 'kwai', 'threads', 'capcut', 'pinterest', 'ytsearch'
]);

function resolveTelegramDispatchCtx(event, ctxExtras = {}) {
  const bot = ctxExtras.bot || null;
  const raw = event?.raw || {};
  const chatId = String(
    event?.chatId ||
    ctxExtras.chatId ||
    raw.chat?.id ||
    raw.message?.chat?.id ||
    raw.callback_query?.message?.chat?.id ||
    ''
  );
  const userId = String(
    event?.userId ||
    ctxExtras.telegramUserId ||
    raw.from?.id ||
    raw.callback_query?.from?.id ||
    ''
  );
  return { bot, chatId, userId };
}

async function intentViaRouterEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.HANORK_INTENT_VIA_ROUTER || '1').trim());
}

/**
 * Onda3.11 / Parte2: NLU WA passa pelo Universal Router (mesma porta que .cmd).
 * Reversivel: HANORK_INTENT_VIA_ROUTER=0.
 */
async function dispatchViaUniversalRouter(match, event, ctxExtras, perm = null) {
  const { processEvent } = require('../universalRouter');
  const conn = ctxExtras.conn;
  const baseCtx = ctxExtras.waCtx || {};
  const cmdName = match.route === 'consulta' && match.consultaTipo ? 'consulta' : match.route;
  let text = String(match.payload || (Array.isArray(match.args) ? match.args.join(' ') : '') || '').trim();
  if (match.route === 'consulta' && match.consultaTipo) {
    text = `${match.consultaTipo} ${match.payload || ''}`.trim();
  }
  let prefix = baseCtx.prefix || '.';
  try {
    const tid = ctxExtras.telegramUserId || event.telegramUserId || conn?._telegramUserId;
    if (tid) prefix = require('../../../utils/configManager').getPrefix(tid) || prefix;
  } catch (_) { /* ignore */ }
  const full = `${prefix}${cmdName}${text ? ` ${text}` : ''}`.trim();

  const info = baseCtx.info || event.raw || {};
  const key = { ...(info.key || {}) };
  key.remoteJid = event.chatId || baseCtx.from || key.remoteJid;
  if (!key.participant && event.isGroup && event.userId) key.participant = event.userId;
  key.fromMe = !!(baseCtx.fromMe || key.fromMe);

  const synthetic = {
    ...info,
    key,
    message: { conversation: full },
    pushName: info.pushName || baseCtx.pushName || ''
  };

  const isOwner = perm?.role === 'owner' || perm?.role === 'platform_admin' || !!baseCtx.isOwner;
  const isVip = isOwner || perm?.role === 'vip' || !!baseCtx.isVip;
  const parsedCtx = {
    ...baseCtx,
    from: event.chatId || baseCtx.from,
    info: synthetic,
    command: cmdName,
    text,
    args: text ? text.split(/\s+/).filter(Boolean) : [],
    q: text,
    fullText: full,
    prefix,
    telegramUserId: ctxExtras.telegramUserId || event.telegramUserId || event.userId,
    sessionId: event.sessionId || conn?._sessionId,
    isOwner,
    isVip,
    authRole: perm?.role || baseCtx.authRole,
    isGroup: !!event.isGroup,
    sender: event.userId || baseCtx.sender,
    _intentSource: true,
    _intentConfidence: match.confidence,
    _intentOriginalText: String(event.fullText || event.text || '').slice(0, 280)
  };

  logger.logInfo(
    `[IntentRouter] via_router cmd=${cmdName} conf=${match.confidence} actor=${String(event.userId || '').slice(-8)}`
  );
  const result = await processEvent(synthetic, 'whatsapp', conn, parsedCtx);
  if (result && result.handled === false && result.error) {
    throw new Error(String(result.error));
  }
  return result;
}

async function dispatchToHandler(match, event, ctxExtras, perm = null) {
  const { getCommand } = require('../../../commands');
  const route = match.route;
  const platform = event.platform || 'whatsapp';

  // Telegram: nunca usar chatId TG como JID WA — helper TG ou nativos
  if (platform === 'telegram') {
    // Sempre preferir nativo para consultas/downloads/pesquisa (NLU ou detector)
    if (TG_NATIVE_ROUTES.has(route)) {
      return dispatchTelegramNative(match, event, ctxExtras);
    }
    if (match.kind === 'nlu' || typeof ctxExtras.executeWaCmd === 'function') {
      return dispatchTelegramNlu(match, event, ctxExtras);
    }
    return dispatchTelegramNative(match, event, ctxExtras);
  }

  if (await intentViaRouterEnabled()) {
    return dispatchViaUniversalRouter(match, event, ctxExtras, perm);
  }

  const cmdName = route === 'consulta' && match.consultaTipo ? 'consulta' : route;
  const cmd = getCommand(cmdName);
  if (!cmd || typeof cmd.execute !== 'function') {
    throw new Error(`Handler nao encontrado: ${cmdName}`);
  }

  const conn = ctxExtras.conn;
  const baseCtx = ctxExtras.waCtx || {};
  // Texto livre: string completa (nao so args[0])
  let text = String(match.payload || (Array.isArray(match.args) ? match.args.join(' ') : '') || '').trim();
  let args = text ? text.split(/\s+/).filter(Boolean) : (match.args || []);

  if (route === 'consulta' && match.consultaTipo) {
    const tipo = match.consultaTipo;
    text = `${tipo} ${match.payload}`;
    args = [tipo, match.payload];
  }

  const isOwner = perm?.role === 'owner' || perm?.role === 'platform_admin' || !!baseCtx.isOwner;
  const isVip = isOwner || perm?.role === 'vip' || !!baseCtx.isVip;

  const ctx = {
    ...baseCtx,
    from: event.chatId || baseCtx.from,
    info: baseCtx.info || event.raw,
    command: cmdName,
    text,
    args,
    q: text,
    fullText: text,
    prefix: baseCtx.prefix || '.',
    telegramUserId: ctxExtras.telegramUserId || event.telegramUserId || event.userId,
    sessionId: event.sessionId || conn?._sessionId,
    isOwner,
    isVip,
    authRole: perm?.role || baseCtx.authRole,
    isGroup: !!event.isGroup,
    sender: event.userId
  };

  logger.logInfo(`[IntentRouter] via_legacy cmd=${cmdName} conf=${match.confidence}`);
  if (cmd.useCtx) {
    await cmd.execute(conn, ctx);
  } else {
    await cmd.execute(conn, ctx.from, ctx.info, args, text, !!ctx.isOwner, !!ctx.isVip);
  }
}

async function dispatchTelegramNlu(match, event, ctxExtras) {
  const { bot, chatId } = resolveTelegramDispatchCtx(event, ctxExtras);
  if (!bot || !chatId) throw new Error('bot/chatId ausente');

  // Nativas mesmo quando Ollama classificou (kind=nlu)
  if (TG_NATIVE_ROUTES.has(match.route)) {
    return dispatchTelegramNative(match, event, ctxExtras);
  }

  if (typeof ctxExtras.executeWaCmd === 'function') {
    const payload = match.payload || (Array.isArray(match.args) ? match.args.join(' ') : '') || '';
    await ctxExtras.executeWaCmd(match.route, payload);
    return;
  }

  await bot.sendMessage(
    chatId,
    `Intencao: ${match.route}\nConecte a sessao WhatsApp para executar, ou use /${match.route}`
  );
}

async function dispatchTelegramNative(match, event, ctxExtras) {
  const { bot, chatId, userId } = resolveTelegramDispatchCtx(event, ctxExtras);
  if (!bot || !chatId) throw new Error('bot/chatId ausente');

  const route = match.route;
  const payload = String(match.payload || '').trim();

  // ---- Downloads / play ----
  const dlRoutes = new Set([
    'tiktok', 'instagram', 'play', 'playvideo', 'ytmp3', 'ytmp4',
    'facebook', 'spotify', 'soundcloud', 'mediafire', 'twitter',
    'kwai', 'threads', 'capcut', 'pinterest', 'ytsearch'
  ]);
  if (dlRoutes.has(route)) {
    const { createTelegramStatus } = require('../../../utils/statusProgress');
    const { formatReportBlock, labelValue, formatStatusBlock } = require('../../../utils/typography');
    const { friendlyMediaError } = require('../../../utils/onboarding');
    const dl = require('../../../services/downloadService');

    const status = await createTelegramStatus(bot, chatId, route.toUpperCase());
    try {
      if (!payload) throw new Error(`Informe o termo ou link para ${route}`);
      const { enforceSearchQuery } = require('../../../utils/searchQueryLimit');
      const term = enforceSearchQuery(payload);
      await status.update('Processando', term.slice(0, 80));

      if (route === 'ytsearch') {
        const list = await dl.searchYoutube(term);
        if (!list?.length) {
          await status.finish(formatStatusBlock('YT SEARCH', [['Estado', 'nenhum resultado']]));
          return;
        }
        const rows = list.slice(0, 8).map((v, i) => `${i + 1}. ${String(v.title || '').slice(0, 60)}\n${v.url || ''}`);
        await status.finish(formatReportBlock('YT SEARCH', [labelValue('Termo', term.slice(0, 60)), '', ...rows]));
        return;
      }

      let media;
      if (route === 'play' || route === 'ytmp3') media = await dl.playMedia(term);
      else if (route === 'playvideo' || route === 'ytmp4') media = await dl.playVideoMedia(term);
      else if (route === 'tiktok') media = await dl.downloadTiktok(term);
      else if (route === 'instagram') media = await dl.downloadInstagram(term);
      else if (route === 'facebook') media = await dl.downloadFacebook(term);
      else if (route === 'spotify') media = await dl.downloadSpotify(term);
      else if (route === 'soundcloud') media = await dl.downloadSoundcloud(term);
      else if (route === 'mediafire') media = await dl.downloadMediafire(term);
      else if (route === 'twitter') media = await dl.downloadTwitter(term);
      else if (route === 'kwai') media = await dl.downloadKwai(term);
      else if (route === 'threads') media = await dl.downloadThreads(term);
      else if (route === 'capcut') media = await dl.downloadCapcut(term);
      else if (route === 'pinterest') media = await dl.downloadPinterest(term);

      await status.remove();

      if ((route === 'play' || route === 'ytmp3') && (media?.audioBuffer || media?.audioUrl)) {
        const opts = {
          caption: formatReportBlock('PLAY', [
            labelValue('Titulo', media.title),
            labelValue('Duracao', media.duration || '-')
          ]).slice(0, 1000)
        };
        if (media.audioBuffer) {
          await bot.sendAudio(chatId, media.audioBuffer, { ...opts, filename: 'audio.mp3' });
        } else {
          await bot.sendAudio(chatId, media.audioUrl, opts);
        }
        return;
      }

      if (media?.videoBuffer || media?.mediaBuffer) {
        const buf = media.videoBuffer || media.mediaBuffer;
        const type = media.type || (media.videoBuffer ? 'video' : 'image');
        const caption = formatReportBlock(route.toUpperCase(), [
          labelValue('Titulo', media.title || '-')
        ]).slice(0, 1000);
        if (type === 'video') await bot.sendVideo(chatId, buf, { caption });
        else await bot.sendPhoto(chatId, buf, { caption });
        return;
      }

      if (media?.imageBuffers?.length) {
        for (const buf of media.imageBuffers.slice(0, 5)) {
          await bot.sendPhoto(chatId, buf);
        }
        return;
      }

      const url = media?.videoUrl || media?.mediaUrl || media?.url || media?.audioUrl;
      if (url) {
        if (/\.(mp3|m4a)(\?|$)/i.test(url) || route === 'spotify' || route === 'soundcloud') {
          await bot.sendAudio(chatId, url, { caption: String(media.title || route).slice(0, 200) });
        } else if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) {
          await bot.sendPhoto(chatId, url, { caption: String(media.title || '').slice(0, 200) });
        } else {
          await bot.sendVideo(chatId, url, { caption: String(media.title || route).slice(0, 200) });
        }
        return;
      }

      if (media?.fileBuffer) {
        await bot.sendDocument(chatId, media.fileBuffer, {}, {
          filename: media.filename || 'arquivo',
          contentType: media.mimetype || 'application/octet-stream'
        });
        return;
      }

      await bot.sendMessage(chatId, 'Midia baixada, mas formato nao suportado no Telegram.');
    } catch (e) {
      await status.finish(formatStatusBlock(route.toUpperCase(), [['Erro', friendlyMediaError(e)]]));
      throw e;
    }
    return;
  }

  if (route === 'consulta') {
    const { executarConsulta, isPiiConsultaTipo } = require('../../../commands/consultas');
    const { createTelegramStatus } = require('../../../utils/statusProgress');
    const tipo = match.consultaTipo || 'cpf';
    const inGroup = !!(event.isGroup || String(chatId).startsWith('-'));
    if (inGroup && isPiiConsultaTipo(tipo)) {
      await bot.sendMessage(chatId, 'Consulta de dados so no privado. Abre o PV comigo e manda de novo.');
      return;
    }
    const status = await createTelegramStatus(bot, chatId, 'CONSULTA');
    const result = await executarConsulta(tipo, payload || match.payload, 'telegram', userId, null, status, {
      isGroup: inGroup
    });
    if (result?.imageUrl) {
      try {
        await bot.sendPhoto(chatId, result.imageUrl, { caption: 'Foto da consulta' });
      } catch (_) {}
    }
    return;
  }

  if (route === 'google' || route === 'pesquisar' || route === 'web' || route === 'search') {
    const { webSearch } = require('../../../services/webIntelligenceService');
    const { createTelegramStatus } = require('../../../utils/statusProgress');
    const { formatReportBlock, labelValue, formatStatusBlock } = require('../../../utils/typography');
    const { enforceSearchQuery } = require('../../../utils/searchQueryLimit');
    let q;
    try {
      q = enforceSearchQuery(payload);
    } catch (e) {
      await bot.sendMessage(chatId, e.message);
      return;
    }
    const status = await createTelegramStatus(bot, chatId, 'PESQUISA');
    try {
      await status.update('Buscando', q.slice(0, 60));
      const results = await webSearch(userId, q);
      if (!results?.length) {
        await status.finish(formatStatusBlock('PESQUISA', [['Estado', 'nenhum resultado']]));
        return;
      }
      const rows = [labelValue('Consulta', q.slice(0, 60)), labelValue('Total', results.length), ''];
      results.slice(0, 8).forEach((r, i) => {
        rows.push(`${i + 1}. ${String(r.title || '').slice(0, 70)}`);
        let url = String(r.url || '');
        if (url.length > 90) url = `${url.slice(0, 87)}...`;
        rows.push(url);
      });
      await status.finish(formatReportBlock('PESQUISA', rows));
    } catch (e) {
      await status.finish(formatStatusBlock('PESQUISA', [['Erro', String(e.message).slice(0, 120)]]));
    }
    return;
  }

  throw new Error(`Rota TG nao suportada: ${route}`);
}

async function askIntentConfirm(event, ctxExtras, classified, reason) {
  try {
    const { getConversationSession } = require('../../../utils/conversationSession');
    const sid = event.sessionId || ctxExtras.sessionId || 'default';
    const sess = getConversationSession(sid, event.userId);
    sess.step = 'intent_confirm';
    sess.pendingIntent = {
      command: classified.command,
      query: classified.query || (Array.isArray(classified.args) ? classified.args.join(' ') : ''),
      args: classified.args || [],
      confidence: classified.confidence,
      expires: Date.now() + 60 * 1000
    };
    const argHint = sess.pendingIntent.query
      ? ` (${String(sess.pendingIntent.query).slice(0, 40)})`
      : '';
    await replyError(
      event,
      ctxExtras,
      `Confirma: ${classified.command}${argHint}?\nResponda sim ou nao.`
    );
    logger.logInfo(
      `[IntentRouter] pedindo confirm cmd=${classified.command} reason=${reason || '?'} conf=${classified.confidence}`
    );
    return { handled: true, route: 'intent_confirm', reason: reason || 'need_confirm' };
  } catch (e) {
    logger.logAviso(`[IntentRouter] askConfirm: ${e.message}`);
    return { handled: false, error: 'confirm_failed' };
  }
}

async function replyError(event, ctxExtras, msg) {
  if (event.platform === 'telegram') {
    const { bot, chatId } = resolveTelegramDispatchCtx(event, ctxExtras);
    if (bot && chatId) {
      await bot.sendMessage(chatId, msg);
      return;
    }
  }
  if (ctxExtras.conn && event.chatId) {
    await ctxExtras.conn.sendMessage(event.chatId, { text: msg });
  }
}

async function processIntent(event, ctxExtras = {}) {
  const startedAt = Date.now();
  const result = await processIntentCore(event, ctxExtras);
  try {
    const plat = String(event?.platform || ctxExtras?.waCtx?.platform || 'whatsapp');
    const cmd = result?.route || 'intent';
    const status = result?.error || (result?.handled ? 'ok' : 'miss');
    logger.logInfo(
      `[PIPE] platform=${plat} cmd=${cmd} stage=intent duration=${Date.now() - startedAt}ms status=${status}`
    );
  } catch (_) { /* ignore */ }
  return result;
}

module.exports = {
  processIntent
};
