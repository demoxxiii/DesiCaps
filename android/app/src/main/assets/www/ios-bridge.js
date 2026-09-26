// iPhone/iPad: exposes the same window.Android API the UI uses, backed by WKWebView messages.
// Does nothing on Android (window.Android exists) or in a normal browser.
(function () {
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge;
  if (!h || window.Android) return;
  document.documentElement.classList.add("ios");
  const st = window.__IOS_STATE || {};
  const post = (cmd, args) => h.postMessage(Object.assign({ cmd }, args || {}));
  window.__iosState = s => { if (s) Object.assign(st, s); };
  window.Android = {
    platform: () => "ios",
    version: () => st.version || "",
    cpu: () => st.cpu || "",
    engines: () => JSON.stringify(st.engines || {}),
    hasVideo: f => (st.files || []).indexOf(f) >= 0,
    mediaUrl: f => location.origin + "/media/" + encodeURIComponent(f),
    pickVideo: () => post("pickVideo"),
    openUrl: url => post("openUrl", { url }),
    downloadModel: id => post("downloadModel", { id }),
    cancelDownload: () => post("cancelDownload"),
    deleteModel: id => {
      post("deleteModel", { id });
      const e = st.engines && st.engines[id];
      if (e && !e.builtIn) e.ready = false;
    },
    cancel: () => post("cancel"),
    transcribe: (file, engine, prompt) => post("transcribe", { file, engine, prompt }),
    makePreview: (file, w, h2) => post("makePreview", { file, w, h: h2 }),
    beginExport: () => post("beginExport"),
    putFrame: (id, x, y, url) => { post("putFrame", { id, x, y, url }); return true; },
    finishExport: (file, plan) => post("finishExport", { file, plan }),
    share: uri => post("share", { uri }),
    openVideo: uri => post("openVideo", { uri }),
    shareText: text => post("shareText", { text }),
  };
})();
