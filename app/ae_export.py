"""Generate an After Effects ExtendScript (.jsx) that rebuilds the captions as editable, animated layers.

Result in AE:
  <name> CAPTIONS (main comp)
    CAPTION CONTROLS (null)  - global colour pickers + pop scale, all captions follow it
    CAP 001 ... CAP n        - one precomp per caption line, native text layers per word
    source video
"""
import json
import os

import engine

JSX = r"""// DesiCaps Studio -> After Effects caption builder (generated)
// Run: File > Scripts > Run Script File...   (AE 2020 or newer)
var DATA = __DATA__;

(function () {
    function hex(h) { h = h.replace("#", ""); return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255]; }
    function pad3(n) { n = String(n); while (n.length < 3) n = "0" + n; return n; }
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    function fmtf(x) { return String(Math.round(x * 1000) / 1000); }

    var S = DATA.style, W = DATA.width, H = DATA.height, FPS = DATA.fps;
    var K = Math.min(W, H) / 1080, FS = S.size * K, STROKE = (S.stroke || 0) * K;
    var warnings = [];

    app.beginUndoGroup("DesiCaps captions");
    var proj = app.project || app.newProject();
    var stamp = new Date(); stamp = pad3(stamp.getHours()).substr(1) + pad3(stamp.getMinutes()).substr(1);
    var root = proj.items.addFolder("DesiCaps - " + DATA.name + " " + stamp);
    var capFolder = proj.items.addFolder("caption lines"); capFolder.parentFolder = root;
    var assetFolder = proj.items.addFolder("assets"); assetFolder.parentFolder = root;

    // ---------- main comp + footage
    var footage = null;
    try {
        footage = proj.importFile(new ImportOptions(new File(DATA.video)));
        footage.parentFolder = assetFolder;
    } catch (e) { warnings.push("Could not import video: " + DATA.video); }
    var MAIN_NAME = DATA.name + " CAPTIONS " + stamp;
    var main = proj.items.addComp(MAIN_NAME, W, H, 1, DATA.duration, FPS);
    main.parentFolder = root;
    if (footage) { var fl = main.layers.add(footage); fl.name = "SOURCE VIDEO"; }

    // ---------- global controls
    var ctrl = main.layers.addNull(DATA.duration);
    ctrl.name = "CAPTION CONTROLS";
    function addColor(name, h) { var fx = ctrl.property("ADBE Effect Parade").addProperty("ADBE Color Control"); fx.name = name; fx.property(1).setValue(hex(h)); }
    function addSlider(name, v) { var fx = ctrl.property("ADBE Effect Parade").addProperty("ADBE Slider Control"); fx.name = name; fx.property(1).setValue(v); }
    addSlider("Pop Scale %", Math.round((S.activeScale || 1.1) * 100));
    var CREF = 'comp(' + q(MAIN_NAME) + ').layer("CAPTION CONTROLS")';

    // ---------- helpers
    var emojiCache = {};
    function emojiFootage(code) {
        if (emojiCache[code]) return emojiCache[code];
        var f = new File((DATA.emojiFiles && DATA.emojiFiles[code]) || (DATA.emojiDir + "/" + code + ".png"));
        if (!f.exists) { warnings.push("Missing emoji " + code); return null; }
        var it = proj.importFile(new ImportOptions(f)); it.parentFolder = assetFolder; emojiCache[code] = it; return it;
    }
    function styleText(layer, txt, size, fillHex) {
        var tp = layer.property("ADBE Text Properties").property("ADBE Text Document");
        var td = tp.value;
        try { td.resetCharStyle(); td.resetParagraphStyle(); } catch (e) {}
        td.text = txt; td.font = S.font; td.fontSize = size; td.applyFill = true; td.fillColor = hex(fillHex || S.textColor);
        if (STROKE > 0) { td.applyStroke = true; td.strokeColor = hex(S.strokeColor); td.strokeWidth = STROKE * 2; td.strokeOverFill = false; }
        else td.applyStroke = false;
        td.justification = ParagraphJustification.CENTER_JUSTIFY;
        tp.setValue(td);
        try { td = tp.value; td.lineJoinType = 1; tp.setValue(td); } catch (e2) {}  // round joins (AE 2023+)
        if (tp.value.font !== S.font && !styleText.warned) { styleText.warned = true; warnings.push("Font '" + S.font + "' is not installed - install it from the DesiCaps fonts folder, then re-run."); }
    }
    function popExpr(Sx, Ex, scaleRef) {
        return "var S=" + fmtf(Sx) + ",E=" + fmtf(Ex) + ";\n" +
            "if (time>=S && time<E) { var s=" + scaleRef + "; var u=Math.min(1,(time-S)/0.14)-1; var k=u*u*(3.5*u+2.5)+1; var v=100+(s-100)*k; [v,v]; } else [100,100];";
    }

    // measure a space once (AE trims spaces, so measure "x x" minus "xx")
    var tmpComp = proj.items.addComp("_measure", W, H, 1, 1, FPS);
    var m1 = tmpComp.layers.addText("x x"); styleText(m1, "x x", FS);
    var m2 = tmpComp.layers.addText("xx"); styleText(m2, "xx", FS);
    var SPACE = m1.sourceRectAtTime(0, false).width - m2.sourceRectAtTime(0, false).width;
    if (!(SPACE > 0)) SPACE = FS * 0.28;
    SPACE += STROKE; if (S.highlight === "box") SPACE += (S.boxPad || 14) * K;
    var capRect = (function () { var l = tmpComp.layers.addText("HX"); styleText(l, "HX", FS); return l.sourceRectAtTime(0, false); })();
    tmpComp.remove();
    var MID = capRect.top + capRect.height / 2;   // vertical centre of capitals relative to baseline

    var LH = FS * (S.lineHeight || 1.12), CY = (S.posY || 0.7) * H, MAXW = (S.maxWidth || 0.82) * W;
    var hl = S.highlight || "color", mode = S.mode || "page";

    for (var pi = 0; pi < DATA.pages.length; pi++) {
        var P = DATA.pages[pi], dur = Math.max(1 / FPS, P.end - P.start);
        var label = "CAP " + pad3(pi + 1) + "  " + P.label;
        var pc = proj.items.addComp(label.substr(0, 60), W, H, 1, dur, FPS);
        pc.parentFolder = capFolder;

        // create + measure word layers
        var ws = [];
        for (var wi = P.words.length - 1; wi >= 0; wi--) {  // add in reverse so first word ends on top
            var w = P.words[wi];
            var L = pc.layers.addText(w.t); styleText(L, w.t, FS, w.hl === 1 ? S.emph1 : w.hl === 2 ? S.emph2 : S.textColor); L.name = w.t;
            var r = L.sourceRectAtTime(0, false);
            ws.unshift({ w: w, L: L, r: r, width: r.width - STROKE * 2 });
        }
        // greedy line wrap (same rule as the renderer)
        var lines = [], cur = [], curw = 0;
        for (var i = 0; i < ws.length; i++) {
            var add = ws[i].width + (cur.length ? SPACE : 0);
            if (cur.length && curw + add > MAXW) { lines.push({ items: cur, w: curw }); cur = []; curw = 0; add = ws[i].width; }
            cur.push(ws[i]); curw += add;
        }
        if (cur.length) lines.push({ items: cur, w: curw });
        var top = CY - LH * lines.length / 2, maxlw = 0;
        for (var li = 0; li < lines.length; li++) {
            var x = W / 2 - lines[li].w / 2; maxlw = Math.max(maxlw, lines[li].w);
            for (var k = 0; k < lines[li].items.length; k++) {
                var o = lines[li].items[k];
                o.cx = x + o.width / 2; o.cy = top + li * LH + LH / 2;
                x += o.width + SPACE;
            }
        }

        for (i = 0; i < ws.length; i++) {
            o = ws[i]; w = o.w;
            var Sx = w.s - P.start, Ex = (i + 1 < ws.length ? ws[i + 1].w.s : P.end) - P.start;
            var tr = o.L.property("ADBE Transform Group");
            tr.property("ADBE Anchor Point").setValue([o.r.left + o.r.width / 2, MID]);
            tr.property("ADBE Position").setValue([o.cx, o.cy]);
            if (S.wordAnim !== "none") tr.property("ADBE Scale").expression = popExpr(Sx, Ex, CREF + '.effect("Pop Scale %")("Slider")');
            if (mode === "reveal") tr.property("ADBE Opacity").expression = "time>=" + fmtf(Sx) + "?100:0";
            if (mode === "dim") tr.property("ADBE Opacity").expression = "time>=" + fmtf(Sx) + "?100:" + Math.round((S.dimOpacity || 0.35) * 100);
            // active-word colour: a text animator whose range is only "on" while this word is spoken
            if (hl === "color" || hl === "box") {
                var an = o.L.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
                an.name = "Active Word";
                var sel = an.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
                var fc = an.property("ADBE Text Animator Properties").addProperty("ADBE Text Fill Color");
                fc.setValue(hex(hl === "color" ? S.activeColor : S.boxTextColor));
                sel.property("ADBE Text Percent End").expression = "(time>=" + fmtf(Sx) + " && time<" + fmtf(Ex) + ") ? 100 : 0";
            }
            o.Sx = Sx; o.Ex = Ex;
        }

        // sliding highlight box
        if (hl === "box") {
            var bx = pc.layers.addShape(); bx.name = "Highlight Box";
            var g = bx.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
            var rect = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
            var fill = g.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue(hex(S.boxColor));
            rect.property("ADBE Vector Rect Roundness").setValue((S.boxRadius || 18) * K);
            var pad = ((S.boxPad || 14) * K + STROKE);
            var sizeP = rect.property("ADBE Vector Rect Size"), posP = bx.property("ADBE Transform Group").property("ADBE Position");
            bx.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
            for (i = 0; i < ws.length; i++) {
                o = ws[i];
                var t = Math.max(0, o.Sx);
                sizeP.setValueAtTime(t, [o.width + pad * 2, capRect.height + pad * 1.4]);
                posP.setValueAtTime(t, [o.cx, o.cy]);
            }
            for (var kk = 1; kk <= sizeP.numKeys; kk++) { sizeP.setInterpolationTypeAtKey(kk, KeyframeInterpolationType.HOLD); }
            for (kk = 1; kk <= posP.numKeys; kk++) { posP.setInterpolationTypeAtKey(kk, KeyframeInterpolationType.HOLD); }
            if (ws.length) bx.inPoint = Math.max(0, ws[0].Sx);
            bx.moveToEnd();
        }
        // background bar
        if (S.pageBg) {
            var bg = pc.layers.addShape(); bg.name = "Background Bar";
            var g2 = bg.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
            var r2 = g2.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
            var f2 = g2.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");
            f2.property("ADBE Vector Fill Color").setValue(hex(S.pageBgColor));
            f2.property("ADBE Vector Fill Opacity").setValue(S.pageBgOpacity * 100);
            var bp = FS * 0.35;
            r2.property("ADBE Vector Rect Size").setValue([maxlw + bp * 2, LH * lines.length + bp * 1.2]);
            r2.property("ADBE Vector Rect Roundness").setValue(FS * 0.3);
            bg.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
            bg.property("ADBE Transform Group").property("ADBE Position").setValue([W / 2, CY]);
            bg.moveToEnd();
        }
        // emoji
        if (S.emoji !== false) {
            for (i = 0; i < ws.length; i++) {
                if (!ws[i].w.emoji) continue;
                var ef = emojiFootage(ws[i].w.emoji);
                if (ef) {
                    var el = pc.layers.add(ef); el.name = "emoji " + ws[i].w.emoji;
                    el.startTime = 0; el.inPoint = Math.max(0, ws[i].Sx);
                    el.property("ADBE Transform Group").property("ADBE Position").setValue([W / 2, top - FS * 0.85]);
                    var target = FS * 1.35 / ef.width * 100;
                    el.property("ADBE Transform Group").property("ADBE Scale").expression =
                        "var S=" + fmtf(Math.max(0, ws[i].Sx)) + ",T=" + fmtf(target) + "; var u=Math.min(1,Math.max(0,(time-S)/0.25))-1; var k=u*u*(3.6*u+2.6)+1; [T*k,T*k];";
                }
                break;
            }
        }

        // place line precomp in the main comp with its entrance animation
        var PL = main.layers.add(pc);
        PL.startTime = P.start; PL.inPoint = P.start; PL.outPoint = P.end;
        PL.moveBefore(ctrl); ctrl.moveToBeginning();
        var ptr = PL.property("ADBE Transform Group");
        ptr.property("ADBE Anchor Point").setValue([W / 2, CY]);
        ptr.property("ADBE Position").setValue([W / 2, CY]);
        var pa = S.pageAnim || "pop";
        var U = "var u=Math.min(1,Math.max(0,(time-inPoint)/0.2));";
        if (pa === "pop") { ptr.property("ADBE Scale").expression = U + "var v=u-1; var k=v*v*(3.2*v+2.2)+1; var s=(70+30*k); [s,s];"; ptr.property("ADBE Opacity").expression = U + "Math.min(1,u*3)*100;"; }
        if (pa === "bounce") { ptr.property("ADBE Scale").expression = U + "var v=u-1; var k=v*v*(4.2*v+3.2)+1; var s=(40+60*k); [s,s];"; ptr.property("ADBE Opacity").expression = U + "Math.min(1,u*4)*100;"; }
        if (pa === "slide") { ptr.property("ADBE Position").expression = U + "var e=1-Math.pow(1-u,3); value+[0,(1-e)*" + fmtf(FS * 0.6) + "];"; ptr.property("ADBE Opacity").expression = U + "(1-Math.pow(1-u,3))*100;"; }
        if (pa === "fade") { ptr.property("ADBE Opacity").expression = U + "(1-Math.pow(1-u,3))*100;"; }
        if ((S.shadowOpacity || 0) > 0) {
            var ds = PL.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
            ds.property("ADBE Drop Shadow-0001").setValue(hex(S.shadowColor));
            ds.property("ADBE Drop Shadow-0002").setValue(S.shadowOpacity * 255);
            ds.property("ADBE Drop Shadow-0003").setValue(180);
            ds.property("ADBE Drop Shadow-0004").setValue(Math.abs(S.shadowY || 0) * K);
            ds.property("ADBE Drop Shadow-0005").setValue((S.shadowBlur || 0) * K * 1.5);
        }
    }

    main.openInViewer();
    app.endUndoGroup();
    alert("DesiCaps: built " + DATA.pages.length + " caption lines in '" + MAIN_NAME + "'.\n\n" +
        "Pop size for ALL captions: 'CAPTION CONTROLS' layer > Pop Scale %.\n" +
        "Active-word colour: each word's 'Active Word' text animator > Fill Color.\n" +
        "Edit a word: open its CAP precomp and retype the text layer." +
        (warnings.length ? "\n\nWarnings:\n- " + warnings.join("\n- ") : ""));
})();
"""


def build_data(project, emoji_dir):
    words, style = project["words"], project["style"]
    pages = []
    for p in engine.pages(words):
        ws = []
        for i in range(p["i0"], p["i1"] + 1):
            w = words[i]
            ws.append({"t": engine.display_text(w, style), "s": round(w["start"], 3), "e": round(w["end"], 3),
                       "hl": w.get("hl", 0) or 0, "emoji": w.get("emoji") or ""})
        label = " ".join(x["t"] for x in ws)
        pages.append({"start": round(p["start"], 3), "end": round(p["end"], 3), "label": label, "words": ws})
    return {"name": project["name"], "video": project["video"].replace("\\", "/"),
            "width": project["width"], "height": project["height"], "fps": project["fps"],
            "duration": project["duration"], "style": style, "pages": pages,
            "emojiDir": os.path.abspath(emoji_dir).replace("\\", "/"),
            "emojiFiles": {w["emoji"]: (engine.emoji_file(w["emoji"]) or "").replace("\\", "/")
                           for w in words if w.get("emoji")}}


def write_jsx(project, out_path, emoji_dir):
    data = json.dumps(build_data(project, emoji_dir), ensure_ascii=True, indent=None)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(JSX.replace("__DATA__", data))
    return out_path
