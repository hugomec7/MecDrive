// MecDrive — interface e fila de downloads. O rclone (rcd) faz as transferências; ver src-tauri/src/main.rs.
'use strict';
const { invoke } = window.__TAURI__.core;
const win = window.__TAURI__.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const MAX_TENTATIVAS = 7;
const REPO_URL = 'https://github.com/hugomec7/MecDrive';

const S = {
  info: null,
  cfg: { base: '', transfers: 4, view: 'details', zoom: 1, openAfter: false },
  email: '',
  links: [], // { url, id, rk, kind: 'folder'|'file', name }
  files: [], // { l (índice do link), src, size, st, bytes, speed, err, path }
  dirs: [], // { l, path } — para mostrar também as pastas vazias
  off: new Set(), // índices de arquivos desmarcados
  closed: new Set(), // pastas recolhidas
  dest: { mode: 'auto', date: '', auto: null, custom: '' },
  opts: { sub: '', prefix: '', suffix: '', keepRoot: false, transfers: 4 },
  free: null,
  job: null,
  run: null,
  phase: 'idle', // idle | reading | running | paused | done | error
  history: [],
  update: null,
};
window.DD = { S };

/* ---------------- utilidades ---------------- */
function fmtSize(n) {
  if (n == null || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  const d = i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return n.toFixed(d).replace('.', ',') + ' ' + u[i];
}
function fmtTime(s) {
  if (!isFinite(s) || s == null || s < 0) return '—';
  s = Math.round(s);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + String(s % 60).padStart(2, '0') + ' s';
  return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const natCmp = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' }).compare;
const cleanName = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '');
const cleanSub = (s) => s.split(/[\\/]+/).map((p) => cleanName(p).trim().replace(/\.+$/, '')).filter(Boolean).join('\\');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isBusy = () => S.phase === 'running' || S.phase === 'paused';
const canEdit = () => S.phase === 'idle' || S.phase === 'error' || S.phase === 'done';

// O rclone troca os caracteres proibidos no Windows por equivalentes de largura cheia; repetimos a regra
// para saber, antes de baixar, qual vai ser o caminho exato de cada arquivo no disco.
const ENC = { '<': '＜', '>': '＞', ':': '：', '"': '＂', '|': '｜', '?': '？', '*': '＊', '\\': '＼' };
const encSeg = (s) => s.replace(/[<>:"|?*\\]/g, (c) => ENC[c]).replace(/ $/, '␠').replace(/\.$/, '．');
const localPath = (base, rel) => base + '\\' + rel.split('/').map(encSeg).join('\\');
// Troca o que o Windows não aceita em nomes por caracteres permitidos (a mesma regra está em src-tauri/src/shared.rs):
// barras, dois-pontos e barra vertical viram hífen, aspas viram apóstrofo, < > viram parênteses, ? e * somem,
// e espaço ou ponto no fim do nome é cortado. O rclone entrega a barra do Drive como "／".
const CLEAN = { '/': '-', '／': '-', '\\': '-', '＼': '-', ':': '-', '：': '-', '|': '-', '｜': '-', '"': "'", '＂': "'", '<': '(', '＜': '(', '>': ')', '＞': ')', '?': '', '？': '', '*': '', '＊': '' };
const cleanSeg = (p) => p.replace(/[\/／\\＼:：|｜"＂<＜>＞?？*＊]/g, (c) => CLEAN[c]).replace(/[\u0000-\u001f]/g, '').replace(/[ .]+$/, '').replace(/^ +/, '') || '_';
const winTrim = (rel) => rel.split('/').filter(Boolean).map(cleanSeg).join('/');

let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

function ask(title, msg, buttons, list) {
  return new Promise((resolve) => {
    $('alertTitle').textContent = title;
    $('alertMsg').textContent = msg;
    $('alertList').textContent = (list || []).join('\n');
    const box = $('alertBtns');
    box.innerHTML = '';
    buttons.forEach((b) => {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.bold) el.classList.add('bold');
      if (b.red) el.classList.add('red');
      el.onclick = () => { document.body.classList.remove('alert-open'); resolve(b.value); };
      box.appendChild(el);
    });
    document.body.classList.add('alert-open');
  });
}

function setStatus(kind, txt) {
  $('dot').className = 'dot ' + kind;
  $('statusTxt').textContent = txt;
}
function setPhase(p) {
  S.phase = p;
  document.body.className = document.body.className.replace(/\bst-\w+/g, '').trim() + ' st-' + p;
  const busy = isBusy();
  $('left').classList.toggle('locked', busy || p === 'reading');
  $('bGo').classList.toggle('hide', busy || p === 'done');
  $('runBtns').classList.toggle('hide', !busy);
  $('doneBtns').classList.toggle('hide', p !== 'done' && p !== 'error');
  $('bPause').textContent = p === 'paused' ? 'Continuar' : 'Pausar';
  $('bCancel').disabled = $('bPause').disabled = false;
  $('bGoTxt').textContent = p === 'error' ? 'Tentar de novo' : 'Baixar';
  refreshGo();
  refreshStatus();
  refreshClear();
}
function refreshStatus() {
  if (S.phase === 'running') return setStatus('run', 'Baixando…');
  if (S.phase === 'paused') return setStatus('wait', 'Pausado');
  if (S.phase === 'reading') return setStatus('wait', 'Lendo o link…');
  if (!S.info) return setStatus('wait', 'Iniciando…');
  if (!S.info.hasRclone) return setStatus('err', 'rclone.exe não encontrado em bin');
  if (!S.info.hasToken) return setStatus('err', 'Sem login no Google');
  setStatus('ok', S.email ? 'Conectado · ' + S.email : 'Conectado ao Google Drive');
}

/* ---------------- rclone ---------------- */
const rc = (method, params = {}, timeoutSecs = null) => invoke('rc', { method, params, timeoutSecs });

async function driveGet(query, rk) {
  const call = () => invoke('drive_get', { query, resourceKey: rk || null });
  for (let n = 0; ; n++) {
    try {
      return await call();
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith('HTTP 401') && n === 0) {
        // token vencido: qualquer chamada do rclone renova e grava o novo token
        await rc('operations/about', { fs: 'gdrive:' }, 30).catch(() => {});
      } else if (/HTTP (403|429|5\d\d)|[rR]ateLimit/.test(msg) && n < 3) {
        await sleep(900 * 2 ** n); // limite de chamadas do Google: espera e tenta de novo
      } else {
        throw e;
      }
    }
  }
}
const srcFs = (l) => `gdrive,root_folder_id=${l.id}${l.rk ? ',resource_key=' + l.rk : ''}:`;

async function connect() {
  S.info = await invoke('app_info');
  $('confPath').textContent = S.info.data + '\\rclone.conf';
  $('verTxt').textContent = $('mVer').textContent = 'Versão ' + S.info.version;
  $('credit').textContent = `MecDrive ${S.info.version} · @hugoeditor_`;
  $('loginBox').classList.toggle('hide', S.info.hasToken || !S.info.hasRclone);
  S.email = '';
  if (S.info.hasRclone && S.info.hasToken) {
    await invoke('rcd_start');
    driveGet('about?fields=user(emailAddress)').then((a) => {
      S.email = (a.user && a.user.emailAddress) || '';
      $('accEmail').value = S.email || 'conectado';
      refreshStatus();
    }).catch(() => {});
  }
  $('accEmail').value = S.info.hasToken ? 'conectado' : '';
  $('bAcc').textContent = S.info.hasToken ? 'Sair' : 'Entrar';
  refreshStatus();
  refreshGo();
}

async function login() {
  const b = $('bLogin');
  b.classList.add('busy');
  b.disabled = true;
  $('bLoginTxt').textContent = 'Aguardando você autorizar no navegador…';
  $('bLoginCancel').classList.remove('hide');
  setStatus('wait', 'Aguardando login no navegador…');
  try {
    await invoke('google_login');
    toast('Conta conectada');
  } catch (e) {
    toast('Login não concluído: ' + e, 5000);
  }
  b.classList.remove('busy');
  b.disabled = false;
  $('bLoginTxt').textContent = 'Entrar no Google';
  $('bLoginCancel').classList.add('hide');
  await connect();
  if (S.info.hasToken && $('iLink').value.trim()) addLinks($('iLink').value);
}

/* ---------------- links e árvore ---------------- */
function parseLink(s) {
  s = s.trim();
  const rk = (s.match(/[?&]resourcekey=([\w-]+)/) || [])[1] || '';
  let m;
  if ((m = s.match(/\/folders\/([\w-]{10,})/))) return { url: s, id: m[1], rk };
  if ((m = s.match(/\/d\/([\w-]{10,})/))) return { url: s, id: m[1], rk };
  if ((m = s.match(/[?&]id=([\w-]{10,})/))) return { url: s, id: m[1], rk };
  if (/^[\w-]{15,}$/.test(s)) return { url: 'https://drive.google.com/open?id=' + s, id: s, rk };
  return null;
}
/** Separa vários links colados juntos (um por linha, com espaço, vírgula ou grudados). */
function splitLinks(text) {
  return text.replace(/(https?:\/\/)/g, '\n$1').split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
}

function showEmpty(title, text, spin) {
  $('treeHead').classList.add('hide');
  $('tree').classList.add('hide');
  $('empty').classList.remove('hide');
  $('emptyT').textContent = title;
  $('emptyP').textContent = text || '';
  const sv = $('empty').querySelector('svg');
  let sp = $('empty').querySelector('.big-spin');
  if (spin && !sp) { sp = document.createElement('div'); sp.className = 'big-spin'; $('empty').prepend(sp); }
  if (!spin && sp) sp.remove();
  sv.classList.toggle('hide', !!spin);
}
const EMPTY_T = 'Cole um ou vários links do Google Drive';
const EMPTY_P = 'A árvore de pastas aparece aqui com os tamanhos, para você escolher o que baixar. Os nomes e as subpastas ficam exatamente como estão no Drive.';

async function readOne(p) {
  const meta = await driveGet(`files/${p.id}?fields=id,name,mimeType,size&supportsAllDrives=true`, p.rk ? `${p.id}/${p.rk}` : '');
  const link = { url: p.url, id: p.id, rk: p.rk, name: meta.name, kind: meta.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file' };
  let files, dirs = [];
  if (link.kind === 'folder') {
    const r = await rc('operations/list', { fs: srcFs(link), remote: '', opt: { recurse: true, noModTime: true } });
    dirs = r.list.filter((i) => i.IsDir).map((i) => i.Path);
    files = r.list.filter((i) => !i.IsDir).map((i) => ({ src: i.Path, size: i.Size }));
  } else {
    files = [{ src: link.name, size: meta.size != null ? Number(meta.size) : -1 }];
  }
  files.sort((a, b) => natCmp(a.src, b.src));
  return { link, files, dirs };
}

/** Lê um ou vários links e soma à lista (não substitui os que já estão lá). */
async function addLinks(text) {
  if (isBusy() || S.phase === 'reading') return;
  const parts = splitLinks(text || '');
  if (!parts.length) return;
  const parsed = parts.map(parseLink).filter(Boolean);
  if (!parsed.length) return toast('Não reconheci nenhum link do Drive');
  if (!S.info.hasToken) return toast('Entre no Google primeiro');
  if (S.phase === 'done' || S.phase === 'error') { S.job = null; $('prog').classList.remove('show'); }
  const fresh = parsed.filter((p, i) => !S.links.some((l) => l.id === p.id) && parsed.findIndex((q) => q.id === p.id) === i);
  if (!fresh.length) return toast('Esse link já está na lista');
  setPhase('reading');
  if (!S.links.length) showEmpty('Lendo o link…', 'Buscando nomes, subpastas e tamanhos no Drive.', true);
  const errors = [];
  for (let n = 0; n < fresh.length; n++) {
    setStatus('wait', fresh.length > 1 ? `Lendo link ${n + 1} de ${fresh.length}…` : 'Lendo o link…');
    try {
      const r = await readOne(fresh[n]);
      const l = S.links.push(r.link) - 1;
      r.dirs.forEach((d) => S.dirs.push({ l, path: d }));
      r.files.forEach((f) => S.files.push({ l, ...f }));
      renderTree();
    } catch (e) {
      const msg = String(e);
      errors.push(/HTTP 404|notFound|not found/i.test(msg)
        ? 'O Drive não encontrou esse item para a conta conectada. Confira se o link é público ou se foi compartilhado com você.'
        : /[rR]ateLimit|HTTP 403/.test(msg) ? 'O Google recusou por limite de chamadas. Espere um minuto e tente de novo. (' + msg + ')' : msg);
    }
  }
  $('iLink').value = '';
  setPhase('idle');
  if (S.links.length) renderTree();
  else showEmpty('Não consegui ler o link', errors[0] || '');
  if (errors.length && S.links.length) ask('Um link não pôde ser lido', errors[0], [{ label: 'OK', value: true, bold: true }]);
  refreshPreview();
  refreshFree();
}

/** Tira itens da lista do app (nunca do disco) e reorganiza os índices. */
function keepOnly(keepFile, keepLink = () => true) {
  const offKeys = new Set([...S.off].map((i) => S.files[i]));
  const map = new Map();
  const links = [];
  S.links.forEach((l, i) => {
    if (keepLink(i) && S.files.some((f, k) => f.l === i && keepFile(f, k))) { map.set(i, links.length); links.push(l); }
  });
  const files = S.files.filter((f, k) => map.has(f.l) && keepFile(f, k));
  S.dirs = S.dirs.filter((d) => map.has(d.l) && files.some((f) => f.l === d.l && f.src.startsWith(d.path + '/'))).map((d) => ({ ...d, l: map.get(d.l) }));
  files.forEach((f) => { f.l = map.get(f.l); });
  S.links = links;
  S.files = files;
  S.off = new Set(files.map((f, i) => (offKeys.has(f) ? i : -1)).filter((i) => i >= 0));
  S.closed = new Set();
  if (S.links.length) renderTree();
  else showEmpty(EMPTY_T, EMPTY_P);
  refreshPreview();
  refreshFree();
  refreshGo();
}
const isDone = (f) => f.st === 'done' || f.st === 'exists';
function clearDownloaded() {
  if (isBusy()) return;
  const n = S.files.filter(isDone).length;
  if (!n) return;
  S.job = null;
  $('prog').classList.remove('show');
  keepOnly((f) => !isDone(f));
  if (S.phase !== 'idle') setPhase('idle');
  toast(`${plural(n, 'item saiu', 'itens saíram')} da lista. Os arquivos continuam no disco.`, 3600);
}
function refreshClear() {
  $('bClear').classList.toggle('hide', isBusy() || !S.files.some(isDone));
}

const treePath = (f) => `${f.l}/${f.src}`;
function buildTree() {
  const mk = (name, path, extra) => ({ name, path, dir: true, kids: new Map(), size: 0, files: [], ...extra });
  const root = mk('', '');
  const linkNodes = S.links.map((l, i) => {
    if (l.kind !== 'folder') return null;
    const n = mk(l.name, String(i), { link: i });
    root.kids.set('L' + i, n);
    return n;
  });
  const dirNode = (l, path) => {
    let n = linkNodes[l];
    if (!path) return n;
    let acc = String(l);
    for (const part of path.split('/')) {
      acc += '/' + part;
      if (!n.kids.has(part)) n.kids.set(part, mk(part, acc));
      n = n.kids.get(part);
    }
    return n;
  };
  S.dirs.forEach((d) => dirNode(d.l, d.path));
  S.files.forEach((f, i) => {
    const cut = f.src.lastIndexOf('/');
    const node = { name: f.src.slice(cut + 1), dir: false, idx: i, size: f.size };
    if (S.links[f.l].kind !== 'folder') root.kids.set('F' + i, { ...node, link: f.l });
    else dirNode(f.l, cut < 0 ? '' : f.src.slice(0, cut)).kids.set('\u0000' + f.src, node);
  });
  const fill = (n) => {
    n.size = 0; n.files = [];
    for (const k of n.kids.values()) {
      if (k.dir) { fill(k); n.size += k.size; n.files.push(...k.files); }
      else { n.size += Math.max(0, k.size); n.files.push(k.idx); }
    }
  };
  fill(root);
  return root;
}

const ICO_DIR = '<svg class="fic dir" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6c.6 0 1.1.2 1.5.7l1.2 1.5h7.3A2.2 2.2 0 0 1 21 9.4v7.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 16.8z"/></svg>';
const ICO_LINK = '<svg class="fic lnk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>';
const ICO_FILE = '<svg class="fic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="12.5" height="12" rx="2.5"/><path d="M16 10.5l4.5-2.5v8L16 13.5"/></svg>';
const ICO_DOC = '<svg class="fic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5v4h4"/></svg>';
const CB = '<svg class="ck" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.4 2.4 4.6-5"/></svg><svg class="ds" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h6"/></svg>';
const CHEV = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 1.5L7 5 3.5 8.5"/></svg>';
const ICO_X = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l6 6M8 2L2 8"/></svg>';
const ICO_OPEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h2.3l1.4 1.7h5.3A1.5 1.5 0 0 1 14 6.700v4.800a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>';
const isVideo = (n) => /\.(mov|mp4|mxf|avi|mkv|m4v|braw|r3d|mts|webm)$/i.test(n);
const fileIco = (n) => (isVideo(n) ? ICO_FILE : ICO_DOC);

let rowEls = new Map(); // idx -> elemento de status
function checkState(idxs) {
  let on = 0;
  for (const i of idxs) if (!S.off.has(i)) on++;
  return on === 0 ? '' : on === idxs.length ? 'on' : 'mix';
}
function renderTree() {
  if (!S.links.length) return;
  const root = buildTree();
  const el = $('tree');
  const scroll = el.scrollTop;
  const html = [];
  const view = S.cfg.view || 'details';
  const rmBtn = (l) => (l != null ? `<button class="lx" data-rm="${l}" title="Tirar este link da lista">${ICO_X}</button>` : '');
  const fileRow = (k, pad, sub) => `<div class="trow ${S.off.has(k.idx) ? 'off' : ''}" ${pad} data-file="${k.idx}">
      <span class="chev none"></span>
      <button class="cb ${S.off.has(k.idx) ? '' : 'on'}" data-chk>${CB}</button>${fileIco(k.name)}
      <span class="nm" title="${esc(k.name)}">${esc(k.name)}${sub ? `<span class="pth">${esc(sub)}</span>` : ''}</span>
      <span class="stt" data-stt></span>
      <span class="sz">${fmtSize(k.size)}</span>${rmBtn(k.link)}</div>`;
  const dirRow = (k, pad, label, only) => {
    const open = !S.closed.has(k.path);
    const st = checkState(k.files);
    return `<div class="trow dir ${k.link != null ? 'link' : ''} ${st ? '' : 'off'}" ${pad} data-dir="${esc(k.path)}" ${only ? 'data-only="1"' : ''}>
      <button class="chev ${open ? 'open' : ''} ${k.kids.size || only ? '' : 'none'}" data-tog>${CHEV}</button>
      <button class="cb ${st}" data-chk>${CB}</button>${k.link != null ? ICO_LINK : ICO_DIR}
      <span class="nm" title="${esc(label)}">${esc(label)}</span>
      ${k.files.some((i) => isDone(S.files[i]) && S.files[i].path) ? `<span class="stt"><button class="rv" data-revealdir title="Abrir esta pasta">${ICO_OPEN}</button></span>` : ''}
      <span class="sz">${k.files.length ? fmtSize(only ? only.size : k.size) : 'vazia'}</span>${rmBtn(k.link)}</div>`;
  };
  const sorted = (n) => [...n.kids.values()].sort((a, b) => (a.link != null || b.link != null ? 0 : a.dir === b.dir ? natCmp(a.name, b.name) : a.dir ? -1 : 1));
  if (view === 'details') {
    const walk = (n, depth) => {
      for (const k of sorted(n)) {
        const pad = `style="padding-left:${6 + depth * 20}px"`;
        if (k.dir) { html.push(dirRow(k, pad, k.name)); if (!S.closed.has(k.path)) walk(k, depth + 1); }
        else html.push(fileRow(k, pad));
      }
    };
    walk(root, 0);
  } else {
    // lista e grade: por link, as pastas viram cabeçalhos com o caminho completo
    for (const top of sorted(root)) {
      if (!top.dir) {
        html.push(view === 'list' ? fileRow(top, '') : `<div class="tiles flat">${tile(top.idx)}</div>`);
        continue;
      }
      html.push(dirRow(top, '', top.name));
      if (S.closed.has(top.path)) continue;
      const groups = [];
      const collect = (n, label) => {
        const own = [...n.kids.values()].filter((k) => !k.dir).sort((a, b) => natCmp(a.name, b.name));
        if (own.length) groups.push({ node: n, label, own });
        [...n.kids.values()].filter((k) => k.dir).sort((a, b) => natCmp(a.name, b.name)).forEach((k) => collect(k, label ? label + ' › ' + k.name : k.name));
      };
      collect(top, '');
      for (const g of groups) {
        if (view === 'list') {
          g.own.forEach((k) => html.push(fileRow(k, 'style="padding-left:26px"', g.label)));
        } else {
          const open = !S.closed.has(g.node.path) || g.node === top;
          if (g.node !== top) {
            const idxs = g.own.map((k) => k.idx);
            html.push(dirRow({ ...g.node, files: idxs }, 'style="padding-left:26px"', g.label, { size: g.own.reduce((a, k) => a + Math.max(0, k.size), 0) }));
          }
          if (open) html.push(`<div class="tiles">${g.own.map((k) => tile(k.idx)).join('')}</div>`);
        }
      }
    }
  }
  el.innerHTML = html.join('');
  document.querySelectorAll('#vSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === view));
  rowEls = new Map();
  el.querySelectorAll('[data-file]').forEach((r) => rowEls.set(Number(r.dataset.file), r.querySelector('[data-stt]')));
  S.files.forEach((f, i) => paintRow(i));
  $('empty').classList.add('hide');
  $('treeHead').classList.remove('hide');
  el.classList.remove('hide');
  el.scrollTop = scroll;
  $('treeName').textContent = S.links.length === 1 ? S.links[0].name : `${S.links.length} links`;
  refreshSummary();
}
function tile(i) {
  const f = S.files[i];
  const name = f.src.slice(f.src.lastIndexOf('/') + 1);
  return `<div class="tile ${S.off.has(i) ? 'off' : ''}" data-file="${i}" title="${esc(name)}">
    <div class="th">${fileIco(name)}<button class="cb ${S.off.has(i) ? '' : 'on'}" data-chk>${CB}</button></div>
    <div class="tn">${esc(name)}</div><div class="ts">${fmtSize(f.size)}</div><span class="stt" data-stt></span></div>`;
}
function refreshSummary() {
  const sel = S.files.filter((_, i) => !S.off.has(i));
  const bytes = sel.reduce((a, f) => a + Math.max(0, f.size), 0);
  const total = S.files.reduce((a, f) => a + Math.max(0, f.size), 0);
  const nd = S.dirs.length;
  $('treeSum').textContent = sel.length === S.files.length
    ? `${plural(S.files.length, 'arquivo', 'arquivos')}${nd ? ` em ${plural(nd, 'pasta', 'pastas')}` : ''} · ${fmtSize(total)}`
    : `${sel.length} de ${S.files.length} arquivos marcados · ${fmtSize(bytes)} de ${fmtSize(total)}`;
  $('cbAll').className = 'cb ' + checkState(S.files.map((_, i) => i));
  refreshGo();
  refreshClear();
  paintFree();
}
function refreshGo() {
  const ok = S.links.length && S.files.some((f, i) => !S.off.has(i) && !isDone(f)) && (S.phase === 'idle' || S.phase === 'error') && finalBase();
  $('bGo').disabled = !ok;
}

const ST_TXT = { queued: 'na fila', conflict: 'tamanho diferente, não tocado', retry: 'tentando de novo…' };
const CHECK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.4 2.4 4.6-5"/></svg>';
function paintRow(i) {
  const el = rowEls.get(i);
  if (!el) return;
  const f = S.files[i];
  const st = f.st || '';
  if (el.dataset.st === st && st !== 'active') return;
  el.dataset.st = st;
  el.className = 'stt ' + st;
  el.title = '';
  if (st === 'active') {
    const p = f.size > 0 ? Math.min(1, (f.bytes || 0) / f.size) : 0;
    let bar = el.querySelector('.mb');
    if (!bar) { el.innerHTML = '<span data-t></span><span class="mb"><i></i></span>'; bar = el.querySelector('.mb'); }
    bar.firstChild.style.setProperty('--p', p.toFixed(4));
    el.querySelector('[data-t]').textContent = `${Math.floor(p * 100)}%${f.speed ? ' · ' + fmtSize(f.speed) + '/s' : ''}`;
  } else if (isDone(f)) {
    el.innerHTML = `${CHECK}<span>${st === 'done' ? 'baixado' : 'já estava na pasta'}</span><button class="rv" data-reveal title="Mostrar o arquivo na pasta">${ICO_OPEN}</button>`;
  } else if (st === 'error') {
    el.textContent = 'erro';
    el.title = f.err || '';
  } else {
    el.textContent = ST_TXT[st] || '';
  }
}

$('tree').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    if (!canEdit()) return;
    const l = Number(rm.dataset.rm);
    if (S.phase !== 'idle') { S.job = null; $('prog').classList.remove('show'); setPhase('idle'); }
    return keepOnly(() => true, (i) => i !== l);
  }
  const row = e.target.closest('[data-file],[data-dir]');
  if (!row) return;
  if (e.target.closest('[data-reveal]')) {
    const f = S.files[Number(row.dataset.file)];
    if (f && f.path) invoke('reveal', { path: f.path }).catch((err) => toast(String(err)));
    return;
  }
  const editable = S.phase === 'idle' || S.phase === 'error';
  if (row.dataset.dir != null) {
    const path = row.dataset.dir;
    if (e.target.closest('[data-revealdir]')) {
      // a pasta no disco sai do caminho de um arquivo já baixado, tirando os níveis que ficam abaixo desta linha
      const f = S.files.find((x) => isDone(x) && x.path && treePath(x).startsWith(path + '/'));
      if (!f) return;
      const up = treePath(f).split('/').length - path.split('/').length;
      invoke('open_folder', { path: f.path.split('\\').slice(0, -up).join('\\') }).catch((err) => toast(String(err)));
      return;
    }
    if (e.target.closest('[data-chk]')) {
      if (!editable) return;
      // na grade cada cabeçalho representa só os arquivos daquela pasta; na árvore, a pasta inteira
      const inDir = (f) => { const tp = treePath(f); return row.dataset.only ? tp.slice(0, tp.lastIndexOf('/')) === path : tp.startsWith(path + '/'); };
      const idxs = S.files.map((f, i) => (inDir(f) ? i : -1)).filter((i) => i >= 0);
      const turnOff = checkState(idxs) === 'on';
      idxs.forEach((i) => (turnOff ? S.off.add(i) : S.off.delete(i)));
    } else {
      S.closed.has(path) ? S.closed.delete(path) : S.closed.add(path);
    }
    renderTree();
  } else if (editable) {
    const i = Number(row.dataset.file);
    if (isDone(S.files[i])) return;
    S.off.has(i) ? S.off.delete(i) : S.off.add(i);
    renderTree();
  }
  refreshPreview();
});
$('cbAll').onclick = () => {
  if (S.phase !== 'idle' && S.phase !== 'error') return;
  if (S.off.size) S.off.clear();
  else S.files.forEach((_, i) => S.off.add(i));
  renderTree();
};

/* ---------------- visualização: modos e zoom suave ---------------- */
const ZMIN = 0.7, ZMAX = 2.2;
let zCur = 1, zRaf = 0, zSave;
function setZoom(target) {
  S.cfg.zoom = Math.max(ZMIN, Math.min(ZMAX, target));
  clearTimeout(zSave);
  zSave = setTimeout(saveCfg, 600);
  if (!zRaf) zRaf = requestAnimationFrame(zoomStep);
}
function zoomStep() {
  const el = $('tree');
  const d = S.cfg.zoom - zCur;
  // aproxima do alvo a cada quadro: o movimento desacelera no fim, sem salto
  zCur = Math.abs(d) < 0.002 ? S.cfg.zoom : zCur + d * 0.22;
  el.style.zoom = zCur.toFixed(4);
  $('zLbl').textContent = Math.round(S.cfg.zoom * 100) + '%';
  zRaf = zCur === S.cfg.zoom ? 0 : requestAnimationFrame(zoomStep);
}
function setView(v) {
  if (S.cfg.view === v) return;
  S.cfg.view = v;
  saveCfg();
  if (document.startViewTransition) document.startViewTransition(() => renderTree());
  else renderTree();
}

/* ---------------- destino ---------------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function computeAuto() {
  if (!S.cfg.base) {
    // sem pasta base configurada não há padrão por data: o destino é a pasta de downloads
    S.dest.auto = null;
    if (S.dest.mode !== 'custom' || !S.dest.custom) { S.dest.mode = 'custom'; S.dest.custom = (S.info && S.info.downloads) || ''; }
    return renderDest();
  }
  const [y, m, d] = (S.dest.date || todayStr()).split('-');
  const base = S.cfg.base.replace(/[\\/]+$/, '');
  const mon = MESES[Number(m) - 1];
  const numbered = (names) => names.map((n) => n.match(/^(\d+)\.\s*(.+?)\s*$/)).filter(Boolean);
  const next = (list) => list.reduce((a, x) => Math.max(a, Number(x[1])), 0) + 1;
  const months = numbered(await invoke('list_dirs', { path: `${base}\\${y}` }));
  const mHit = months.find((x) => x[2].toUpperCase() === mon);
  const monthName = mHit ? mHit[0].trim() : `${next(months)}. ${mon}`;
  const tag = `${m}-${d}-${y.slice(2)}`;
  const days = mHit ? numbered(await invoke('list_dirs', { path: `${base}\\${y}\\${monthName}` })) : [];
  const dHit = days.find((x) => x[2] === tag);
  const dayName = dHit ? dHit[0].trim() : `${next(days)}. ${tag}`;
  S.dest.auto = { base, year: y, monthName, monthNew: !mHit, dayName, dayNew: !dHit, path: [base, y, monthName, dayName, 'RAW'].join('\\') };
  renderDest();
}
function finalBase() {
  const root = S.dest.mode === 'custom' ? S.dest.custom : S.dest.auto && S.dest.auto.path;
  if (!root) return '';
  return S.opts.sub ? root + '\\' + S.opts.sub : root;
}
const wb = (p) => esc(p).replace(/\\/g, '\\<wbr>');
function renderDest() {
  const el = $('destPath');
  const sub = S.opts.sub ? `\\<wbr><b>${esc(S.opts.sub)}</b>` : '';
  $('rowDate').classList.toggle('hide', S.dest.mode === 'custom');
  $('bAuto').disabled = S.dest.mode !== 'custom' || !S.cfg.base;
  if (S.dest.mode === 'custom') {
    el.innerHTML = `${wb(S.dest.custom)}${sub}<span class="tag custom">${!S.cfg.base && S.info && S.dest.custom === S.info.downloads ? 'pasta de downloads' : 'pasta escolhida'}</span>`;
  } else if (S.dest.auto) {
    const a = S.dest.auto;
    el.innerHTML = `${wb(a.base)}\\<wbr>${a.year}\\<wbr><span class="${a.monthNew ? 'new' : ''}" style="white-space:nowrap">${esc(a.monthName)}</span>\\<wbr><b class="${a.dayNew ? 'new' : ''}" style="white-space:nowrap">${esc(a.dayName)}</b>\\<wbr>RAW${sub}` +
      (a.dayNew ? '<span class="tag">pasta nova</span>' : '<span class="tag old">já existe, usa a mesma</span>');
  }
  refreshGo();
  refreshFree();
}
/** Espaço livre no disco do destino, comparado com o que está marcado para baixar. */
async function refreshFree() {
  const base = finalBase();
  S.free = base ? await invoke('disk_free', { path: base }).catch(() => null) : null;
  paintFree();
}
function paintFree() {
  const el = $('freeTxt');
  const base = finalBase();
  if (S.free == null || !base) { el.textContent = base ? 'Não consegui medir o espaço desse disco' : ''; return; }
  const disk = /^[A-Za-z]:/.test(base) ? base.slice(0, 2).toUpperCase() : 'no destino';
  const need = S.files.reduce((a, f, i) => a + (S.off.has(i) || isDone(f) ? 0 : Math.max(0, f.size)), 0);
  if (!need) el.innerHTML = `<b class="ok">${fmtSize(S.free)}</b> livres em ${disk}`;
  else if (need > S.free) el.innerHTML = `<span class="bad">Não cabe em ${disk}: faltam ${fmtSize(need - S.free)}</span><br>livre ${fmtSize(S.free)} · precisa ${fmtSize(need)}`;
  else el.innerHTML = `<b class="ok">${fmtSize(S.free)}</b> livres em ${disk}<br>precisa ${fmtSize(need)} · sobram ${fmtSize(S.free - need)}`;
}

/* ---------------- opções ---------------- */
function rename(name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return S.opts.prefix + stem + S.opts.suffix + ext;
}
function dstRel(f) {
  const link = S.links[f.l];
  const cut = f.src.lastIndexOf('/');
  const dir = cut < 0 ? '' : f.src.slice(0, cut + 1);
  const root = link.kind === 'folder' && S.opts.keepRoot ? cleanSeg(link.name) + '/' : '';
  return root + winTrim(dir + rename(f.src.slice(cut + 1)));
}
function refreshPreview() {
  const f = S.files.find((_, k) => !S.off.has(k));
  const leaf = f ? f.src.slice(f.src.lastIndexOf('/') + 1) : 'IMG_3558.MOV';
  const el = $('preview');
  if (S.opts.prefix || S.opts.suffix) el.innerHTML = `Prévia: ${esc(leaf)} → <b>${esc(rename(leaf))}</b>`;
  else el.textContent = 'Os nomes ficam como estão no Drive. O sufixo entra antes da extensão.';
  if (f) el.innerHTML += `<br>Vai ficar em: <b>…\\${esc(dstRel(f).replace(/\//g, '\\'))}</b>`;
}
function bindOpts() {
  const upd = () => {
    S.opts.sub = cleanSub($('iSub').value);
    S.opts.prefix = cleanName($('iPre').value);
    S.opts.suffix = cleanName($('iSuf').value);
    renderDest();
    refreshPreview();
  };
  ['iSub', 'iPre', 'iSuf'].forEach((id) => ($(id).oninput = upd));
  $('swRoot').onclick = () => { S.opts.keepRoot = !S.opts.keepRoot; $('swRoot').classList.toggle('on', S.opts.keepRoot); refreshPreview(); };
  $('swOpen').onclick = () => { S.cfg.openAfter = !S.cfg.openAfter; $('swOpen').classList.toggle('on', S.cfg.openAfter); saveCfg(); };
  const setN = (n) => { S.opts.transfers = Math.max(1, Math.min(8, n)); $('nTransfers').textContent = S.opts.transfers; S.cfg.transfers = S.opts.transfers; saveCfg(); };
  $('bLess').onclick = () => setN(S.opts.transfers - 1);
  $('bMore').onclick = () => setN(S.opts.transfers + 1);
  $('bAdv').onclick = () => { $('bAdv').classList.toggle('open'); $('adv').classList.toggle('open'); };
}
const saveCfg = () => invoke('write_json', { name: 'config', value: S.cfg }).catch(() => {});

/* ---------------- histórico ---------------- */
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
async function pushHistory(entry) {
  S.history = [entry, ...S.history.filter((h) => !(sameSet(h.links || [], entry.links) && h.dest === entry.dest))].slice(0, 20);
  await invoke('write_json', { name: 'history', value: S.history }).catch(() => {});
}
const H_ST = { running: 'em andamento', done: 'concluído', canceled: 'cancelado', error: 'com erros' };
function renderHistory() {
  const el = $('hList');
  if (!S.history.length) { el.innerHTML = '<div class="row"><span class="caption" style="margin:0">Nenhum download ainda.</span></div>'; return; }
  el.innerHTML = S.history.map((h, i) => `<div class="row h-row" data-h="${i}">
    <div class="n"><span>${esc(h.name)}</span><em>${esc(new Date(h.when).toLocaleDateString('pt-BR'))} · ${fmtSize(h.bytes)} · ${H_ST[h.status] || ''}</em></div>
    <div class="d">${esc(h.dest)}</div>${(h.links || []).map((u) => `<div class="l">${esc(u)}</div>`).join('')}</div>`).join('');
}
$('hList').addEventListener('click', (e) => {
  const r = e.target.closest('[data-h]');
  if (!r || isBusy()) return;
  const h = S.history[Number(r.dataset.h)];
  closeSheets();
  resetAll();
  S.dest.mode = 'custom';
  S.dest.custom = h.root || h.dest;
  if (h.opts) applyOpts(h.opts);
  renderDest();
  addLinks((h.links || []).join('\n'));
});
function applyOpts(o) {
  Object.assign(S.opts, o);
  $('iSub').value = S.opts.sub; $('iPre').value = S.opts.prefix; $('iSuf').value = S.opts.suffix;
  $('swRoot').classList.toggle('on', S.opts.keepRoot);
  $('nTransfers').textContent = S.opts.transfers;
}

/* ---------------- download ---------------- */
async function startDownload(resume) {
  if (isBusy()) return;
  let job;
  if (resume) {
    job = S.job;
  } else {
    const base = finalBase();
    if (!/^([A-Za-z]:\\|\\\\)/.test(base)) return toast('O destino precisa ser um caminho completo');
    const picked = S.files.map((f, i) => ({ f, i })).filter((x) => !S.off.has(x.i) && !isDone(x.f));
    if (!picked.length) return;
    job = {
      v: 2, id: Date.now(), links: S.links, base, root: S.dest.mode === 'custom' ? S.dest.custom : S.dest.auto.path,
      opts: { ...S.opts }, state: 'running', when: new Date().toISOString(),
      dirs: S.dirs, all: S.files.map((f) => ({ l: f.l, src: f.src, size: f.size })), off: [...S.off],
      items: picked.map((x) => ({ i: x.i, dst: dstRel(x.f) })),
    };
    // dois itens do Drive nunca podem cair no mesmo arquivo do disco
    const seen = new Set();
    for (const it of job.items) {
      let n = 1, d = it.dst;
      while (seen.has(d.toLowerCase())) { const dot = it.dst.lastIndexOf('.'), sl = it.dst.lastIndexOf('/'); d = dot > sl + 1 ? `${it.dst.slice(0, dot)} (${++n})${it.dst.slice(dot)}` : `${it.dst} (${++n})`; }
      seen.add(d.toLowerCase()); it.dst = d;
    }
  }
  const inJob = new Set(job.items.map((it) => it.i));
  S.files.forEach((f, i) => { if (inJob.has(i) || !isDone(f)) { f.st = ''; f.bytes = 0; f.speed = 0; f.err = ''; } });

  // 1) o que já existe no destino: mesmo tamanho é pulado, tamanho diferente nunca é tocado
  const paths = job.items.map((it) => localPath(job.base, it.dst));
  const sizes = await invoke('stat_files', { paths });
  const queue = [], conflicts = [];
  job.items.forEach((it, k) => {
    const f = S.files[it.i];
    f.path = paths[k];
    if (sizes[k] === -1) { f.st = 'queued'; queue.push(k); }
    else if (sizes[k] === f.size || f.size < 0) f.st = 'exists';
    else { f.st = 'conflict'; conflicts.push(paths[k] + `  (no disco ${fmtSize(sizes[k])}, no Drive ${fmtSize(f.size)})`); }
  });
  S.files.forEach((_, i) => paintRow(i));
  const abort = () => { S.files.forEach((f, i) => { if (f.st === 'queued') f.st = ''; paintRow(i); }); refreshGo(); refreshClear(); };
  if (conflicts.length && !resume) {
    invoke('alerta', { color: 'red' });
    const one = conflicts.length === 1;
    const go = await ask('Arquivos com tamanho diferente',
      `${one ? '1 arquivo já existe' : conflicts.length + ' arquivos já existem'} no destino com outro tamanho. O MecDrive não sobrescreve nem apaga nada: ${one ? 'ele fica como está' : 'eles ficam como estão'}.`,
      [{ label: 'Cancelar', value: false }, { label: queue.length ? 'Baixar o resto' : 'OK', value: queue.length > 0, bold: true }], conflicts);
    if (!go) return abort();
  }
  if (!queue.length && !conflicts.length) toast('Tudo isso já está na pasta de destino');

  // 2) espaço em disco
  const need = queue.reduce((a, k) => a + Math.max(0, S.files[job.items[k].i].size), 0);
  if (!resume && need > 0) {
    const free = await invoke('disk_free', { path: job.base }).catch(() => null);
    if (free != null && free < need + 512 * 1024 * 1024) {
      invoke('alerta', { color: 'red' });
      const go = await ask('Pouco espaço em disco', `O download precisa de ${fmtSize(need)} e o disco ${job.base.slice(0, 2)} tem ${fmtSize(free)} livres.`,
        [{ label: 'Cancelar', value: false, bold: true }, { label: 'Baixar assim mesmo', value: true, red: true }]);
      if (!go) return abort();
    }
  }

  // 3) temporários de um download interrompido à força (só os .partial do próprio rclone)
  await invoke('clean_partials', { files: queue.map((k) => paths[k]) }).catch(() => 0);

  S.job = job;
  job.state = 'running';
  await invoke('write_json', { name: 'job', value: job });
  const names = job.links.map((l) => l.name);
  await pushHistory({ id: job.id, links: job.links.map((l) => l.url), name: names.length > 2 ? `${names[0]} + ${names.length - 1} links` : names.join(' + '), dest: job.base, root: job.root, opts: job.opts, when: job.when, bytes: job.items.reduce((a, it) => a + Math.max(0, S.files[it.i].size), 0), files: job.items.length, status: 'running' });

  S.run = {
    group: 'dd' + Date.now(), queue, paths, active: new Map(), retry: [], attempts: {}, busy: false, stop: false, started: Date.now(),
    total: job.items.reduce((a, it) => a + (S.files[it.i].st === 'conflict' ? 0 : Math.max(0, S.files[it.i].size)), 0), speed: 0,
  };
  $('prog').classList.add('show');
  $('pNote').classList.add('hide');
  $('pTitle').textContent = job.base;
  setPhase('running');
  paintProgress();
  loop();
}

async function launch(k) {
  const R = S.run, job = S.job, it = job.items[k], f = S.files[it.i], link = job.links[f.l];
  // cada tentativa de cada arquivo tem o seu grupo de estatísticas: progresso e velocidade exatos por arquivo
  const group = `${R.group}_${k}_${R.attempts[k] || 0}`;
  const common = { _async: true, _group: group, _config: { IgnoreExisting: true } };
  const baseFwd = job.base.replace(/\\/g, '/');
  // garantia extra contra sobrescrita: confere de novo no momento de começar
  const [now] = await invoke('stat_files', { paths: [R.paths[k]] });
  if (now !== -1) { f.st = now === f.size ? 'exists' : 'conflict'; paintRow(it.i); return; }
  try {
    const r = link.kind === 'file'
      ? await rc('backend/command', { command: 'copyid', fs: `gdrive${link.rk ? ',resource_key=' + link.rk : ''}:`, arg: [link.id, baseFwd + '/' + it.dst], ...common })
      : await rc('operations/copyfile', { srcFs: srcFs(link), srcRemote: f.src, dstFs: baseFwd, dstRemote: it.dst, ...common });
    R.active.set(k, { jobid: r.jobid, group });
    f.st = 'active'; f.bytes = 0; f.speed = 0;
  } catch (e) {
    failed(k, String(e));
  }
  paintRow(it.i);
}
function failed(k, err) {
  const R = S.run, f = S.files[S.job.items[k].i];
  R.attempts[k] = (R.attempts[k] || 0) + 1;
  f.err = err; f.bytes = 0; f.speed = 0;
  if (R.attempts[k] < MAX_TENTATIVAS && !/cannotDownloadAbusiveFile|notFound/i.test(err)) {
    f.st = 'retry';
    R.retry.push({ k, at: Date.now() + Math.min(60, 5 * 2 ** (R.attempts[k] - 1)) * 1000 });
  } else {
    f.st = 'error';
  }
}

async function tick() {
  const R = S.run, job = S.job;
  let speed = 0;
  for (const [k, a] of [...R.active]) {
    const f = S.files[job.items[k].i];
    const stats = await rc('core/stats', { group: a.group }, 20).catch(() => null);
    if (stats) { f.bytes = stats.bytes || 0; f.speed = stats.speed || 0; speed += f.speed; }
    const st = await rc('job/status', { jobid: a.jobid }, 20).catch((e) => ({ finished: true, success: false, error: String(e) }));
    if (!st.finished) continue;
    R.active.delete(k);
    if (R.stop) { f.st = 'queued'; f.bytes = 0; continue; }
    if (st.success) {
      const [sz] = await invoke('stat_files', { paths: [R.paths[k]] });
      if (sz >= 0 && (sz === f.size || f.size < 0)) { f.st = 'done'; f.bytes = Math.max(0, f.size); f.speed = 0; R.dirty = true; }
      else failed(k, sz === -1 ? 'o arquivo não apareceu no destino' : 'tamanho final diferente do Drive');
    } else {
      failed(k, st.error || 'falhou');
    }
  }
  R.speed = speed;
  if (R.stop) return;
  // novas tentativas e próximos da fila
  const nowT = Date.now();
  R.retry = R.retry.filter((r) => { if (r.at <= nowT) { R.queue.unshift(r.k); return false; } return true; });
  while (R.active.size < job.opts.transfers && R.queue.length) await launch(R.queue.shift());
}

async function loop() {
  const R = S.run;
  while (S.run === R && !R.stop) {
    if (S.phase === 'running') {
      R.busy = true;
      try { await tick(); } catch (e) { console.error(e); }
      R.busy = false;
      if (R.stop) return;
      if (R.dirty) { R.dirty = false; renderTree(); }
      paintProgress();
      if (!R.active.size && !R.queue.length && !R.retry.length) return finish();
    }
    await sleep(1000);
  }
}

function paintProgress() {
  const R = S.run, job = S.job;
  let got = 0, okN = 0, n = 0;
  job.items.forEach((it) => {
    const f = S.files[it.i];
    if (f.st !== 'conflict') n++;
    if (isDone(f)) { got += Math.max(0, f.size); okN++; }
    else if (f.st === 'active') got += Math.min(f.bytes || 0, Math.max(0, f.size));
    paintRow(it.i);
  });
  const p = R.total > 0 ? Math.min(1, got / R.total) : okN / Math.max(1, n);
  $('pPct').textContent = Math.floor(p * 100);
  $('pBar').style.setProperty('--p', p.toFixed(4));
  const live = S.phase === 'running' && R.active.size;
  $('pSpeed').textContent = live ? fmtSize(R.speed) + '/s' : '—';
  $('pEta').textContent = live && R.speed > 0 ? fmtTime((R.total - got) / R.speed) : '—';
  $('pBytes').textContent = `${fmtSize(got)} / ${fmtSize(R.total)}`;
  $('pFiles').textContent = `${okN} de ${n}`;
  $('pEtaK').textContent = 'Tempo restante';
  const waiting = R.retry.length;
  if (waiting && S.phase === 'running') {
    $('pNote').className = 'note';
    $('pNote').textContent = `${plural(waiting, 'arquivo', 'arquivos')} com falha de conexão, tentando de novo sozinho…`;
  } else if (S.phase === 'running') $('pNote').classList.add('hide');
}

async function finish() {
  const job = S.job, R = S.run;
  const count = (st) => job.items.filter((it) => S.files[it.i].st === st).length;
  const done = count('done'), exists = count('exists'), conflict = count('conflict'), errors = count('error');
  job.state = errors ? 'error' : 'done';
  await invoke('write_json', { name: 'job', value: job });
  const h = S.history.find((x) => x.id === job.id);
  if (h) { h.status = job.state; await invoke('write_json', { name: 'history', value: S.history }); }
  S.run = null;
  const parts = [plural(done, 'baixado', 'baixados')];
  if (exists) parts.push(`${exists} já ${exists === 1 ? 'estava' : 'estavam'} na pasta`);
  if (conflict) parts.push(`${conflict} com tamanho diferente (não ${conflict === 1 ? 'tocado' : 'tocados'})`);
  if (errors) parts.push(`${errors} com erro`);
  const note = $('pNote');
  note.className = 'note' + (errors ? ' err' : '') + (!conflict && !errors ? ' hide' : '');
  if (errors) {
    const first = job.items.map((it) => S.files[it.i]).find((f) => f.st === 'error');
    note.textContent = `${plural(errors, 'arquivo não baixou', 'arquivos não baixaram')}. ${explain(first.err)} Clique em “Tentar de novo” para continuar de onde parou.`;
  } else if (conflict) {
    note.textContent = `${conflict === 1 ? '1 arquivo já existia com tamanho diferente e ficou como estava' : conflict + ' arquivos já existiam com tamanho diferente e ficaram como estavam'} (em amarelo na lista).`;
  }
  setPhase(errors ? 'error' : 'done');
  $('pTitle').textContent = (errors ? 'Terminou com erros · ' : 'Concluído · ') + parts.join(' · ');
  $('pSpeed').textContent = '—';
  $('pEtaK').textContent = 'Tempo total';
  $('pEta').textContent = fmtTime((Date.now() - R.started) / 1000);
  renderTree();
  refreshFree();
  invoke('notify', { title: errors ? 'MecDrive: terminou com erros' : 'MecDrive: download concluído', body: `${job.links.map((l) => l.name).join(', ')}\n${parts.join(' · ')}` });
  invoke('alerta', { color: errors || conflict ? 'red' : 'green' });
  if (S.cfg.openAfter && done) invoke('open_folder', { path: job.base });
}
function explain(err) {
  err = String(err || '');
  if (/downloadQuotaExceeded|quota/i.test(err)) return 'O Google bloqueou por cota de download desse arquivo (muita gente baixando); costuma liberar em até 24 h.';
  if (/dial tcp|no such host|timeout|connection|EOF|network/i.test(err)) return 'A conexão caiu e não voltou a tempo.';
  return 'Motivo: ' + err.slice(0, 160);
}

async function stopJobs() {
  const R = S.run;
  if (!R) return;
  R.stop = true;
  if (S.phase === 'paused') await invoke('rcd_pause', { pause: false }).catch(() => {});
  while (R.busy) await sleep(50);
  // parar pelo rclone faz ele mesmo remover os temporários das transferências em andamento
  for (const a of R.active.values()) await rc('job/stop', { jobid: a.jobid }, 10).catch(() => {});
  const t0 = Date.now();
  while (R.active.size && Date.now() - t0 < 15000) {
    for (const [k, a] of [...R.active]) {
      const st = await rc('job/status', { jobid: a.jobid }, 10).catch(() => ({ finished: true }));
      if (st.finished) R.active.delete(k);
    }
    if (R.active.size) await sleep(250);
  }
}

let toggling = false;
async function togglePause() {
  const R = S.run;
  if (!R || toggling) return;
  toggling = true;
  try {
    if (S.phase === 'running') {
      setPhase('paused');
      while (R.busy) await sleep(50);
      await invoke('rcd_pause', { pause: true }).catch((e) => toast(String(e)));
      paintProgress();
    } else if (S.phase === 'paused') {
      await invoke('rcd_pause', { pause: false }).catch((e) => toast(String(e)));
      setPhase('running');
    }
  } finally { toggling = false; }
}

async function cancelDownload() {
  if (!S.run) return;
  const ok = await ask('Cancelar o download?', 'Os arquivos já baixados ficam na pasta. Os que estavam pela metade são descartados.',
    [{ label: 'Continuar baixando', value: false, bold: true }, { label: 'Cancelar download', value: true, red: true }]);
  if (!ok || !S.run) return;
  $('bCancel').disabled = $('bPause').disabled = true;
  setStatus('wait', 'Cancelando…');
  await stopJobs();
  const job = S.job;
  job.state = 'canceled';
  await invoke('write_json', { name: 'job', value: job });
  const h = S.history.find((x) => x.id === job.id);
  if (h) { h.status = 'canceled'; await invoke('write_json', { name: 'history', value: S.history }); }
  S.run = null;
  S.files.forEach((f, i) => { if (!isDone(f) && f.st !== 'conflict') f.st = ''; f.bytes = 0; paintRow(i); });
  $('prog').classList.remove('show');
  setPhase('idle');
  refreshFree();
  toast('Download cancelado');
}

function resetAll() {
  S.links = []; S.files = []; S.dirs = []; S.off = new Set(); S.closed = new Set(); S.job = null; S.run = null;
  $('iLink').value = '';
  $('prog').classList.remove('show');
  showEmpty(EMPTY_T, EMPTY_P);
  S.dest.mode = 'auto'; S.dest.custom = ''; S.dest.date = todayStr(); $('iDate').value = S.dest.date;
  setPhase('idle');
  computeAuto();
}

/** Ao abrir: se o app fechou no meio de um download, continua de onde parou. */
async function restoreJob() {
  const job = await invoke('read_json', { name: 'job' });
  if (!job || job.v !== 2 || !job.items || (job.state !== 'running' && job.state !== 'error')) return;
  S.job = job;
  S.links = job.links;
  S.dirs = job.dirs || [];
  S.files = job.all.map((f) => ({ ...f }));
  S.off = new Set(job.off || []);
  applyOpts(job.opts);
  S.dest.mode = 'custom';
  S.dest.custom = job.root;
  renderDest();
  renderTree();
  refreshPreview();
  if (!S.info.hasToken) return;
  toast('Continuando o download de onde parou…', 4000);
  await startDownload(true);
}

/* ---------------- atualização ---------------- */
async function checkUpdate(manual) {
  try {
    const u = await invoke('check_update');
    S.update = u;
    $('bUpdate').classList.toggle('hide', !u.newer);
    if (u.newer) $('updTxt').textContent = `Atualização ${u.latest} disponível`;
    if (manual) toast(u.newer ? `Versão ${u.latest} disponível` : u.latest ? 'Você já está na versão mais recente' : 'Ainda não há versões publicadas no GitHub');
  } catch (e) {
    if (manual) toast('Não consegui consultar o GitHub: ' + e, 4000);
  }
}

/* ---------------- folhas e janela ---------------- */
function openSheet(id) { $(id).classList.add('open'); document.body.classList.add('sheet-on'); }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open')); document.body.classList.remove('sheet-on'); }

async function closeApp() {
  if (S.run) {
    const ok = await ask('Fechar com download em andamento?', 'Ao abrir o MecDrive de novo ele continua de onde parou: o que já baixou é pulado e os arquivos que estavam pela metade recomeçam.',
      [{ label: 'Voltar', value: false }, { label: 'Fechar', value: true, bold: true }]);
    if (!ok) return;
    await stopJobs(); // job.state continua "running": é isso que faz retomar na próxima abertura
  }
  win.destroy();
}

async function init() {
  $('bClose').onclick = closeApp;
  $('bMin').onclick = () => win.minimize();
  $('bMax').onclick = () => win.toggleMaximize();
  win.onCloseRequested((e) => { if (S.run) { e.preventDefault(); closeApp(); } });
  // menu suspenso no nome do app
  const menu = $('menu'), bMenu = $('bMenu');
  const setMenu = (open) => { menu.classList.toggle('open', open); bMenu.classList.toggle('open', open); };
  bMenu.onclick = (e) => { e.stopPropagation(); setMenu(!menu.classList.contains('open')); };
  document.addEventListener('click', () => setMenu(false));
  $('mCheck').onclick = () => checkUpdate(true);
  $('bHistory').onclick = () => { renderHistory(); openSheet('shHistory'); };
  $('bSettings').onclick = () => { $('basePath').textContent = S.cfg.base || 'nenhuma (o destino é a pasta de downloads)'; openSheet('shSettings'); };
  $('bAbout').onclick = () => openSheet('shAbout');
  $('bRepo').onclick = () => invoke('open_url', { url: REPO_URL }).catch((e) => toast(String(e)));
  $('repoTxt').value = REPO_URL.replace('https://', '');
  $('backdrop').onclick = closeSheets;
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeSheets));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheets(); setMenu(false); } });
  document.addEventListener('contextmenu', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });

  $('bLogin').onclick = login;
  $('bLoginCancel').onclick = () => invoke('google_login_cancel');
  $('bAcc').onclick = async () => {
    closeSheets();
    if (S.info.hasToken) {
      if (S.run) return toast('Termine ou cancele o download antes');
      const ok = await ask('Sair da conta Google?', 'O token guardado na pasta do app é apagado. Para baixar de novo será preciso entrar outra vez.',
        [{ label: 'Voltar', value: false, bold: true }, { label: 'Sair', value: true, red: true }]);
      if (!ok) return;
      await invoke('google_logout');
      await connect();
    } else login();
  };
  $('bBase').onclick = async () => {
    const p = await invoke('pick_folder', { start: S.cfg.base });
    if (!p) return;
    S.cfg.base = p; $('basePath').textContent = p; saveCfg(); S.dest.mode = 'auto'; computeAuto();
  };
  $('bAppDir').onclick = () => invoke('open_folder', { path: S.info.root });
  $('bCheck').onclick = () => checkUpdate(true);
  $('bUpdate').onclick = () => S.update && invoke('open_url', { url: S.update.url }).catch((e) => toast(String(e)));

  $('bRead').onclick = () => addLinks($('iLink').value);
  $('iLink').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLinks($('iLink').value); });
  // colar: lemos o texto inteiro da área de transferência para aceitar vários links, um por linha
  $('iLink').addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!splitLinks(text).some(parseLink)) return;
    e.preventDefault();
    $('iLink').value = splitLinks(text).join('  ');
    addLinks(text);
  });
  $('iDate').onchange = () => { S.dest.date = $('iDate').value || todayStr(); computeAuto(); };
  $('bPick').onclick = async () => {
    const p = await invoke('pick_folder', { start: S.dest.mode === 'custom' ? S.dest.custom : S.cfg.base });
    if (!p) return;
    S.dest.mode = 'custom'; S.dest.custom = p.replace(/[\\/]+$/, ''); renderDest();
  };
  $('bAuto').onclick = () => { S.dest.mode = 'auto'; computeAuto(); };
  $('bOpenDest').onclick = () => invoke('open_folder', { path: finalBase() }).catch((e) => toast(String(e)));
  bindOpts();

  $('zOut').onclick = () => setZoom(S.cfg.zoom / 1.15);
  $('zIn').onclick = () => setZoom(S.cfg.zoom * 1.15);
  $('zLbl').ondblclick = () => setZoom(1);
  // Ctrl + roda do mouse sobre a lista: aumenta ou diminui de forma contínua
  $('tree').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.cfg.zoom * Math.exp(-e.deltaY * 0.001));
  }, { passive: false });
  // roda do mouse direto em cima do controle de tamanho, sem Ctrl
  $('zCtl').addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(S.cfg.zoom * Math.exp(-e.deltaY * 0.001));
  }, { passive: false });
  $('vSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) setView(b.dataset.v); });
  $('bClear').onclick = clearDownloaded;

  $('bGo').onclick = () => startDownload(S.phase === 'error' && !!S.job);
  $('bPause').onclick = togglePause;
  $('bCancel').onclick = cancelDownload;
  $('bOpen').onclick = () => invoke('open_folder', { path: S.job ? S.job.base : finalBase() });
  $('bNew').onclick = resetAll;

  S.info = await invoke('app_info');
  const cfg = await invoke('read_json', { name: 'config' });
  if (cfg) Object.assign(S.cfg, cfg);
  S.cfg.zoom = Math.max(ZMIN, Math.min(ZMAX, Number(S.cfg.zoom) || 1));
  zCur = S.cfg.zoom;
  $('tree').style.zoom = zCur;
  $('zLbl').textContent = Math.round(zCur * 100) + '%';
  $('swOpen').classList.toggle('on', !!S.cfg.openAfter);
  S.opts.transfers = S.cfg.transfers || 4;
  $('nTransfers').textContent = S.opts.transfers;
  S.history = ((await invoke('read_json', { name: 'history' })) || []).filter((h) => Array.isArray(h.links));
  S.dest.date = todayStr();
  $('iDate').value = S.dest.date;
  await computeAuto();
  setPhase('idle');
  try {
    await connect();
  } catch (e) {
    setStatus('err', String(e));
  }
  await restoreJob();
  checkUpdate(false);
  setInterval(() => checkUpdate(false), 6 * 3600 * 1000);
}
Object.assign(window.DD, { addLinks, startDownload, togglePause, cancelDownload, stopJobs, renderDest, computeAuto, resetAll, setZoom, setView, clearDownloaded });
init();
