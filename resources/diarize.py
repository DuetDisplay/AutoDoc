#!/usr/bin/env python3
"""
Speaker diarization using pyannote.audio.
Input: path to a WAV file (first argument)
Output: JSON to stdout with speaker segments
"""
import sys
import json
import os

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: diarize.py <wav_path>"}), file=sys.stderr)
        sys.exit(1)

    wav_path = sys.argv[1]
    if not os.path.exists(wav_path):
        print(json.dumps({"error": f"File not found: {wav_path}"}), file=sys.stderr)
        sys.exit(1)

    # Import here so errors are caught gracefully
    try:
        from pyannote.audio import Pipeline
    except ImportError as e:
        print(json.dumps({"error": f"pyannote.audio not installed: {e}"}), file=sys.stderr)
        sys.exit(1)

    # Use pretrained pipeline — downloads model on first use
    # Model is cached in ~/.cache/torch/pyannote/ by default
    hf_token = os.environ.get("HF_TOKEN", "") or None
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=hf_token,
    )

    if pipeline is None:
        print("Failed to load pipeline. The pyannote/speaker-diarization-3.1 model is gated.", file=sys.stderr)
        print("1. Accept conditions at https://hf.co/pyannote/speaker-diarization-3.1", file=sys.stderr)
        print("2. Set HF_TOKEN environment variable with your HuggingFace token", file=sys.stderr)
        sys.exit(1)

    # Run diarization
    diarization = pipeline(wav_path)

    # Collect segments by speaker
    speakers = {}
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        if speaker not in speakers:
            speakers[speaker] = {"id": speaker, "segments": []}
        speakers[speaker]["segments"].append({
            "start": round(turn.start, 3),
            "end": round(turn.end, 3),
        })

    result = {"speakers": list(speakers.values())}
    print(json.dumps(result))

if __name__ == "__main__":
    main()
