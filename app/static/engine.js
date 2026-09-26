// DesiCaps caption engine (browser side). Mirrors app/engine.py 1:1 so the preview
// matches the rendered MP4. Coordinates are in video pixels.
const DC = (() => {
  const PAGE_IN = 0.20, WORD_POP = 0.14, PAGE_HOLD = 0.60, WORD_RISE = 0.28;
  const PUNCT_RE = /^["'“‘(\[]+|["'”’)\],.!?;:।…]+$/g;

  function displayText(w, st) {
    let t = w.text || "";
    if (st.stripPunct !== false) t = t.replace(PUNCT_RE, "") || t;
    if (st.uppercase) t = t.toUpperCase();
    return t;
  }

  function regroup(words, st) {
    const per = Math.max(1, st.wordsPerPage | 0 || 3), maxChars = st.maxChars | 0 || 18;
    let count = 0, chars = 0;
    words.forEach((w, i) => {
      let nw = i === 0;
      if (!nw) {
        const prev = words[i - 1], gap = w.start - prev.end;
        if (count >= per || chars + 1 + w.text.length > maxChars || gap > 0.45) nw = true;
        else if (/[.!?।]$/.test(prev.text)) nw = true;
      }
      if (nw) { count = 0; chars = -1; }
      w.brk = nw; count += 1; chars += 1 + w.text.length;
    });
    return words;
  }

  function pages(words) {
    const out = [];
    words.forEach((w, i) => {
      if (i === 0 || w.brk) out.push({ i0: i, i1: i }); else out[out.length - 1].i1 = i;
    });
    out.forEach((p, k) => {
      p.start = words[p.i0].start;
      const lastEnd = words[p.i1].end;
      let end = lastEnd + PAGE_HOLD;
      if (k + 1 < out.length) end = Math.min(end, words[out[k + 1].i0].start);
      p.end = Math.max(end, lastEnd);
    });
    return out;
  }

  const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
  const easeOutBack = (u, s = 1.70158) => { u = clamp(u) - 1; return u * u * ((s + 1) * u + s) + 1; };
  const easeOutCubic = u => 1 - Math.pow(1 - clamp(u), 3);

  function pageAnim(st, u) {
    const a = st.pageAnim || "pop";
    if (a === "none" || u >= 1) return [1, 1, 0];
    if (a === "pop") return [0.7 + 0.3 * easeOutBack(u, 2.2), clamp(u * 3), 0];
    if (a === "bounce") return [0.4 + 0.6 * easeOutBack(u, 3.2), clamp(u * 4), 0];
    if (a === "slide") { const e = easeOutCubic(u); return [1, e, (1 - e) * 0.6]; }
    if (a === "fade") return [1, easeOutCubic(u), 0];
    return [1, 1, 0];
  }
  function wordScale(st, active, t, ws) {
    if (!active || st.wordAnim === "none") return 1;
    const s = +st.activeScale || 1.1;
    return 1 + (s - 1) * easeOutBack((t - ws) / WORD_POP, 2.5);
  }

  // words appear as spoken, fading + rising in (wordAnim "rise")
  function wordRise(st, t, ws) {
    if (st.wordAnim !== "rise") return [true, 1, 0];
    if (ws > t + 1e-6) return [false, 0, 0];
    const e = easeOutCubic((t - ws) / WORD_RISE);
    return [true, e, (1 - e) * 0.35];
  }
  const cleanLen = w => (w.text || "").replace(PUNCT_RE, "").length;
  // 0 normal, 1/2 emphasis; pages with no marked word can emphasise their longest word (emphAuto)
  function emphOf(words, page, i, st) {
    const h = words[i].hl || 0;
    if (h) return h;
    if (st.emphAuto === "longest" && page.i1 > page.i0) {
      let any = false, best = page.i0;
      for (let j = page.i0; j <= page.i1; j++) {
        if (words[j].hl) any = true;
        if (cleanLen(words[j]) >= cleanLen(words[best])) best = j;
      }
      if (!any) return i === best ? 1 : 0;
    }
    return 0;
  }
  const wordFont = (st, em) => (em && st.emphFont) ? [st.emphFont, +st.emphScale || 1] : [st.font, 1];
  const isDiff = st => st.blend === "difference" || st.blend === "emph";
  // is this word negative text? blend "emph" = only the emphasised (accent) words
  const wordDiff = (st, em) => st.blend === "difference" || (st.blend === "emph" && !!em);

  // ---------- fonts / emoji
  const loaded = new Set();
  async function loadFont(name) {
    if (loaded.has(name)) return;
    const f = new FontFace(name, `url(/fonts/${name}.ttf)`);
    await f.load(); document.fonts.add(f); loaded.add(name);
  }
  const emojiCache = {};
  function emojiImg(code, onload) {
    if (!emojiCache[code]) {
      const im = new Image(); im.onload = onload; im.src = `/emoji/${code}.png`; emojiCache[code] = im;
    }
    const im = emojiCache[code];
    return im.complete && im.naturalWidth ? im : null;
  }
  // resolves once every emoji image is decoded (used before exporting frames)
  function preloadEmoji(codes) {
    return Promise.all(codes.map(code => new Promise(res => {
      const im = emojiImg(code, null);
      if (im) return res();
      const el = emojiCache[code];
      el.addEventListener("load", () => res(), { once: true });
      el.addEventListener("error", () => res(), { once: true });
    })));
  }

  const mctx = document.createElement("canvas").getContext("2d");
  function fontStr(st, px, name) { return `${Math.max(1, Math.round(px))}px "${name || st.font}"`; }
  function loadStyleFonts(st) {
    return Promise.all([st.font, st.emphFont].filter(Boolean).map(f => loadFont(f).catch(() => {})));
  }
  function metrics(st, px, name) {
    mctx.font = fontStr(st, px, name);
    const m = mctx.measureText("Hg");
    return { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent };
  }
  const baselineShift = (st, px, name) => { const m = metrics(st, px, name); return (m.asc - m.desc) / 2; };
  const unit = (W, H) => Math.min(W, H) / 1080;

  function layout(words, page, st, W, H) {
    const k = unit(W, H), fs = st.size * k;
    mctx.font = fontStr(st, fs);
    let space = mctx.measureText(" ").width + (st.stroke || 0) * k;
    if ((st.wordAnim || "pop") !== "none") space += fs * Math.max(0, (+st.activeScale || 1.1) - 1) * 1.6;
    if (st.highlight === "box") space += (st.boxPad ?? 14) * k;
    const maxw = (st.maxWidth ?? 0.82) * W;
    const items = [];
    for (let i = page.i0; i <= page.i1; i++) {
      const text = displayText(words[i], st), em = emphOf(words, page, i, st), [fname, mult] = wordFont(st, em);
      mctx.font = fontStr(st, fs * mult, fname);
      items.push({ text, idx: i, em, font: fname, mult, w: mctx.measureText(text).width });
    }
    mctx.font = fontStr(st, fs);
    const own = !!st.emphLine;   // accent words sit on a line of their own
    const lines = []; let cur = [], curw = 0;
    for (const it of items) {
      let add = it.w + (cur.length ? space : 0);
      const brk = own && cur.length && (it.em || cur[cur.length - 1].em);
      if (cur.length && (brk || curw + add > maxw)) { lines.push([cur, curw]); cur = []; curw = 0; add = it.w; }
      cur.push(it); curw += add;
    }
    if (cur.length) lines.push([cur, curw]);
    const lh = fs * (st.lineHeight ?? 1.12), cy = (st.posY ?? 0.7) * H;
    const lhs = lines.map(([ln]) => lh * Math.max(...ln.map(it => it.mult)));
    const total = lhs.reduce((a, b) => a + b, 0), top = cy - total / 2;
    const maxlw = Math.max(...lines.map(l => l[1])), left = st.align === "left";
    let y = top;
    lines.forEach(([ln, lw], li) => {
      let x = W / 2 - (left ? maxlw : lw) / 2;
      for (const it of ln) { it.cx = x + it.w / 2; it.cy = y + lhs[li] / 2; x += it.w + space; }
      y += lhs[li];
    });
    return { items, box: [W / 2 - maxlw / 2, top, W / 2 + maxlw / 2, top + total], fs, cy };
  }

  function activeIndex(words, page, t) {
    let a = null;
    for (let i = page.i0; i <= page.i1; i++) if (words[i].start <= t) a = i;
    return a;
  }

  function roundRect(ctx, x0, y0, x1, y1, r) {
    ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2)); ctx.fill();
  }
  const rgba = (hex, a) => {
    const h = hex.replace("#", "");
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  };

  let shadowCanvas = null;
  // Draw captions for time t onto ctx (already scaled to video pixels). Returns page index or -1.
  // layer "normal": everything (for 'difference' styles: all but the text)
  // layer "diff": only the text of a 'difference' style, in white — draw it on a canvas with
  //               mix-blend-mode / composite "difference" over the video for the negative look
  function draw(ctx, project, t, W, H, pgs, redraw, layer) {
    const words = project.words, st = project.style;
    layer = layer || "normal";
    const diff = isDiff(st);
    if (layer === "diff" && !diff) return -1;
    pgs = pgs || pages(words);
    const pi = pgs.findIndex(p => p.start <= t && t < p.end);
    if (pi < 0) return -1;
    const page = pgs[pi], k = unit(W, H);
    const { items, box, fs, cy } = layout(words, page, st, W, H);
    const a = activeIndex(words, page, t);
    let [ps, pop, yoff] = pageAnim(st, (t - page.start) / PAGE_IN);
    yoff *= fs;
    const mode = st.mode || "page", hl = st.highlight || "color";
    const stroke = Math.round((st.stroke || 0) * k * ps);
    const tx = (x, y) => [W / 2 + (x - W / 2) * ps, cy + (y - cy) * ps + yoff];

    if (st.pageBg && layer === "normal") {
      const pad = fs * 0.35;
      const [x0, y0] = tx(box[0] - pad, box[1] - pad * 0.6), [x1, y1] = tx(box[2] + pad, box[3] + pad * 0.6);
      ctx.fillStyle = rgba(st.pageBgColor, st.pageBgOpacity * pop);
      roundRect(ctx, x0, y0, x1, y1, fs * 0.3 * ps);
    }

    const glyphs = [];
    for (const it of items) {
      const w = words[it.idx];
      if (mode === "reveal" && w.start > t) continue;
      const [vis, ra, ry] = wordRise(st, t, w.start);
      if (!vis) continue;
      const isAct = it.idx === a, ws = st.wordAnim === "rise" ? 1 : wordScale(st, isAct, t, w.start);
      const [x, y] = tx(it.cx, it.cy + ry * fs);
      let fill = st.textColor;
      if (it.em === 1) fill = st.emph1; else if (it.em === 2) fill = st.emph2;
      if (isAct && hl === "color") fill = st.activeColor;
      if (isAct && hl === "box") fill = st.boxTextColor;
      let alpha = pop * ra;
      if (mode === "dim" && w.start > t) alpha *= st.dimOpacity ?? 0.35;
      glyphs.push({ it, x, y, size: fs * ps * ws * it.mult, fill, alpha, isAct, ws });
    }

    if (layer === "diff") {  // white text mask
      for (const g of glyphs) {
        if (!wordDiff(st, g.it.em)) continue;
        ctx.font = fontStr(st, g.size, g.it.font); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
        ctx.globalAlpha = g.alpha; ctx.fillStyle = "#FFFFFF";
        ctx.fillText(g.it.text, g.x, g.y + baselineShift(st, g.size, g.it.font));
      }
      ctx.globalAlpha = 1;
      return pi;
    }

    if (hl === "box") for (const g of glyphs) {
      if (!g.isAct) continue;
      const pad = ((st.boxPad ?? 14) + (st.stroke || 0)) * k * ps * g.ws;
      ctx.font = fontStr(st, g.size, g.it.font); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      const m = ctx.measureText(g.it.text), by = g.y + baselineShift(st, g.size, g.it.font);
      ctx.fillStyle = rgba(st.boxColor, g.alpha);
      roundRect(ctx, g.x - m.actualBoundingBoxLeft - pad, by - m.actualBoundingBoxAscent - pad * 0.7,
        g.x + m.actualBoundingBoxRight + pad, by + m.actualBoundingBoxDescent + pad * 0.7, (st.boxRadius ?? 18) * k * ps * g.ws);
    }

    const plain = glyphs.filter(g => !wordDiff(st, g.it.em)).sort((p, q) => p.isAct - q.isAct);
    const textPass = (c, color, dy, strokeColor) => {
      for (const g of plain) {
        c.font = fontStr(st, g.size, g.it.font); c.textAlign = "center"; c.textBaseline = "alphabetic";
        const y = g.y + dy + baselineShift(st, g.size, g.it.font), sw = Math.round(stroke * (color ? 1 : g.ws));
        c.globalAlpha = g.alpha;
        if (sw > 0) {
          c.lineJoin = "round"; c.miterLimit = 2; c.lineWidth = sw * 2;
          c.strokeStyle = color || strokeColor; c.strokeText(g.it.text, g.x, y);
        }
        c.fillStyle = color || g.fill; c.fillText(g.it.text, g.x, y);
      }
      c.globalAlpha = 1;
    };

    if ((st.shadowOpacity || 0) > 0 && plain.length && ctx.canvas.width > 0 && ctx.canvas.height > 0) {
      const cw = ctx.canvas.width, ch = ctx.canvas.height;
      if (!shadowCanvas) shadowCanvas = document.createElement("canvas");
      if (shadowCanvas.width !== cw || shadowCanvas.height !== ch) { shadowCanvas.width = cw; shadowCanvas.height = ch; }
      const sc = shadowCanvas.getContext("2d");
      sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, cw, ch);
      sc.setTransform(ctx.getTransform());
      textPass(sc, st.shadowColor, (st.shadowY || 0) * k * ps, null);
      const scale = ctx.getTransform().a;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = st.shadowOpacity;
      const blur = (st.shadowBlur || 0) * k * scale / 2;
      if (blur > 0) ctx.filter = `blur(${blur}px)`;
      ctx.drawImage(shadowCanvas, 0, 0);
      ctx.restore();
    }
    textPass(ctx, null, 0, st.strokeColor);

    if (st.emoji !== false) {
      for (let i = page.i0; i <= page.i1; i++) {
        const code = words[i].emoji;
        if (code && words[i].start <= t + 0.001) {
          const es = easeOutBack((t - words[i].start) / 0.25, 2.6), px = fs * 1.35 * ps * es;
          const im = px >= 2 && emojiImg(code, redraw);
          if (im) { const [ex, ey] = tx(W / 2, box[1] - fs * 0.85); ctx.drawImage(im, ex - px / 2, ey - px / 2, px, px); }
          break;
        }
      }
    }
    return pi;
  }

  // Negative-text preview without CSS blending (video overlays on some GPUs ignore mix-blend-mode):
  // paints the video frame, inverted, only inside the caption's diff mask. ctx is in canvas pixels.
  let negMask = null;
  function paintNegative(ctx, video, project, t, W, H, pgs, redraw) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cw, ch);
    if (!isDiff(project.style) || !video || video.readyState < 2 || !cw || !ch) return false;
    if (!negMask) negMask = document.createElement("canvas");
    if (negMask.width !== cw || negMask.height !== ch) { negMask.width = cw; negMask.height = ch; }
    const m = negMask.getContext("2d");
    m.setTransform(1, 0, 0, 1, 0, 0); m.clearRect(0, 0, cw, ch);
    m.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    if (draw(m, project, t, W, H, pgs, redraw, "diff") < 0) return false;
    // same placement as the <video> (object-fit: contain) so the inverted pixels line up with what is shown
    const vw = video.videoWidth || cw, vh = video.videoHeight || ch, f = Math.min(cw / vw, ch / vh);
    const dw = vw * f, dh = vh * f;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    ctx.globalCompositeOperation = "difference"; ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(negMask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    return true;
  }

  return { paintNegative, regroup, pages, draw, layout, loadFont, loadStyleFonts, displayText, activeIndex, preloadEmoji, isDiff, PAGE_IN, WORD_RISE };
})();
