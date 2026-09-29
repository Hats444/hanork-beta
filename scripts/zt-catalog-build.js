#!/usr/bin/env node
'use strict';
/**
 * Gera core/zt/catalog.json com todas as rotas da API (painel docs).
 * Uso: node scripts/zt-catalog-build.js
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'core', 'zt', 'catalog.json');

/** @type {Array<object>} */
const entries = [];
const seenCmd = new Set();
const seenPath = new Set();

function slug(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
}

function add(e) {
  if (!e.path || !e.cmd) return;
  if (e.disabled) return;
  let cmd = slug(e.cmd);
  if (!cmd) return;
  if (seenCmd.has(cmd)) {
    let i = 2;
    while (seenCmd.has(cmd + i)) i++;
    cmd = cmd + i;
  }
  seenCmd.add(cmd);
  const key = `${e.method || 'GET'} ${e.path}`;
  seenPath.add(key);
  entries.push({
    id: e.id || cmd,
    cmd,
    aliases: (e.aliases || []).map(slug).filter((a) => a && a !== cmd),
    category: e.category,
    method: e.method || 'GET',
    path: e.path,
    params: e.params || [{ name: 'q', from: 'text', required: false }],
    response: e.response || 'auto',
    permission: e.permission || 'user',
    menuLabel: e.menuLabel || e.cmd,
    nsfw: !!e.nsfw,
    mediaHint: e.mediaHint || null,
    upload: !!e.upload,
    disabled: false
  });
}

function pUrl(name = 'url') {
  return [{ name, from: 'text', required: true }];
}
function pQ(name = 'q') {
  return [{ name, from: 'text', required: true }];
}
function pText(name = 'texto') {
  return [{ name, from: 'text', required: true }];
}

// ─── DOWNLOADS (47) ───────────────────────────────────────────
const downloads = [
  ['multidl', '/api/dl/multi', 'url', 'user'],
  ['multidl2', '/api/download/multi', 'url', 'user'],
  ['instagram', '/api/dl/instagram', 'url', 'user'],
  ['instagram2', '/api/instagram/post', 'url', 'user'],
  ['igpost', '/api/instagram/post', 'url', 'user'],
  ['igstory', '/api/instagram/story', 'url', 'user'],
  ['ighighlights', '/api/instagram/highlights', 'url', 'user'],
  ['capcut', '/api/dl/capcut', 'url', 'user'],
  ['threads', '/api/dl/threads', 'url', 'user'],
  ['spotify', '/api/dl/spotify', 'url', 'user'],
  ['kwai', '/api/kwai/video', 'url', 'user'],
  ['facebook', '/download/facebook', 'url', 'user'],
  ['facebook2', '/download/facebook2', 'url', 'user'],
  ['facebook3', '/download/facebook3', 'url', 'user'],
  ['tiktok', '/api/download/tiktok', 'url', 'user'],
  ['tiktok2', '/api/download/tiktok/v2', 'url', 'user'],
  ['tiktok3', '/api/download/tiktok/v3', 'url', 'user'],
  ['tiktok4', '/api/download/tiktok/v4', 'url', 'user'],
  ['tiktoksearch', '/api/tiktok/search', 'q', 'user'],
  ['twitter', '/api/dl/twitter', 'url', 'user'],
  ['mediafireinfo', '/api/dl/mediafire/info', 'url', 'user'],
  ['mediafire', '/api/dl/mediafire', 'url', 'user'],
  ['gdrive', '/api/dl/gdrive', 'url', 'user'],
  ['myinst', '/api/dl/myinstants', 'q', 'user'],
  ['ytshorts', '/api/dl/ytshorts', 'url', 'user'],
  ['ytmusic', '/api/dl/ytmusic', 'url', 'user'],
  ['ytlive', '/api/dl/ytlive', 'url', 'user'],
  ['ytaudio', '/api/dl/ytaudio', 'url', 'user'],
  ['ytaudio2', '/api/dl/ytaudio2', 'url', 'user'],
  ['ytaudio3', '/api/dl/ytaudio3', 'url', 'user'],
  ['ytvideo', '/api/dl/ytvideo2', 'url', 'user'],
  ['ytvideo2', '/api/dl/ytvideo3', 'url', 'user'],
  ['ytvideo3', '/api/dl/ytvideo4', 'url', 'user'],
  ['soundcloudsearch', '/api/soundcloud/search', 'query', 'user'],
  ['soundclouddetails', '/api/soundcloud/track-details', 'url', 'user'],
  ['soundcloud', '/api/soundcloud', 'url', 'user'],
  ['xvideos', '/api/dl/xvideos', 'url', 'owner', true],
  ['xnxx', '/api/dl/xnxx', 'url', 'owner', true],
  ['pornhub', '/api/dl/pornhub', 'url', 'owner', true],
  ['shazam', '/api/shazam', 'url', 'user'],
  ['animestory', '/api/dl/anime-story', 'url', 'user'],
  ['applemusicsearch', '/api/applemusic/search', 'q', 'user'],
  ['applemusic', '/api/dl/applemusic', 'url', 'user'],
  ['pinterest', '/api/pinterest_mp4', 'url', 'user'],
  ['pinterest2', '/api/dl/pinterest', 'url', 'user'],
  ['aptoide', '/api/dl/aptoide', 'q', 'user'],
  ['tgsticker', '/api/dl/telegram-sticker', 'url', 'user'],
  ['tgstickers', '/api/telegram/stickers', 'url', 'user']
];
for (const [cmd, path_, param, perm, nsfw] of downloads) {
  add({
    cmd,
    category: 'downloads',
    path: path_,
    params: param === 'url' ? pUrl() : pQ(param === 'query' ? 'query' : 'q'),
    permission: perm,
    nsfw: !!nsfw,
    response: 'auto',
    menuLabel: cmd
  });
}

