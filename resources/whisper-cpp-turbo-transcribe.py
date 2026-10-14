#!/usr/bin/env python3
"""Whisper large-v3-turbo via whisper.cpp, matching the Mac pause-split contract.

Python owns pause_split, the word-energy gate, overlap de-dup, and JSON shaping
(whisper_turbo_contract.py). whisper-cli decodes each 10-30 s clip (language
pinned, -mc 0, greedy + temperature fallback, --dtw large.v3.turbo, -nfa).
One whisper-cli process decodes many clips (`-f` repeated); clips are batched
only so the Windows command line stays under 32767 characters.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from whisper_turbo_contract import (  # noqa: E402
    INITIAL_PROMPTS,
    SAMPLE_RATE,
    collect_clip_segments,
    dump_bridge_json,
    pause_split,
)

# Windows CreateProcess command-line limit.
WINDOWS_CMDLINE_LIMIT = 32767

# OpenAI Whisper split_to_word_tokens: these languages split on unicode, not spaces.
# Korean is space-delimited in Whisper. Mirror that.
UNICODE_SPLIT_LANGS = {"zh", "ja", "th", "lo", "my", "yue"}
SPECIAL_TOKEN_MARKERS = ("[_", "<|", "[ ")

# mlx-whisper / openai-whisper timing.py defaults. Identical in both repos.
PREPEND_PUNCTUATIONS = "\"'“¿([{-"
APPEND_PUNCTUATIONS = "\"'.。,，!！?？:：”)]}、"
SENTENCE_END_MARKS = ".。!！?？"

# whisper.cpp ggml-vulkan: "N = <name> | uma: …"
VULKAN_DEVICE_LINE = re.compile(r"^ggml_vulkan:\s+(\d+)\s+=\s+(.+)$")


class VulkanDeviceError(Exception):
    def __init__(self, message: str, devices: list[dict] | None = None):
        super().__init__(message)
        self.devices = devices or []


def parse_vulkan_devices(text: str) -> list[tuple[int, str]]:
    """Parse `ggml_vulkan: N = <name>` lines from whisper-cli --help."""
    devices: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        match = VULKAN_DEVICE_LINE.match(raw_line.strip())
        if not match:
            continue
        name = match.group(2).split(" | ", 1)[0].strip()
        devices.append((int(match.group(1)), name))
    return devices


def match_vulkan_device(devices: list[tuple[int, str]], substring: str) -> tuple[int, str]:
    """Case-insensitive substring match. First hit wins. No match is an error."""
    needle = substring.casefold()
    for index, name in devices:
        if needle in name.casefold():
            return index, name
    available = ", ".join(f"{index}={name}" for index, name in devices) or "(none)"
    raise VulkanDeviceError(
        f"Vulkan device matching {substring!r} not found; available: {available}",
        devices=[{"index": index, "name": name} for index, name in devices],
    )


def list_vulkan_devices(cli: Path) -> list[tuple[int, str]]:
    """`--help` prints the Vulkan list without loading a model."""
    proc = subprocess.run(
        [str(cli), "--help"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return parse_vulkan_devices((proc.stdout or "") + "\n" + (proc.stderr or ""))


def resolve_vulkan_device(
    device: int | None,
    device_name: str | None,
    devices: list[tuple[int, str]] | None = None,
    list_devices=None,
) -> tuple[int | None, str | None]:
    """`--device` wins. `--device-name` must match a listed GPU. Neither → unset."""

    def catalog() -> list[tuple[int, str]]:
        if devices is not None:
            return devices
        if list_devices is not None:
            return list_devices()
        return []

    if device is not None:
        name = None
        if devices is not None or list_devices is not None:
            for index, listed in catalog():
                if index == device:
                    name = listed
                    break
        return device, name
    if device_name:
        return match_vulkan_device(catalog(), device_name)
    return None, None


def load_wav_mono_16k(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        nframes = handle.getnframes()
        raw = handle.readframes(nframes)
    if width == 2:
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {width} in {path}")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1).astype(np.float32)
    if rate != SAMPLE_RATE:
        duration = len(audio) / float(rate)
        target = int(round(duration * SAMPLE_RATE))
        if target <= 0:
            return np.zeros(0, dtype=np.float32)
        x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=target, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    return audio


def write_wav_mono_16k(path: Path, audio: np.ndarray) -> None:
    clipped = np.clip(audio, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm.tobytes())


def is_special_token(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    return stripped.startswith(SPECIAL_TOKEN_MARKERS) or (
        stripped.startswith("[") and stripped.endswith("]")
    )


def _hms_to_sec(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", ".")
    parts = text.split(":")
    if len(parts) != 3:
        return 0.0
    hours, minutes, seconds = parts
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def token_dtw_sec(token: dict) -> float | None:
    """whisper.cpp --dtw writes t_dtw in centiseconds. -1 = unaligned."""
    if "t_dtw" not in token:
        return None
    raw = float(token["t_dtw"])
    if raw < 0:
        return None
    return raw / 100.0


def segment_end_sec(segment: dict) -> float | None:
    """whisper.cpp segment timestamp token (t1). Maps to openai/mlx EOT jump."""
    offsets = segment.get("offsets") or {}
    if "to" in offsets:
        return float(offsets["to"]) / 1000.0
    if "t1" in segment:
        return float(segment["t1"]) / 100.0
    timestamps = segment.get("timestamps") or {}
    if timestamps.get("to") is not None:
        return _hms_to_sec(timestamps.get("to"))
    return None


def segment_start_sec(segment: dict) -> float:
    offsets = segment.get("offsets") or {}
    if "from" in offsets:
        return float(offsets["from"]) / 1000.0
    if "t0" in segment:
        return float(segment["t0"]) / 100.0
    timestamps = segment.get("timestamps") or {}
    return _hms_to_sec(timestamps.get("from"))


def group_tokens(tokens: list[dict], language: str) -> list[dict]:
    """OpenAI / mlx split_to_word_tokens grouping (no EOT dummy word)."""
    usable = []
    for token in tokens:
        text = str(token.get("text") or "")
        if is_special_token(text):
            continue
        usable.append(
            {
                "text": text,
                "t": token_dtw_sec(token),
                "p": float(token.get("p") or 0.0),
            }
        )

    grouped: list[dict] = []
    if language in UNICODE_SPLIT_LANGS:
        grouped = [
            {"word": item["text"], "ts": [item["t"]], "ps": [item["p"]], "n": 1}
            for item in usable
        ]
    else:
        current = None
        for item in usable:
            text = item["text"]
            new_word = current is None or text[:1].isspace() or text.startswith("\u0120")
            if new_word:
                if current is not None:
                    grouped.append(current)
                current = {"word": text, "ts": [item["t"]], "ps": [item["p"]], "n": 1}
            else:
                current["word"] += text
                current["ts"].append(item["t"])
                current["ps"].append(item["p"])
                current["n"] += 1
        if current is not None:
            grouped.append(current)
    return grouped


def find_alignment_from_dtw(tokens: list[dict], language: str) -> list[dict]:
    """openai / faster-whisper find_alignment word spans from whisper.cpp t_dtw.

    matrix rows after `matrix[len(sot_sequence):-1]` are
    [no_timestamps, text_0, …, text_{T-1}]. jump_times[0] is the
    no_timestamps path start (clip-relative 0.0 here: each pause-split clip
    is its own whisper.cpp window with seek=0). jump_times[k+1] is text
    token k's t_dtw.

    Word w covering flat tokens [b_w, b_{w+1}):
      start = jump_times[b_w]     → 0.0 if w==0 else t_dtw of token b_w-1
      end   = jump_times[b_{w+1}] → t_dtw of this word's last token
    EOT / t1 / next-word-first-token are not used as ends.
    """
    grouped = group_tokens(tokens, language)
    flat_times: list[float | None] = []
    for item in grouped:
        flat_times.extend(item["ts"])
    path_start = 0.0
    words: list[dict] = []
    cursor = 0
    for item in grouped:
        n = item["n"]
        b0 = cursor
        b1 = cursor + n
        if b0 == 0:
            start = path_start
        else:
            pred = flat_times[b0 - 1]
            start = pred if pred is not None else path_start
        last = flat_times[b1 - 1] if b1 > b0 else None
        end = last if last is not None else start
        timed = any(t is not None for t in item["ts"])
        if b0 > 0 and flat_times[b0 - 1] is not None:
            timed = True
        words.append(
            {
                "word": item["word"],
                "tokens": [0] * item["n"],
                "start": float(start),
                "end": float(end),
                "timed": timed,
                "probability": float(np.mean(item["ps"])) if item["ps"] else 0.0,
            }
        )
        cursor = b1
    return words


def merge_punctuations(alignment: list[dict], prepended: str, appended: str) -> None:
    """Byte-for-byte mlx_whisper/timing.py merge_punctuations, dict form."""
    i = len(alignment) - 2
    j = len(alignment) - 1
    while i >= 0:
        previous = alignment[i]
        following = alignment[j]
        if previous["word"].startswith(" ") and previous["word"].strip() in prepended:
            following["word"] = previous["word"] + following["word"]
            following["tokens"] = previous["tokens"] + following["tokens"]
            previous["word"] = ""
            previous["tokens"] = []
        else:
            j = i
        i -= 1

    i = 0
    j = 1
    while j < len(alignment):
        previous = alignment[i]
        following = alignment[j]
        if not previous["word"].endswith(" ") and following["word"] in appended:
            previous["word"] = previous["word"] + following["word"]
            previous["tokens"] = previous["tokens"] + following["tokens"]
            following["word"] = ""
            following["tokens"] = []
        else:
            i = j
        j += 1


def add_word_timestamps(
    raw_segments: list[dict],
    language: str,
    last_speech_timestamp: float,
    clip_offset: float,
) -> tuple[list[list[dict]], float]:
    """mlx-whisper add_word_timestamps over one pause-split clip (one decode).

    DTW times stay clip-relative until words are emitted (mlx adds seek offset
    then rounds to 0.01 s). last_speech_timestamp is file-absolute, matching
    how mlx/openai carry it across 30 s windows.
    """
    if not raw_segments:
        return [], last_speech_timestamp

    all_tokens: list[dict] = []
    token_counts: list[int] = []
    for segment in raw_segments:
        tokens = [
            tok
            for tok in (segment.get("tokens") or [])
            if not is_special_token(str(tok.get("text") or ""))
        ]
        token_counts.append(len(tokens))
        all_tokens.extend(tokens)
    flat = find_alignment_from_dtw(all_tokens, language)

    word_durations = np.array([t["end"] - t["start"] for t in flat])
    word_durations = word_durations[word_durations.nonzero()]
    median_duration = np.median(word_durations) if len(word_durations) > 0 else 0.0
    median_duration = min(0.7, float(median_duration))
    max_duration = median_duration * 2

    if len(word_durations) > 0:
        for i in range(1, len(flat)):
            if flat[i]["end"] - flat[i]["start"] > max_duration:
                if flat[i]["word"] in SENTENCE_END_MARKS:
                    flat[i]["end"] = flat[i]["start"] + max_duration
                elif flat[i - 1]["word"] in SENTENCE_END_MARKS:
                    flat[i]["start"] = flat[i]["end"] - max_duration

    merge_punctuations(flat, PREPEND_PUNCTUATIONS, APPEND_PUNCTUATIONS)

    word_index = 0
    per_segment: list[list[dict]] = []
    for segment, n_tokens in zip(raw_segments, token_counts):
        saved_tokens = 0
        words = []
        while word_index < len(flat) and saved_tokens < n_tokens:
            timing = flat[word_index]
            if timing["word"]:
                words.append(
                    {
                        "word": timing["word"],
                        "start": round(clip_offset + timing["start"], 2),
                        "end": round(clip_offset + timing["end"], 2),
                        "timed": timing.get("timed", True),
                        "probability": float(timing.get("probability") or 0.0),
                    }
                )
            saved_tokens += len(timing["tokens"])
            word_index += 1

        seg_start = clip_offset + segment_start_sec(segment)
        seg_end = clip_offset + (segment_end_sec(segment) or 0.0)
        if words:
            if words[0]["end"] - last_speech_timestamp > median_duration * 4 and (
                words[0]["end"] - words[0]["start"] > max_duration
                or (len(words) > 1 and words[1]["end"] - words[0]["start"] > max_duration * 2)
            ):
                if len(words) > 1 and words[1]["end"] - words[1]["start"] > max_duration:
                    boundary = max(words[1]["end"] / 2, words[1]["end"] - max_duration)
                    words[0]["end"] = words[1]["start"] = boundary
                words[0]["start"] = max(0, words[0]["end"] - max_duration)

            if seg_start < words[0]["end"] and seg_start - 0.5 > words[0]["start"]:
                words[0]["start"] = max(0, min(words[0]["end"] - median_duration, seg_start))
            else:
                seg_start = words[0]["start"]

            if seg_end > words[-1]["start"] and seg_end + 0.5 < words[-1]["end"]:
                words[-1]["end"] = max(words[-1]["start"] + median_duration, seg_end)
            else:
                seg_end = words[-1]["end"]

            last_speech_timestamp = seg_end
        per_segment.append(words)
    return per_segment, last_speech_timestamp


def load_whisper_json(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        if "transcription" in data:
            return data["transcription"]
        if "segments" in data:
            return data["segments"]
    if isinstance(data, list):
        return data
    raise ValueError(f"unrecognized whisper.cpp json: {path}")


def assemble_mac_from_raw_clips(raw_clips, language: str, has_speech):
    """DTW + Mac collect_clip_segments (clip-relative energy gate)."""
    segments = []
    emitted_until = 0.0
    last_speech_timestamp = 0.0
    for clip in raw_clips:
        start = int(clip["wav_start_sample"])
        end = int(clip["wav_end_sample"])
        raw_segments = clip["segments"]
        offset = start / SAMPLE_RATE
        timed_segments, last_speech_timestamp = add_word_timestamps(
            raw_segments, language, last_speech_timestamp, offset
        )
        normalized = []
        for segment, words in zip(raw_segments, timed_segments):
            rel_words = [
                {
                    "start": float(word["start"]) - offset,
                    "end": float(word["end"]) - offset,
                    "word": word["word"],
                }
                for word in words
                if word.get("word")
            ]
            offsets = segment.get("offsets") or {}
            if "from" in offsets:
                seg_start = float(offsets.get("from", 0)) / 1000.0
                seg_end = float(offsets.get("to", 0)) / 1000.0
            else:
                seg_start = float(segment.get("start", 0))
                seg_end = float(segment.get("end", 0))
            normalized.append(
                {
                    "start": seg_start,
                    "end": seg_end,
                    "text": segment.get("text") or "",
                    "words": rel_words,
                }
            )
        added, emitted_until = collect_clip_segments(
            start, end, normalized, has_speech, emitted_until
        )
        segments.extend(added)
    return segments


def assemble_indexfix_from_raw_clips(raw_clips, language: str, has_speech):
    """r7-lastword/indexfix whisper_cpp_turbo_transcribe.py energy gate.

    Words stay file-absolute. Gate is has_speech(max(0, w0), w1) — the loop
    that produced r10-turbo-drops/transcripts/B.
    """
    segments = []
    emitted_until = 0.0
    last_speech_timestamp = 0.0
    for clip in raw_clips:
        start = int(clip["wav_start_sample"])
        end = int(clip["wav_end_sample"])
        raw_segments = clip["segments"]
        offset = start / SAMPLE_RATE
        clip_end = end / SAMPLE_RATE
        timed_segments, last_speech_timestamp = add_word_timestamps(
            raw_segments, language, last_speech_timestamp, offset
        )
        for segment, words in zip(raw_segments, timed_segments):
            if words:
                kept = []
                for word in words:
                    w0 = int(word["start"] * SAMPLE_RATE)
                    w1 = int(word["end"] * SAMPLE_RATE)
                    if has_speech(max(0, w0), w1):
                        kept.append(word)
                words = kept
                if not words:
                    continue
                text = "".join(word["word"] for word in words)
                seg_start = float(words[0]["start"])
                seg_end = min(float(words[-1]["end"]), clip_end)
            else:
                offsets = segment.get("offsets") or {}
                if "from" in offsets:
                    seg_start = offset + float(offsets.get("from", 0)) / 1000.0
                    seg_end = offset + float(offsets.get("to", 0)) / 1000.0
                else:
                    seg_start = offset + float(segment.get("start", 0))
                    seg_end = offset + float(segment.get("end", 0))
                seg_end = min(seg_end, clip_end)
                if not has_speech(int(seg_start * SAMPLE_RATE), int(seg_end * SAMPLE_RATE)):
                    continue
                text = segment.get("text") or ""
            if not text.strip() or (seg_start + seg_end) / 2 < emitted_until:
                continue
            segments.append(
                {
                    "offsets": {"from": int(seg_start * 1000), "to": int(seg_end * 1000)},
                    "text": text,
                }
            )
            emitted_until = max(emitted_until, seg_end)
    return segments


def find_clip_json(clip_wav: Path) -> Path | None:
    candidates = [
        clip_wav.with_suffix(".json"),
        Path(str(clip_wav) + ".json"),
        clip_wav.parent / f"{clip_wav.stem}.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def command_line_length(args: list[str]) -> int:
    if os.name == "nt" and hasattr(subprocess, "list2cmdline"):
        return len(subprocess.list2cmdline(args))
    return sum(len(arg) + 3 for arg in args)


def build_whisper_cli_base(
    cli: Path,
    model: Path,
    language: str,
    device: int | None,
    threads: int | None,
    dtw_model: str = "large.v3.turbo",
) -> list[str]:
    cmd = [
        str(cli),
        "-m",
        str(model),
        "-l",
        language,
        "-mc",
        "0",
        "-bs",
        "1",
        "-tp",
        "0",
        "-tpi",
        "0.2",
        "-ojf",
        "-dtw",
        dtw_model,
        "-sns",
        "-nfa",  # flash-attn silently disables DTW; required for t_dtw
    ]
    prompt = INITIAL_PROMPTS.get(language)
    if prompt:
        cmd.extend(["--prompt", prompt])
    if device is not None:
        cmd.extend(["-dev", str(device)])
    if isinstance(threads, int) and threads > 0:
        cmd.extend(["-t", str(threads)])
    return cmd


def batch_clip_wavs(
    base_cmd: list[str],
    clip_wavs: list[Path],
    limit: int = WINDOWS_CMDLINE_LIMIT,
) -> list[list[Path]]:
    """Split clips so each `base_cmd + -f paths` stays under the OS argv limit."""
    batches: list[list[Path]] = []
    current: list[Path] = []
    for wav in clip_wavs:
        trial = current + [wav]
        cmd = list(base_cmd)
        for item in trial:
            cmd.extend(["-f", str(item)])
        if current and command_line_length(cmd) > limit:
            batches.append(current)
            current = [wav]
        else:
            current = trial
    if current:
        batches.append(current)
    return batches


def transcribe_clips_one_process(
    cli: Path,
    model: Path,
    clip_wavs: list[Path],
    language: str,
    device: int | None,
    extra_args: list[str],
    dtw_model: str,
    threads: int | None = None,
) -> tuple[list[Path], str, float]:
    """Load the model once and decode every clip as a separate file."""
    cmd = build_whisper_cli_base(cli, model, language, device, threads, dtw_model)
    cmd.extend(extra_args)
    for wav in clip_wavs:
        cmd.extend(["-f", str(wav)])

    t0 = time.perf_counter()
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(cli.parent) if cli.parent.is_dir() else None,
    )
    wall = time.perf_counter() - t0
    log = (proc.stdout or "") + "\n" + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(f"whisper-cli failed ({proc.returncode}): {log[-4000:]}")
    jsons = []
    missing = []
    for wav in clip_wavs:
        found = find_clip_json(wav)
        if found is None:
            missing.append(wav.name)
        else:
            jsons.append(found)
    if missing:
        raise RuntimeError(f"whisper-cli produced no JSON for: {missing}\n{log[-2000:]}")
    return jsons, log, wall


def transcribe_clips_batched(
    cli: Path,
    model: Path,
    clip_wavs: list[Path],
    language: str,
    device: int | None,
    threads: int | None,
    dtw_model: str = "large.v3.turbo",
) -> tuple[list[Path], str, float]:
    base = build_whisper_cli_base(cli, model, language, device, threads, dtw_model)
    jsons: list[Path] = []
    logs: list[str] = []
    wall = 0.0
    for batch in batch_clip_wavs(base, clip_wavs):
        batch_jsons, log, batch_wall = transcribe_clips_one_process(
            cli, model, batch, language, device, [], dtw_model, threads
        )
        jsons.extend(batch_jsons)
        logs.append(log)
        wall += batch_wall
    return jsons, "\n".join(logs), wall


def _selftest_tone(sample_rate: int = SAMPLE_RATE, seconds: float = 1.0) -> np.ndarray:
    n = int(sample_rate * seconds)
    t = np.arange(n, dtype=np.float32) / float(sample_rate)
    return (0.1 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)


def _selftest_error(message: str, devices: list[dict] | None = None) -> int:
    result = {"ok": False, "error": message}
    if devices is not None:
        result["devices"] = devices
    print(json.dumps(result, ensure_ascii=False))
    print(f"whisper.cpp turbo self-test failed: {message}", file=sys.stderr)
    return 1


def resolve_cli_device(args: argparse.Namespace) -> tuple[int | None, str | None]:
    cli = Path(args.cli)
    device, name = resolve_vulkan_device(
        args.device,
        args.device_name,
        list_devices=lambda: list_vulkan_devices(cli),
    )
    if name:
        print(f"resolved vulkan device {device} = {name}", file=sys.stderr)
    elif device is not None:
        print(f"resolved vulkan device {device}", file=sys.stderr)
    return device, name


def run_selftest(args: argparse.Namespace) -> int:
    try:
        device, device_name = resolve_cli_device(args)
    except VulkanDeviceError as exc:
        return _selftest_error(str(exc), exc.devices)

    work = Path(tempfile.mkdtemp(prefix="w"))
    try:
        wav_path = work / "0.wav"
        write_wav_mono_16k(wav_path, _selftest_tone())
        language = args.language or "en"
        t0 = time.perf_counter()
        _jsons, log, wall = transcribe_clips_one_process(
            Path(args.cli),
            Path(args.model),
            [wav_path],
            language,
            device,
            [],
            "large.v3.turbo",
            args.threads,
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        result = {
            "ok": True,
            "device": device,
            "deviceName": device_name,
            "elapsedMs": round(elapsed_ms, 1),
            "decodeWallS": round(wall, 3),
        }
        print(
            f"selftest ok device={device} deviceName={device_name} "
            f"elapsed_ms={result['elapsedMs']}",
            file=sys.stderr,
        )
        if log:
            print("\n".join(log.splitlines()[-20:]), file=sys.stderr)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        return _selftest_error(str(exc))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc whisper.cpp Vulkan turbo bridge")
    parser.add_argument("--model", required=True)
    parser.add_argument("--cli", required=True)
    parser.add_argument("--audio", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--language", default="")
    parser.add_argument("--device", type=int, default=None, help="whisper-cli -dev GPU id")
    parser.add_argument(
        "--device-name",
        default=None,
        help="case-insensitive substring of a ggml_vulkan device name; ignored if --device is set",
    )
    parser.add_argument("--threads", type=int, default=None, help="whisper-cli -t thread count")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return run_selftest(args)
    if not args.audio or not args.output or not args.language:
        parser.error("--audio, --output, and --language are required unless --self-test")

    try:
        device, device_name = resolve_cli_device(args)
    except VulkanDeviceError as exc:
        print(json.dumps({"ok": False, "error": str(exc), "devices": exc.devices}, ensure_ascii=False))
        print(f"whisper.cpp turbo transcription failed: {exc}", file=sys.stderr)
        return 1

    audio = load_wav_mono_16k(Path(args.audio))
    clips, has_speech = pause_split(audio, np)
    segments = []
    emitted_until = 0.0
    skipped_silent_clips = 0
    last_speech_timestamp = 0.0

    work = Path(tempfile.mkdtemp(prefix="w"))
    clip_wavs: list[Path] = []
    clip_meta: list[tuple[int, int]] = []
    try:
        for index, (start, end) in enumerate(clips):
            if not has_speech(start, end):
                skipped_silent_clips += 1
                continue
            clip_meta.append((start, end))
            wav_path = work / f"{index}.wav"
            write_wav_mono_16k(wav_path, audio[start:end])
            clip_wavs.append(wav_path)

        decode_log = ""
        decode_wall = 0.0
        clip_jsons: list[Path] = []
        if clip_wavs:
            clip_jsons, decode_log, decode_wall = transcribe_clips_batched(
                Path(args.cli),
                Path(args.model),
                clip_wavs,
                args.language,
                device,
                args.threads,
            )

        raw_clips = [
            {
                "wav_start_sample": start,
                "wav_end_sample": end,
                "segments": load_whisper_json(json_path),
            }
            for (start, end), json_path in zip(clip_meta, clip_jsons)
        ]
        segments = assemble_mac_from_raw_clips(
            raw_clips, args.language, has_speech
        )

        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        dump_bridge_json(args.output, segments)
        print(
            f"clips={len(clips)} segments={len(segments)} "
            f"skipped_silent_clips={skipped_silent_clips} "
            f"decode_wall_s={decode_wall:.3f} "
            f"whisper_files={len(clip_wavs)}",
            file=sys.stderr,
        )
        if decode_log:
            tail = "\n".join(decode_log.splitlines()[-40:])
            print(tail, file=sys.stderr)
        return 0
    except Exception as exc:
        print(f"whisper.cpp turbo transcription failed: {exc}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
