/* PdfTool — annotazioni e firme su PDF, interamente nel browser.
 *
 * Sistema di coordinate: ogni annotazione è memorizzata in PUNTI del "viewport"
 * della pagina (origine in alto a sinistra, y verso il basso) — cioè la pagina
 * così come la vedi, con l'eventuale rotazione /Rotate già applicata.
 * La conversione verso il sistema del PDF (origine in basso a sinistra) avviene
 * solo in fase di export, in vpToPdf(). In questo modo lo zoom non influenza i
 * dati e le pagine ruotate restano gestibili.
 */

const { PDFDocument, StandardFonts, rgb, degrees, BlendMode } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const { LINE_HEIGHT, rectToPdf, imageAnchor, textBaseline, sanitize } = PdfCoords;

const state = {
  bytes: null,
  name: 'documento.pdf',
  doc: null,
  pages: [],        // { num, wv, hv } dimensioni viewport in punti
  annos: [],
  tool: 'select',
  scale: 1,
  selected: null,
  pendingImage: null,   // dataURL in attesa di essere piazzata con un click
  seq: 0,
};

const $ = (sel) => document.querySelector(sel);
const viewer = $('#viewer');

/* ------------------------------------------------------------------ utils */

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const uid = () => `a${++state.seq}`;

/* --------------------------------------------- ponte con l'app nativa macOS */

// Presente solo dentro il guscio Swift; nel browser resta undefined.
const nativeSave = window.webkit?.messageHandlers?.savePdf;
const nativePicker = window.webkit?.messageHandlers?.pickerKind;

/** Consegna il PDF al foglio di condivisione del sistema (iOS e Android):
 *  da lì si salva in File, si manda per mail, ecc. Restituisce false se la
 *  strada non è disponibile, così il chiamante ripiega sul download. */
async function shareFile(bytes, filename) {
  if (!navigator.canShare) return false;
  const file = new File([bytes], filename, { type: 'application/pdf' });
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: filename });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') return true;      // annullato di proposito
    console.warn('condivisione non riuscita, ripiego sul download', err);
    return false;
  }
}

/** Apre il pannello di scelta file. Nell'app nativa il pannello è gestito da
 *  Swift, che deve sapere in anticipo quali tipi accettare. */
function openFilePicker(kind) {
  nativePicker?.postMessage(kind);
  document.getElementById(kind === 'pdf' ? 'file-input' : 'image-input').click();
}

function bytesToBase64(bytes) {
  let out = '';
  const CHUNK = 0x8000;                      // evita di sforare lo stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Chiamata dal menu "Apri…" dell'app nativa. */
window.nativeOpen = async (b64, name) => {
  try {
    await openPdf(base64ToBytes(b64).buffer, name);
  } catch (err) {
    toast(`Non riesco ad aprire ${name}: ${err.message}`, true);
  }
};

/* --------------------------------------------------------- apertura file */

$('#btn-open').addEventListener('click', () => openFilePicker('pdf'));

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await openPdf(await file.arrayBuffer(), file.name);
  } catch (err) {
    console.error(err);
    toast(`Non riesco ad aprire il PDF: ${err.message}`, true);
  }
  e.target.value = '';
});

async function openPdf(buffer, name) {
  state.bytes = new Uint8Array(buffer);
  state.name = name;
  state.annos = [];
  state.selected = null;
  state.pendingImage = null;

  // pdf.js consuma (detach) il buffer che riceve: gliene passo una copia.
  state.doc = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;

  state.pages = [];
  for (let i = 1; i <= state.doc.numPages; i++) {
    const page = await state.doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    state.pages.push({ num: i, wv: vp.width, hv: vp.height });
  }

  state.scale = fitScale();

  $('#doc-name').textContent = `${name} — ${state.doc.numPages} pagin${state.doc.numPages === 1 ? 'a' : 'e'}`;
  $('#btn-save').disabled = false;
  await render();
  toast(`Aperto: ${name}`);
}

/* ------------------------------------------------------------- rendering */

