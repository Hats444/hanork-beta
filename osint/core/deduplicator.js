'use strict';

function keyOf(item) {
  return `${item.entityType}|${String(item.value || '').toLowerCase()}`;
}

function dedupe(items) {
  const map = new Map();
  for (const item of items || []) {
    const k = keyOf(item);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, {
        ...item,
        sources: [item.source],
        urls: item.url ? [item.url] : [],
        evidences: [item]
      });
      continue;
    }
    if (!prev.sources.includes(item.source)) prev.sources.push(item.source);
    if (item.url && !prev.urls.includes(item.url)) prev.urls.push(item.url);
    prev.evidences.push(item);
    prev.confidence = Math.max(prev.confidence || 0, item.confidence || 0);
  }
  return [...map.values()];
}

module.exports = { dedupe, keyOf };
