#!/usr/bin/env python3
"""Japanese / Simplified Chinese / Korean bridge: Whisper large-v3-turbo via mlx-whisper.

Same CLI and JSON contract as mlx-whisper-transcribe.py, which stays the English
(Distil) bridge. Decode contract: the language is pinned, audio is split at
pauses into clips of at most 30 seconds (a forced cut overlaps the next clip),
and each clip is decoded without conditioning on previous text. This avoids the
repetition loops turbo showed on long windows.

Whisper also invents text over silence. Two language-independent guards remove
it: Whisper's own hallucination_silence_threshold, and dropping any word whose
time span holds no speech energy in the audio.
"""
import argparse
import os
from pathlib import Path
import json
import sys

SAMPLE_RATE = 16000
FRAME_SEC = 0.03
MAX_CLIP_SEC = 30.0
MIN_CLIP_SEC = 10.0
FORCED_CUT_OVERLAP_SEC = 1.5
# Speech needs energy above both the track's own noise floor and -50 dBFS, so a
# mostly-quiet track cannot lower the gate onto its own background.
ABSOLUTE_SPEECH_FLOOR_RMS = 10 ** (-50 / 20)
HALLUCINATION_SILENCE_SEC = 2.0
# Digital silence (exact zeros from a loopback before audio starts) is not
# background noise. Counting it pulled the noise floor to ~0 on recordings with
# a long silent lead-in, so no natural pause qualified and every speech clip
# became a forced 30 s cut, which Whisper can collapse to a single phrase.
DIGITAL_SILENCE_RMS = 10 ** (-90 / 20)

# Nudges Whisper's shared zh decoder toward Simplified characters.
INITIAL_PROMPTS = {"zh": "以下是普通话的句子，使用简体中文。"}


def pause_split(audio, np):
    """Returns (start_sample, end_sample) clips cut at the quietest frame near a pause."""
    frame = int(FRAME_SEC * SAMPLE_RATE)
    frame_count = len(audio) // frame
    if frame_count == 0:
        return [], lambda start, end: False
    energy = np.sqrt(np.mean(audio[: frame_count * frame].reshape(frame_count, frame) ** 2, axis=1))
    silence = float(np.percentile(energy, 15)) * 1.5 + 1e-4
    audible = energy[energy > DIGITAL_SILENCE_RMS]
    pause = float(np.percentile(audible, 15)) * 1.5 + 1e-4 if audible.size else silence

    clips = []
    start = 0
    total = len(audio)
    max_len = int(MAX_CLIP_SEC * SAMPLE_RATE)
    min_len = int(MIN_CLIP_SEC * SAMPLE_RATE)
    overlap = int(FORCED_CUT_OVERLAP_SEC * SAMPLE_RATE)
    while start < total:
        if total - start <= max_len:
            clips.append((start, total))
            break
        first = (start + min_len) // frame
        last = (start + max_len) // frame
        quietest = first + int(np.argmin(energy[first:last]))
        if energy[quietest] <= pause:
            cut = quietest * frame + frame // 2
            clips.append((start, cut))
            start = cut
        else:
            cut = start + max_len
            clips.append((start, cut))
            start = cut - overlap

    # A clip that opens with more digital silence than
    # HALLUCINATION_SILENCE_SEC makes Whisper skip the speech after it, so
    # decode from just before the audio starts.
    lead = int(0.2 * SAMPLE_RATE)
    trimmed = []
    for clip_start, clip_end in clips:
        first = clip_start // frame
        last = min(clip_end // frame, frame_count)
        while first < last and energy[first] <= DIGITAL_SILENCE_RMS:
            first += 1
        if first < last:
            clip_start = max(clip_start, first * frame - lead)
        trimmed.append((clip_start, clip_end))
    clips = trimmed

    speech_gate = max(2 * silence, ABSOLUTE_SPEECH_FLOOR_RMS)

    def has_speech(span_start, span_end):
        frames = energy[span_start // frame : max(span_start // frame + 1, span_end // frame)]
        return frames.size > 0 and float(frames.max()) > speech_gate

    return clips, has_speech


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc MLX Whisper turbo bridge")
    parser.add_argument("--model", required=True)
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
        import numpy as np
        import mlx_whisper
        from mlx_whisper.audio import load_audio
    except Exception as exc:
        print(f"failed to import mlx_whisper: {exc}", file=sys.stderr)
        return 2

    try:
        audio = np.array(load_audio(args.audio), dtype=np.float32)
        clips, has_speech = pause_split(audio, np)
        segments = []
        emitted_until = 0.0
        for start, end in clips:
            # Whisper invents text on silence; skip clips with no speech energy.
            if not has_speech(start, end):
                continue
            clip = audio[start:end]
            offset = start / SAMPLE_RATE
            clip_end = end / SAMPLE_RATE
            result = mlx_whisper.transcribe(
                clip,
                path_or_hf_repo=args.model,
                language=args.language,
                condition_on_previous_text=False,
                initial_prompt=INITIAL_PROMPTS.get(args.language),
                verbose=None,
                word_timestamps=True,
                hallucination_silence_threshold=HALLUCINATION_SILENCE_SEC,
            )
            for segment in result.get("segments", []):
                seg_start = offset + float(segment.get("start", 0))
                seg_end = min(offset + float(segment.get("end", 0)), clip_end)
                words = segment.get("words") or []
                if words:
                    # Keep only words spoken where the audio has speech energy.
                    words = [
                        word
                        for word in words
                        if has_speech(
                            int((offset + float(word["start"])) * SAMPLE_RATE),
                            int((offset + float(word["end"])) * SAMPLE_RATE),
                        )
                    ]
                    if not words:
                        continue
                    text = "".join(word["word"] for word in words)
                    seg_start = offset + float(words[0]["start"])
                    seg_end = min(offset + float(words[-1]["end"]), clip_end)
                elif has_speech(int(seg_start * SAMPLE_RATE), int(seg_end * SAMPLE_RATE)):
                    text = segment.get("text", "")
                else:
                    continue
                # Drop text re-decoded from the overlap after a forced cut.
                if not text.strip() or (seg_start + seg_end) / 2 < emitted_until:
                    continue
                segments.append(
                    {
                        "offsets": {"from": int(seg_start * 1000), "to": int(seg_end * 1000)},
                        "text": text,
                    }
                )
                emitted_until = max(emitted_until, seg_end)

        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump({"transcription": segments}, handle, ensure_ascii=False)
        print(f"clips={len(clips)} segments={len(segments)}", file=sys.stderr)
        return 0
    except Exception as exc:
        print(f"mlx-whisper turbo transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
