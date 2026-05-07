import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc faster-whisper bridge")
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="en")
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(f"failed to import faster_whisper: {exc}", file=sys.stderr)
        return 2

    model_kwargs = {
        "device": args.device,
        "compute_type": args.compute_type,
    }
    if args.device == "cpu" and args.threads > 0:
        model_kwargs["cpu_threads"] = args.threads

    try:
        model = WhisperModel(args.model, **model_kwargs)
        segments, _info = model.transcribe(
            args.audio,
            language=args.language,
            beam_size=1,
            vad_filter=True,
            word_timestamps=False,
        )

        payload = {
            "transcription": [
                {
                    "offsets": {
                        "from": int(segment.start * 1000),
                        "to": int(segment.end * 1000),
                    },
                    "text": segment.text,
                }
                for segment in segments
            ]
        }

        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        return 0
    except Exception as exc:
        print(f"faster-whisper transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