// ─── MONTAGEM canvas image effects (49) ───────────────────────
const montagens = [
  'legenda-foto', 'affect', 'batslap', 'brightness', 'color', 'colorfy', 'darkness',
  'fuse', 'kiss', 'replacecolor', 'spank', 'beautiful', 'blackwhite', 'blur',
  'bolsonaro', 'circle', 'comunism', 'delete', 'dither', 'facepalm', 'comic',
  'gay', 'invert', 'jail', 'magik', 'pixelate', 'qrcode', 'rip', 'rotate',
  'sepia', 'stickbug', 'threshold', 'trash', 'triggered', 'wanted', 'wasted'
];
for (const m of montagens) {
  add({
    cmd: `montagem${slug(m)}`,
    aliases: [slug(m)],
    category: 'montagem',
    path: `/api/canvas/${m}`,
    params: [
      { name: 'url', from: 'text', required: false },
      { name: 'avatar', from: 'text', required: false },
      { name: 'texto', from: 'text', required: false }
    ],
    response: 'buffer',
    permission: 'user',
    mediaHint: 'image',
    menuLabel: m
  });
}
const gifs = ['cuddle', 'feed', 'hug', 'kissgif', 'pat', 'poke', 'slap', 'tickle'];
for (const g of gifs) {
  const api = g === 'kissgif' ? 'kiss' : g;
  add({
    cmd: `gif${slug(g)}`,
    aliases: [slug(g)],
    category: 'montagem',
    path: `/api/gif/${api}`,
    params: [],
    response: 'buffer',
    permission: 'user',
    mediaHint: 'gif',
    menuLabel: g
  });
}
for (const v of ['countdown2026', 'greeting2026', 'newyearvideo', 'pubgvideo', 'tigervideo']) {
  add({
    cmd: v,
    category: 'montagem',
    path: `/api/video/${v}`,
    params: pText('texto'),
    response: 'buffer',
    permission: 'user',
    mediaHint: 'video',
    menuLabel: v
  });
}

// ─── LOGOS (104) — unificadas + ephoto/photooxy + list ────────
add({
  cmd: 'listlogos',
  category: 'logos',
  path: '/api/logos/list',
  params: [],
  response: 'json',
  permission: 'user',
  menuLabel: 'listar logos'
});
add({
  cmd: 'logoephoto',
  aliases: ['ephoto'],
  category: 'logos',
  path: '/api/ephoto',
  params: [
    { name: 'efeito', from: 'arg0', required: true },
    { name: 'texto', from: 'textRest', required: true }
  ],
  response: 'buffer',
  permission: 'user',
  mediaHint: 'image',
  menuLabel: 'logo ephoto'
});
add({
  cmd: 'logophotooxy',
  aliases: ['photooxy'],
  category: 'logos',
  path: '/api/photooxy',
  params: [
    { name: 'efeito', from: 'arg0', required: true },
    { name: 'texto', from: 'textRest', required: true }
  ],
  response: 'buffer',
  permission: 'user',
  mediaHint: 'image',
  menuLabel: 'logo photooxy'
});

const ephotos = [
  'glitch', 'galaxylight', 'glossy', 'metallic', 'graffiti', 'deadpool', 'vintage3d',
  'goldpink', 'dragonfire', 'newyear', 'tiger', 'pubgvideo', 'comics', 'amongus',
  'cemiterio', 'hallobat', 'blood', 'halloween', 'titanium', 'sunset', 'snow',
  'america', 'eraser', 'captain', 'blackpink', 'phlogo', 'metal', '3dcrack',
  'multicolor', 'balloon', 'colorful', 'frozen', 'graffitiwall', 'graffitipaint',
  'graffitistyle', 'ligatures', 'watercolor', 'cloudsky', 'summerbeach', 'royal',
  'countdown2026', 'happynewyear2026', 'dragonball', 'glossysilver', 'colorfulneon',
  'typographypavement', 'digitalglitch', '3dcubic', '3druby', '3dsilver', '3dtext',
  '3dtextstyle', '3dwooden', 'balloontext', 'beautifulgold', 'blueneon', 'bokeh',
  'bookname', 'caketext', 'caketextonline', 'candy', 'chocolate', 'christmas',
  'chrome', 'cloud', 'colortext', 'colorfulglow', 'colorfuleffects', '3dstone',
  'scifi', 'glitcheffect', 'galaxylogo', 'halloweentheme', 'avengers', 'bwlayer',
  'yasuo', 'nameeffect'
];
for (const ef of ephotos) {
  add({
    cmd: `ephoto${slug(ef)}`,
    category: 'logos',
    path: `/api/ephoto/${ef}`,
    params: pText('texto'),
    response: 'buffer',
    permission: 'user',
    mediaHint: 'image',
    menuLabel: `ephoto ${ef}`
  });
}
const ephotoUpload = [
  'galaxy', 'mascote', 'retro', 'pubgavatar', 'ffavatar', 'lolavatar',
  'mascoteneon', 'doubleexposure', 'glitter', 'techstyle', 'firework',
  'mascotemetal', 'newyear2026', 'fireworks2026', 'videogreeting2026', 'balloonframe2026'
];
for (const ef of ephotoUpload) {
  add({
    cmd: `ephotoup${slug(ef)}`,
    category: 'logos',
    path: `/api/ephoto/upload/${ef}`,
    params: [
      { name: 'texto', from: 'text', required: false },
      { name: 'url', from: 'text', required: false }
    ],
    response: 'buffer',
    permission: 'user',
    mediaHint: 'image',
    menuLabel: `ephoto upload ${ef}`
  });
}
const photooxy = [
  'neondark', 'glow', 'flaming', 'harrypotter', 'blackpink', 'reflectedneon', 'shadowsky'
];
for (const ef of photooxy) {
  add({
    cmd: `photooxy${slug(ef)}`,
    category: 'logos',
    path: `/api/photooxy/${ef}`,
    params: pText('texto'),
    response: 'buffer',
    permission: 'user',
    mediaHint: 'image',
    menuLabel: `photooxy ${ef}`
  });
}

