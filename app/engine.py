"""DesiCaps caption engine (Python side).

Mirrors static/engine.js exactly: same grouping, layout and animation maths,
so the MP4 render matches the browser preview.
"""
import math
import os
import re
import urllib.request
import sys
from functools import lru_cache

import paths

_BIN = paths.BIN_DIR
if sys.platform.startswith("win") and os.path.isdir(_BIN):  # fribidi-0.dll for Devanagari shaping
    os.environ["PATH"] = _BIN + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(_BIN)
    except Exception:
        pass

from PIL import Image, ImageDraw, ImageFilter, ImageFont, features  # noqa: E402

HAS_RAQM = features.check("raqm")

FONT_DIR = paths.FONT_DIR
EMOJI_DIR = paths.EMOJI_DIR

PAGE_IN = 0.20      # seconds for page entrance
WORD_POP = 0.14     # seconds for active-word pop
PAGE_HOLD = 0.60    # max seconds a page lingers after its last word
PUNCT_RE = re.compile(r"^[\"'“‘(\[]+|[\"'”’)\],.!?;:।…]+$")


# ---------------------------------------------------------------- grouping
def display_text(word, style):
    t = word.get("text", "")
    if style.get("stripPunct", True):
        t = PUNCT_RE.sub("", t) or t
    if style.get("uppercase"):
        t = t.upper()
    return t


def regroup(words, style):
    """Set the 'brk' flag (start of a new caption page) on words."""
    per = max(1, int(style.get("wordsPerPage", 3)))
    max_chars = int(style.get("maxChars", 18))
    count, chars = 0, 0
    for i, w in enumerate(words):
        new = i == 0
        if not new:
            prev = words[i - 1]
            gap = w["start"] - prev["end"]
            wl = len(w["text"])
            if count >= per or chars + 1 + wl > max_chars or gap > 0.45:
                new = True
            elif re.search(r"[.!?।]$", prev["text"]):
                new = True
        if new:
            count, chars = 0, -1
        w["brk"] = new
        count += 1
        chars += 1 + len(w["text"])
    return words


def pages(words):
    out = []
    for i, w in enumerate(words):
        if i == 0 or w.get("brk"):
            out.append({"i0": i, "i1": i})
        else:
            out[-1]["i1"] = i
    for k, p in enumerate(out):
        p["start"] = words[p["i0"]]["start"]
        last_end = words[p["i1"]]["end"]
        end = last_end + PAGE_HOLD
        if k + 1 < len(out):
            end = min(end, words[out[k + 1]["i0"]]["start"])
        p["end"] = max(end, last_end)
    return out


# ---------------------------------------------------------------- easing
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def ease_out_back(u, s=1.70158):
    u = clamp(u) - 1
    return u * u * ((s + 1) * u + s) + 1


def ease_out_cubic(u):
    u = clamp(u)
    return 1 - (1 - u) ** 3


def page_anim(style, u):
    """-> (scale, opacity, yoffset_factor)  yoffset in units of font size."""
    a = style.get("pageAnim", "pop")
    if a == "none" or u >= 1:
        return 1.0, 1.0, 0.0
    if a == "pop":
        return 0.7 + 0.3 * ease_out_back(u, 2.2), clamp(u * 3), 0.0
    if a == "bounce":
        return 0.4 + 0.6 * ease_out_back(u, 3.2), clamp(u * 4), 0.0
    if a == "slide":
        e = ease_out_cubic(u)
        return 1.0, e, (1 - e) * 0.6
    if a == "fade":
        return 1.0, ease_out_cubic(u), 0.0
    return 1.0, 1.0, 0.0


def word_scale(style, active, t, wstart):
    if not active or style.get("wordAnim", "pop") == "none":
        return 1.0
    s = float(style.get("activeScale", 1.1))
    return 1 + (s - 1) * ease_out_back((t - wstart) / WORD_POP, 2.5)


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# ---------------------------------------------------------------- fonts / emoji
@lru_cache(maxsize=256)
def font(name, px):
    return ImageFont.truetype(os.path.join(FONT_DIR, name + ".ttf"), max(1, int(round(px))))


def emoji_file(code):
    """Path of an emoji PNG: bundled set first, then the user cache (fetched once when online)."""
    code = "".join(c for c in code.lower() if c in "0123456789abcdef-")
    for d in (EMOJI_DIR, paths.EMOJI_CACHE):
        p = os.path.join(d, code + ".png")
        if os.path.exists(p):
            return p
    try:
        url = f"https://raw.githubusercontent.com/jdecked/twemoji/main/assets/72x72/{code}.png"
        p = os.path.join(paths.EMOJI_CACHE, code + ".png")
        urllib.request.urlretrieve(url, p)
        return p
    except Exception:
        return None


