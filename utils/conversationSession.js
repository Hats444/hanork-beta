// utils/conversationSession.js — estado de conversa/step por remetente (persiste entre msgs)
'use strict';

/** @type {Map<string, object>} */
const store = new Map();
const TTL_MS = 30 * 60 * 1000;

function key(sessionId, sender) {
  return `${String(sessionId || 'na')}|${String(sender || 'na')}`;
}

function pruneExpired() {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (!v || (v._updatedAt && now - v._updatedAt > TTL_MS)) store.delete(k);
  }
}

/**
 * Retorna (e cria) o objeto de sessao de conversa do usuario.
 * Sempre um objeto — nunca undefined.
 */
function getConversationSession(sessionId, sender) {
  pruneExpired();
  const k = key(sessionId, sender);
  let s = store.get(k);
  if (!s || typeof s !== 'object') {
    s = { step: null, quantidade: null, _updatedAt: Date.now() };
    store.set(k, s);
  }
  s._updatedAt = Date.now();
  return s;
}

function clearConversationSession(sessionId, sender) {
  store.delete(key(sessionId, sender));
}

function touchConversationSession(session) {
  if (session && typeof session === 'object') session._updatedAt = Date.now();
}

module.exports = {
  getConversationSession,
  clearConversationSession,
  touchConversationSession
};