// ─── ANIMES (62) ──────────────────────────────────────────────
add({ cmd: 'animewallpaper', category: 'animes', path: '/api/anime/wallpaper', params: [], response: 'buffer', permission: 'user', mediaHint: 'image' });
add({ cmd: 'metadinha', category: 'animes', path: '/api/anime/metadinha', params: [], response: 'json', permission: 'user' });
add({ cmd: 'cosplay', category: 'animes', path: '/api/anime/cosplay', params: [], response: 'buffer', permission: 'user', mediaHint: 'image' });
const waifus = [
  'waifu', 'waifu2', 'loli', 'shota', 'yotsuba', 'shinomiya', 'yumeko', 'tejina',
  'chiho', 'boruto', 'kaori', 'shizuka', 'kaga', 'kotori', 'mikasa', 'akiyama',
  'gremory', 'izuku', 'shina', 'kagura', 'shinka', 'eba', 'yuri', 'erza',
  'elaina', 'hinata', 'naruto', 'minato', 'sagari', 'nezuko', 'rize', 'anna',
  'deidara', 'asuna', 'ayuzawa', 'emilia', 'chitoge', 'hestia', 'inori',
  'itachi', 'madara', 'sakura', 'sasuke', 'tsunade', 'onepiece', 'mobil',
  'montor', 'keneki', 'megumin', 'toukachan'
];
for (const w of waifus) {
  add({
    cmd: `anime${slug(w)}`,
    aliases: [slug(w)],
    category: 'animes',
    path: `/api/anime/${w}`,
    params: [],
    response: 'buffer',
    permission: 'user',
    mediaHint: 'image',
    menuLabel: w
  });
}
const editAnimes = ['aleatorios', 'bleach', 'chainsaw', 'demonslayer', 'dragonball', 'hunterx', 'jujutsu', 'narutoedit', 'zerotwo'];
for (const a of editAnimes) {
  const api = a === 'narutoedit' ? 'naruto' : a === 'demonslayer' ? 'demon-slayer' : a === 'hunterx' ? 'hunterx' : a;
  add({
    cmd: `editanime${slug(a)}`,
    category: 'animes',
    path: `/api/anime/edit/${api}`,
    params: [],
    response: 'buffer',
    permission: 'user',
    mediaHint: 'image'
  });
}

// ─── WALLPAPERS (28) ───────────────────────────────────────────
const walls = [
  'aleatorios', 'china', 'hijaber', 'indonesia', 'japan', 'korea', 'malaysia',
  'thailand', 'vietnam', 'aesthetic', 'anjing', 'blackpink', 'boneka', 'cecan',
  'hekel', 'justina', 'kayes', 'kpop', 'kucing', 'mobil', 'montor', 'notnot',
  'profil', 'pubg', 'rose', 'ryujin', 'wallhp', 'wallml'
];
for (const w of walls) {
  add({
    cmd: `wall${slug(w)}`,
    category: 'wallpapers',
    path: `/api/wallpaper/${w}`,
    params: [],
    response: 'buffer',
    permission: 'user',
    mediaHint: 'image',
    menuLabel: w
  });
}

// ─── CONSULTAS (26) — owner ───────────────────────────────────
const consultas = [
  ['cpf', '/consultas/serasa/cpf', 'cpf'],
  ['cpf2', '/consultas/serasa/cpf2', 'cpf'],
  ['cpf3', '/consultas/serasa/cpf3', 'cpf'],
  ['cpf4', '/consultas/serasa/cpf4', 'cpf'],
  ['cpf5', '/consultas/serasa/cpf5', 'cpf'],
  ['rg', '/consultas/serasa/rg', 'rg'],
  ['nome', '/consultas/serasa/nome', 'nome'],
  ['nome2', '/consultas/serasa/nome2', 'nome'],
  ['mae', '/consultas/serasa/mae', 'nome'],
  ['telefone', '/consultas/serasa/telefone', 'telefone'],
  ['telefone3', '/consultas/serasa/telefone3', 'telefone'],
  ['score', '/consultas/serasa/score', 'cpf'],
  ['cnpj', '/consultas/serasa/cnpj', 'cnpj'],
  ['cep', '/consultas/serasa/cep', 'cep'],
  ['ddd', '/consultas/serasa/ddd', 'ddd'],
  ['placa', '/consultas/serasa/placa', 'placa'],
  ['chassi', '/consultas/serasa/chassi', 'chassi'],
  ['cnh', '/consultas/serasa/cnh', 'cnh'],
  ['abreviado', '/consultas/serasa/abreviado', 'cpf'],
  ['srs', '/consultas/serasa/srs', 'cpf'],
  ['fotorj', '/consultas/serasa/foto-rj', 'cpf'],
  ['obito', '/consultas/serasa/obito', 'cpf'],
  ['parentes', '/consultas/serasa/parentes', 'cpf'],
  ['bin2', '/consultas/serasa/bin2', 'bin'],
  ['gerarcpf', '/consultas/gerar-cpf', 'q'],
  ['gerarcc', '/consultas/gerar-cc', 'q']
];
for (const [cmd, path_, param] of consultas) {
  add({
    cmd: `zt${cmd}`,
    aliases: cmd === 'cpf' ? [] : [],
    category: 'consultas',
    path: path_,
    params: [{ name: param === 'q' ? 'q' : param, from: 'text', required: true }],
    response: 'json',
    permission: 'owner',
    menuLabel: cmd
  });
}