@lru_cache(maxsize=512)
def emoji_img(code, px):
    path = emoji_file(code)
    if not path:
        return None
    im = Image.open(path).convert("RGBA")
    return im.resize((max(1, int(px)), max(1, int(px))), Image.LANCZOS)


# ---------------------------------------------------------------- layout
def unit(W, H):
    return min(W, H) / 1080.0


def layout(words, page, style, W, H):
    """Static layout of one page: list of dict(text, idx, w, cx, cy) + block box."""
    k = unit(W, H)
    fs = style["size"] * k
    f = font(style["font"], fs)
    space = f.getlength(" ") + style.get("stroke", 0) * k
    if style.get("highlight") == "box":
        space += style.get("boxPad", 14) * k
    maxw = style.get("maxWidth", 0.82) * W
    items = []
    for i in range(page["i0"], page["i1"] + 1):
        txt = display_text(words[i], style)
        items.append({"text": txt, "idx": i, "w": f.getlength(txt)})
    lines, cur, curw = [], [], 0.0
    for it in items:
        add = it["w"] + (space if cur else 0)
        if cur and curw + add > maxw:
            lines.append((cur, curw))
            cur, curw = [], 0.0
            add = it["w"]
        cur.append(it)
        curw += add
    if cur:
        lines.append((cur, curw))
    lh = fs * style.get("lineHeight", 1.12)
    cy = style.get("posY", 0.7) * H
    top = cy - lh * len(lines) / 2
    maxlw = 0
    for li, (ln, lw) in enumerate(lines):
        x = W / 2 - lw / 2
        maxlw = max(maxlw, lw)
        for it in ln:
            it["cx"] = x + it["w"] / 2
            it["cy"] = top + li * lh + lh / 2
            x += it["w"] + space
    box = (W / 2 - maxlw / 2, top, W / 2 + maxlw / 2, top + lh * len(lines))
    return items, box, fs, cy


def active_index(words, page, t):
    a = None
    for i in range(page["i0"], page["i1"] + 1):
        if words[i]["start"] <= t:
            a = i
    return a


def frame_state(project, t, pgs=None):
    """Quantised description of what is visible at t (used as a cache key)."""
    words = project["words"]
    style = project["style"]
    pgs = pgs if pgs is not None else pages(words)
    for pi, p in enumerate(pgs):
        if p["start"] <= t < p["end"]:
            a = active_index(words, p, t)
            pu = clamp((t - p["start"]) / PAGE_IN)
            wu = clamp((t - words[a]["start"]) / WORD_POP) if a is not None else 1
            return (pi, a, round(pu, 3), round(wu, 3))
    return None