async function render() {
  viewer.innerHTML = '';
  const dpr = window.devicePixelRatio || 1;

  for (const info of state.pages) {
    const page = await state.doc.getPage(info.num);
    const vp = page.getViewport({ scale: state.scale });

    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = `${vp.width}px`;
    wrap.style.height = `${vp.height}px`;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;

    const layer = document.createElement('div');
    layer.className = 'page-layer';
    layer.dataset.page = info.num - 1;

    const badge = document.createElement('span');
    badge.className = 'page-badge';
    badge.textContent = `pagina ${info.num} / ${state.pages.length}`;

    wrap.append(canvas, layer, badge);
    viewer.append(wrap);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    attachLayerEvents(layer);
  }

  state.annos.forEach(drawAnno);
  updateZoomLabel();
}

function layerOf(pageIndex) {
  return viewer.querySelector(`.page-layer[data-page="${pageIndex}"]`);
}

function drawAnno(a) {
  const layer = layerOf(a.page);
  if (!layer) return;
  const s = state.scale;

  const el = document.createElement('div');
  el.className = `anno anno-${a.type}`;
  el.dataset.id = a.id;
  el.style.left = `${a.x * s}px`;
  el.style.top = `${a.y * s}px`;

  if (a.type === 'text') {
    el.classList.add('anno-text');
    el.style.fontSize = `${a.size * s}px`;
    el.style.color = a.color;
    el.style.lineHeight = LINE_HEIGHT;
    el.textContent = a.text;
  } else {
    el.style.width = `${a.w * s}px`;
    el.style.height = `${a.h * s}px`;
    if (a.type === 'highlight') {
      el.style.background = a.color;
      el.style.opacity = 0.38;
      el.style.mixBlendMode = 'multiply';
    } else {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      el.append(img);
    }
  }

  const del = document.createElement('button');
  del.className = 'anno-del';
  del.textContent = '×';
  del.title = 'Elimina';
  del.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  del.addEventListener('click', (ev) => {
    ev.stopPropagation();
    removeAnno(a.id);
  });
  el.append(del);

  if (a.type !== 'text') {
    const grip = document.createElement('div');
    grip.className = 'anno-grip';
    grip.title = 'Ridimensiona';
    grip.addEventListener('pointerdown', (ev) => startResize(ev, a, el));
    el.append(grip);
  }

  el.addEventListener('pointerdown', (ev) => {
    if (state.tool !== 'select' && state.tool !== 'text') return;
    ev.stopPropagation();
    select(a.id);
    startDrag(ev, a, el);
  });

  if (a.type === 'text') {
    el.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      editText(a, el);
    });
  }

  layer.append(el);
  if (state.selected === a.id) el.classList.add('selected');
  return el;
}

function redrawAnno(a) {
  const old = viewer.querySelector(`.anno[data-id="${a.id}"]`);
  if (old) old.remove();
  return drawAnno(a);
}

function removeAnno(id) {
  state.annos = state.annos.filter((a) => a.id !== id);
  const el = viewer.querySelector(`.anno[data-id="${id}"]`);
  if (el) el.remove();
  if (state.selected === id) state.selected = null;
}

function select(id) {
  state.selected = id;
  viewer.querySelectorAll('.anno').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
}

/* ------------------------------------------- interazione con la pagina */

function attachLayerEvents(layer) {
  const pageIndex = Number(layer.dataset.page);

  layer.addEventListener('pointerdown', (ev) => {
    if (ev.target !== layer) return;          // click su un'annotazione: gestito altrove
    select(null);

    const pt = layerPoint(layer, ev);

    if (state.tool === 'text') {
      createText(pageIndex, pt);
    } else if (state.tool === 'highlight') {
      startHighlight(layer, pageIndex, pt, ev);
    } else if (state.tool === 'image') {
      if (state.pendingImage) {
        placeImage(pageIndex, pt, state.pendingImage);
        state.pendingImage = null;
        setTool('select');
      } else {
        pendingClick = { pageIndex, pt };
        openFilePicker('image');
      }
    }
  });
}

/** Coordinate del puntatore dentro il layer, in punti viewport. */
function layerPoint(layer, ev) {
  const r = layer.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left) / state.scale,
    y: (ev.clientY - r.top) / state.scale,
  };
}

/* ---------------------------------------------------------------- testo */