// ─── PESQUISAS (56) ───────────────────────────────────────────
const pesquisas = [
  ['ytsearchall', '/api/ytsrc', 'q'],
  ['ytsearchvid', '/api/yt/search/video', 'q'],
  ['ytplaylist', '/api/yt/playlist', 'q'],
  ['spotifysearch', '/api/spotify/search', 'q'],
  ['pinimg', '/api/pinterest/search', 'q'],
  ['pinimg2', '/api/pinterest/search2', 'q'],
  ['pinvid', '/api/pinterest/video', 'q'],
  ['igstalk', '/api/instagram/stalk', 'q'],
  ['igseguidores', '/api/instagram/followers', 'q'],
  ['igseguindo', '/api/instagram/following', 'q'],
  ['ytstalk', '/api/youtube/stalk', 'q'],
  ['ttstalk', '/api/tiktok/stalk', 'q'],
  ['ttstalk2', '/api/tiktok/stalk2', 'q'],
  ['ghstalk', '/api/github/stalk', 'q'],
  ['wastalk', '/api/whatsapp/stalk', 'q'],
  ['ttboost', '/api/tiktok/boost', 'url'],
  ['kwaisearch', '/api/kwai/search', 'q'],
  ['kwaistalk', '/api/kwai/stalk', 'q'],
  ['imdb', '/api/imdb/search', 'q'],
  ['imdbinfo', '/api/imdb/info', 'q'],
  ['animesearch', '/api/anime/search', 'q'],
  ['animeinfo', '/api/anime/info', 'q'],
  ['gimage', '/api/google/image', 'q'],
  ['gsearch', '/api/google/search', 'q'],
  ['letra', '/api/lyrics', 'q'],
  ['letra2', '/api/lyrics2', 'q'],
  ['playstore', '/api/playstore', 'q'],
  ['wattpad', '/api/wattpad', 'q'],
  ['nerding', '/api/nerding', 'q'],
  ['happymod', '/api/happymod', 'q'],
  ['pensador', '/api/pensador', 'q'],
  ['pensador2', '/api/pensador2', 'q'],
  ['mercadolivre', '/api/mercadolivre', 'q'],
  ['amazon', '/api/amazon', 'q'],
  ['horoscopo', '/api/horoscope', 'q'],
  ['g1', '/api/news/g1', 'q'],
  ['poder360', '/api/news/poder360', 'q'],
  ['jovempan', '/api/news/jovempan', 'q'],
  ['uol', '/api/news/uol', 'q'],
  ['cnnbr', '/api/news/cnn', 'q'],
  ['estadao', '/api/news/estadao', 'q'],
  ['brasileirao', '/api/news/brasileirao', 'q'],
  ['esporte', '/api/news/esporte', 'q'],
  ['esports', '/api/news/esports', 'q'],
  ['npmsearch', '/api/npm', 'q'],
  ['stickersearch', '/api/sticker/search', 'q'],
  ['bing', '/api/bing/search', 'q'],
  ['bingimg', '/api/bing/image', 'q'],
  ['bingvid', '/api/bing/video', 'q'],
  ['pokemon', '/api/pokemon', 'q'],
  ['grupos', '/api/groups/random', 'q'],
  ['grupos2', '/api/groups/random2', 'q'],
  ['bbb26', '/api/bbb/reality', 'q'],
  ['bbbbigdays', '/api/bbb/bigdays', 'q'],
  ['bbbfora', '/api/bbb/fora', 'q'],
  ['spacenews', '/api/space/news', 'q']
];
for (const [cmd, path_, param] of pesquisas) {
  add({
    cmd,
    category: 'pesquisas',
    path: path_,
    params: param === 'url' ? pUrl() : pQ(),
    response: 'json',
    permission: 'user',
    menuLabel: cmd
  });
}