# ---------------------------------------------------------------- drawing
def draw_frame(project, t, W, H, pgs=None, oy=0, bh=None):
    """RGBA image (W x bh) of captions at time t; the band starts at y=oy. None if empty."""
    words = project["words"]
    style = project["style"]
    pgs = pgs if pgs is not None else pages(words)
    page = next((p for p in pgs if p["start"] <= t < p["end"]), None)
    if page is None:
        return None
    k = unit(W, H)
    items, box, fs, cy = layout(words, page, style, W, H)
    a = active_index(words, page, t)
    ps, pop, yoff = page_anim(style, (t - page["start"]) / PAGE_IN)
    yoff *= fs
    mode = style.get("mode", "page")
    hl = style.get("highlight", "color")

    CW, CH = W, (bh or H)
    img = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    stroke = int(round(style.get("stroke", 0) * k * ps))

    def tx(x, y):  # page-scale about the block centre
        return W / 2 + (x - W / 2) * ps, cy + (y - cy) * ps + yoff - oy

    # page background
    if style.get("pageBg"):
        pad = fs * 0.35
        x0, y0 = tx(box[0] - pad, box[1] - pad * 0.6)
        x1, y1 = tx(box[2] + pad, box[3] + pad * 0.6)
        bg = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        ImageDraw.Draw(bg).rounded_rectangle(
            (x0, y0, x1, y1), radius=fs * 0.3 * ps,
            fill=hex_rgb(style["pageBgColor"]) + (int(255 * style["pageBgOpacity"] * pop),))
        img.alpha_composite(bg)

    glyphs = []  # (text, x, y, font, fill, alpha, is_active, scale)
    for it in items:
        i = it["idx"]
        w = words[i]
        if mode == "reveal" and w["start"] > t:
            continue
        is_act = i == a
        ws = word_scale(style, is_act, t, w["start"])
        x, y = tx(it["cx"], it["cy"])
        fill = style["textColor"]
        if w.get("hl") == 1:
            fill = style["emph1"]
        elif w.get("hl") == 2:
            fill = style["emph2"]
        if is_act and hl == "color":
            fill = style["activeColor"]
        if is_act and hl == "box":
            fill = style["boxTextColor"]
        alpha = pop
        if mode == "dim" and w["start"] > t:
            alpha *= style.get("dimOpacity", 0.35)
        glyphs.append((it, x, y, fs * ps * ws, fill, alpha, is_act, ws))

    # active box (drawn under text)
    if hl == "box":
        for it, x, y, size, fill, alpha, is_act, ws in glyphs:
            if not is_act:
                continue
            pad = (style["boxPad"] + style.get("stroke", 0)) * k * ps * ws
            fnt = font(style["font"], size)
            by = y + baseline_shift(fnt)
            l, tp, r, b = fnt.getbbox(it["text"], anchor="ms")
            lay = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
            ImageDraw.Draw(lay).rounded_rectangle(
                (x + l - pad, by + tp - pad * 0.7, x + r + pad, by + b + pad * 0.7),
                radius=style["boxRadius"] * k * ps * ws,
                fill=hex_rgb(style["boxColor"]) + (int(255 * alpha),))
            img.alpha_composite(lay)

    # shadow pass
    if style.get("shadowOpacity", 0) > 0:
        sh = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        d = ImageDraw.Draw(sh)
        sc = hex_rgb(style["shadowColor"])
        sy = style.get("shadowY", 0) * k * ps
        for it, x, y, size, fill, alpha, is_act, ws in glyphs:
            fnt = font(style["font"], size)
            d.text((x, y + sy + baseline_shift(fnt)), it["text"], font=fnt, anchor="ms",
                   fill=sc + (int(255 * alpha),), stroke_width=stroke, stroke_fill=sc + (int(255 * alpha),))
        blur = style.get("shadowBlur", 0) * k
        if blur > 0:
            sh = sh.filter(ImageFilter.GaussianBlur(blur / 2))
        if style["shadowOpacity"] < 1:
            sh.putalpha(sh.getchannel("A").point(lambda v: int(v * style["shadowOpacity"])))
        img.alpha_composite(sh)

    # text pass (non-active first so the popped word sits on top)
    for g in sorted(glyphs, key=lambda g: g[6]):
        it, x, y, size, fill, alpha, is_act, ws = g
        lay = Image.new("RGBA", (CW, CH), (0, 0, 0, 0)) if alpha < 1 else img
        d = ImageDraw.Draw(lay)
        a8 = 255
        fnt = font(style["font"], size)
        d.text((x, y + baseline_shift(fnt)), it["text"], font=fnt, anchor="ms",
               fill=hex_rgb(fill) + (a8,), stroke_width=int(round(stroke * ws)),
               stroke_fill=hex_rgb(style["strokeColor"]) + (a8,))
        if lay is not img:
            lay.putalpha(lay.getchannel("A").point(lambda v, al=alpha: int(v * al)))
            img.alpha_composite(lay)

    # emoji
    if style.get("emoji", True):
        for i in range(page["i0"], page["i1"] + 1):
            code = words[i].get("emoji")
            if code and words[i]["start"] <= t + 0.001:
                u = (t - words[i]["start"]) / 0.25
                es = ease_out_back(u, 2.6)
                px = fs * 1.35 * ps * es
                if px >= 2:
                    em = emoji_img(code, int(px))
                    if em is not None:
                        ex, ey = tx(W / 2, box[1] - fs * 0.85)
                        paste_clip(img, em, int(ex - px / 2), int(ey - px / 2))
                break
    return img


def paste_clip(dst, src, x, y):
    """alpha_composite that tolerates src partly outside dst."""
    sx0, sy0 = max(0, -x), max(0, -y)
    sx1, sy1 = min(src.width, dst.width - x), min(src.height, dst.height - y)
    if sx1 <= sx0 or sy1 <= sy0:
        return
    dst.alpha_composite(src.crop((sx0, sy0, sx1, sy1)), (x + sx0, y + sy0))


def compute_band(project, W, H):
    """Vertical band (oy, bh) that contains every caption frame, incl. pops + emoji."""
    words, style = project["words"], project["style"]
    y0, y1 = H, 0
    for p in pages(words):
        items, box, fs, cy = layout(words, p, style, W, H)
        grow = max(1.35, float(style.get("activeScale", 1.1)) * 1.25)
        top = cy - (cy - box[1]) * grow - fs * 1.9
        bot = cy + (box[3] - cy) * grow + fs * 0.9
        y0, y1 = min(y0, top), max(y1, bot)
    if y1 <= y0:
        return 0, H
    y0 = max(0, int(y0)) & ~1
    y1 = min(H, int(y1) + 2) & ~1
    return y0, max(2, y1 - y0)
