// DesiCaps for Android — UI logic. Native work (video import, speech-to-text, export) happens in Kotlin
// via window.Android; results come back through window.__native(json).
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const A = window.Android;

const WORD_POP = 0.14, EMOJI_POP = 0.25;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

let PRESETS = null;     // presets.json
let P = null;           // current project
let PGS = [];           // caption pages
let ENGINES = {};
let engineId = store.get("dc_engine", "hinglish");
let downloading = {};   // id -> {got,total}
let busyKind = null;    // "transcribe" | "export" | "import"
let lastExportUri = null;
let SEL = -1;           // selected word index

// ---------------------------------------------------------------- helpers
function toast(msg, err = false, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg; t.classList.toggle("err", err); t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
const fmtT = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
const emojiUrl = c => `/emoji/${c}.png`;
const clone = o => JSON.parse(JSON.stringify(o));

function showBusy(kind, msg, cancellable = true) {
  busyKind = kind;
  $("#busyMsg").textContent = msg; $("#busySub").textContent = ""; $("#busyBar").style.width = "0%";
  $("#busyCancel").classList.toggle("hidden", !cancellable);
  $("#busy").classList.remove("hidden");
}
function setBusy(frac, msg, sub) {
  if (msg) $("#busyMsg").textContent = msg;
  if (sub !== undefined) $("#busySub").textContent = sub;
  $("#busyBar").style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}
function hideBusy() { busyKind = null; $("#busy").classList.add("hidden"); }

function openSheet(id) { $$(".sheet").forEach(s => s.classList.add("hidden")); $("#scrim").classList.remove("hidden"); $(id).classList.remove("hidden"); }
function closeSheets() { $$(".sheet").forEach(s => s.classList.add("hidden")); $("#scrim").classList.add("hidden"); if (document.activeElement) document.activeElement.blur(); }
const sheetOpen = () => $$(".sheet").some(s => !s.classList.contains("hidden"));

function styleFor(presetId) {
  const st = clone(PRESETS.base);
  const p = PRESETS.presets.find(x => x.id === presetId);
  if (p) Object.assign(st, p.style);
  return st;
}
const MAXCH = { 1: 12, 2: 14, 3: 18, 4: 22, 5: 26, 6: 32, 7: 38 };

function saveSoon() { clearTimeout(saveSoon._t); saveSoon._t = setTimeout(() => P && store.set("dc_proj", P), 400); }
function restructure() { if (!P) return; DC.regroup(P.words, P.style); PGS = DC.pages(P.words); }

// ---------------------------------------------------------------- whisper output -> words (port of transcribe.py)
const SPECIAL = /^\[_|^<\||^\[\w+\]$/;
function wordsFromWhisper(data) {
  const words = []; let cur = null;
  for (const seg of data.transcription || []) {
    for (const tok of seg.tokens || []) {
      const txt = tok.text || "";
      if (!txt || SPECIAL.test(txt.trim())) continue;
      const off = tok.offsets;
      const prevEnd = cur ? cur.end : (words.length ? words[words.length - 1].end : ((seg.offsets || {}).from || 0) / 1000);
      let t0, t1;
      if (off) { t0 = (off.from || 0) / 1000; t1 = (off.to || 0) / 1000; } else { t0 = t1 = prevEnd; }
      const dtw = tok.t_dtw;
      if (typeof dtw === "number" && dtw >= 0) t0 = dtw / 100;
      if (txt.startsWith(" ") || cur === null) {
        if (cur && cur.text.trim()) words.push(cur);
        cur = { text: txt.trim(), start: t0, end: Math.max(t1, t0) };
      } else {
        cur.text += txt; cur.end = Math.max(cur.end, t1);
      }
    }
    if (cur && cur.text.trim()) words.push(cur);
    cur = null;
  }
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (b.start - a.start > 0 && b.start - a.start < 2) a.end = Math.min(Math.max(a.end, a.start + 0.08), b.start);
  }
  return words.filter(w => w.text);
}
function collapseLoops(words, maxRepeat = 3) {
  const out = [];
  for (const w of words) {
    const k = out.length;
    if (k >= maxRepeat && out.slice(k - maxRepeat).every(o => o.text.toLowerCase() === w.text.toLowerCase())) {
      out[k - 1].end = Math.max(out[k - 1].end, w.end); continue;
    }
    out.push(w);
  }
  return out;
}
function fixTimings(words, total) {
  const out = [];
  for (const w of words) {
    let s = +w.start, e = +w.end;
    if (!w.text.trim() || isNaN(s) || (total && s >= total - 0.02)) continue;
    if (isNaN(e) || e < s) e = s + 0.25;
    s = Math.max(0, s);
    if (out.length && s < out[out.length - 1].start + 0.04) s = out[out.length - 1].start + 0.04;
    e = Math.max(e, s + 0.08);
    if (out.length && out[out.length - 1].end > s) out[out.length - 1].end = s;
    out.push({ text: w.text, start: +s.toFixed(3), end: +(total ? Math.min(e, total) : e).toFixed(3) });
  }
  return out;
}
const norm = t => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function similarity(a, b) {  // 2*LCS/(|a|+|b|), close to difflib's ratio for short words
  const m = a.length, n = b.length; if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return 2 * dp[m][n] / (m + n);
}
function applyVocab(words, vocab) {
  const terms = vocab.split(/[,\n;]/).map(t => t.trim()).filter(Boolean);
  for (const term of terms) {
    const tw = term.split(/\s+/), n = tw.length, target = norm(tw.join(""));
    if (target.length < 3) continue;
    for (let i = 0; i + n <= words.length; i++) {
      const win = words.slice(i, i + n), cand = norm(win.map(w => w.text).join(""));
      if (!cand || cand === target || cand[0] !== target[0]) continue;
      if (similarity(cand, target) >= 0.66) win.forEach((w, k) => {
        const trail = (w.text.match(/[.,!?।]+$/) || [""])[0];
        w.text = tw[k] + trail;
      });
    }
  }
  return words;
}

// ---------------------------------------------------------------- auto emoji & highlights (no AI needed)
const EMOJI_RULES = [
  [/^(paisa|paise|paison|money|rupaye|rupees?|crore|lakh|kamai|salary|income|cash)$/, "1f4b0"],
  [/^(pyaar|pyar|love|dil|mohabbat|ishq)$/, "2764"],
  [/^(fire|aag|garda|zabardast|kamaal|kamal|mast|badhiya|jhakaas|lit|awesome|amazing)$/, "1f525"],
  [/^(haha|hahaha|funny|hasi|hansi|mazaa|maza|mazak|comedy|lol)$/, "1f602"],
  [/^(dimaag|dimag|brain|smart|genius|soch|sochna|socho)$/, "1f9e0"],
  [/^(idea|tip|tips|trick|hack|jugaad)$/, "1f4a1"],
  [/^(time|samay|waqt|jaldi|late|deadline)$/, "23f0"],
  [/^(phone|mobile|iphone|android|app)$/, "1f4f1"],
  [/^(gaadi|gadi|car|bike)$/, "1f697"],
  [/^(ghar|home|house|flat)$/, "1f3e0"],
  [/^(gussa|angry|naraz|pagal)$/, "1f621"],
  [/^(darr|dar|scary|shock|shocking|omg|horror)$/, "1f631"],
  [/^(sach|sachchi|truth|real|100)$/, "1f4af"],
  [/^(jeet|jeeta|win|winner|success|safal|champion)$/, "1f3c6"],
  [/^(party|celebrate|celebration|shaadi|birthday)$/, "1f389"],
  [/^(galti|galat|mistake|wrong|fail|fake)$/, "274c"],
  [/^(sahi|correct|right|done|perfect)$/, "2705"],
  [/^(india|bharat|desi|hindustan)$/, "1f1ee-1f1f3"],
  [/^(gift|free|offer)$/, "1f381"],
  [/^(music|gaana|song|gana)$/, "1f3b5"],
  [/^(video|camera|shoot|reel|reels|youtube)$/, "1f3a5"],
  [/^(target|goal|focus|lakshya)$/, "1f3af"],
  [/^(king|raja|boss|queen|rani)$/, "1f451"],
  [/^(dekho|dekh|look|watch|dekhiye)$/, "1f440"],
  [/^(power|strong|gym|mehnat|hardwork|strength)$/, "1f4aa"],
  [/^(growth|grow|badhna|profit|up)$/, "1f4c8"],
  [/^(loss|nuksaan|nuksan|down|crash)$/, "1f4c9"],
  [/^(laptop|computer|coding|code|ai)$/, "1f4bb"],
  [/^(rocket|launch|viral|fast|tez)$/, "1f680"],
  [/^(warning|dhyan|savdhan|careful|danger|khatra)$/, "26a0"],
  [/^(secret|raaz|chupke)$/, "1f92b"],
  [/^(crazy|unbelievable|mindblowing|insane)$/, "1f92f"],
  [/^(thanks|thank|shukriya|dhanyavaad|please)$/, "1f64f"],
  [/^(kyun|kyu|why|kaise|how)$/, "1f914"],
  [/^(khatam|dead|rip)$/, "1f480"],
  [/^(dosti|dost|friend|friends|bhai|partner)$/, "1f91d"],
  [/^(star|famous|celebrity)$/, "2b50"],
  [/^(flight|travel|trip|safar)$/, "2708"],
];
const POS_HL = /^(\d[\d,.]*%?|₹\d.*|sabse|best|free|zabardast|kamaal|double|triple|sach|pakka|guaranteed|secret|important|zaroori|asli|profit|jeet|win|viral|crore|lakh|lakhs|million|billion)$/;
const NEG_HL = /^(nahi|nahin|never|kabhi|galti|galat|mistake|wrong|problem|loss|band|mat|stop|danger|khatra|fake|fail)$/;

function autoFx() {
  if (!P) return;
  restructure();
  let lastEmojiAt = -99;
  for (const pg of PGS) {
    let emo = null, hl = null;
    for (let i = pg.i0; i <= pg.i1; i++) {
      const w = P.words[i], k = norm(w.text);
      if (!k) continue;
      if (!emo) for (const [re, code] of EMOJI_RULES) if (re.test(k)) { emo = [i, code]; break; }
      if (!hl) { if (POS_HL.test(k)) hl = [i, 1]; else if (NEG_HL.test(k)) hl = [i, 2]; }
    }
    for (let i = pg.i0; i <= pg.i1; i++) { delete P.words[i].emoji; delete P.words[i].hl; }
    if (emo && P.words[emo[0]].start - lastEmojiAt > 2.5) { P.words[emo[0]].emoji = emo[1]; lastEmojiAt = P.words[emo[0]].start; }
    if (hl) P.words[hl[0]].hl = hl[1];
  }
  changed();
  const n = P.words.filter(w => w.emoji).length, h = P.words.filter(w => w.hl).length;
  toast(n || h ? `Added ${n} emoji and ${h} highlights` : "No matching words found — tap words to add your own");
}

// ---------------------------------------------------------------- home
function refreshHome() {
  $("#versionLbl").textContent = A && A.version ? `v${A.version()}` : "";
  refreshEngines();
  const saved = store.get("dc_proj", null);
  const ok = saved && saved.words && saved.words.length && A.hasVideo(saved.file);
  $("#resumeCard").classList.toggle("hidden", !ok);
  if (ok) {
    $("#resumeName").textContent = saved.name || "Last video";
    $("#resumeMeta").textContent = `${saved.words.length} words · ${fmtT(saved.video.duration)}`;
  }
}
function refreshEngines() {
  try { ENGINES = JSON.parse(A.engines()); } catch (e) { ENGINES = {}; }
  if (!ENGINES[engineId] || !ENGINES[engineId].ready) engineId = "hinglish";
  $("#modelName").textContent = ENGINES[engineId] ? ENGINES[engineId].label : "Hinglish · Fast";
  renderModelList();
}
function renderModelList() {
  const box = $("#modelList"); box.innerHTML = "";
  for (const [id, e] of Object.entries(ENGINES)) {
    const d = downloading[id];
    const el = document.createElement("div");
    el.className = "model" + (id === engineId ? " sel" : "");
    let right = "";
    if (d) right = `<button class="btn small ghost" data-act="cancel">Stop</button>`;
    else if (!e.ready) right = `<button class="btn small" data-act="dl">Download · ${e.sizeMb} MB</button>`;
    else if (!e.builtIn) right = `<button class="btn small ghost danger" data-act="del">Delete</button>`;
    el.innerHTML = `<div class="radio"></div><div class="grow"><div class="card-title">${e.label}</div>
      <div class="muted small">${e.note}${e.builtIn ? "" : ` · ${e.sizeMb} MB`}</div>
      ${d ? `<div class="bar-track"><div class="bar-fill" style="width:${d.total ? Math.round(100 * d.got / d.total) : 3}%"></div></div>
             <div class="muted small">${(d.got / 1048576).toFixed(0)} / ${d.total ? (d.total / 1048576).toFixed(0) : "?"} MB</div>` : ""}
      </div>${right}`;
    el.onclick = ev => {
      const act = ev.target.dataset && ev.target.dataset.act;
      if (act === "dl") { downloading[id] = { got: 0, total: e.sizeMb * 1048576 }; A.downloadModel(id); renderModelList(); return; }
      if (act === "cancel") { A.cancelDownload(); return; }
      if (act === "del") { A.deleteModel(id); if (engineId === id) engineId = "hinglish"; store.set("dc_engine", engineId); refreshEngines(); return; }
      if (!e.ready) { toast("Download this model first"); return; }
      engineId = id; store.set("dc_engine", id); refreshEngines();
    };
    box.appendChild(el);
  }
  if (P && !$("#editor").classList.contains("hidden")) {
    const b = document.createElement("button");
    b.className = "btn primary wide mt"; b.style.width = "100%";
    b.textContent = "Redo captions with this model";
    b.onclick = () => { closeSheets(); startTranscribe(); };
    box.appendChild(b);
  }
  $("#cpuLbl").textContent = A.cpu ? `Engine: ${A.cpu()}` : "";
}

// ---------------------------------------------------------------- project lifecycle
function newProject(info) {
  const preset = store.get("dc_preset", "hormozi");
  P = {
    name: info.name || "Video", file: info.file, url: info.url,
    video: { width: info.width || 1080, height: info.height || 1920, duration: info.duration || 0, fps: info.fps || 30 },
    engine: engineId, preset, style: styleFor(preset), words: [],
  };
}
function startTranscribe() {
  if (!P) return;
  P.engine = engineId;
  showBusy("transcribe", "Listening to your video…");
  setBusy(0.01, null, ENGINES[engineId] ? ENGINES[engineId].label : "");
  A.transcribe(P.file, engineId, $("#vocab").value.trim());
}
function onTranscribed(msg) {
  let words = wordsFromWhisper(msg.result || {});
  words = collapseLoops(words);
  const vocab = $("#vocab").value.trim();
  if (vocab) words = applyVocab(words, vocab);
  words = fixTimings(words, P.video.duration || msg.seconds || 0);
  hideBusy();
  if (!words.length) { toast("No speech found in this video", true, 5000); return; }
  P.words = words;
  restructure();
  saveSoon();
  openEditor();
  const sec = (msg.ms / 1000).toFixed(0);
  toast(`${words.length} words in ${sec}s — tap Words to fix anything`);
}

// ---------------------------------------------------------------- editor
const video = $("#video"), overlay = $("#overlay"), octx = overlay.getContext("2d");
let raf = null;

function openEditor() {
  $("#home").classList.add("hidden"); $("#editor").classList.remove("hidden");
  $("#projTitle").textContent = P.name;
  const { width: W, height: H } = P.video;
  $("#stage").style.aspectRatio = `${W} / ${H}`;
  if (video.dataset.src !== P.url) { video.src = P.url; video.dataset.src = P.url; }
  restructure();
  Promise.all([DC.loadFont(P.style.font).catch(() => {})]).then(() => { sizeOverlay(); draw(); });
  buildPresetGrid(); renderWords(); syncAdjust();
  sizeOverlay(); draw();
}
function closeEditor() {
  video.pause();
  $("#editor").classList.add("hidden"); $("#home").classList.remove("hidden");
  refreshHome();
}
function sizeOverlay() {
  const r = overlay.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.max(1, Math.round(r.width * dpr)), ch = Math.max(1, Math.round(r.height * dpr));
  if (overlay.width !== cw || overlay.height !== ch) { overlay.width = cw; overlay.height = ch; }
}
function draw() {
  if (!P) return;
  const W = P.video.width, H = P.video.height;
  octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!P.words.length || !overlay.width) return;
  octx.setTransform(overlay.width / W, 0, 0, overlay.height / H, 0, 0);
  DC.draw(octx, P, video.currentTime, W, H, PGS, () => draw());
  markPlaying(video.currentTime);
}
function loop() { draw(); updateScrub(); raf = video.paused ? null : requestAnimationFrame(loop); }
function updateScrub() {
  const d = video.duration || P.video.duration || 1;
  $("#seek").value = Math.round(1000 * video.currentTime / d);
  $("#tCur").textContent = fmtT(video.currentTime); $("#tDur").textContent = fmtT(d);
}
function changed(structural = true) {
  if (structural) restructure();
  renderWords(); draw(); saveSoon();
}