// ─── NSFW (35) owner ──────────────────────────────────────────
const nsfwSearch = ['xvideossearch', 'xnxxsearch', 'pornhubsearch'];
for (const c of nsfwSearch) {
  const api = c.replace('search', '');
  add({
    cmd: c,
    category: 'nsfw',
    path: `/api/nsfw/search/${api}`,
    params: pQ(),
    response: 'json',
    permission: 'owner',
    nsfw: true
  });
}
const nsfwRand = [
  'loli', 'ahegao', 'ass', 'bdsm', 'blowjob', 'cuckold', 'cum', 'ero', 'femdom',
  'foot', 'gangbang', 'glasses', 'hentai', 'jahy', 'manga', 'neko', 'neko2',
  'orgy', 'panties', 'pussy', 'tentacles', 'thighs', 'yuri', 'zettairyouiki', 'tetas'
];
for (const n of nsfwRand) {
  add({
    cmd: `nsfw${slug(n)}`,
    category: 'nsfw',
    path: `/api/nsfw/${n}`,
    params: [],
    response: 'buffer',
    permission: 'owner',
    nsfw: true,
    mediaHint: 'image'
  });
}
const hentainyaa = [
  ['hentainyaahome', '/api/hentainyaa/home'],
  ['hentainyaasearch', '/api/hentainyaa/search'],
  ['hentainyaacats', '/api/hentainyaa/categories'],
  ['hentainyaacat', '/api/hentainyaa/category'],
  ['hentainyaastudio', '/api/hentainyaa/studio'],
  ['hentainyaadetail', '/api/hentainyaa/detail'],
  ['hentainyaaep', '/api/hentainyaa/episode']
];
for (const [cmd, path_] of hentainyaa) {
  add({
    cmd,
    category: 'nsfw',
    path: path_,
    params: pQ(),
    response: 'json',
    permission: 'owner',
    nsfw: true
  });
}

// ─── FIGURINHAS (16) ──────────────────────────────────────────
add({ cmd: 'attpcanvas', category: 'figurinhas', path: '/api/canvas/attps', params: [{ name: 'texto', from: 'text', required: true }, { name: 'type', from: 'fixed', value: 'attp' }], response: 'buffer', permission: 'user', mediaHint: 'sticker' });
add({ cmd: 'amongusfig', category: 'figurinhas', path: '/api/sticker/amongus', params: pText('texto'), response: 'buffer', permission: 'user', mediaHint: 'sticker' });
for (const f of ['random1', 'random2', 'figemoji', 'figflork', 'figale', 'figmemes', 'figanime', 'figcoreana', 'figbebe', 'figdesenho', 'figanimais']) {
  add({
    cmd: slug(f),
    category: 'figurinhas',
    path: `/api/sticker/${f}`,
    params: [],
    response: 'buffer',
    permission: 'user',
    mediaHint: 'sticker'
  });
}
add({ cmd: 'stickerlypack', category: 'figurinhas', path: '/api/stickerly/pack', params: pQ(), response: 'json', permission: 'user' });
add({ cmd: 'stickerlysearch', category: 'figurinhas', path: '/api/stickerly/search', params: pQ(), response: 'json', permission: 'user' });
add({ cmd: 'stickerlytrend', category: 'figurinhas', path: '/api/stickerly/trending', params: [], response: 'json', permission: 'user' });

// ─── UPLOAD (3) ───────────────────────────────────────────────
add({ cmd: 'ztupload', category: 'upload', path: '/api/upload', params: [], response: 'json', permission: 'vip', upload: true });
add({ cmd: 'ztuploadjson', category: 'upload', path: '/api/upload/json', params: [], response: 'json', permission: 'vip', upload: true });
add({ cmd: 'telegra', category: 'upload', path: '/api/telegra', params: [], response: 'json', permission: 'vip', upload: true });

// ─── DORAMAS (30) ─────────────────────────────────────────────
const doramas = [
  ['doramasearch', '/api/doramas/search'],
  ['doramaserie', '/api/doramas/serie'],
  ['doramafilme', '/api/doramas/filme'],
  ['doramaep', '/api/doramas/episodio'],
  ['doramadl', '/api/doramas/download'],
  ['doramarecentes', '/api/doramas/recentes'],
  ['sdhome', '/api/seudorama/home'],
  ['sdbuscar', '/api/seudorama/search'],
  ['sdcatalogo', '/api/seudorama/catalog'],
  ['sdfilmes', '/api/seudorama/filmes'],
  ['sdcomentarios', '/api/seudorama/comments'],
  ['sdtemporadas', '/api/seudorama/seasons'],
  ['sdeps', '/api/seudorama/episodes'],
  ['sdfeed', '/api/seudorama/feed'],
  ['sddetalhes', '/api/seudorama/detail'],
  ['sdalleps', '/api/seudorama/all-episodes'],
  ['sdepdetail', '/api/seudorama/episode'],
  ['sdstream', '/api/seudorama/stream'],
  ['sdcheck', '/api/seudorama/check'],
  ['sdgeneros', '/api/seudorama/genres'],
  ['sdporgenero', '/api/seudorama/by-genre'],
  ['sdtaxonomia', '/api/seudorama/taxonomy'],
  ['sdtermos', '/api/seudorama/terms'],
  ['sdsitemap', '/api/seudorama/sitemap'],
  ['sdslugs', '/api/seudorama/slugs'],
  ['sddivergencias', '/api/seudorama/divergences'],
  ['sdstats', '/api/seudorama/stats'],
  ['sdcatalogofull', '/api/seudorama/catalog-full'],
  ['sdwatch', '/api/seudorama/watch'],
  ['sdimgproxy', '/api/seudorama/image']
];
for (const [cmd, path_] of doramas) {
  add({
    cmd,
    category: 'doramas',
    path: path_,
    params: pQ(),
    response: 'json',
    permission: 'vip',
    menuLabel: cmd
  });
}

