// Browser-only stand-in for the Android bridge, so the UI can be developed and tested on a PC.
// Does nothing inside the app (window.Android exists there).
if (!window.Android) (function () {
  const emit = o => setTimeout(() => window.__native(JSON.stringify(o)), 0);
  const sentence = "bhai ye trick kamaal ki hai, isse paisa bhi bachega aur time bhi. sach mein, 100 percent kaam karti hai dekho";
  let cancel = false;
  const engines = {
    hinglish: { label: "Hinglish · Fast", note: "Built in. Writes Hindi speech in Roman letters.", sizeMb: 80, ready: true, builtIn: true },
    "hinglish-best": { label: "Hinglish · Best", note: "Same as the PC app. Most accurate, but slow on most phones.", sizeMb: 574, ready: false, builtIn: false },
    devanagari: { label: "Hindi · देवनागरी", note: "Writes Hindi in Devanagari script.", sizeMb: 190, ready: false, builtIn: false },
    english: { label: "English", note: "For English-only videos.", sizeMb: 190, ready: false, builtIn: false },
  };
  window.__mockFrames = [];
  window.Android = {
    version: () => "0.0.1-dev",
    cpu: () => "browser mock",
    pickVideo() {
      emit({ type: "importing" });
      const v = document.createElement("video");
      v.src = "/media/test.webm";
      v.onloadedmetadata = () => emit({ type: "picked", name: "test_reel", file: "test.webm", url: "/media/test.webm",
        width: v.videoWidth, height: v.videoHeight, duration: v.duration, fps: 30 });
      v.onerror = () => emit({ type: "pickError", message: "no /media/test.webm" });
    },
    hasVideo: () => true,
    engines: () => JSON.stringify(engines),
    openUrl: u => console.log("openUrl", u),
    downloadModel(id) {
      let got = 0; const total = engines[id].sizeMb * 1048576; cancel = false;
      const tick = () => {
        if (cancel) return emit({ type: "downloadError", id, message: "cancelled" });
        got = Math.min(total, got + total / 12);
        emit({ type: "downloadProgress", id, got, total });
        if (got >= total) { engines[id].ready = true; if (id === "devanagari") engines.english.ready = true; if (id === "english") engines.devanagari.ready = true; emit({ type: "downloadDone", id }); }
        else setTimeout(tick, 150);
      };
      tick();
    },
    cancelDownload() { cancel = true; },
    deleteModel(id) { engines[id].ready = false; },
    cancel() { cancel = true; },
    transcribe(file, engine, prompt) {
      cancel = false;
      let p = 0;
      const tick = () => {
        if (cancel) return emit({ type: "cancelled" });
        p += 0.1;
        emit({ type: "transcribeProgress", progress: p, message: p < 0.12 ? "Reading audio" : "Listening" });
        if (p < 1) return setTimeout(tick, 80);
        const words = sentence.split(" ");
        const tokens = [];
        words.forEach((w, i) => {
          const t = 0.4 + i * 0.42, cs = Math.round(t * 100);
          // split long words into 2 tokens like BPE does
          if (w.length > 5) {
            tokens.push({ text: " " + w.slice(0, 3), offsets: { from: t * 1000, to: (t + 0.2) * 1000 }, t_dtw: cs });
            tokens.push({ text: w.slice(3), offsets: { from: (t + 0.2) * 1000, to: (t + 0.4) * 1000 }, t_dtw: cs + 20 });
          } else tokens.push({ text: " " + w, offsets: { from: t * 1000, to: (t + 0.4) * 1000 }, t_dtw: cs });
        });
        tokens.unshift({ text: "[_BEG_]", offsets: { from: 0, to: 0 }, t_dtw: -1 });
        emit({ type: "transcribed", result: { transcription: [{ offsets: { from: 0, to: 9000 }, tokens }] }, seconds: 9, ms: 1234 });
      };
      tick();
    },
    beginExport() { window.__mockFrames = []; window.__mockPlan = null; },
    putFrame(id, x, y, url) { window.__mockFrames.push({ id, x, y, len: url.length, url }); return true; },
    finishExport(file, plan) {
      window.__mockPlan = JSON.parse(plan);
      let p = 0;
      const tick = () => {
        if (cancel) return emit({ type: "cancelled" });
        p += 0.25; emit({ type: "exportProgress", progress: Math.min(1, p) });
        if (p >= 1) emit({ type: "exported", uri: "content://mock/1" }); else setTimeout(tick, 100);
      };
      cancel = false; tick();
    },
    share: u => console.log("share", u),
    openVideo: u => console.log("open", u),
    shareText: t => console.log("shareText", t),
  };
})();