// --- Style tab
function buildPresetGrid() {
  const g = $("#presetGrid"); g.innerHTML = "";
  for (const p of PRESETS.presets) {
    const b = document.createElement("button");
    b.className = "preset" + (P.preset === p.id ? " active" : "");
    b.innerHTML = `<canvas width="360" height="270"></canvas><span>${p.name}</span>`;
    b.onclick = async () => {
      const keep = { posY: P.style.posY };
      P.preset = p.id; P.style = styleFor(p.id);
      if (P.customPos) P.style.posY = keep.posY;
      store.set("dc_preset", p.id);
      await DC.loadFont(P.style.font).catch(() => {});
      $$(".preset").forEach(x => x.classList.remove("active")); b.classList.add("active");
      changed(); syncAdjust();
    };
    g.appendChild(b);
    drawPresetThumb(b.querySelector("canvas"), p);
  }
}
async function drawPresetThumb(cv, p) {
  const st = styleFor(p.id);
  await DC.loadFont(st.font).catch(() => {});
  const W = 360, H = 270, dev = p.id === "devanagari";
  const text = dev ? ["ये", "ट्रिक", "कमाल"] : ["ye", "trick", "kamaal"];
  const words = text.map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.3 }));
  const s = Object.assign({}, st, { posY: 0.52, size: st.size * 2.1, wordsPerPage: 3, maxChars: 40, maxWidth: 0.92 });
  if (s.mode === "single") { s.wordsPerPage = 1; }
  DC.regroup(words, s);
  const proj = { words, style: s };
  const c = cv.getContext("2d");
  c.clearRect(0, 0, W, H);
  DC.draw(c, proj, s.mode === "single" ? 0.7 : 0.75, W, H, DC.pages(words), () => drawPresetThumb(cv, p));
}