// ─── ENCONTREI / POBREFLIX (14) ────────────────────────────────
const encontrei = [
  ['pflxlogin', '/api/pobreflix/login'],
  ['pflxhome', '/api/pobreflix/home'],
  ['pflxbuscar', '/api/pobreflix/search'],
  ['pflxfilmes', '/api/pobreflix/filmes'],
  ['pflxseries', '/api/pobreflix/series'],
  ['pflxfiltros', '/api/pobreflix/filters'],
  ['pflxficha', '/api/pobreflix/item'],
  ['pflxeps', '/api/pobreflix/episodes'],
  ['pflxservers', '/api/pobreflix/servers'],
  ['pflxstream', '/api/pobreflix/stream'],
  ['pflxfavs', '/api/pobreflix/favorites'],
  ['pflxfavoritar', '/api/pobreflix/favorite'],
  ['pflxtoggle', '/api/pobreflix/favorite-toggle'],
  ['pflxdesfav', '/api/pobreflix/unfavorite']
];
for (const [cmd, path_] of encontrei) {
  add({
    cmd,
    category: 'encontrei',
    path: path_,
    params: pQ(),
    response: 'json',
    permission: 'vip'
  });
}

// ─── ANICHIN & ETC (25) ───────────────────────────────────────
const anichin = [
  ['anichinsearch', '/api/anichin/search'],
  ['anichinpopular', '/api/anichin/popular'],
  ['anichinlatest', '/api/anichin/latest'],
  ['anichindetail', '/api/anichin/detail'],
  ['anichinep', '/api/anichin/episode'],
  ['anichindl', '/api/anichin/download'],
  ['otakudesu', '/api/otakudesu/search'],
  ['otakudesudl', '/api/otakudesu/download'],
  ['animesgames', '/api/animesgames/search'],
  ['animesgamesep', '/api/animesgames/episode'],
  ['animesgamesdl', '/api/animesgames/download'],
  ['animesgamesdl2', '/api/animesgames/download2'],
  ['animesfire', '/api/animesfire/search'],
  ['animesfiredetail', '/api/animesfire/detail'],
  ['animesfiredl', '/api/animesfire/download'],
  ['animesdigital', '/api/animesdigital/search'],
  ['animesdigitalep', '/api/animesdigital/episode'],
  ['animesdigitaldl', '/api/animesdigital/download'],
  ['animeshd', '/api/animeshd/search'],
  ['animeshdlist', '/api/animeshd/list'],
  ['animeshdrecent', '/api/animeshd/recent'],
  ['animeshdeps', '/api/animeshd/episodes'],
  ['animeshdinfo', '/api/animeshd/info'],
  ['animeshdlink', '/api/animeshd/link'],
  ['animeshdwatch', '/api/animeshd/watch']
];
for (const [cmd, path_] of anichin) {
  add({
    cmd,
    category: 'anichin',
    path: path_,
    params: pQ(),
    response: 'json',
    permission: 'vip'
  });
}

// ─── MANGAS (26) ──────────────────────────────────────────────
const mangas = [
  ['mangadex', '/api/mangadex/search'],
  ['mangadexcaps', '/api/mangadex/chapters'],
  ['mangadexpages', '/api/mangadex/pages'],
  ['mlhome', '/api/mangalivre/home'],
  ['mlrecentes', '/api/mangalivre/recent'],
  ['mllancamentos', '/api/mangalivre/releases'],
  ['mlpopulares', '/api/mangalivre/popular'],
  ['mlvistos', '/api/mangalivre/most-viewed'],
  ['mlbuscar', '/api/mangalivre/search'],
  ['mlcatalogo', '/api/mangalivre/catalog'],
  ['mlcatalogofull', '/api/mangalivre/catalog-full'],
  ['mlgeneros', '/api/mangalivre/genres'],
  ['mlporgenero', '/api/mangalivre/by-genre'],
  ['mlstatus', '/api/mangalivre/by-status'],
  ['mlidiomas', '/api/mangalivre/languages'],
  ['mlporidioma', '/api/mangalivre/by-language'],
  ['mlfiltros', '/api/mangalivre/filters'],
  ['mldetalhes', '/api/mangalivre/detail'],
  ['mlcapitulos', '/api/mangalivre/chapters'],
  ['mlpaginas', '/api/mangalivre/pages'],
  ['mlstats', '/api/mangalivre/stats'],
  ['mlsitemap', '/api/mangalivre/sitemap'],
  ['mlrest', '/api/mangalivre/rest-search'],
  ['mlfeed', '/api/mangalivre/feed'],
  ['mldl', '/api/mangalivre/download'],
  ['mlfull', '/api/mangalivre/catalog-details']
];
for (const [cmd, path_] of mangas) {
  add({
    cmd,
    category: 'mangas',
    path: path_,
    params: pQ(),
    response: 'json',
    permission: 'vip'
  });
}

// ─── MCPEDL (21) ──────────────────────────────────────────────
const mcpedl = [
  'home', 'search', 'mods', 'maps', 'textures', 'shaders', 'versions',
  'category', 'categories', 'detail', 'video', 'videos', 'direct',
  'apk', 'download', 'sitemap', 'slugs', 'stats', 'scan', 'resolve', 'watch'
];
for (const m of mcpedl) {
  add({
    cmd: `mcpedl${slug(m)}`,
    category: 'mcpedl',
    path: `/api/mcpedl/${m}`,
    params: pQ(),
    response: 'json',
    permission: 'user'
  });
}

// ─── TINDER (8) owner ─────────────────────────────────────────
const tinder = [
  ['tinderreg', '/api/tinder/register'],
  ['tinderlike', '/api/tinder/like'],
  ['tinderdislike', '/api/tinder/dislike'],
  ['tinderbuscar', '/api/tinder/search'],
  ['tinderfoto', '/api/tinder/photo'],
  ['tinderdel', '/api/tinder/delete'],
  ['tinderrank', '/api/tinder/ranking'],
  ['tindersugest', '/api/tinder/suggestions']
];
for (const [cmd, path_] of tinder) {
  add({
    cmd,
    category: 'tinder',
    path: path_,
    params: pQ(),
    response: 'json',
    permission: 'owner'
  });
}

