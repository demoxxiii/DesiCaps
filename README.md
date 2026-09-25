# DesiCaps Studio

**Free, offline Hinglish caption studio for Reels & Shorts, for Windows and Mac.**

DesiCaps transcribes your video in Hinglish ("bhai ye trick kamaal ki hai") with word-level timing. It then animates the captions in the style of the popular caption apps, and exports an MP4, an editable After Effects project or an SRT. Everything runs on your own computer. There's no upload, no account and no watermark.

➡ **Download:** see [Releases](../../releases/latest)
- Windows 10/11: `DesiCaps-Windows-Setup.exe`
- Mac (Apple Silicon): `DesiCaps-Mac-AppleSilicon.dmg`

## Features
- Hinglish speech-to-text with [Oriserve Whisper-Hindi2Hinglish-Apex](https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Apex) running on [whisper.cpp](https://github.com/ggml-org/whisper.cpp). It uses the GPU through Vulkan on Windows and Metal on Mac, and falls back to the CPU.
- Optional Hindi (Devanagari) and English engines, each a one-time download.
- 9 animated caption styles. Every font, colour, stroke, shadow, box highlight and animation can be edited.
- Word-level editor with a timeline, find & replace, emphasis colours, emoji and undo/redo.
- Exports: MP4 (hardware encoding where available: NVENC, AMF, QuickSync or VideoToolbox), After Effects `.jsx` (native, editable layers), and SRT.
- Optional local AI through [Ollama](https://ollama.com):
  - **AI Style** picks punch words and emoji.
  - **Post kit** writes hooks, captions and hashtags.

## First launch (unsigned app)
- **Windows:** if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
- **Mac:** right-click the app and choose **Open**. On macOS 15+, go to **System Settings → Privacy & Security → Open Anyway**.

## How releases are built
Pushing a tag like `v1.0.1` runs `.github/workflows/build.yml`, which:
1. downloads the Hinglish model from Hugging Face and converts it to a quantised whisper.cpp file (the result is cached);
2. builds `whisper-cli` for Windows (CPU and Vulkan GPU) and for macOS arm64 (Metal);
3. bundles FFmpeg, the fonts, the full Twemoji set and the model with PyInstaller;
4. makes the Windows installer (Inno Setup) and the Mac DMG, and attaches both to a GitHub Release.

On Windows, `publish_to_github.bat` does the whole publish in one step: first release or new version.

## Develop
```
pip install -r requirements.txt
python app/desktop.py            # native window
python app/server.py             # or just the web UI at http://127.0.0.1:7870
```
For local transcription, put `whisper-cli` (and optionally `whisper-cli-gpu`) in `bin/` and the model in `models/`.

## Project layout
```
app/            Python backend (FastAPI) + web UI (app/static)
  engine.py     caption layout/animation (mirrors static/engine.js)
  render.py     MP4 renderer (Pillow + FFmpeg)
  transcribe.py whisper.cpp runner + word timing
  ae_export.py  After Effects script generator
  desktop.py    native window (pywebview)
assets/         fonts (OFL/Apache), emoji (Twemoji, CC-BY 4.0)
packaging/      PyInstaller spec, Inno Setup script, DMG script, icons
scripts/        CI helpers (model conversion, fribidi, emoji)
website/        download page for your site
```

## License
DesiCaps Studio is GPL-3.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bundled components.
