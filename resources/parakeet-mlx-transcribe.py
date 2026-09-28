#!/usr/bin/env python3
"""Non-English macOS bridge: Parakeet TDT 0.6B v3 via parakeet-mlx.

Same CLI and JSON contract as mlx-whisper-transcribe.py. Parakeet has no
language argument; the meeting language drives routing and notes, never a
decoder token, so --language is accepted only to keep the contract.
"""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc Parakeet MLX bridge")
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    try:
        from parakeet_mlx import from_pretrained
    except Exception as exc:
        print(f"failed to import parakeet_mlx: {exc}", file=sys.stderr)
        return 2

    try:
        model = from_pretrained(args.model)
        # The app already windows long meetings. Omit chunk_duration: in
        # parakeet-mlx, chunk_duration=0 yields empty windows and no segments.
        result = model.transcribe(args.audio)
        payload = {
            "transcription": [
                {
                    "offsets": {
                        "from": int(float(getattr(sentence, "start", 0)) * 1000),
                        "to": int(float(getattr(sentence, "end", 0)) * 1000),
                    },
                    "text": getattr(sentence, "text", "") or "",
                }
                for sentence in (getattr(result, "sentences", None) or [])
            ]
        }

        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        return 0
    except Exception as exc:
        print(f"parakeet-mlx transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