// ─── JOGOS (7) ────────────────────────────────────────────────
const jogos = ['cobrinha', 'velha', 'matematica', 'quizanime', 'mario', 'mario2', 'cassinolobby'];
for (const j of jogos) {
  const api = j === 'cassinolobby' ? 'casino/lobby' : j === 'mario2' ? 'mario2' : j;
  add({
    cmd: `jogo${slug(j)}`,
    aliases: j === 'cassinolobby' ? ['cassino', 'cassinolobby'] : [slug(j)],
    category: 'jogos',
    path: `/api/games/${api}`,
    params: pQ(),
    response: 'json',
    permission: j === 'cassinolobby' ? 'owner' : 'user'
  });
}

// ─── CASSINO (114) owner ──────────────────────────────────────
const cassinoGames = [
  'fortuneox', 'fortunemouse', 'fortunedragon', 'mahjongways', 'mahjongways2',
  'luckyneko', 'treasuresofaztec', 'wildbandito', 'luckypiggy', 'buffalowin',
  'baccaratdeluxe', 'dragonhatch', 'waysoftheqilin', 'wildbountyshowdown',
  'thairiverwonders', 'dreamsofmacau', 'fortunegods', 'ganeshagold',
  'captainsbounty', 'galacticgems', 'cryptogold', 'forgeofwealth', 'mafiamayhem',
  'cashmania', 'chickyrun', 'wildape', 'balivacation', 'battlegroundroyale',
  'bikiniparadise', 'butterflyblossom', 'caishenwins', 'candyburst', 'candysuperwin',
  'chickyroyale', 'circusdelight', 'cocktailnights', 'cruiseroyale', 'cryptoffortune',
  'destinyofsunmoon', 'dinerdelights', 'doublefortune', 'dragonlegend', 'dragontigerluck',
  'egyptsbook', 'emojiriches', 'emperorsfavour', 'flirtingscholar', 'fruitycandy',
  'ganeshafortune', 'garudagems', 'gemsaviour', 'gemsaviourconquest', 'gemsavioursword',
  'genies3wishes', 'guardiansicefire', 'hawaiianiki', 'heiststakes', 'hiphoppanda',
  'honeytrap', 'hoodvswolf', 'hotpot', 'jackfrost', 'jewelsofprosperity',
  'journeytowealth', 'jungledelight', 'jurassickingdom', 'legendofhouyi',
  'legendofperseus', 'legendarymonkeyking', 'leprechaunriches', 'luckycloverriches',
  'majestictreasures', 'maskcarnival', 'medusa', 'medusa2', 'mermaidriches',
  'midasfortune', 'mrhollowjackpot', 'muaythai', 'mysticalspirits',
  'ninjaraccoonfrenzy', 'ninjavssamurai', 'operadynasty', 'orientalprosperity',
  'phoenixrises', 'piggygold', 'plushiefrenzy', 'prosperitylion', 'queenofbounty',
  'ravepartyfever', 'reellove', 'riseofthesungod', 'roosterrumble', 'santasgiftrush',
  'secretsofcleopatra', 'shaolinsoccer', 'songkransplash', 'speedwinner',
  'spiritedwonders', 'supergolfdrive', 'supermarketspree', 'symbolsofegypt',
  'thegreaticescape', 'thequeensbanquet', 'totemwonders', 'treeoffortune',
  'ultimatestriker', 'vampirescharm', 'wildcoaster', 'wildfireworks',
  'winwinfishprawncrab', 'winwinwon', 'zombieoutbreak',
  // extras to reach ~114 with lobby already counted in jogos
  'fortunetiger', 'fortunerabbit', 'gatesofolympus', 'sweetbonanza', 'starlightprincess',
  'sugarush', 'fruity', 'wisdomofathena', 'doubleriches', 'wildbounty'
];
for (const g of cassinoGames) {
  add({
    cmd: `cassino${slug(g)}`,
    aliases: [slug(g)],
    category: 'cassino',
    path: `/api/casino/${g}`,
    params: pQ(),
    response: 'json',
    permission: 'owner',
    menuLabel: g
  });
}

// ─── CANVAS (23) ──────────────────────────────────────────────
const canvas = [
  ['welcome', '/api/canvas/welcome'],
  ['top10', '/api/canvas/top10'],
  ['level', '/api/canvas/level'],
  ['levelup', '/api/canvas/levelup'],
  ['levelup2', '/api/canvas/levelup2'],
  ['ship', '/api/canvas/ship'],
  ['welcomesimples', '/api/canvas/welcome-simple'],
  ['goodbyesimples', '/api/canvas/goodbye-simple'],
  ['welcomejxr', '/api/canvas/welcome-jxr'],
  ['goodbyejxr', '/api/canvas/goodbye-jxr'],
  ['musiccard', '/api/canvas/music-card'],
  ['musiccard2', '/api/canvas/music-card2'],
  ['musiccard3', '/api/canvas/music-card3'],
  ['premiumwelcome', '/api/canvas/premium-welcome'],
  ['premiumgoodbye', '/api/canvas/premium-goodbye'],
  ['aniversario', '/api/canvas/birthday'],
  ['nglcanvas', '/api/canvas/ngl'],
  ['gurasticker', '/api/canvas/gura'],
  ['pingcanvas', '/api/canvas/welcome'],
  ['pingcanvas2', '/api/canvas/welcome'],
  ['duelocanvas', '/api/canvas/duelo'],
  ['brat', '/api/maker/brat'],
  ['bratvideo', '/api/maker/brat']
];
for (const [cmd, path_] of canvas) {
  const isBrat = cmd.startsWith('brat');
  add({
    cmd,
    category: 'canvas',
    path: path_,
    params: isBrat
      ? [{ name: 'text', from: 'text', required: true }]
      : [
          { name: 'nome', from: 'text', required: false },
          { name: 'url', from: 'text', required: false },
          { name: 'texto', from: 'text', required: false }
        ],
    response: isBrat ? 'auto' : 'buffer',
    permission: 'user',
    mediaHint: cmd.includes('video') ? 'video' : 'image'
  });
}

