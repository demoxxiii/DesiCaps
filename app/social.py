"""Post kit: hook titles, platform captions, hashtags and a summary from the transcript (local Ollama)."""
import json

import enhance

PROMPT = """You are a social media writer for an Indian creator who talks in Hinglish
(Hindi in Roman script mixed with English). Below is the transcript of one video.

Write in the SAME casual Hinglish the creator speaks - Hindi sentences in Roman script with English
keywords mixed in (example style: "GTA 6 delay ho gaya? Physical disc milegi ya nahi 😱"). Do NOT
write pure English except for the YouTube title keywords and hashtags. No Devanagari.
- "hooks": 5 scroll-stopping title / on-screen hook options, max 60 characters each.
- "instagram": an Instagram Reels caption, 2-4 short lines, 1-3 emojis, ends with a question or CTA.
- "youtube_title": one YouTube title, max 70 characters, curiosity + keyword.
- "youtube_description": 3-5 sentences summarising the video for the description box.
- "shorts_title": one YouTube Shorts title, max 60 characters.
- "hashtags": 12-15 relevant hashtags about the TOPIC (mix of broad + niche + India-specific), each
  starting with #. No generic tags like #hinglish or #video.
- "summary": one plain-English sentence describing the video.

Only use facts that are in the transcript. Reply with JSON only, using exactly those keys.

Transcript:
{text}"""


def make_kit(words, url, model, progress=None):
    if not model:
        raise RuntimeError("No Ollama model selected - open 'Local AI setup' on the home screen")
    text = " ".join(w["text"] for w in words)
    if not text.strip():
        raise RuntimeError("Transcribe the video first")
    if progress:
        progress(0.2, "Writing hooks, captions and hashtags")
    res = enhance.call(url, model, PROMPT.format(text=text[:12000]))
    kit = {
        "hooks": [str(h) for h in (res.get("hooks") or [])][:8],
        "instagram": str(res.get("instagram") or ""),
        "youtube_title": str(res.get("youtube_title") or ""),
        "youtube_description": str(res.get("youtube_description") or ""),
        "shorts_title": str(res.get("shorts_title") or ""),
        "hashtags": [("#" + str(h).lstrip("#")).replace(" ", "") for h in (res.get("hashtags") or [])][:20],
        "summary": str(res.get("summary") or ""),
        "model": model,
    }
    if progress:
        progress(1.0, "Done")
    return kit


def kit_to_text(kit):
    lines = ["HOOK OPTIONS"] + [f"{i}. {h}" for i, h in enumerate(kit.get("hooks", []), 1)]
    lines += ["", "INSTAGRAM CAPTION", kit.get("instagram", ""), "", "YOUTUBE TITLE", kit.get("youtube_title", ""),
              "", "YOUTUBE DESCRIPTION", kit.get("youtube_description", ""), "", "SHORTS TITLE",
              kit.get("shorts_title", ""), "", "HASHTAGS", " ".join(kit.get("hashtags", [])), "", "SUMMARY",
              kit.get("summary", "")]
    return "\n".join(lines)


if __name__ == "__main__":
    print(json.dumps(kit_to_text({"hooks": ["a", "b"], "hashtags": ["#x"]})))
