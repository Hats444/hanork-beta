// utils/mediaUpload.js — upload temporario p/ APIs que pedem URL (antiporno etc.)
'use strict';

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../logger');

/**
 * Sobe buffer de imagem e devolve URL publica.
 * Fallback: litterbox → uguu → catbox (catbox sozinho costuma ECONNRESET).
 * @param {Buffer} buffer
 * @param {string} [filename]
 * @returns {Promise<string|null>}
 */
async function uploadImageBuffer(buffer, filename = 'img.jpg') {
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  const name = String(filename || 'img.jpg').replace(/[^\w.\-]+/g, '_') || 'img.jpg';
  const errors = [];

  // 1) litterbox (mesmo ecossistema catbox, mais estavel)
  try {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('time', '1h');
    fd.append('fileToUpload', buffer, { filename: name, contentType: 'image/jpeg' });
    const res = await axios.post(
      'https://litterbox.catbox.moe/resources/internals/api.php',
      fd,
      {
        headers: fd.getHeaders(),
        timeout: 30000,
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024
      }
    );
    const url = String(res.data || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    errors.push(`litterbox:${url.slice(0, 60)}`);
  } catch (e) {
    errors.push(`litterbox:${e.message}`);
  }

  // 2) uguu.se
  try {
    const fd = new FormData();
    fd.append('files[]', buffer, { filename: name, contentType: 'image/jpeg' });
    const res = await axios.post('https://uguu.se/upload.php', fd, {
      headers: fd.getHeaders(),
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024
    });
    const fileUrl = res.data?.files?.[0]?.url || res.data?.url;
    const url = String(fileUrl || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    errors.push(`uguu:no-url`);
  } catch (e) {
    errors.push(`uguu:${e.message}`);
  }

  // 3) catbox ultimo
  try {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('fileToUpload', buffer, { filename: name, contentType: 'image/jpeg' });
    const res = await axios.post('https://catbox.moe/user/api.php', fd, {
      headers: fd.getHeaders(),
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024
    });
    const url = String(res.data || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    errors.push(`catbox:${url.slice(0, 60)}`);
  } catch (e) {
    errors.push(`catbox:${e.message}`);
  }

  logger.logAviso(`[UPLOAD] falhou: ${errors.join(' | ')}`);
  return null;
}

module.exports = { uploadImageBuffer };