// ─── IAS (29) vip/owner ───────────────────────────────────────
const ias = [
  ['chatgpt', '/api/ia/zerotwo', 'vip'],
  ['chatgpt4', '/api/ia/gpt', 'vip'],
  ['gpt', '/api/ia/gpt', 'vip'],
  ['hanorkia', '/api/ia/zerotwo', 'vip'],
  ['claude', '/api/ia2/claude', 'vip'],
  ['geminipro', '/api/ia2/geminipro', 'vip'],
  ['deepseek', '/api/ia2/deepseek_r1', 'vip'],
  ['chatgpt55', '/api/ia2/chatgpt_5_5', 'vip'],
  ['gpt4omini', '/api/ia2/gpt4o_mini', 'vip'],
  ['llama33', '/api/ia2/llama33', 'vip'],
  ['qwencoder', '/api/ia2/qwencoder', 'vip'],
  ['mistral', '/api/ia2/mistral', 'vip'],
  ['geminitexto', '/gemini/texto', 'vip'],
  ['geminiimg', '/gemini/imagem', 'vip'],
  ['gptvideo', '/api/ia/gpt-video', 'vip'],
  ['animagine', '/api/ia/animagine', 'vip'],
  ['iaimagine', '/api/ia/animagine', 'vip'],
  ['iaimaginestatus', '/api/ia/imagine/status', 'vip'],
  ['gemini', '/api/ia2/geminipro', 'vip'],
  ['toanime', '/api/ia/toanime', 'vip'],
  ['tozombie', '/api/ia/tozombie', 'vip'],
  ['togta', '/api/ia/togta', 'vip'],
  ['iacode', '/api/ia/generate-code', 'vip'],
  ['iapoem', '/api/ia/generate-poem', 'vip'],
  ['identifyanime', '/api/ia/identify-anime', 'vip'],
  ['veo2', '/api/ia/veo2', 'vip'],
  ['randomface', '/api/ia/random-face', 'vip'],
  ['pollinations', '/api/ia/gpt', 'vip'],
  ['iatts', '/api/ia/tts', 'vip'],
  ['ttsvoces', '/api/ia/tts/voices', 'vip'],
  ['ttsbuscar', '/api/ia/tts/search-voices', 'vip'],
  ['ttsmodelos', '/api/ia/tts/models', 'vip'],
  ['ttsaudio', '/api/ia/tts/generate', 'vip'],
  ['ttspresets', '/api/ia/tts/presets', 'vip'],
  ['ttsinfo', '/api/ia/tts/info', 'vip'],
  ['transcrever', '/api/transcrever', 'vip'],
  ['iapremium', '/api/ia/gpt', 'owner'],
  ['iaflux', '/api/ia/animagine', 'vip'],
  ['iasdxl', '/api/ia/animagine', 'vip'],
  ['nanobanana', '/api/ia/animagine', 'vip']
];
for (const [cmd, path_, perm] of ias) {
  add({
    cmd,
    category: 'ias',
    path: path_,
    params: pText('query'),
    response: 'auto',
    permission: perm
  });
}

// ─── OUTROS (14) ──────────────────────────────────────────────
const outros = [
  ['rastreio', '/api/correios/rastreio', 'user'],
  ['icms', '/api/icms', 'user'],
  ['ssweb', '/api/ssweb', 'user'],
  ['removebg', '/api/removebg', 'vip'],
  ['hd', '/api/hd', 'vip'],
  ['hdvideo', '/api/hd-video', 'vip'],
  ['hdvideostatus', '/api/hd-video/status', 'vip'],
  ['hdvideodl', '/api/hd-video/download', 'vip'],
  ['tradutor', '/api/translate', 'user'],
  ['nickpro', '/api/nickpro', 'user'],
  ['emojimix', '/api/emoji-mix', 'user'],
  ['operadora', '/api/operadora', 'user'],
  ['antipornoapi', '/api/antiporno', 'owner'],
  ['ascii', '/api/ascii', 'user'],
  ['encurtar', '/api/shorturl', 'user'],
  ['encurtarnet', '/api/shorturl/net', 'user']
];
for (const [cmd, path_, perm] of outros) {
  add({
    cmd,
    category: 'outros',
    path: path_,
    params: pQ(),
    response: 'auto',
    permission: perm
  });
}

// ─── write ────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const byCat = {};
for (const e of entries) {
  byCat[e.category] = (byCat[e.category] || 0) + 1;
}
const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: 'https://zero-two-apis.store/docs',
  count: entries.length,
  byCategory: byCat,
  entries
};
fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2));
console.log(`OK ${entries.length} endpoints -> ${OUT}`);
console.log(JSON.stringify(byCat, null, 2));
