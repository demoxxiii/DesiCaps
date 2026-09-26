// DesiCaps for Premiere Pro — ExtendScript side (runs inside Premiere).
// Called from the panel with evalScript; every function returns a JSON string.

function dc_json(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") {
        return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(dc_json(v[i]));
        return "[" + a.join(",") + "]";
    }
    var o = [];
    for (var k in v) if (v.hasOwnProperty(k)) o.push(dc_json(k) + ":" + dc_json(v[k]));
    return "{" + o.join(",") + "}";
}

function dc_err(msg) { return dc_json({ ok: false, error: msg }); }

function dc_seqInfo(seq) {
    var fps = 30;
    try {
        var fr = seq.getSettings().videoFrameRate.seconds;
        if (fr > 0) fps = 1 / fr;
    } catch (e) {
        try { fps = 254016000000 / Number(seq.timebase); } catch (e2) {}
    }
    return {
        name: seq.name,
        width: Number(seq.frameSizeHorizontal),
        height: Number(seq.frameSizeVertical),
        fps: Math.round(fps * 1000) / 1000,
        playhead: seq.getPlayerPosition().seconds
    };
}

function dc_clipInfo(item, kind, trackIndex) {
    var speed = 1;
    try { speed = item.getSpeed(); } catch (e) {}
    return {
        name: item.name,
        kind: kind,
        track: trackIndex,
        path: item.projectItem ? item.projectItem.getMediaPath() : "",
        start: item.start.seconds,
        end: item.end.seconds,
        inPoint: item.inPoint.seconds,
        outPoint: item.outPoint.seconds,
        speed: speed
    };
}

/** Active sequence + the selected clip (or the clip under the playhead). */
function dc_info() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return dc_err("Open a sequence first.");
        var info = dc_seqInfo(seq);
        var clip = null, i, j, t, all = [];
        // 1) selected clips (video first, then audio)
        try {
            var sel = seq.getSelection();
            for (i = 0; sel && i < sel.length; i++) {
                var s0 = sel[i];
                if (!s0 || !s0.projectItem) continue;
                var mp = ""; try { mp = s0.projectItem.getMediaPath(); } catch (e0) {}
                if (!mp) continue;
                all.push(dc_clipInfo(s0, s0.mediaType === "Video" ? "video" : "audio", -1));
            }
            for (i = 0; sel && i < sel.length; i++) {
                var it = sel[i];
                if (it && it.projectItem && it.mediaType === "Video") { clip = dc_clipInfo(it, "video", -1); break; }
            }
            if (!clip) for (i = 0; sel && i < sel.length; i++) {
                if (sel[i] && sel[i].projectItem) { clip = dc_clipInfo(sel[i], "audio", -1); break; }
            }
        } catch (e) {}
        // 2) otherwise: the clip under the playhead (top-most video track, then audio)
        if (!clip) {
            var ph = info.playhead;
            for (i = seq.videoTracks.numTracks - 1; i >= 0 && !clip; i--) {
                t = seq.videoTracks[i];
                for (j = 0; j < t.clips.numItems; j++) {
                    var c = t.clips[j];
                    if (c.projectItem && c.start.seconds <= ph && ph < c.end.seconds && c.projectItem.getMediaPath()) {
                        clip = dc_clipInfo(c, "video", i); break;
                    }
                }
            }
            for (i = 0; i < seq.audioTracks.numTracks && !clip; i++) {
                t = seq.audioTracks[i];
                for (j = 0; j < t.clips.numItems; j++) {
                    var a = t.clips[j];
                    if (a.projectItem && a.start.seconds <= ph && ph < a.end.seconds && a.projectItem.getMediaPath()) {
                        clip = dc_clipInfo(a, "audio", i); break;
                    }
                }
            }
        }
        info.ok = true;
        info.clip = clip;
        info.clips = all;
        return dc_json(info);
    } catch (e) {
        return dc_err("Premiere error: " + e.toString());
    }
}