// --- Words tab
function renderWords() {
  const box = $("#wordList"); if (!P) return;
  box.innerHTML = "";
  const frag = document.createDocumentFragment();
  P.words.forEach((w, i) => {
    if (i > 0 && w.brk) { const br = document.createElement("div"); br.className = "br"; frag.appendChild(br); }
    const b = document.createElement("button");
    b.className = "w" + (w.hl === 1 ? " hl1" : w.hl === 2 ? " hl2" : "");
    b.dataset.i = i;
    b.textContent = DC.displayText(w, P.style);
    if (w.emoji) { const im = document.createElement("img"); im.src = emojiUrl(w.emoji); b.appendChild(im); }
    frag.appendChild(b);
  });
  box.appendChild(frag);
}
let lastMark = -2;
function markPlaying(t) {
  if (!P || $("#p-words").classList.contains("hidden")) return;
  let a = -1;
  for (let i = 0; i < P.words.length; i++) { if (P.words[i].start <= t) a = i; else break; }
  if (a >= 0 && t > P.words[a].end + 0.6) a = -1;
  if (a === lastMark) return;
  const prev = $("#wordList .w.now"); if (prev) prev.classList.remove("now");
  lastMark = a;
  if (a >= 0) {
    const el = $(`#wordList .w[data-i="${a}"]`);
    if (el) { el.classList.add("now"); if (!video.paused) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }
}
function openWord(i) {
  if (!P.words[i]) return;
  SEL = i; video.pause();
  const w = P.words[i];
  video.currentTime = Math.max(0, w.start + Math.min(0.3, Math.max(0.02, (w.end - w.start) * 0.7))); draw();
  $("#wText").value = w.text;
  $("#wTime").textContent = `${w.start.toFixed(2)}s`;
  $$("#hlSeg button").forEach(b => b.classList.toggle("on", +b.dataset.hl === (w.hl || 0)));
  $$("#emojiGrid button").forEach(b => b.classList.toggle("on", (b.dataset.code || "") === (w.emoji || "")));
  openSheet("#wordSheet");
}
function commitWord() {
  const w = P.words[SEL]; if (!w) return;
  const t = $("#wText").value.trim();
  if (t && t !== w.text) { w.text = t; changed(); }
}
function buildEmojiGrid() {
  const g = $("#emojiGrid"); g.innerHTML = "";
  const none = document.createElement("button"); none.textContent = "None"; none.dataset.code = ""; g.appendChild(none);
  for (const c of EMOJI_CODES) {
    const b = document.createElement("button"); b.dataset.code = c;
    b.innerHTML = `<img loading="lazy" src="${emojiUrl(c)}" alt="">`; g.appendChild(b);
  }
  g.onclick = e => {
    const b = e.target.closest("button"); if (!b || !P.words[SEL]) return;
    const code = b.dataset.code || undefined;
    if (code) P.words[SEL].emoji = code; else delete P.words[SEL].emoji;
    $$("#emojiGrid button").forEach(x => x.classList.toggle("on", x === b));
    changed(false);
  };
}
const EMOJI_CODES = ["1f525", "1f602", "1f4b0", "2764", "1f631", "1f92f", "1f4af", "1f440", "1f4a1", "1f9e0", "1f680", "1f3c6", "2705", "274c",
  "26a0", "1f914", "1f64f", "1f44d", "1f44f", "1f4aa", "1f60d", "1f60e", "1f62d", "1f621", "1f923", "1f929", "1f973", "1f389", "1f381",
  "1f3af", "1f451", "1f48e", "1f4c8", "1f4c9", "1f4b8", "1f4b5", "23f0", "1f4f1", "1f4bb", "1f697", "2708", "1f3e0", "1f3a5", "1f3b5",
  "1f4e2", "1f6a8", "1f6d1", "1f480", "1f494", "1f91d", "1f92b", "1f605", "1f609", "1f60a", "1f64c", "1f449", "1f447", "1f4dd", "1f4c5",
  "1f511", "1f512", "1f4a5", "26a1", "2728", "2b50", "2753", "2757", "1f1ee-1f1f3"];

// --- Adjust tab
const SWATCHES = ["#FFE500", "#FF9933", "#22E06B", "#3DDCFF", "#00F0FF", "#FF3D5A", "#C084FC", "#FFFFFF"];
function syncAdjust() {
  if (!P) return;
  const st = P.style;
  $("#sizeR").value = st.size; $("#sizeV").textContent = st.size;
  $("#posR").value = st.posY; $("#posV").textContent = Math.round(st.posY * 100) + "%";
  $("#wppR").value = st.wordsPerPage; $("#wppV").textContent = st.wordsPerPage;
  $("#upperT").checked = !!st.uppercase; $("#popT").checked = st.wordAnim !== "none"; $("#emojiT").checked = st.emoji !== false;
  const key = st.highlight === "box" ? "boxColor" : "activeColor";
  $$("#swatches .sw").forEach(s => s.classList.toggle("active", s.dataset.c.toLowerCase() === String(st[key]).toLowerCase()));
}
function buildAdjust() {
  const sw = $("#swatches");
  for (const c of SWATCHES) {
    const b = document.createElement("button"); b.className = "sw"; b.dataset.c = c; b.style.background = c;
    b.onclick = () => { const key = P.style.highlight === "box" ? "boxColor" : "activeColor"; P.style[key] = c; if (P.style.highlight === "none") P.style.highlight = "color"; syncAdjust(); changed(false); };
    sw.appendChild(b);
  }
  $("#sizeR").oninput = e => { P.style.size = +e.target.value; $("#sizeV").textContent = P.style.size; changed(); };
  $("#posR").oninput = e => { P.style.posY = +e.target.value; P.customPos = true; $("#posV").textContent = Math.round(P.style.posY * 100) + "%"; changed(false); };
  $("#wppR").oninput = e => { const n = +e.target.value; P.style.wordsPerPage = n; P.style.maxChars = MAXCH[n] || 22; if (n > 1 && P.style.mode === "single") P.style.mode = "page"; $("#wppV").textContent = n; changed(); };
  $("#upperT").onchange = e => { P.style.uppercase = e.target.checked; changed(); };
  $("#popT").onchange = e => { P.style.wordAnim = e.target.checked ? "pop" : "none"; if (e.target.checked && P.style.pageAnim === "none") P.style.pageAnim = "pop"; changed(); };
  $("#emojiT").onchange = e => { P.style.emoji = e.target.checked; changed(false); };
}

// ---------------------------------------------------------------- export
function outSize() {
  const { width: W, height: H } = P.video, s = Math.min(1, 1080 / Math.min(W, H));
  return [Math.round(W * s / 2) * 2, Math.round(H * s / 2) * 2];
}
function stateKey(t, f, pgs) {
  const st = P.style, words = P.words;
  const pi = pgs.findIndex(p => p.start <= t && t < p.end);
  if (pi < 0) return null;
  const pg = pgs[pi], a = DC.activeIndex(words, pg, t);
  let anim = (st.pageAnim || "pop") !== "none" && (t - pg.start) < DC.PAGE_IN;
  if (a != null && st.wordAnim !== "none" && (t - words[a].start) < WORD_POP) anim = true;
  if (st.emoji !== false) for (let i = pg.i0; i <= pg.i1; i++) {
    if (words[i].emoji && words[i].start <= t + 0.001) { if (t - words[i].start < EMOJI_POP) anim = true; break; }
  }
  return anim ? `${pi}|${a}|${f}` : `${pi}|${a}`;
}
async function exportVideo() {
  if (!P || !P.words.length) { toast("Nothing to export yet"); return; }
  video.pause();
  showBusy("export", "Preparing captions…");
  try {
    const [OW, OH] = outSize();
    await DC.loadFont(P.style.font).catch(() => {});
    await DC.preloadEmoji([...new Set(P.words.map(w => w.emoji).filter(Boolean))]);
    A.beginExport();
    const pgs = DC.pages(P.words);
    const dur = P.video.duration || video.duration || (P.words[P.words.length - 1].end + 1);
    const fps = 30, N = Math.ceil(dur * fps);
    const cv = document.createElement("canvas"); cv.width = OW; cv.height = OH;
    const ctx = cv.getContext("2d");
    const band = document.createElement("canvas"), bctx = band.getContext("2d");
    const times = [], ids = [];
    let prev, nextId = 0, states = 0, lastYield = performance.now();
    for (let f = 0; f <= N; f++) {
      if (busyKind !== "export") return;           // cancelled
      const t = f / fps, key = stateKey(t, f, pgs);
      if (key === prev) continue;
      prev = key;
      let id = -1;
      if (key !== null) {
        id = nextId++;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, OW, OH);
        const pi = DC.draw(ctx, P, t, OW, OH, pgs);
        if (pi < 0) { id = -1; nextId--; times.push(Math.round(t * 1e6)); ids.push(id); continue; }
        const pg = pgs[pi], lay = DC.layout(P.words, pg, P.style, OW, OH);
        const fs = lay.fs;
        const y0 = Math.max(0, Math.floor(lay.box[1] - fs * 2.8)), y1 = Math.min(OH, Math.ceil(lay.box[3] + fs * 1.3));
        const h = Math.max(1, y1 - y0);
        band.width = OW; band.height = h;
        bctx.clearRect(0, 0, OW, h); bctx.drawImage(cv, 0, y0, OW, h, 0, 0, OW, h);
        if (!A.putFrame(id, 0, y0, band.toDataURL("image/png"))) throw new Error("Could not store caption frame");
        states++;
      }
      times.push(Math.round(t * 1e6)); ids.push(id);
      if (performance.now() - lastYield > 120) {
        setBusy(0.3 * f / N, "Preparing captions…", `${states} caption frames`);
        await new Promise(r => setTimeout(r, 0)); lastYield = performance.now();
      }
    }
    setBusy(0.3, "Making your video…", "Using the phone's video encoder");
    A.finishExport(P.file, JSON.stringify({ width: OW, height: OH, fps: P.video.fps || 30, times, ids, name: P.name }));
  } catch (e) {
    hideBusy(); toast("Export failed: " + e.message, true, 6000);
  }
}

