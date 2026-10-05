#!/usr/bin/env python3
"""EU-language bridge: Canary-1B-v2 via mlx-audio.

Same CLI and JSON contract as mlx-whisper-transcribe.py. The meeting language
is pinned as both source and target, so Canary transcribes (never translates)
and cannot drift into English. Silero VAD splits the audio into speech spans of
at most 25 seconds; silence is never decoded, and each span's text is timed by
its span.
"""
import argparse
import os
from pathlib import Path
import json
import sys

MAX_SPEECH_SEC = 25
SAMPLE_RATE = 16000


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc Canary MLX bridge")
    parser.add_argument("--model", required=True)
    parser.add_argument("--vad", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", required=True)
    args = parser.parse_args()
    # Setup owns downloads; a recording must never contact Hugging Face.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if not Path(args.model).is_dir():
        print("speech model is missing; select the language in Settings to download it", file=sys.stderr)
        return 1

    try:
        import tempfile
        from pathlib import Path

        import numpy as np
        import onnx_asr
        import soundfile as sf
        from mlx_audio.stt import load
        from onnx_asr.utils import pad_list
    except Exception as exc:
        print(f"failed to import canary runtime: {exc}", file=sys.stderr)
        return 2

    try:
        audio, rate = sf.read(args.audio, dtype="float32")
        if rate != SAMPLE_RATE or audio.ndim != 1:
            raise ValueError(f"expected {SAMPLE_RATE} Hz mono audio, got {rate} Hz with shape {audio.shape}")

        vad = onnx_asr.load_vad("silero", path=args.vad, providers=["CPUExecutionProvider"])
        waveforms, lengths = pad_list([audio])
        spans = list(
            next(vad.segment_batch(waveforms, lengths, rate, max_speech_duration_s=MAX_SPEECH_SEC))
        )

        model = load(args.model)
        segments = []
        with tempfile.TemporaryDirectory() as scratch:
            span_path = str(Path(scratch) / "span.wav")
            for start, end in spans:
                start, end = int(start), int(end)
                if end <= start:
                    continue
                sf.write(span_path, audio[start:end], rate)
                text = model.generate(
                    span_path,
                    source_lang=args.language,
                    target_lang=args.language,
                    max_tokens=256,
                ).text.strip()
                if not text:
                    continue
                segments.append(
                    {
                        "offsets": {
                            "from": round(start * 1000 / rate),
                            "to": round(end * 1000 / rate),
                        },
                        "text": text,
                    }
                )

        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump({"transcription": segments}, handle, ensure_ascii=False)
        print(f"spans={len(spans)} segments={len(segments)}", file=sys.stderr)
        return 0
    except Exception as exc:
        print(f"canary-mlx transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