function dc_bin() {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        if (c && c.type === ProjectItemType.BIN && c.name === "DesiCaps") return c;
    }
    var b = root.createBin("DesiCaps");
    if (b) return b;
    for (i = 0; i < root.children.numItems; i++) {
        if (root.children[i].type === ProjectItemType.BIN && root.children[i].name === "DesiCaps") return root.children[i];
    }
    return root;
}

function dc_norm(p) { return String(p).replace(/\\/g, "/").toLowerCase(); }

function dc_import(path) {
    var bin = dc_bin();
    app.project.importFiles([path], true, bin, false);
    var want = dc_norm(path);
    for (var i = bin.children.numItems - 1; i >= 0; i--) {
        var c = bin.children[i];
        try { if (c && dc_norm(c.getMediaPath()) === want) return c; } catch (e) {}
    }
    return null;
}

function dc_time(sec) { var t = new Time(); t.seconds = sec; return t; }

/** Try to set a clip's Opacity blend mode to Difference (for the negative-text layer). */
function dc_setDifference(clip) {
    try {
        for (var i = 0; i < clip.components.numItems; i++) {
            var c = clip.components[i];
            if (c.displayName !== "Opacity" && c.matchName !== "AE.ADBE Opacity") continue;
            for (var j = 0; j < c.properties.numItems; j++) {
                var p = c.properties[j];
                if (p.displayName === "Blend Mode") {
                    // Premiere's internal code for "Difference"
                    p.setValue(22, true);
                    return true;
                }
            }
        }
    } catch (e) {}
    return false;
}

/** Put the caption layer (.mov with alpha) on a new video track above everything, at `start` seconds. */
function dc_place(path, start, blend) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return dc_err("Open a sequence first.");
        var item = dc_import(path);
        if (!item) return dc_err("Couldn't import " + path);
        var before = seq.videoTracks.numTracks;
        try {
            app.enableQE();
            qe.project.getActiveSequence().addTracks(1, before, 0, 1, seq.audioTracks.numTracks, 0, 0);
        } catch (e) {}
        var track = seq.videoTracks[seq.videoTracks.numTracks - 1];
        if (seq.videoTracks.numTracks === before) {
            // couldn't add a track: use the top-most track that is empty over this range
            track = null;
            for (var i = seq.videoTracks.numTracks - 1; i >= 0 && !track; i--) {
                var t = seq.videoTracks[i], free = true;
                for (var j = 0; j < t.clips.numItems; j++) {
                    if (t.clips[j].end.seconds > start && t.clips[j].start.seconds < start + 1) { free = false; break; }
                }
                if (free) track = t;
            }
            if (!track) return dc_err("No free video track. Add an empty track above your video and try again.");
        }
        track.overwriteClip(item, dc_time(start));
        var blended = false;
        if (blend === "difference") {
            for (var k = 0; k < track.clips.numItems; k++) {
                var cl = track.clips[k];
                if (Math.abs(cl.start.seconds - start) < 0.05 && cl.projectItem && dc_norm(cl.projectItem.getMediaPath()) === dc_norm(path)) {
                    blended = dc_setDifference(cl); break;
                }
            }
        }
        return dc_json({ ok: true, track: track.name, blend: blended });
    } catch (e) {
        return dc_err("Premiere error: " + e.toString());
    }
}

/** Import an .srt and create a Premiere caption track starting at `start` seconds. */
function dc_captions(path, start) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return dc_err("Open a sequence first.");
        var item = dc_import(path);
        if (!item) return dc_err("Couldn't import " + path);
        if (typeof seq.createCaptionTrack !== "function") return dc_err("This Premiere version can't create caption tracks from scripts. The .srt is in the DesiCaps bin — drag it onto the timeline.");
        var fmt = (typeof Sequence !== "undefined" && Sequence.CAPTION_FORMAT_SUBTITLE) ? Sequence.CAPTION_FORMAT_SUBTITLE : undefined;
        var r = fmt !== undefined ? seq.createCaptionTrack(item, start, fmt) : seq.createCaptionTrack(item, start);
        return dc_json({ ok: !!r || r === undefined });
    } catch (e) {
        return dc_err("Premiere error: " + e.toString());
    }
}

function dc_version() { return dc_json({ ok: true, version: app.version, os: $.os }); }