// ---------------------------------------------------------------- native events
window.__native = raw => {
  let m; try { m = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return; }
  switch (m.type) {
    case "importing": closeSheets(); showBusy("import", "Opening video…", false); break;
    case "picked": newProject(m); hideBusy(); startTranscribe(); break;
    case "pickCancelled": hideBusy(); break;
    case "pickError": hideBusy(); toast("Couldn't open that video: " + m.message, true, 5000); break;
    case "transcribeProgress": if (busyKind === "transcribe") setBusy(m.progress, m.message === "Listening" ? "Listening to your video…" : m.message + "…"); break;
    case "transcribed": if (busyKind === "transcribe") onTranscribed(m); break;
    case "transcribeError": hideBusy(); toast(m.message, true, 6000); break;
    case "cancelled": hideBusy(); toast("Cancelled"); break;
    case "exportProgress": if (busyKind === "export") setBusy(0.3 + 0.7 * m.progress, "Making your video…", `${Math.round(m.progress * 100)}%`); break;
    case "exported": hideBusy(); lastExportUri = m.uri; openSheet("#doneSheet"); break;
    case "exportError": hideBusy(); toast("Export failed: " + m.message, true, 7000); break;
    case "downloadProgress": downloading[m.id] = { got: m.got, total: m.total }; renderModelList(); break;
    case "downloadDone": delete downloading[m.id]; engineId = m.id; store.set("dc_engine", engineId); refreshEngines(); toast("Model ready"); break;
    case "downloadError": delete downloading[m.id]; renderModelList(); toast(m.message === "cancelled" ? "Download stopped" : "Download failed: " + m.message, m.message !== "cancelled", 5000); break;
  }
};
window.onAndroidBack = () => {
  if (!$("#busy").classList.contains("hidden")) return true;
  if (sheetOpen()) { if (!$("#wordSheet").classList.contains("hidden")) commitWord(); closeSheets(); return true; }
  if (!$("#editor").classList.contains("hidden")) { closeEditor(); return true; }
  return false;
};