function createText(pageIndex, pt) {
  const a = {
    id: uid(),
    page: pageIndex,
    type: 'text',
    x: pt.x,
    y: pt.y,
    text: '',
    size: Number($('#prop-size').value) || 14,
    color: $('#prop-color').value,
  };
  state.annos.push(a);
  const el = drawAnno(a);
  select(a.id);
  editText(a, el);
}

function editText(a, el) {
  el.setAttribute('contenteditable', 'plaintext-only');
  if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    el.removeAttribute('contenteditable');
    el.removeEventListener('blur', finish);
    el.removeEventListener('keydown', onKey);
    a.text = el.innerText.replace(/\n$/, '');
    if (!a.text.trim()) removeAnno(a.id);
    else el.textContent = a.text;
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); el.blur(); }
    ev.stopPropagation();
  };

  el.addEventListener('blur', finish);
  el.addEventListener('keydown', onKey);
}

/* --------------------------------------------------------- evidenziatore */

function startHighlight(layer, pageIndex, origin, ev) {
  const s = state.scale;
  const ghost = document.createElement('div');
  ghost.className = 'anno anno-highlight';
  ghost.style.background = $('#prop-color').value;
  ghost.style.opacity = 0.38;
  ghost.style.mixBlendMode = 'multiply';
  ghost.style.pointerEvents = 'none';
  layer.append(ghost);

  const info = state.pages[pageIndex];

  const move = (e) => {
    const p = layerPoint(layer, e);
    const x = Math.max(0, Math.min(origin.x, p.x));
    const y = Math.max(0, Math.min(origin.y, p.y));
    const w = Math.min(Math.abs(p.x - origin.x), info.wv - x);
    const h = Math.min(Math.abs(p.y - origin.y), info.hv - y);
    ghost.style.left = `${x * s}px`;
    ghost.style.top = `${y * s}px`;
    ghost.style.width = `${w * s}px`;
    ghost.style.height = `${h * s}px`;
    ghost._box = { x, y, w, h };
  };

  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const box = ghost._box;
    ghost.remove();
    if (!box || box.w < 3 || box.h < 3) return;
    const a = { id: uid(), page: pageIndex, type: 'highlight', ...box, color: $('#prop-color').value };
    state.annos.push(a);
    drawAnno(a);
    select(a.id);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  move(ev);
}

/* ------------------------------------------------------------- immagini */

let pendingClick = null;

$('#image-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !pendingClick) return;
  const reader = new FileReader();
  reader.onload = () => {
    placeImage(pendingClick.pageIndex, pendingClick.pt, reader.result);
    pendingClick = null;
    setTool('select');
  };
  reader.readAsDataURL(file);
});

function placeImage(pageIndex, pt, dataUrl) {
  const img = new Image();
  img.onload = () => {
    const info = state.pages[pageIndex];
    const maxW = info.wv * 0.4;
    const ratio = Math.min(1, maxW / img.width);
    const w = img.width * ratio;
    const h = img.height * ratio;
    const a = {
      id: uid(),
      page: pageIndex,
      type: 'image',
      x: Math.max(0, Math.min(pt.x, info.wv - w)),
      y: Math.max(0, Math.min(pt.y, info.hv - h)),
      w, h, dataUrl,
    };
    state.annos.push(a);
    drawAnno(a);
    select(a.id);
  };
  img.onerror = () => toast('Immagine non leggibile', true);
  img.src = dataUrl;
}

/* -------------------------------------------------- spostamento e resize */

