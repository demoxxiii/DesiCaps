// DesiCaps panel for Premiere Pro (CEP). Talks to the DesiCaps desktop app on 127.0.0.1 for
// transcription (GPU) and rendering, and to Premiere through jsx/host.jsx.
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const hasNode = typeof require === "function";
const http = hasNode ? require("http") : null;

let PORT = null, PRESETS = null, SEQ = null, CLIP = null, PID = null, PROJECT = null;

// ------------------------------------------------------------------ helpers
function status(msg, kind) { const s = $("#status"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }
function progress(f, msg) {
  const p = $("#progress");
  if (f === null) { p.classList.add("hidden"); return; }
  p.classList.remove("hidden"); $("#bar").style.width = Math.round(f * 100) + "%"; $("#progMsg").textContent = msg || "";
}
function evalHost(code) {
  return new Promise((resolve, reject) => {
    if (!window.__adobe_cep__) return reject(new Error("Open this panel inside Premiere Pro"));
    window.__adobe_cep__.evalScript(code, r => {
      try { const j = JSON.parse(r); j.ok === false ? reject(new Error(j.error)) : resolve(j); }
      catch (e) { reject(new Error("Premiere: " + r)); }
    });
  });
}
const jsStr = s => JSON.stringify(String(s));

function api(method, path, body, port) {
  port = port || PORT;
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    if (!http) {  // browser fallback (development)
      fetch(`http://127.0.0.1:${port}${path}`, { method, body: data && JSON.stringify(body), headers: { "Content-Type": "application/json" } })
        .then(r => r.json().then(j => r.ok ? resolve(j) : reject(new Error(j.detail || r.statusText)))).catch(reject);
      return;
    }
    const req = http.request({ host: "127.0.0.1", port, path, method, timeout: 8000,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, res => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", c => buf += c);
      res.on("end", () => {
        let j = null; try { j = JSON.parse(buf); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(new Error((j && j.detail) || ("HTTP " + res.statusCode)));
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function job(started, label) {
  let j = started;
  while (!j.done) {
    progress(j.progress || 0, (label || "") + (j.msg ? " — " + j.msg : ""));
    await new Promise(r => setTimeout(r, 700));
    j = await api("GET", "/api/job/" + j.id);
  }
  progress(null);
  if (j.error) throw new Error(j.error);
  return j.result;
}
function openUrl(u) {
  try { window.cep.util.openURLInDefaultBrowser(u); } catch (e) { try { require("child_process").exec((process.platform === "win32" ? 'start "" ' : "open ") + JSON.stringify(u)); } catch (e2) {} }
}

// ------------------------------------------------------------------ connect to the DesiCaps app
async function findApp() {
  for (let p = 7870; p <= 7890; p++) {
    try { const h = await api("GET", "/api/health", null, p); if (h && "raqm" in h) return p; } catch (e) {}
  }
  return null;
}
async function connect(quiet) {
  const p = await findApp();
  PORT = p;
  $("#offline").classList.toggle("hidden", !!p);
  $("#main").classList.toggle("hidden", !p);
  if (p && !PRESETS) {
    PRESETS = await api("GET", "/api/presets");
    buildStyles();
  }
  if (!p && !quiet) status("");
  return p;
}
function startApp() {
  if (!hasNode) return;
  const cp = require("child_process"), fs = require("fs"), path = require("path");
  try {
    if (process.platform === "win32") {
      const exe = path.join(process.env.LOCALAPPDATA || "", "Programs", "DesiCaps", "DesiCaps.exe");
      if (!fs.existsSync(exe)) { status("DesiCaps isn't installed — get it free from klyn.in", "err"); return; }
      cp.spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
    } else {
      cp.spawn("open", ["-a", "DesiCaps"], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) { status("Couldn't start DesiCaps: " + e.message, "err"); return; }
  status("Starting DesiCaps…");
  let tries = 0;
  const t = setInterval(async () => { if (await connect(true) || ++tries > 40) { clearInterval(t); status(PORT ? "Connected to DesiCaps" : "DesiCaps didn't start", PORT ? "ok" : "err"); } }, 1500);
}

// ------------------------------------------------------------------ steps
async function pickClip() {
  try {
    const info = await evalHost("dc_info()");
    SEQ = info;
    // several clips selected (e.g. Ctrl+A in the timeline): caption them all as one piece
    const isOut = p => /_captions_|_negative\.mov$|\.srt$/i.test(p);
    const sel = (info.clips || []).filter(c => c.path && !isOut(c.path));
    const starts = new Set(sel.map(c => c.path + "@" + c.start.toFixed(2)));
    if (starts.size > 1) {
      status(`Combining ${starts.size} clips…`);
      PROJECT = await job(await api("POST", "/api/premiere/open_timeline",
        { clips: sel, width: info.width, height: info.height, name: `${info.name} (${starts.size} clips)` }), "Combining clips");
      PID = PROJECT.id;
      const t0 = PROJECT.timelineStart || 0;
      CLIP = { name: `${starts.size} clips`, path: PROJECT.video, inPoint: 0, outPoint: PROJECT.duration, start: t0, speed: 1, multi: true };
      const vids = sel.filter(c => c.kind === "video").length, auds = sel.filter(c => c.kind === "audio").length;
      $("#clipInfo").innerHTML = `<b>${starts.size} clips</b> (${vids} video, ${auds} audio parts)<br>` +
        `${PROJECT.duration.toFixed(1)}s from ${t0.toFixed(2)}s on the timeline · sequence ${info.width}×${info.height} @ ${info.fps} fps` +
        (sel.some(c => Math.abs(c.speed - 1) > 0.001) ? `<br><span style="color:#ffb020">Some clips are speed-changed — captions follow normal speed.</span>` : "");
      status("");
      showWords();
      $("#transcribe").disabled = false;
      return;
    }
    if (!info.clip || !info.clip.path) throw new Error("Select a clip in the timeline (or put the playhead over it).");
    CLIP = info.clip;
    const len = (CLIP.outPoint - CLIP.inPoint).toFixed(1);
    $("#clipInfo").innerHTML = `<b>${esc(CLIP.name)}</b><br>${len}s on the timeline at ${CLIP.start.toFixed(2)}s · sequence ${info.width}×${info.height} @ ${info.fps} fps` +
      (Math.abs(CLIP.speed - 1) > 0.001 ? `<br><span style="color:#ffb020">Clip speed is ${Math.round(CLIP.speed * 100)}% — captions follow normal speed.</span>` : "");
    status("");
    PROJECT = await api("POST", "/api/premiere/open", { path: CLIP.path });
    PID = PROJECT.id;
    showWords();
    $("#transcribe").disabled = false;
  } catch (e) { progress(null); status(e.message, "err"); }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function wordsInRange() {
  if (!PROJECT || !CLIP) return [];
  return (PROJECT.words || []).filter(w => w.end > CLIP.inPoint && w.start < CLIP.outPoint);
}
function showWords() {
  const ws = wordsInRange();
  $("#wordsInfo").textContent = ws.length ? `${ws.length} words: “${ws.slice(0, 10).map(w => w.text).join(" ")}${ws.length > 10 ? " …" : ""}”` :
    (PROJECT && PROJECT.words && PROJECT.words.length ? "No words inside this clip's in/out range." : "Not transcribed yet.");
  $("#transcribe").textContent = PROJECT && PROJECT.words && PROJECT.words.length ? "Transcribe again" : "Transcribe";
  $("#editWords").disabled = !ws.length;
  $("#addTimeline").disabled = !ws.length;
  if (PROJECT && PROJECT.style) syncStyle();
}
async function transcribe() {
  if (!PID) return;
  try {
    status("");
    const r = await job(await api("POST", `/api/project/${PID}/transcribe`, { engine: $("#engine").value, vocab: $("#vocab").value.trim() }), "Transcribing");
    PROJECT = await api("GET", "/api/project/" + PID);
    showWords();
    status(`Done — ${r.words} words. Check them with “Edit words”, then add to the timeline.`, "ok");
  } catch (e) { progress(null); status(e.message, "err"); }
}
async function editWords() {
  try { await api("POST", "/api/ui/open", { pid: PID }); status("Opened in the DesiCaps window. Fix words there, then click Add to timeline.", "ok"); }
  catch (e) { status(e.message, "err"); }
}

// ------------------------------------------------------------------ style
function styleFor(id) {
  const st = JSON.parse(JSON.stringify(PRESETS.base));
  const p = PRESETS.presets.find(x => x.id === id);
  if (p) Object.assign(st, p.style);
  return st;
}
function buildStyles() {
  const box = $("#styles"); box.innerHTML = "";
  for (const p of PRESETS.presets) {
    const st = styleFor(p.id);
    const d = document.createElement("div");
    d.className = "style"; d.dataset.id = p.id; d.textContent = p.name;
    d.style.color = st.highlight === "box" ? "#fff" : st.activeColor;
    if (st.highlight === "box") d.style.background = st.boxColor;
    d.onclick = () => setPreset(p.id);
    box.appendChild(d);
  }
}
function syncStyle() {
  const st = PROJECT.style;
  $$(".style").forEach(d => d.classList.toggle("on", d.dataset.id === PROJECT.preset));
  $("#size").value = st.size; $("#sizeV").textContent = st.size;
  $("#pos").value = st.posY; $("#posV").textContent = Math.round(st.posY * 100) + "%";
}
async function saveStyle(regroup) {
  await api("POST", "/api/project/" + PID, { style: PROJECT.style, preset: PROJECT.preset });
  if (regroup) {
    const r = await api("POST", `/api/project/${PID}/regroup`, { words: PROJECT.words, style: PROJECT.style });
    PROJECT.words = r.words;
  }
}
async function setPreset(id) {
  if (!PROJECT) return status("Pick a clip first", "err");
  const keepPos = PROJECT.style && PROJECT.style.posY;
  PROJECT.preset = id; PROJECT.style = styleFor(id);
  if (PROJECT.customPos && keepPos) PROJECT.style.posY = keepPos;
  syncStyle();
  try { await saveStyle(true); } catch (e) { status(e.message, "err"); }
}

// ------------------------------------------------------------------ timeline
async function addToTimeline() {
  if (!PID || !CLIP) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  try {
    // re-read the project: words may have been edited in the DesiCaps window
    PROJECT = await api("GET", "/api/project/" + PID);
    showWords();
    const range = { t0: CLIP.inPoint, t1: CLIP.outPoint };
    if (mode === "overlay") {
      const r = await job(await api("POST", `/api/project/${PID}/premiere_overlay`,
        Object.assign({ width: SEQ.width, height: SEQ.height, fps: SEQ.fps }, range)), "Rendering");
      status("Placing on the timeline…");
      let p = null;
      if (r.path) p = await evalHost(`dc_place(${jsStr(r.path)}, ${CLIP.start}, "")`);
      if (r.diffPath) {
        const d = await evalHost(`dc_place(${jsStr(r.diffPath)}, ${CLIP.start}, "difference")`);
        status(d.blend ? `Negative text added on ${d.track} (blend mode: Difference).` :
          `Negative text added on ${d.track}. Select it → Effect Controls → Opacity → Blend Mode → Difference.`, "ok");
      } else {
        status(`Added on ${p.track || "a new track"}. Transparent ProRes 4444 layer — move or trim it like any clip.`, "ok");
      }
    } else {
      const r = await api("POST", `/api/project/${PID}/premiere_srt`, range);
      await evalHost(`dc_captions(${jsStr(r.path)}, ${CLIP.start})`);
      status("Caption track added. Style it in the Essential Graphics / Properties panel.", "ok");
    }
  } catch (e) { progress(null); status(e.message, "err"); }
}

// ------------------------------------------------------------------ wiring
$("#startApp").onclick = startApp;
$("#pickClip").onclick = pickClip;
$("#transcribe").onclick = transcribe;
$("#editWords").onclick = editWords;
$("#addTimeline").onclick = addToTimeline;
$$("[data-url]").forEach(a => a.onclick = e => { e.preventDefault(); openUrl(a.dataset.url); });
$("#size").oninput = e => { if (!PROJECT) return; PROJECT.style.size = +e.target.value; $("#sizeV").textContent = e.target.value; clearTimeout(window._st); window._st = setTimeout(() => saveStyle(true).catch(() => {}), 400); };
$("#pos").oninput = e => { if (!PROJECT) return; PROJECT.style.posY = +e.target.value; PROJECT.customPos = true; $("#posV").textContent = Math.round(e.target.value * 100) + "%"; clearTimeout(window._st); window._st = setTimeout(() => saveStyle(false).catch(() => {}), 400); };
try { $("#engine").value = localStorage.getItem("dc_engine") || "hinglish"; $("#vocab").value = localStorage.getItem("dc_vocab") || ""; } catch (e) {}
$("#engine").onchange = e => { try { localStorage.setItem("dc_engine", e.target.value); } catch (x) {} };
$("#vocab").onchange = e => { try { localStorage.setItem("dc_vocab", e.target.value); } catch (x) {} };

connect().then(p => { if (!p) setInterval(() => { if (!PORT) connect(true); }, 4000); });
