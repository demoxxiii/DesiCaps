"""CI helper: download the Hinglish Whisper model from Hugging Face and convert it to a
quantised whisper.cpp (ggml) file.

usage: python scripts/convert_model.py <whisper.cpp dir> <openai-whisper dir> <out dir> [quant=q5_0]
Needs: torch (cpu), transformers<5, huggingface_hub, numpy; whisper.cpp built (whisper-quantize).
"""
import glob
import json
import os
import shutil
import subprocess
import sys

HF_MODEL = os.environ.get("HF_MODEL", "Oriserve/Whisper-Hindi2Hinglish-Apex")
OUT_NAME = "ggml-hinglish-apex-{q}.bin"


def main():
    wcpp, owhisper, out = sys.argv[1:4]
    quant = sys.argv[4] if len(sys.argv) > 4 else "q5_0"
    os.makedirs(out, exist_ok=True)

    from huggingface_hub import snapshot_download
    d = snapshot_download(HF_MODEL, allow_patterns=["*.json", "*.safetensors", "*.bin", "*.txt", "*.model"],
                          local_dir="hf-model")
    print("downloaded", d, os.listdir(d))

    # the converter needs vocab.json + added_tokens.json next to the weights
    if not os.path.exists(os.path.join(d, "vocab.json")) or not os.path.exists(os.path.join(d, "added_tokens.json")):
        from transformers import WhisperTokenizer
        tok = WhisperTokenizer.from_pretrained(d)
        tok.save_pretrained(d)
        if not os.path.exists(os.path.join(d, "added_tokens.json")):
            json.dump(tok.get_added_vocab(), open(os.path.join(d, "added_tokens.json"), "w"))
    cfg = json.load(open(os.path.join(d, "config.json")))
    print("config: layers enc/dec", cfg.get("encoder_layers"), cfg.get("decoder_layers"), "mels", cfg.get("num_mel_bins"))

    subprocess.run([sys.executable, os.path.join(wcpp, "models", "convert-h5-to-ggml.py"), d, owhisper, out],
                   check=True)
    f16 = os.path.join(out, "ggml-model.bin")
    assert os.path.exists(f16), "conversion produced no ggml-model.bin"

    q = glob.glob(os.path.join(wcpp, "build", "bin", "*quantize*"))
    q = [p for p in q if os.access(p, os.X_OK)]
    assert q, "whisper-quantize not built"
    final = os.path.join(out, OUT_NAME.format(q=quant))
    subprocess.run([q[0], f16, final, quant], check=True)
    os.remove(f16)
    print("model ready:", final, os.path.getsize(final) >> 20, "MB")
    shutil.rmtree("hf-model", ignore_errors=True)


if __name__ == "__main__":
    main()