function startDrag(ev, a, el) {
  const s = state.scale;
  const info = state.pages[a.page];
  const start = { mx: ev.clientX, my: ev.clientY, ax: a.x, ay: a.y };
  let moved = false;

  const move = (e) => {
    const dx = (e.clientX - start.mx) / s;
    const dy = (e.clientY - start.my) / s;
    if (!moved && Math.hypot(dx * s, dy * s) < 3) return;
    moved = true;
    const bw = a.type === 'text' ? 0 : a.w;
    const bh = a.type === 'text' ? 0 : a.h;
    a.x = Math.max(0, Math.min(start.ax + dx, info.wv - bw));
    a.y = Math.max(0, Math.min(start.ay + dy, info.hv - bh));
    el.style.left = `${a.x * s}px`;
    el.style.top = `${a.y * s}px`;
  };

  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startResize(ev, a, el) {
  ev.stopPropagation();
  const s = state.scale;
  const info = state.pages[a.page];
  const start = { mx: ev.clientX, my: ev.clientY, w: a.w, h: a.h };
  const aspect = a.type === 'image' ? a.w / a.h : null;

  const move = (e) => {
    let w = Math.max(8, start.w + (e.clientX - start.mx) / s);
    let h = aspect ? w / aspect : Math.max(5, start.h + (e.clientY - start.my) / s);
    w = Math.min(w, info.wv - a.x);
    h = Math.min(h, info.hv - a.y);
    if (aspect) w = Math.min(w, h * aspect);
    a.w = w;
    a.h = aspect ? w / aspect : h;
    el.style.width = `${a.w * s}px`;
    el.style.height = `${a.h * s}px`;
  };

  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ---------------------------------------------------------------- firma */

const signDialog = $('#sign-dialog');
const signCanvas = $('#sign-canvas');
const signCtx = signCanvas.getContext('2d');
let signHasInk = false;

$('#btn-signature').addEventListener('click', () => {
  if (!state.doc) return toast('Apri prima un PDF', true);
  signDialog.showModal();
});

$('#sign-clear').addEventListener('click', () => {
  signCtx.clearRect(0, 0, signCanvas.width, signCanvas.height);
  signHasInk = false;
});

$('#sign-cancel').addEventListener('click', () => signDialog.close());

$('#sign-ok').addEventListener('click', () => {
  if (!signHasInk) return toast('Disegna la firma prima di confermare', true);
  const png = trimCanvas(signCanvas);
  signDialog.close();
  state.pendingImage = png;
  setTool('image');
  toast('Clicca sulla pagina dove vuoi mettere la firma');
});

(function initSignPad() {
  let drawing = false;
  const pos = (e) => {
    const r = signCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (signCanvas.width / r.width),
      y: (e.clientY - r.top) * (signCanvas.height / r.height),
    };
  };

  signCanvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    signCanvas.setPointerCapture(e.pointerId);
    signCtx.strokeStyle = '#111827';
    signCtx.lineWidth = 2.6;
    signCtx.lineCap = 'round';
    signCtx.lineJoin = 'round';
    const p = pos(e);
    signCtx.beginPath();
    signCtx.moveTo(p.x, p.y);
  });

  signCanvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    signCtx.lineTo(p.x, p.y);
    signCtx.stroke();
    signHasInk = true;
  });

  signCanvas.addEventListener('pointerup', () => { drawing = false; });
})();

/** Ritaglia i margini trasparenti e restituisce un PNG. */
function trimCanvas(src) {
  const { width: w, height: h } = src;
  const data = src.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return src.toDataURL('image/png');

  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);

  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/* ------------------------------------------------------- toolbar e tasti */

function setTool(tool) {
  state.tool = tool;
  document.body.dataset.tool = tool;
  document.querySelectorAll('.btn.tool').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
}

$('#tools').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn.tool');
  if (!btn) return;
  if (!state.doc) return toast('Apri prima un PDF', true);
  state.pendingImage = null;
  setTool(btn.dataset.tool);
});

$('#zoom-in').addEventListener('click', () => setScale(state.scale * 1.25));
$('#zoom-out').addEventListener('click', () => setScale(state.scale / 1.25));

/** Scala che fa stare la pagina nella larghezza disponibile, senza però
 *  ingrandirla oltre la dimensione reale. */
function fitScale() {
  const w = state.pages[0]?.wv;
  if (!w) return 1;
  const avail = (viewer.clientWidth || window.innerWidth) - 24;
  return Math.max(0.4, Math.min(1, avail / w));
}

function setScale(v) {
  if (!state.doc) return;
  state.scale = Math.max(0.4, Math.min(3, v));
  render();
}

function updateZoomLabel() {
  $('#zoom-label').textContent = `${Math.round(state.scale * 100)}%`;
}

$('#btn-undo').addEventListener('click', () => {
  const last = state.annos[state.annos.length - 1];
  if (!last) return toast('Niente da annullare');
  removeAnno(last.id);
});

