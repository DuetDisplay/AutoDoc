#!/usr/bin/env python3
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc MLX Whisper bridge")
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    try:
        import mlx_whisper
    except Exception as exc:
        print(f"failed to import mlx_whisper: {exc}", file=sys.stderr)
        return 2

    try:
        result = mlx_whisper.transcribe(
            args.audio,
            path_or_hf_repo=args.model,
            language=args.language,
            verbose=False,
            word_timestamps=False,
        )
        payload = {
            "transcription": [
                {
                    "offsets": {
                        "from": int(float(segment.get("start", 0)) * 1000),
                        "to": int(float(segment.get("end", 0)) * 1000),
                    },
                    "text": segment.get("text", ""),
                }
                for segment in result.get("segments", [])
            ]
        }

        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        return 0
    except Exception as exc:
        print(f"mlx-whisper transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
