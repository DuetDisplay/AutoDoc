#!/usr/bin/env python3
"""Shared Whisper turbo pause-split / energy-gate / overlap-dedup contract.

Line-for-line port of resources/mlx-whisper-turbo-transcribe.py (stdlib + numpy
only). Same names, formulas, and constants. Callers supply numpy as `np` to
pause_split, matching the Mac script.
"""
import json

# mlx-whisper-turbo-transcribe.py:18-29
SAMPLE_RATE = 16000
FRAME_SEC = 0.03
MAX_CLIP_SEC = 30.0
MIN_CLIP_SEC = 10.0
FORCED_CUT_OVERLAP_SEC = 1.5
# Speech needs energy above both the track's own noise floor and -50 dBFS, so a
# mostly-quiet track cannot lower the gate onto its own background.
ABSOLUTE_SPEECH_FLOOR_RMS = 10 ** (-50 / 20)
HALLUCINATION_SILENCE_SEC = 2.0

# Nudges Whisper's shared zh decoder toward Simplified characters.
INITIAL_PROMPTS = {"zh": "以下是普通话的句子，使用简体中文。"}


def pause_split(audio, np):
    """Returns (start_sample, end_sample) clips cut at the quietest frame near a pause."""
    # mlx-whisper-turbo-transcribe.py:32-69
    frame = int(FRAME_SEC * SAMPLE_RATE)
    frame_count = len(audio) // frame
    if frame_count == 0:
        return [], lambda start, end: False
    energy = np.sqrt(np.mean(audio[: frame_count * frame].reshape(frame_count, frame) ** 2, axis=1))
    silence = float(np.percentile(energy, 15)) * 1.5 + 1e-4

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
        if energy[quietest] <= silence:
            cut = quietest * frame + frame // 2
            clips.append((start, cut))
            start = cut
        else:
            cut = start + max_len
            clips.append((start, cut))
            start = cut - overlap

    speech_gate = max(2 * silence, ABSOLUTE_SPEECH_FLOOR_RMS)

    def has_speech(span_start, span_end):
        frames = energy[span_start // frame : max(span_start // frame + 1, span_end // frame)]
        return frames.size > 0 and float(frames.max()) > speech_gate

    return clips, has_speech


def collect_clip_segments(start, end, result_segments, has_speech, emitted_until):
    """Port of mlx-whisper-turbo-transcribe.py:97-142 (one clip after decode).

    result_segments items are dicts with clip-relative `start` / `end` / `text`
    and optional `words` as [{start, end, word}, ...] (also clip-relative).
    Returns (new_segments, emitted_until).
    """
    offset = start / SAMPLE_RATE
    clip_end = end / SAMPLE_RATE
    new_segments = []
    for segment in result_segments:
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
        new_segments.append(
            {
                "offsets": {"from": int(seg_start * 1000), "to": int(seg_end * 1000)},
                "text": text,
            }
        )
        emitted_until = max(emitted_until, seg_end)
    return new_segments, emitted_until


def assemble_transcription(clips, has_speech, decoded_clips):
    """Port of mlx-whisper-turbo-transcribe.py:91-142 (clip skip + assemble).

    decoded_clips maps (start, end) -> result_segments for clips that were
    decoded. Clips missing from the map, or with no speech energy, are skipped
    (Mac line 95-96).
    """
    segments = []
    emitted_until = 0.0
    for start, end in clips:
        # Whisper invents text on silence; skip clips with no speech energy.
        if not has_speech(start, end):
            continue
        result_segments = decoded_clips.get((start, end), [])
        added, emitted_until = collect_clip_segments(
            start, end, result_segments, has_speech, emitted_until
        )
        segments.extend(added)
    return segments


def bridge_json(segments):
    """Mac line 145: {"transcription":[...]}."""
    return {"transcription": segments}


def dump_bridge_json(path, segments):
    """Mac lines 144-145."""
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(bridge_json(segments), handle, ensure_ascii=False)
