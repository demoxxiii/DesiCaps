"""Auto emphasis + emoji (and optional spelling clean-up) with a local Ollama model."""
import json
import re
import urllib.request

import engine

PROMPT = """You style short-form video captions for Indian creators. The captions are Hinglish
(Hindi written in Roman script, mixed with English). Each word below has its index in [brackets].

For every caption line, decide:
- "hl": index of 0-1 word that carry the MEANING punch: numbers, money, names/brands, strong
  verbs, key nouns, emotional words. NEVER pick filler words (hai, ki, ka, ke, ko, ne, mein, se, ho,
  toh, aur, ye, wo, jab, tab, ek, just, the, a, is, gaya, diya, raha). Use [] when nothing stands
  out - only about HALF the lines should get a highlight.
- "emoji": ONE emoji that matches the MEANING of that line (money -> 💰, shock -> 😱, fire/hype -> 🔥,
  leak/secret -> 🤫, game -> 🎮, date -> 📅) or "". Only on about 1 line in 4, never on filler lines.
{fix}
Reply with JSON only: {{"lines":[{{"i":0,"hl":[1],"emoji":""{fixkey}}}, ...]}}

Lines:
{lines}"""

STOP = set("""hai hain ki ka ke ko ne mein me se ho toh to aur ye yeh wo woh jab tab ek just the a an is are
was of and or but in on at for with bhi hi na nahi kya ab par pe kar karo raha rahe rahi tha the thi
gaya gayi gaye diya di diye aa aaya aaye rakh rakha hua hui hue hota hoti sach soch lekin phir fir
bas sab kuch koi apna apne mera meri tera teri uska uski unka unki hum ham tum aap main""".split())

FIX = """- "text": the same line with obvious Hinglish spelling mistakes fixed (keep the SAME number of
  words, keep casual spelling like "hai", "kya", "bhai"; do not translate)."""


def emoji_code(ch):
    """'🔥' -> '1f525' (Twemoji file name)."""
    return "-".join(f"{ord(c):x}" for c in ch if ord(c) != 0xFE0F)


def call(url, model, prompt):
    req = urllib.request.Request(url + "/api/chat", data=json.dumps({
        "model": model, "stream": False, "format": "json", "options": {"temperature": 0.2},
        "messages": [{"role": "user", "content": prompt}]}).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(json.load(r)["message"]["content"])


def enhance(words, url, model, progress=None, fix_spelling=False, batch=40):
    if not model:
        raise RuntimeError("No Ollama model selected - open 'Local AI setup' on the home screen")
    pgs = engine.pages(words)
    for b in range(0, len(pgs), batch):
        chunk = pgs[b:b + batch]
        lines = "\n".join(f"L{n}: " + " ".join(f"[{k}]{words[i]['text']}" for k, i in enumerate(range(p["i0"], p["i1"] + 1)))
                          for n, p in enumerate(chunk))
        prompt = PROMPT.format(fix=FIX if fix_spelling else "", fixkey=',"text":"..."' if fix_spelling else "",
                               lines=lines)
        try:
            res = call(url, model, prompt).get("lines", [])
        except Exception as e:
            raise RuntimeError(f"Ollama call failed: {e}")
        for item in res:
            try:
                n = int(str(item.get("i")).lstrip("L"))
                p = chunk[n]
            except Exception:
                continue
            idxs = list(range(p["i0"], p["i1"] + 1))
            for j in (item.get("hl", []) or [])[:1]:  # max one punch word per line
                if isinstance(j, int) and 0 <= j < len(idxs):
                    if re.sub(r"[^\w]", "", words[idxs[j]]["text"].lower()) not in STOP:
                        words[idxs[j]]["hl"] = 1
            em = (item.get("emoji") or "").strip()
            if em and not re.match(r"^[\w\s]+$", em):
                words[idxs[0]]["emoji"] = emoji_code(em[:4].strip())
            if fix_spelling and isinstance(item.get("text"), str):
                new = item["text"].split()
                if len(new) == len(idxs):
                    for i, t in zip(idxs, new):
                        words[i]["text"] = t
        if progress:
            progress(min(1.0, (b + batch) / len(pgs)), "AI styling captions")
    return words