$('#btn-clear').addEventListener('click', () => {
  if (!state.annos.length) return;
  if (!confirm(`Rimuovere ${state.annos.length} annotazioni?`)) return;
  state.annos = [];
  state.selected = null;
  viewer.querySelectorAll('.anno').forEach((el) => el.remove());
});

document.addEventListener('keydown', (e) => {
  if (e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selected) {
    e.preventDefault();
    removeAnno(state.selected);
  } else if (e.key === 'Escape') {
    select(null);
    setTool('select');
  } else if (e.key === 'v') setTool('select');
  else if (e.key === 't' && state.doc) setTool('text');
  else if (e.key === 'h' && state.doc) setTool('highlight');
});

// apertura tramite drag & drop sulla finestra
['dragover', 'drop'].forEach((type) => {
  document.addEventListener(type, async (e) => {
    e.preventDefault();
    if (type !== 'drop') return;
    const file = [...e.dataTransfer.files].find((f) => f.type === 'application/pdf');
    if (!file) return;
    await openPdf(await file.arrayBuffer(), file.name);
  });
});

/* ----------------------------------------------------------- export PDF */

$('#btn-save').addEventListener('click', exportPdf);

async function exportPdf() {
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Salvo…';

  try {
    const out = await PDFDocument.load(state.bytes);
    const font = await out.embedFont(StandardFonts.Helvetica);
    const pages = out.getPages();
    const imageCache = new Map();
    let dropped = 0;

    for (const a of state.annos) {
      const page = pages[a.page];
      if (!page) continue;
      const R = ((page.getRotation().angle % 360) + 360) % 360;
      const { width: W, height: H } = page.getSize();

      if (a.type === 'text') {
        const clean = sanitize(a.text);
        dropped += clean.dropped;
        const lines = clean.text.split('\n');
        lines.forEach((line, i) => {
          if (!line) return;
          const p = textBaseline(a, i, R, W, H);
          page.drawText(line, {
            x: p.x,
            y: p.y,
            size: a.size,
            font,
            color: hexToRgb(a.color),
            rotate: degrees(R),
          });
        });

      } else if (a.type === 'highlight') {
        page.drawRectangle({
          ...rectToPdf(a, R, W, H),
          color: hexToRgb(a.color),
          opacity: 0.38,
          blendMode: BlendMode.Multiply,
        });

      } else if (a.type === 'image') {
        let img = imageCache.get(a.dataUrl);
        if (!img) {
          img = a.dataUrl.startsWith('data:image/png')
            ? await out.embedPng(a.dataUrl)
            : await out.embedJpg(a.dataUrl);
          imageCache.set(a.dataUrl, img);
        }
        // Ancoraggio: spigolo in basso a sinistra dell'immagine nel viewport.
        const p = imageAnchor(a, R, W, H);
        page.drawImage(img, {
          x: p.x,
          y: p.y,
          width: a.w,
          height: a.h,
          rotate: degrees(R),
        });
      }
    }

    const bytes = await out.save();
    const filename = state.name.replace(/\.pdf$/i, '') + '-annotato.pdf';

    if (nativeSave) {
      nativeSave.postMessage({ name: filename, data: bytesToBase64(bytes) });
    } else if (await shareFile(bytes, filename)) {
      // sul telefono il foglio di condivisione permette "Salva su File"
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    toast(dropped
      ? `PDF salvato, ma ${dropped} caratteri non supportati da Helvetica sono stati rimossi.`
      : 'PDF salvato.');
  } catch (err) {
    console.error(err);
    toast(`Errore durante il salvataggio: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salva PDF';
  }
}

setTool('select');
// Comodità: ?file=percorso.pdf apre subito un documento servito dalla stessa cartella.
(async () => {
  const url = new URLSearchParams(location.search).get('file');
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openPdf(await res.arrayBuffer(), url.split('/').pop());
  } catch (err) {
    toast(`Non riesco a caricare ${url}: ${err.message}`, true);
  }
})();

// Il funzionamento offline sul telefono passa dal service worker, che i browser
// accettano solo su HTTPS o localhost (non dentro il guscio nativo, che usa uno
// schema proprio).
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .catch((err) => console.warn('service worker non registrato:', err));
  });
}
