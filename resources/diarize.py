#!/usr/bin/env python3
"""
Speaker diarization using pyannote.audio.
Input: path to a WAV file (first argument)
Output: JSON to stdout with speaker segments
"""
import sys
import json
import os

def resolve_device(pipeline):
    preferred = os.environ.get("PYANNOTE_DEVICE", "").strip().lower()

    try:
        import torch
    except ImportError:
        return None

    if preferred:
        if preferred == "cpu":
            return None
        return torch.device(preferred)

    if torch.cuda.is_available():
        return torch.device("cuda")

    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")

    return None

def resolve_annotation(diarization):
    if hasattr(diarization, "speaker_diarization") and diarization.speaker_diarization is not None:
        return diarization.speaker_diarization

    if hasattr(diarization, "exclusive_speaker_diarization") and diarization.exclusive_speaker_diarization is not None:
        return diarization.exclusive_speaker_diarization

    return diarization

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

    pipeline_source = os.environ.get("PYANNOTE_PIPELINE", "").strip() or "pyannote/speaker-diarization-community-1"
    hf_token = os.environ.get("HF_TOKEN", "") or os.environ.get("HUGGINGFACE_TOKEN", "") or None
    os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")

    pipeline_kwargs = {}
    if os.path.exists(pipeline_source):
        pipeline_kwargs["token"] = None
    else:
        pipeline_kwargs["token"] = hf_token

    pipeline = Pipeline.from_pretrained(
        pipeline_source,
        **pipeline_kwargs,
    )

    if pipeline is None:
        print("Failed to load speaker diarization pipeline.", file=sys.stderr)
        print("1. Bundle community-1 into the app build or set PYANNOTE_PIPELINE to a local snapshot", file=sys.stderr)
        print("2. If using a remote Hugging Face repo, set HF_TOKEN/HUGGINGFACE_TOKEN", file=sys.stderr)
        sys.exit(1)

    target_device = resolve_device(pipeline)
    if target_device is not None and hasattr(pipeline, "to"):
        try:
            pipeline.to(target_device)
            print(json.dumps({"device": str(target_device)}), file=sys.stderr)
        except Exception as exc:
            print(
                json.dumps({"warning": f"Failed to move diarization pipeline to {target_device}: {exc}"}),
                file=sys.stderr,
            )

    # Run diarization
    diarization = pipeline(wav_path)
    annotation = resolve_annotation(diarization)

    if not hasattr(annotation, "itertracks"):
        print(
            json.dumps({"error": f"Unsupported diarization output type: {type(diarization).__name__}"}),
            file=sys.stderr,
        )
        sys.exit(1)

    # Collect segments by speaker
    speakers = {}
    for turn, _, speaker in annotation.itertracks(yield_label=True):
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