// ---------------------------------------------------------------- wiring
function wire() {
  $("#pickBtn").onclick = () => A.pickVideo();
  $("#modelBtn").onclick = () => { refreshEngines(); openSheet("#modelSheet"); };
  $("#redoBtn").onclick = () => { refreshEngines(); openSheet("#modelSheet"); };
  $("#resumeBtn").onclick = () => { P = store.get("dc_proj", null); if (P) openEditor(); };
  $("#scrim").onclick = () => { if (!$("#wordSheet").classList.contains("hidden")) commitWord(); closeSheets(); };
  $("#busyCancel").onclick = () => { const k = busyKind; busyKind = null; A.cancel(); hideBusy(); if (k === "export") toast("Export cancelled"); };
  $("#backBtn").onclick = closeEditor;
  $("#exportBtn").onclick = exportVideo;
  $$("[data-url]").forEach(a => a.onclick = e => { e.preventDefault(); A.openUrl(a.dataset.url); });
  $("#vocab").value = store.get("dc_vocab", "");
  $("#vocab").onchange = e => store.set("dc_vocab", e.target.value);

  $$(".tab").forEach(t => t.onclick = () => {
    $$(".tab").forEach(x => x.classList.toggle("active", x === t));
    $$(".panel").forEach(p => p.classList.toggle("hidden", p.id !== "p-" + t.dataset.tab));
    lastMark = -2; markPlaying(video.currentTime);
  });

  $("#stage").onclick = () => { if (video.paused) video.play(); else video.pause(); };
  video.onplay = () => { $("#playIcon").classList.add("off"); if (!raf) raf = requestAnimationFrame(loop); };
  video.onpause = () => { $("#playIcon").classList.remove("off"); draw(); updateScrub(); };
  video.onseeked = () => { draw(); updateScrub(); };
  video.onloadedmetadata = () => { if (P && video.duration && !P.video.duration) P.video.duration = video.duration; sizeOverlay(); draw(); updateScrub(); };
  video.onerror = () => toast("This video can't be previewed here, but export may still work", true, 5000);
  $("#seek").oninput = e => { const d = video.duration || P.video.duration || 0; video.currentTime = d * e.target.value / 1000; draw(); };
  window.addEventListener("resize", () => { sizeOverlay(); draw(); });

  $("#wordList").onclick = e => { const b = e.target.closest(".w"); if (b) openWord(+b.dataset.i); };
  $("#wText").addEventListener("keydown", e => { if (e.key === "Enter") { commitWord(); closeSheets(); } });
  $("#wText").addEventListener("input", () => { const w = P.words[SEL]; if (w && $("#wText").value.trim()) { w.text = $("#wText").value.trim(); draw(); } });
  $("#hlSeg").onclick = e => {
    const b = e.target.closest("button"); if (!b || !P.words[SEL]) return;
    const v = +b.dataset.hl; if (v) P.words[SEL].hl = v; else delete P.words[SEL].hl;
    $$("#hlSeg button").forEach(x => x.classList.toggle("on", x === b)); changed(false);
  };
  $("#wDone").onclick = () => { commitWord(); closeSheets(); };
  $("#wPrev").onclick = () => { commitWord(); if (SEL > 0) openWord(SEL - 1); };
  $("#wNext").onclick = () => { commitWord(); if (SEL < P.words.length - 1) openWord(SEL + 1); };
  $("#wDel").onclick = () => {
    if (!P.words[SEL]) return;
    const w = P.words.splice(SEL, 1)[0];
    if (SEL > 0 && P.words[SEL - 1]) P.words[SEL - 1].end = Math.max(P.words[SEL - 1].end, Math.min(w.end, (P.words[SEL] || w).start));
    closeSheets(); changed(); toast(`Deleted “${w.text}”`);
  };
  $("#autoBtn").onclick = autoFx;
  $("#clearFxBtn").onclick = () => { P.words.forEach(w => { delete w.emoji; delete w.hl; }); changed(false); };
  $("#openBtn").onclick = () => lastExportUri && A.openVideo(lastExportUri);
  $("#shareBtn").onclick = () => lastExportUri && A.share(lastExportUri);
  buildEmojiGrid(); buildAdjust();
}

(async function init() {
  PRESETS = await fetch("/presets.json").then(r => r.json());
  wire();
  refreshHome();
  // load all caption fonts in the background so style previews are instant
  PRESETS.fonts.forEach(f => DC.loadFont(f).catch(() => {}));
})();
