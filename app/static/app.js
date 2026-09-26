// DesiCaps Studio - editor UI
const $ = s => document.querySelector(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
};
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, "0")}`; };
function toast(html, err = false, ms = 3500) {
  const el = $("#toast"); el.innerHTML = html; el.className = "toast" + (err ? " err" : "");
  clearTimeout(toast.t); if (ms) toast.t = setTimeout(() => el.classList.add("hidden"), ms);
}

let PRESETS = null, P = null, PGS = [], SEL = -1, EMOJIS = [];
const video = $("#video"), cv = $("#overlay"), ctx = cv.getContext("2d");
const cvd = $("#overlayDiff"), dctx = cvd.getContext("2d");  // negative ("difference") text layer

// ======================================================= HOME
async function showHome() {
  $("#editor").classList.add("hidden"); $("#home").classList.remove("hidden");
  video.pause(); P = null;
  const list = await api("/api/projects");
  $("#projList").innerHTML = list.length ? "" : '<div class="muted">No projects yet.</div>';
  for (const p of list) {
    const d = document.createElement("div"); d.className = "proj";
    d.innerHTML = `<span>${esc(p.name)}</span><span class="muted">${p.words} words · ${fmt(p.duration)}</span>`;
    d.onclick = () => openProject(p.id); $("#projList").appendChild(d);
  }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function uploadFile(file) {
  const fd = new FormData(); fd.append("file", file);
  const xhr = new XMLHttpRequest(); xhr.open("POST", "/api/upload");
  jobUI(true, "Uploading " + file.name, 0);
  xhr.upload.onprogress = e => e.lengthComputable && jobUI(true, "Uploading " + file.name, e.loaded / e.total);
  xhr.onload = () => { jobUI(false); if (xhr.status === 200) { const p = JSON.parse(xhr.responseText); openProject(p.id, true); } else toast(xhr.responseText, true); };
  xhr.onerror = () => { jobUI(false); toast("Upload failed", true); };
  xhr.send(fd);
}
const HAS_NATIVE = () => !!(window.pywebview && window.pywebview.api);
async function openPath(path) {
  try { const p = await api("/api/open_path", { method: "POST", body: { path } }); openProject(p.id, true); }
  catch (e) { toast(esc(e.message), true); }
}
$("#fileInput").onchange = e => e.target.files[0] && uploadFile(e.target.files[0]);
$("#drop").addEventListener("click", async e => {
  if (!HAS_NATIVE()) return;             // browser: normal <input type=file>
  e.preventDefault();
  const path = await window.pywebview.api.pick_video();
  if (path) openPath(path);
});
function openExternal(url) {
  if (HAS_NATIVE()) window.pywebview.api.open_url(url); else window.open(url, "_blank");
}
$("#openExports").onclick = () => api("/api/reveal", { method: "POST", body: {} });
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => e.dataTransfer.files[0] && uploadFile(e.dataTransfer.files[0]));
$("#pathBtn").onclick = () => openPath($("#pathInput").value);

// ======================================================= EDITOR LOAD
async function openProject(id, autoTranscribe = false) {
  P = await api("/api/project/" + id);
  $("#home").classList.add("hidden"); $("#editor").classList.remove("hidden");
  $("#projName").value = P.name;
  video.src = "/media/" + id;
  $("#frame").style.aspectRatio = `${P.width} / ${P.height}`;
  $("#engineSel").value = P.engine || "hinglish";
  await DC.loadStyleFonts(P.style);
  $("#vocabInput").value = P.vocab || "";
  SEL = -1; refreshAll(); snapshot(true);
  if (autoTranscribe && !P.words.length) transcribe();
}
$("#backBtn").onclick = () => { flushSave(); showHome(); };
$("#projName").onchange = e => { P.name = e.target.value; save(); };

let saveT = null, HIST = [], HI = -1, restoring = false;
function save() { clearTimeout(saveT); saveT = setTimeout(flushSave, 500); }
function snapshot(reset = false) {
  if (!P || restoring) return;
  const s = JSON.stringify({ w: P.words, s: P.style, p: P.preset });
  if (reset) { HIST = [s]; HI = 0; return; }
  if (s === HIST[HI]) return;
  HIST = HIST.slice(0, HI + 1); HIST.push(s); if (HIST.length > 200) HIST.shift(); HI = HIST.length - 1;
}
async function undoRedo(d) {
  flushSave();
  const j = HI + d; if (j < 0 || j >= HIST.length) return toast(d < 0 ? "Nothing to undo" : "Nothing to redo", false, 1200);
  HI = j; const s = JSON.parse(HIST[HI]); restoring = true;
  P.words = s.w; P.style = s.s; P.preset = s.p;
  await DC.loadStyleFonts(P.style);
  SEL = Math.min(SEL, P.words.length - 1); refreshAll(); restoring = false;
  api("/api/project/" + P.id, { method: "POST", body: { words: P.words, style: P.style, preset: P.preset } }).catch(() => {});
}
$("#undoBtn").onclick = () => undoRedo(-1); $("#redoBtn").onclick = () => undoRedo(1);
function flushSave() {
  if (!P) return; clearTimeout(saveT); snapshot();
  api("/api/project/" + P.id, { method: "POST", body: { words: P.words, style: P.style, preset: P.preset, name: P.name } }).catch(e => toast("Save failed: " + e.message, true));
}

function refreshAll() {
  PGS = DC.pages(P.words);
  $("#empty").classList.toggle("hidden", P.words.length > 0);
  $("#wordCount").textContent = P.words.length ? `${P.words.length} words · ${PGS.length} lines` : "";
  renderTranscript(); renderInspector(); buildPresetGrid(); buildStyleForm(); drawTimeline(); drawOverlay();
}
function changed(structural = true) { if (structural) PGS = DC.pages(P.words); renderTranscript(); renderInspector(); drawTimeline(); drawOverlay(); save(); }

// ======================================================= OVERLAY
function drawOverlay() {
  if (!P) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
  const s = cv.width / P.width; ctx.setTransform(s, 0, 0, s, 0, 0);
  const t = video.currentTime;
  DC.draw(ctx, P, t, P.width, P.height, PGS, drawOverlay);
  if (cvd.width !== cv.width || cvd.height !== cv.height) { cvd.width = cv.width; cvd.height = cv.height; }
  dctx.setTransform(1, 0, 0, 1, 0, 0); dctx.clearRect(0, 0, cvd.width, cvd.height);
  if (DC.isDiff(P.style)) { dctx.setTransform(s, 0, 0, s, 0, 0); DC.draw(dctx, P, t, P.width, P.height, PGS, drawOverlay, "diff"); }
  $("#timeLbl").textContent = fmt(t) + " / " + fmt(P.duration);
  markPlaying(t); drawPlayhead();
}
let raf = null;
function loop() { drawOverlay(); raf = video.paused ? null : requestAnimationFrame(loop); }
video.addEventListener("play", () => { $("#playBtn").textContent = "❚❚"; if (!raf) loop(); });
video.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; drawOverlay(); });
video.addEventListener("seeked", drawOverlay);
video.addEventListener("loadeddata", drawOverlay);
video.addEventListener("error", async () => {
  if (!P || P.proxy || video.dataset.proxying === P.id) return;
  video.dataset.proxying = P.id;
  jobUI(true, "This codec can't play in the browser - making a preview copy (render still uses the original)", 0.3);
  try { await api(`/api/project/${P.id}/proxy`, { method: "POST", body: {} }); P.proxy = true; video.src = "/media/" + P.id + "?proxy=1"; }
  catch (e) { toast("Preview copy failed: " + esc(e.message), true, 0); }
  jobUI(false);
});
window.addEventListener("resize", () => { drawOverlay(); drawTimeline(); });
$("#playBtn").onclick = () => (video.paused ? video.play() : video.pause());

// drag captions vertically on the video
let dragY = null;
cv.addEventListener("pointerdown", e => { dragY = { y: e.clientY, p: P.style.posY }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener("pointermove", e => {
  if (!dragY) return;
  P.style.posY = Math.min(0.95, Math.max(0.05, dragY.p + (e.clientY - dragY.y) / cv.clientHeight));
  drawOverlay(); syncForm("posY");
});
cv.addEventListener("pointerup", e => {
  if (dragY && Math.abs(e.clientY - dragY.y) < 3) video.paused ? video.play() : video.pause();
  if (dragY) save(); dragY = null;
});

// ======================================================= TRANSCRIPT
function renderTranscript() {
  const box = $("#transcript"); box.innerHTML = "";
  const frag = document.createDocumentFragment();
  PGS.forEach((p, pi) => {
    const row = document.createElement("div"); row.className = "page"; row.dataset.pi = pi;
    row.innerHTML = `<div class="t mono">${fmt(p.start).slice(0, -1)}</div><div class="ws"></div>`;
    const ws = row.lastChild;
    for (let i = p.i0; i <= p.i1; i++) {
      const w = P.words[i], c = document.createElement("span");
      c.className = "chip" + (w.hl ? " h" + w.hl : "") + (i === SEL ? " sel" : "");
      c.dataset.i = i; c.textContent = w.text;
      if (w.emoji) { const im = document.createElement("img"); im.src = `/emoji/${w.emoji}.png`; c.appendChild(im); }
      ws.appendChild(c);
    }
    frag.appendChild(row);
  });
  box.appendChild(frag);
}
$("#transcript").addEventListener("click", e => {
  const c = e.target.closest(".chip"); if (!c || c.isContentEditable) return;
  select(+c.dataset.i, true);
});
$("#transcript").addEventListener("dblclick", e => {
  const c = e.target.closest(".chip"); if (!c) return;
  const i = +c.dataset.i; c.textContent = P.words[i].text; c.contentEditable = true; c.focus();
  document.getSelection().selectAllChildren(c);
  const done = ok => {
    c.contentEditable = false; c.onblur = c.onkeydown = null;
    const txt = c.textContent.trim();
    if (ok && txt && txt !== P.words[i].text) { applyText(i, txt); } else renderTranscript();
  };
  c.onblur = () => done(true);
  c.onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); c.blur(); } if (ev.key === "Escape") done(false); };
});
function applyText(i, txt) {
  // typing a space splits the word into several words with proportional timings
  const parts = txt.split(/\s+/).filter(Boolean), w = P.words[i];
  if (parts.length <= 1) { w.text = txt; changed(false); return; }
  const tot = parts.reduce((a, b) => a + b.length, 0), dur = w.end - w.start; let cur = w.start;
  const nw = parts.map((t, k) => { const d = dur * t.length / tot; const o = { text: t, start: +cur.toFixed(3), end: +(cur + d).toFixed(3) }; if (k === 0) { o.brk = w.brk; o.hl = w.hl; o.emoji = w.emoji; } cur += d; return o; });
  P.words.splice(i, 1, ...nw); changed();
}
let lastPlayPage = -1, lastAct = -1;
function markPlaying(t) {
  const pi = PGS.findIndex(p => p.start <= t && t < p.end);
  const a = pi >= 0 ? DC.activeIndex(P.words, PGS[pi], t) : -1;
  if (pi !== lastPlayPage) {
    document.querySelectorAll(".page.cur").forEach(e => e.classList.remove("cur"));
    const row = document.querySelector(`.page[data-pi="${pi}"]`);
    if (row) { row.classList.add("cur"); if (!video.paused) row.scrollIntoView({ block: "center", behavior: "smooth" }); }
    lastPlayPage = pi;
  }
  if (a !== lastAct) {
    document.querySelectorAll(".chip.act").forEach(e => e.classList.remove("act"));
    const c = document.querySelector(`.chip[data-i="${a}"]`); if (c) c.classList.add("act");
    lastAct = a;
  }
}

// ======================================================= INSPECTOR
function select(i, seek = false) {
  SEL = i; renderInspector();
  document.querySelectorAll(".chip.sel").forEach(e => e.classList.remove("sel"));
  const c = document.querySelector(`.chip[data-i="${i}"]`); if (c) { c.classList.add("sel"); c.scrollIntoView({ block: "nearest" }); }
  if (seek && P.words[i]) { video.pause(); video.currentTime = P.words[i].start + 0.01; }
  drawTimeline();
}
function renderInspector() {
  const w = P && P.words[SEL];
  $("#inspector").classList.toggle("hidden", !w);
  if (!w) return;
  $("#wText").value = w.text; $("#wStart").value = w.start.toFixed(2); $("#wEnd").value = w.end.toFixed(2);
  document.querySelectorAll("#hlSeg button").forEach(b => b.classList.toggle("on", +b.dataset.hl === (w.hl || 0)));
  $("#brkBtn").textContent = w.brk && SEL > 0 ? "⤒ Join line above" : "↵ New line here";
  $("#emojiBtn").innerHTML = w.emoji ? `<img src="/emoji/${w.emoji}.png" style="width:14px;vertical-align:-2px"> Emoji` : "😀 Emoji";
}
$("#wText").onchange = e => { const t = e.target.value.trim(); if (t) applyText(SEL, t); };
$("#wStart").onchange = e => setTime(SEL, "start", +e.target.value);
$("#wEnd").onchange = e => setTime(SEL, "end", +e.target.value);
$("#setIn").onclick = () => setTime(SEL, "start", video.currentTime);
$("#setOut").onclick = () => setTime(SEL, "end", video.currentTime);
function setTime(i, k, v) {
  const w = P.words[i]; if (!w || isNaN(v)) return;
  const prev = P.words[i - 1], next = P.words[i + 1];
  if (k === "start") { w.start = Math.max(prev ? prev.start + 0.02 : 0, Math.min(v, w.end - 0.04)); if (prev && prev.end > w.start) prev.end = w.start; }
  else { w.end = Math.max(w.start + 0.04, Math.min(v, next ? next.end - 0.04 : P.duration)); if (next && next.start < w.end) next.start = w.end; }
  w.start = +w.start.toFixed(3); w.end = +w.end.toFixed(3); changed();
}
document.querySelectorAll("#hlSeg button").forEach(b => b.onclick = () => { P.words[SEL].hl = +b.dataset.hl || 0; changed(false); });
$("#brkBtn").onclick = () => { if (SEL <= 0) return; P.words[SEL].brk = !P.words[SEL].brk; changed(); };
$("#delBtn").onclick = () => {
  const w = P.words[SEL]; if (!w) return;
  if (w.brk && P.words[SEL + 1]) P.words[SEL + 1].brk = true;
  P.words.splice(SEL, 1); SEL = Math.min(SEL, P.words.length - 1); changed();
};
$("#addBtn").onclick = () => {
  const w = P.words[SEL], next = P.words[SEL + 1];
  const s = w.end, e = Math.min(next ? next.start : P.duration, s + 0.3);
  if (e - s < 0.05) { const mid = (w.start + w.end) / 2; P.words.splice(SEL + 1, 0, { text: "new", start: +mid.toFixed(3), end: w.end }); w.end = +mid.toFixed(3); }
  else P.words.splice(SEL + 1, 0, { text: "new", start: +s.toFixed(3), end: +e.toFixed(3) });
  SEL++; changed(); setTimeout(() => { $("#wText").focus(); $("#wText").select(); }, 0);
};
$("#splitBtn").onclick = () => {
  const w = P.words[SEL]; if (!w || w.text.length < 2) return;
  const m = Math.ceil(w.text.length / 2); applyText(SEL, w.text.slice(0, m) + " " + w.text.slice(m));
};
// emoji picker
$("#emojiBtn").onclick = async () => {
  const g = $("#emojiGrid");
  if (!EMOJIS.length) EMOJIS = await api("/api/emoji");
  if (!g.childElementCount) {
    g.innerHTML = `<div class="none" data-c="">none</div><input class="paste" placeholder="paste 😀" style="grid-column:span 6;padding:3px 6px;font-size:12px">`;
    for (const c of EMOJIS) { const im = document.createElement("img"); im.src = `/emoji/${c}.png`; im.dataset.c = c; g.appendChild(im); }
    g.querySelector(".paste").onchange = e => { const ch = e.target.value.trim(); if (ch) setEmoji([...ch].filter(x => x !== "️").map(x => x.codePointAt(0).toString(16)).join("-")); e.target.value = ""; };
  }
  g.classList.toggle("hidden");
};
$("#emojiGrid").addEventListener("click", e => { const c = e.target.dataset.c; if (c !== undefined && e.target.tagName !== "INPUT") setEmoji(c); });
function setEmoji(code) { if (P.words[SEL]) { P.words[SEL].emoji = code || undefined; changed(false); } $("#emojiGrid").classList.add("hidden"); }

// keyboard
document.addEventListener("keydown", e => {
  if (!P || $("#editor").classList.contains("hidden")) return;
  const tag = document.activeElement.tagName, editing = tag === "INPUT" || tag === "SELECT" || document.activeElement.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoRedo(e.shiftKey ? 1 : -1); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); undoRedo(1); return; }
  if (editing) return;
  if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault(); const d = e.key === "ArrowRight" ? 1 : -1;
    const base = SEL >= 0 ? SEL : Math.max(0, P.words.findIndex(w => w.start >= video.currentTime));
    select(Math.max(0, Math.min(P.words.length - 1, base + (SEL >= 0 ? d : 0))), true);
  }
  else if (e.key === "Enter" && SEL > 0) { $("#brkBtn").click(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && SEL >= 0) { e.preventDefault(); $("#delBtn").click(); }
  else if (e.key === "1" || e.key === "2" || e.key === "0") { if (SEL >= 0) { P.words[SEL].hl = +e.key; changed(false); } }
  else if (e.key.toLowerCase() === "e" && SEL >= 0) { e.preventDefault(); $("#wText").focus(); $("#wText").select(); }
});

// ======================================================= TIMELINE
const tlWrap = $("#timeline"), tl = $("#tl"), tctx = tl.getContext("2d");
let pps = 120; // pixels per second
$("#zoom").oninput = e => { pps = +e.target.value; drawTimeline(); };
function drawTimeline() {
  if (!P) return;
  const dpr = window.devicePixelRatio || 1, W = Math.max(tlWrap.clientWidth, Math.ceil((P.duration || 1) * pps) + 40), H = tlWrap.clientHeight;
  tl.style.width = W + "px"; tl.width = W * dpr; tl.height = H * dpr; tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.fillStyle = "#14161b"; tctx.fillRect(0, 0, W, H);
  tctx.fillStyle = "#5b6170"; tctx.font = "10px system-ui"; tctx.textBaseline = "top";
  const step = pps > 200 ? 0.5 : pps > 80 ? 1 : 2;
  for (let s = 0; s <= P.duration; s += step) { const x = s * pps; tctx.fillRect(x, 0, 1, s % (step * 2) ? 5 : 9); if (!(s % (step * 2))) tctx.fillText(fmt(s).replace(/\.\d+$/, ""), x + 3, 1); }
  PGS.forEach((p, pi) => {
    tctx.fillStyle = pi % 2 ? "#1c2230" : "#211c2a"; tctx.fillRect(p.start * pps, 18, (p.end - p.start) * pps, 70);
    for (let i = p.i0; i <= p.i1; i++) {
      const w = P.words[i], x = w.start * pps, ww = Math.max(2, (w.end - w.start) * pps);
      tctx.fillStyle = i === SEL ? "#3b82f6" : w.hl === 1 ? "#1f7a45" : w.hl === 2 ? "#8a2a3a" : "#3a4150";
      tctx.beginPath(); tctx.roundRect(x, 30, ww - 1, 42, 5); tctx.fill();
      tctx.fillStyle = "#e9ebf0"; tctx.font = "600 11px system-ui"; tctx.textBaseline = "middle";
      tctx.save(); tctx.beginPath(); tctx.rect(x, 30, ww - 1, 42); tctx.clip(); tctx.fillText(w.text, x + 4, 51); tctx.restore();
    }
  });
  drawPlayhead();
}
let phEl = null;
function drawPlayhead() {
  if (!phEl) { phEl = document.createElement("div"); phEl.style.cssText = "position:absolute;top:0;bottom:0;width:2px;background:#ff8a1f;pointer-events:none"; tlWrap.appendChild(phEl); }
  const x = video.currentTime * pps; phEl.style.left = x + "px";
  if (!video.paused && (x < tlWrap.scrollLeft || x > tlWrap.scrollLeft + tlWrap.clientWidth - 40)) tlWrap.scrollLeft = x - 60;
}
let tdrag = null;
tl.addEventListener("pointerdown", e => {
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, t = x / pps;
  let hit = -1, edge = null;
  if (y >= 30 && y <= 72) P.words.forEach((w, i) => {
    const x0 = w.start * pps, x1 = w.end * pps;
    if (x >= x0 - 4 && x <= x1 + 4) { hit = i; edge = x - x0 < 6 ? "start" : x1 - x < 6 ? "end" : "move"; }
  });
  if (hit < 0) { video.currentTime = t; return; }
  select(hit, false); video.pause(); video.currentTime = P.words[hit].start + 0.01;
  tdrag = { i: hit, edge, x, s: P.words[hit].start, e: P.words[hit].end }; tl.setPointerCapture(e.pointerId);
});
tl.addEventListener("pointermove", e => {
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left;
  if (!tdrag) { let cur = "default"; P && P.words.forEach(w => { const x0 = w.start * pps, x1 = w.end * pps; if (Math.abs(x - x0) < 6 || Math.abs(x - x1) < 6) cur = "ew-resize"; }); tl.style.cursor = cur; return; }
  const dt = (x - tdrag.x) / pps, w = P.words[tdrag.i], prev = P.words[tdrag.i - 1], next = P.words[tdrag.i + 1];
  const lo = prev ? prev.end : 0, hi = next ? next.start : P.duration;
  if (tdrag.edge === "start") w.start = Math.min(tdrag.e - 0.04, Math.max(lo, tdrag.s + dt));
  else if (tdrag.edge === "end") w.end = Math.max(tdrag.s + 0.04, Math.min(hi, tdrag.e + dt));
  else { const d = Math.max(lo - tdrag.s, Math.min(hi - tdrag.e, dt)); w.start = tdrag.s + d; w.end = tdrag.e + d; }
  w.start = +w.start.toFixed(3); w.end = +w.end.toFixed(3);
  PGS = DC.pages(P.words); drawTimeline(); video.currentTime = w.start + 0.01; renderInspector();
});
tl.addEventListener("pointerup", () => { if (tdrag) { tdrag = null; changed(); } });

// ======================================================= STYLE PANEL
const FORM = [
  ["Text", [
    ["font", "Font", "font"], ["size", "Size", "range", 30, 200, 1], ["uppercase", "UPPERCASE", "check"],
    ["lineHeight", "Line height", "range", 0.8, 1.6, 0.01], ["maxWidth", "Max width", "range", 0.4, 1, 0.01],
    ["posY", "Position Y", "range", 0.05, 0.95, 0.005], ["stripPunct", "Hide punctuation", "check"],
    ["blend", "Negative text", "select", ["normal", "difference"]],
  ]],
  ["Accent font", [
    ["emphFont", "Emphasis font", "emphfont"], ["emphScale", "Emphasis size", "range", 0.6, 3, 0.05],
    ["emphAuto", "Auto accent", "select", ["", "longest"]],
  ]],
  ["Colours", [
    ["textColor", "Text", "color"], ["activeColor", "Active word", "color"], ["emph1", "Emphasis 1", "color"], ["emph2", "Emphasis 2", "color"],
  ]],
  ["Highlight", [
    ["highlight", "Active word", "select", ["color", "box", "none"]], ["boxColor", "Box colour", "color"], ["boxTextColor", "Box text", "color"],
    ["boxRadius", "Box radius", "range", 0, 40, 1], ["boxPad", "Box padding", "range", 0, 40, 1],
  ]],
  ["Outline & shadow", [
    ["stroke", "Stroke", "range", 0, 24, 1], ["strokeColor", "Stroke colour", "color"],
    ["shadowOpacity", "Shadow", "range", 0, 1, 0.01], ["shadowBlur", "Blur", "range", 0, 40, 1], ["shadowY", "Offset Y", "range", -20, 30, 1], ["shadowColor", "Shadow colour", "color"],
    ["pageBg", "Background bar", "check"], ["pageBgColor", "Bar colour", "color"], ["pageBgOpacity", "Bar opacity", "range", 0, 1, 0.01],
  ]],
  ["Animation", [
    ["mode", "Mode", "select", ["page", "reveal", "dim"]], ["pageAnim", "Line in", "select", ["pop", "bounce", "slide", "fade", "none"]],
    ["wordAnim", "Word anim", "select", ["pop", "rise", "none"]], ["activeScale", "Pop scale", "range", 1, 1.5, 0.01], ["emoji", "Show emoji", "check"],
  ]],
  ["Grouping", [
    ["wordsPerPage", "Words / line", "range", 1, 10, 1], ["maxChars", "Max chars", "range", 6, 50, 1],
  ]],
];
function buildPresetGrid() {
  const g = $("#presetGrid"); g.innerHTML = "";
  for (const p of PRESETS.presets) {
    const st = { ...PRESETS.base, ...p.style }, d = document.createElement("div");
    d.className = "preset" + (P.preset === p.id ? " on" : "");
    DC.loadFont(st.font).then(() => { b.style.fontFamily = `"${st.font}"`; }).catch(() => {});
    const b = document.createElement("b");
    b.textContent = st.uppercase ? "BHAI SUNO" : "Bhai suno";
    b.style.color = st.textColor; if (st.stroke) { b.style.webkitTextStroke = "3px " + st.strokeColor; b.style.paintOrder = "stroke fill"; }
    b.innerHTML = st.uppercase ? `BHAI <span>SUNO</span>` : `Bhai <span>suno</span>`;
    const sp = b.querySelector("span");
    if (st.highlight === "box") { sp.style.background = st.boxColor; sp.style.borderRadius = "4px"; sp.style.padding = "0 3px"; sp.style.color = st.boxTextColor; }
    else if (st.highlight === "color") sp.style.color = st.activeColor;
    d.appendChild(b); d.append(p.name);
    d.onclick = () => applyPreset(p);
    g.appendChild(d);
  }
}
async function applyPreset(p) {
  const old = P.style, st = { ...PRESETS.base, ...p.style };
  st.posY = p.style.posY ?? old.posY; // keep the user's placement unless preset needs its own
  P.style = st; P.preset = p.id;
  await DC.loadStyleFonts(st);
  if (old.wordsPerPage !== st.wordsPerPage || old.maxChars !== st.maxChars) { DC.regroup(P.words, st); toast("Lines re-grouped for this preset"); }
  refreshAll(); save();
}
function buildStyleForm() {
  const f = $("#styleForm"); f.innerHTML = "";
  for (const [title, fields] of FORM) {
    const grp = document.createElement("div"); grp.className = "grp"; grp.innerHTML = `<h4>${title}</h4>`;
    for (const [k, label, type, a, b, step] of fields) {
      const row = document.createElement("div"); row.className = "fld" + (type === "check" ? " check" : ""); row.dataset.k = k;
      let input;
      if (type === "range") { input = document.createElement("input"); input.type = "range"; input.min = a; input.max = b; input.step = step; }
      else if (type === "color") { input = document.createElement("input"); input.type = "color"; }
      else if (type === "check") { input = document.createElement("input"); input.type = "checkbox"; input.style.justifySelf = "start"; }
      else {
        input = document.createElement("select");
        const opts = type === "font" ? PRESETS.fonts : type === "emphfont" ? ["", ...PRESETS.fonts] : a;
        for (const o of opts) input.add(new Option(o === "" ? "— none —" : o === "difference" ? "negative (difference)" : o === "longest" ? "longest word" : o.replace(/-Regular$/, ""), o));
      }
      row.innerHTML = `<span>${label}</span>`; row.appendChild(input);
      if (type === "range") { const v = document.createElement("span"); v.className = "v"; row.appendChild(v); }
      input.addEventListener("input", async () => {
        let v = type === "check" ? input.checked : type === "range" ? +input.value : input.value;
        P.style[k] = v; P.preset = null;
        if (k === "font" || k === "emphFont") await DC.loadFont(v).catch(() => {});
        if (k === "wordsPerPage" || k === "maxChars") { DC.regroup(P.words, P.style); changed(); }
        syncForm(k); drawOverlay(); save();
        document.querySelectorAll(".preset.on").forEach(e => e.classList.remove("on"));
      });
      grp.appendChild(row);
    }
    f.appendChild(grp);
  }
  FORM.forEach(([, fs]) => fs.forEach(([k]) => syncForm(k)));
}
function syncForm(k) {
  const row = document.querySelector(`.fld[data-k="${k}"]`); if (!row) return;
  const input = row.querySelector("input,select"), v = P.style[k];
  if (input.type === "checkbox") input.checked = !!v; else input.value = v;
  const lab = row.querySelector(".v"); if (lab) lab.textContent = typeof v === "number" ? (Math.abs(v) < 2 && v % 1 ? v.toFixed(2) : v) : "";
}

// ======================================================= JOBS
function jobUI(show, msg, f) {
  $("#jobBox").classList.toggle("hidden", !show);
  if (show) { $("#jobMsg").textContent = msg; $("#jobBar").style.width = Math.round((f || 0) * 100) + "%"; }
}
async function runJob(url, body, label) {
  let j = await api(url, { method: "POST", body: body || {} });
  jobUI(true, label, 0);
  while (!j.done) { await new Promise(r => setTimeout(r, 700)); j = await api("/api/job/" + j.id); jobUI(true, `${label} — ${j.msg} (${Math.round(j.progress * 100)}%)`, j.progress); }
  jobUI(false);
  if (j.error) throw new Error(j.error);
  return j.result;
}
let ENGINES = {};
async function loadEngines() {
  ENGINES = await api("/api/engines");
  const sel = $("#engineSel"), cur = sel.value; sel.innerHTML = "";
  for (const [k, v] of Object.entries(ENGINES)) sel.add(new Option(v.label + (v.ready ? "" : ` (download ${v.size_mb} MB)`), k));
  if (cur) sel.value = cur;
}
async function transcribe() {
  if (P.words.length && !confirm("Replace the current transcript?")) return;
  const eng = ENGINES[$("#engineSel").value];
  if (eng && !eng.ready) {
    if (!eng.downloadable) return toast("The Hinglish model is missing - please reinstall DesiCaps.", true, 0);
    if (!confirm(`This engine needs a one-time ${eng.size_mb} MB download. Download now?`)) return;
    try { await runJob(`/api/engines/${$("#engineSel").value}/download`, {}, "⬇ Model"); await loadEngines(); }
    catch (e) { return toast("Download failed (are you online?): " + esc(e.message), true, 0); }
  }
  try {
    const r = await runJob(`/api/project/${P.id}/transcribe`, { engine: $("#engineSel").value, vocab: $("#vocabInput").value }, "🎙 Transcribing");
    P = await api("/api/project/" + P.id); SEL = -1; refreshAll(); snapshot(true); toast(`Done — ${r.words} words. Double-click any word to fix it.`);
  } catch (e) { toast("Transcription failed: " + esc(e.message), true, 0); }
}
$("#transcribeBtn").onclick = transcribe; $("#emptyTranscribe").onclick = transcribe;
$("#enhanceBtn").onclick = async () => {
  if (!P.words.length) return toast("Transcribe first", true);
  const model = $("#ollamaSel").value;
  if (!model) return showAiSetup();
  flushSave();
  try {
    await runJob(`/api/project/${P.id}/enhance`, { model }, "✨ AI styling");
    P = await api("/api/project/" + P.id); refreshAll(); toast("Emphasis + emoji added. Tweak anything you don't like.");
  } catch (e) { toast(esc(e.message), true, 0); }
};
$("#exportBtn").onclick = e => { e.stopPropagation(); $("#exportMenu").classList.toggle("open"); };
document.addEventListener("click", () => $("#exportMenu").classList.remove("open"));
$("#exportMenu").addEventListener("click", async e => {
  const k = e.target.dataset.exp; if (!k) return;
  flushSave(); await new Promise(r => setTimeout(r, 200));
  try {
    let r;
    if (k === "mp4") r = await runJob(`/api/project/${P.id}/render`, {}, "🎬 Rendering");
    if (k === "ae") r = await api(`/api/project/${P.id}/ae`, { method: "POST", body: {} });
    if (k === "srt") r = await api(`/api/project/${P.id}/srt`);
    if (k === "fonts") { const f = await api("/api/install_fonts", { method: "POST", body: {} }); return toast(`Installed ${f.installed.length} fonts. Restart After Effects to see them.`); }
    if (k === "folder") return api("/api/reveal", { method: "POST", body: {} });
    const hint = k === "ae" ? "<br>In After Effects: <b>File → Scripts → Run Script File…</b> and pick it." : "";
    toast(`Saved: <a href="#" id="revealLink">${esc(r.path)}</a>${hint}`, false, 12000);
    $("#revealLink").onclick = ev => { ev.preventDefault(); api("/api/reveal", { method: "POST", body: { path: r.path } }); };
  } catch (err) { toast(esc(err.message), true, 0); }
});

// ======================================================= BOOT
(async () => {
  PRESETS = await api("/api/presets");
  await loadEngines();
  const models = await api("/api/ollama/models").catch(() => []);
  $("#ollamaSel").add(new Option(models.length ? "AI: " + models[0] : "AI: not set up", models[0] || ""));
  models.slice(1).forEach(m => $("#ollamaSel").add(new Option("AI: " + m, m)));
  $("#ollamaSel").addEventListener("change", e => { if (!e.target.value) showAiSetup(); });
  const hh = await api("/api/health").catch(() => ({}));
  $("#versionLbl").textContent = hh.version ? "DesiCaps v" + hh.version : "";
  if (HAS_NATIVE()) $("#pathRow").classList.add("hidden");
  window.addEventListener("pywebviewready", () => $("#pathRow").classList.add("hidden"));
  showHome();
})();

// ======================================================= FIND & REPLACE
const norm = s => s.toLowerCase().replace(/[.,!?;:"'“”‘’]+/g, "");
function findMatches() {
  const q = $("#findIn").value.trim();
  document.querySelectorAll(".chip.match").forEach(c => c.classList.remove("match"));
  if (!q || !P) return [];
  const parts = q.split(/\s+/).map(norm), hits = [];
  for (let i = 0; i + parts.length <= P.words.length; i++)
    if (parts.every((p, k) => norm(P.words[i + k].text) === p)) hits.push(i);
  hits.forEach(i => parts.forEach((_, k) => { const c = document.querySelector(`.chip[data-i="${i + k}"]`); if (c) c.classList.add("match"); }));
  return hits;
}
$("#findIn").addEventListener("input", () => { const n = findMatches().length; $("#replBtn").textContent = n ? `Replace ${n}` : "Replace all"; });
$("#replBtn").onclick = () => {
  const q = $("#findIn").value.trim(), r = $("#replIn").value.trim(); if (!q) return;
  const n = q.split(/\s+/).length, hits = findMatches(); if (!hits.length) return toast("No matches", true, 1500);
  for (const i of hits.reverse()) {
    const ws = P.words.slice(i, i + n), start = ws[0].start, end = ws[ws.length - 1].end;
    const trail = (ws[ws.length - 1].text.match(/[.,!?।]+$/) || [""])[0];
    const parts = r ? r.split(/\s+/) : [];
    if (!parts.length) { if (ws[0].brk && P.words[i + n]) P.words[i + n].brk = true; P.words.splice(i, n); continue; }
    const tot = parts.reduce((a, b) => a + b.length, 0); let cur = start;
    const nw = parts.map((t, k) => { const d = (end - start) * t.length / tot; const o = { text: t + (k === parts.length - 1 ? trail : ""), start: +cur.toFixed(3), end: +(cur + d).toFixed(3) }; if (k === 0) { o.brk = ws[0].brk; o.hl = ws[0].hl; o.emoji = ws[0].emoji; } cur += d; return o; });
    P.words.splice(i, n, ...nw);
  }
  toast(`Replaced ${hits.length}×`); $("#replBtn").textContent = "Replace all"; changed();
};
(async () => {
  const h = await api("/api/health").catch(() => ({ raqm: true }));
  $("#engineSel").addEventListener("change", e => {
    if (e.target.value === "devanagari" && !h.raqm) toast("Hindi text shaping isn't available on this system, so Devanagari may render imperfectly in MP4s.", true, 8000);
  });
})();

// ======================================================= POST KIT
function copyText(t) {
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("Copied", false, 1000))
    .catch(() => { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("Copied", false, 1000); });
}
function showKit(kit) {
  const b = $("#kitBody"); b.innerHTML = ""; $("#kitModel").textContent = kit.model ? "· " + kit.model : "";
  const sec = (title, items, allText) => {
    const d = document.createElement("div"); d.className = "kit-sec";
    d.innerHTML = `<h4>${title}</h4>`;
    if (allText !== undefined) { const c = document.createElement("button"); c.className = "mini"; c.textContent = "Copy"; c.onclick = () => copyText(allText); d.firstChild.appendChild(c); }
    for (const it of items) {
      if (!it) continue;
      const row = document.createElement("div"); row.className = "kit-item";
      row.innerHTML = `<span>${esc(it)}</span>`;
      const cp = document.createElement("button"); cp.className = "mini use"; cp.textContent = "Copy"; cp.onclick = () => copyText(it); row.appendChild(cp);
      d.appendChild(row);
    }
    b.appendChild(d);
  };
  sec("Hook options", kit.hooks || []);
  sec("Instagram caption", [kit.instagram]);
  sec("YouTube title", [kit.youtube_title]);
  sec("YouTube description", [kit.youtube_description]);
  sec("Shorts title", [kit.shorts_title]);
  sec("Hashtags", [(kit.hashtags || []).join(" ")]);
  sec("Summary", [kit.summary]);
  $("#kitModal").classList.remove("hidden");
}
async function makeKit() {
  if (!P.words.length) return toast("Transcribe first", true);
  const model = $("#ollamaSel").value;
  if (!model) return showAiSetup();
  flushSave();
  try { const r = await runJob(`/api/project/${P.id}/postkit`, { model }, "📣 Writing post kit"); P.postkit = r.kit; showKit(r.kit); }
  catch (e) { toast(esc(e.message), true, 0); }
}
$("#kitBtn").onclick = () => (P && P.postkit ? showKit(P.postkit) : makeKit());
$("#kitRegen").onclick = () => { $("#kitModal").classList.add("hidden"); makeKit(); };
$("#kitClose").onclick = () => $("#kitModal").classList.add("hidden");
$("#kitModal").addEventListener("click", e => { if (e.target.id === "kitModal") $("#kitModal").classList.add("hidden"); });

// ======================================================= LOCAL AI SETUP (Ollama)
async function refreshAiModels() {
  const st = await api("/api/ollama/status");
  const sel = $("#ollamaSel"); sel.innerHTML = "";
  if (st.models.length) st.models.forEach(m => sel.add(new Option("AI: " + m, m)));
  else sel.add(new Option("AI: not set up", ""));
  return st;
}
async function showAiSetup() {
  const st = await refreshAiModels();
  const has = st.models.length > 0;
  $("#aiBody").innerHTML = `
    <p class="muted" style="margin-top:0">AI Style (auto emphasis + emoji) and Post kit (hooks, captions, hashtags) run on a free local AI called Ollama.
    Captions, editing and export work without it.</p>
    <div class="step ${st.running ? "ok" : ""}"><div class="n">${st.running ? "✓" : "1"}</div><div>
      <b>Install Ollama</b><p>${st.running ? "Ollama is running (v" + esc(st.version || "") + ")." : "Free app from ollama.com - install it, then come back here."}</p>
      ${st.running ? "" : '<button class="btn" id="getOllama">Get Ollama ↗</button> <button class="btn ghost" id="aiRecheck">I installed it - check again</button>'}
    </div></div>
    <div class="step ${has ? "ok" : ""}"><div class="n">${has ? "✓" : "2"}</div><div>
      <b>Download the AI model</b><p>${has ? "Ready: " + esc(st.models.join(", ")) : "Gemma 3 12B - about 8 GB, one time. Best on 12 GB+ GPUs or 16 GB+ Macs."}</p>
      ${st.running && !has ? '<button class="btn primary" id="pullGemma">Download Gemma 3 12B</button> <button class="btn ghost" id="pullSmall">Smaller: Gemma 3 4B (3 GB)</button>' : ""}
    </div></div>`;
  $("#aiModal").classList.remove("hidden");
  const g = $("#getOllama"); if (g) g.onclick = () => openExternal("https://ollama.com/download");
  const rc = $("#aiRecheck"); if (rc) rc.onclick = showAiSetup;
  const pull = async m => {
    $("#aiModal").classList.add("hidden");
    try { await runJob("/api/ollama/pull", { model: m }, "⬇ " + m); toast("AI model ready ✨"); }
    catch (e) { toast("Download failed: " + esc(e.message), true, 0); }
    showAiSetup();
  };
  const p1 = $("#pullGemma"); if (p1) p1.onclick = () => pull("gemma3:12b");
  const p2 = $("#pullSmall"); if (p2) p2.onclick = () => pull("gemma3:4b");
}
$("#aiSetupBtn").onclick = showAiSetup;
$("#aiClose").onclick = () => $("#aiModal").classList.add("hidden");

// Premiere Pro panel -> "Edit words in DesiCaps": open the requested project here.
setInterval(async () => {
  try {
    const r = await fetch("/api/ui/pending").then(x => x.json());
    if (r && r.open) { await openProject(r.open); toast("Opened from Premiere Pro — edit words, then click Update in the panel"); }
  } catch (e) { /* app starting / offline */ }
}, 1500);

$("#premiereBtn").onclick = async () => {
  try {
    await api("/api/install_premiere", { method: "POST", body: {} });
    toast("Premiere Pro panel installed ✔ Restart Premiere, then open <b>Window → Extensions → DesiCaps</b>. Keep this app open while you use it.", false, 12000);
  } catch (e) { toast("Couldn't install the panel: " + esc(e.message), true, 0); }
};
