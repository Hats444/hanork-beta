'use strict';

const { evidence } = require('../core/http');

async function collect(target) {
  const parsed = target && typeof target === 'object' ? target : {};
  const m = parsed.media;
  if (!m || !m.sha256) return [];
  return [
    evidence(m.sha256, 'media', '', {
      entityType: 'FileHash',
      confidence: 0.7,
      extra: {
        bytes: m.bytes || 0,
        mime: m.mime || '',
        exif: m.exif || 'nao_lido',
        derived: false,
        note: 'arquivo enviado pelo dono; sem face-id; GPS omitido'
      }
    })
  ];
}

module.exports = { collect, name: 'media', phase: 2 };
