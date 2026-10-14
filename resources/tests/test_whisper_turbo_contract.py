#!/usr/bin/env python3
"""Contract tests: whisper_turbo_contract.py must match the Mac turbo script.

Imports resources/mlx-whisper-turbo-transcribe.py via importlib (mlx is only
imported inside that script's main(), so no stub is required for pause_split)
and asserts identical constants, clips, and has_speech on synthetic audio and
real eval clips when present.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
import wave
from pathlib import Path

import numpy as np

RESOURCES = Path(__file__).resolve().parents[1]
if str(RESOURCES) not in sys.path:
    sys.path.insert(0, str(RESOURCES))

import whisper_turbo_contract as contract  # noqa: E402

MAC_SCRIPT = RESOURCES / "mlx-whisper-turbo-transcribe.py"
EVAL_AUDIO_DIR_ENV = "AUTODOC_AD100_EVAL_AUDIO_DIR"
RUN5_JA = "run5-90s/ja.wav"
RUN5_ZH = "run5-90s/zh-Hans.wav"
RUN5_KO = "run5-90s/ko.wav"
COVERAGE_DE = "coverage-3min/coverage-de.wav"


def require_eval_wav(test: unittest.TestCase, relative: str) -> Path:
    root = os.environ.get(EVAL_AUDIO_DIR_ENV)
    if not root:
        test.skipTest(
            f"{EVAL_AUDIO_DIR_ENV} is unset; skipping real-WAV contract test"
        )
    path = Path(root) / relative
    if not path.is_file():
        test.skipTest(f"missing eval WAV {path}")
    return path


def load_mac_module():
    spec = importlib.util.spec_from_file_location("mlx_whisper_turbo_transcribe", MAC_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {MAC_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_wav_mono_16k(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"expected 16-bit PCM in {path}, got width={width}")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1).astype(np.float32)
    if rate != contract.SAMPLE_RATE:
        duration = len(audio) / float(rate)
        target = int(round(duration * contract.SAMPLE_RATE))
        if target <= 0:
            return np.zeros(0, dtype=np.float32)
        x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=target, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    return audio


def mac_collect_clip_segments(start, end, result_segments, has_speech, emitted_until):
    """Exact Mac loop (mlx-whisper-turbo-transcribe.py:97-142) for a cross-check."""
    sample_rate = 16000
    offset = start / sample_rate
    clip_end = end / sample_rate
    new_segments = []
    for segment in result_segments:
        seg_start = offset + float(segment.get("start", 0))
        seg_end = min(offset + float(segment.get("end", 0)), clip_end)
        words = segment.get("words") or []
        if words:
            words = [
                word
                for word in words
                if has_speech(
                    int((offset + float(word["start"])) * sample_rate),
                    int((offset + float(word["end"])) * sample_rate),
                )
            ]
            if not words:
                continue
            text = "".join(word["word"] for word in words)
            seg_start = offset + float(words[0]["start"])
            seg_end = min(offset + float(words[-1]["end"]), clip_end)
        elif has_speech(int(seg_start * sample_rate), int(seg_end * sample_rate)):
            text = segment.get("text", "")
        else:
            continue
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


def assert_has_speech_grid(test, mac_fn, contract_fn, audio):
    total = len(audio)
    if total == 0:
        return
    spans = [
        (0, min(total, 1600)),
        (0, total),
        (total // 4, total // 4 + 480),
        (max(0, total - 16000), total),
    ]
    for start, end in spans:
        test.assertEqual(
            mac_fn(start, end),
            contract_fn(start, end),
            f"has_speech({start}, {end})",
        )


class ConstantsMatchMac(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mac = load_mac_module()

    def test_constants(self):
        mac = self.mac
        self.assertEqual(contract.SAMPLE_RATE, mac.SAMPLE_RATE)
        self.assertEqual(contract.FRAME_SEC, mac.FRAME_SEC)
        self.assertEqual(contract.MAX_CLIP_SEC, mac.MAX_CLIP_SEC)
        self.assertEqual(contract.MIN_CLIP_SEC, mac.MIN_CLIP_SEC)
        self.assertEqual(contract.FORCED_CUT_OVERLAP_SEC, mac.FORCED_CUT_OVERLAP_SEC)
        self.assertEqual(contract.ABSOLUTE_SPEECH_FLOOR_RMS, mac.ABSOLUTE_SPEECH_FLOOR_RMS)
        self.assertEqual(contract.HALLUCINATION_SILENCE_SEC, mac.HALLUCINATION_SILENCE_SEC)
        self.assertEqual(contract.DIGITAL_SILENCE_RMS, mac.DIGITAL_SILENCE_RMS)
        self.assertEqual(contract.INITIAL_PROMPTS, mac.INITIAL_PROMPTS)
        self.assertEqual(contract.INITIAL_PROMPTS["zh"], "以下是普通话的句子，使用简体中文。")


class PauseSplitMatchesMac(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mac = load_mac_module()

    def _compare(self, audio, label):
        mac_clips, mac_speech = self.mac.pause_split(audio, np)
        our_clips, our_speech = contract.pause_split(audio, np)
        self.assertEqual(mac_clips, our_clips, label)
        if not mac_clips:
            self.assertFalse(mac_speech(0, len(audio) or 0))
            self.assertFalse(our_speech(0, len(audio) or 0))
            return
        for start, end in mac_clips:
            self.assertEqual(mac_speech(start, end), our_speech(start, end), f"{label} clip {start}-{end}")
        assert_has_speech_grid(self, mac_speech, our_speech, audio)

    def test_empty(self):
        audio = np.zeros(0, dtype=np.float32)
        self._compare(audio, "empty")

    def test_shorter_than_one_frame(self):
        frame = int(contract.FRAME_SEC * contract.SAMPLE_RATE)
        audio = np.zeros(frame - 1, dtype=np.float32)
        self._compare(audio, "subframe")

    def test_silence_two_seconds(self):
        audio = np.zeros(2 * contract.SAMPLE_RATE, dtype=np.float32)
        self._compare(audio, "silence-2s")

    def test_pause_then_speech(self):
        rng = np.random.default_rng(0)
        audio = np.zeros(25 * contract.SAMPLE_RATE, dtype=np.float32)
        speech = rng.normal(0.0, 0.05, 8 * contract.SAMPLE_RATE).astype(np.float32)
        audio[5 * contract.SAMPLE_RATE : 13 * contract.SAMPLE_RATE] = speech
        self._compare(audio, "pause-then-speech")

    def test_forced_cut_overlap(self):
        # Quiet prefix lowers the track p15; the rest is loud and flat so the
        # 10–30 s window has no frame at or below silence → forced 30 s cut
        # with 1.5 s overlap (Mac lines 58-61).
        sr = contract.SAMPLE_RATE
        audio = np.full(int(45 * sr), 0.1, dtype=np.float32)
        # >15% quiet frames so p15 is the tail, not the speech floor.
        audio[-int(8 * sr) :] = 0.0001
        self._compare(audio, "forced-cut")
        clips, _ = contract.pause_split(audio, np)
        self.assertGreaterEqual(len(clips), 2)
        first_end = clips[0][1]
        second_start = clips[1][0]
        overlap = first_end - second_start
        self.assertEqual(overlap, int(contract.FORCED_CUT_OVERLAP_SEC * sr))
        self.assertEqual(first_end, int(contract.MAX_CLIP_SEC * sr))

    def test_quietest_frame_cut(self):
        rng = np.random.default_rng(2)
        audio = rng.normal(0.0, 0.08, int(40 * contract.SAMPLE_RATE)).astype(np.float32)
        quiet_at = 18 * contract.SAMPLE_RATE
        audio[quiet_at : quiet_at + int(0.2 * contract.SAMPLE_RATE)] *= 0.001
        self._compare(audio, "quietest-frame")

    def _silent_lead_in_speech(self):
        # Live loopback: 50 s of exact zeros, then speech with quiet (not
        # silent) 0.3 s pauses every 4 s.
        sr = contract.SAMPLE_RATE
        rng = np.random.default_rng(3)
        speech = rng.normal(0.0, 0.08, int(60 * sr)).astype(np.float32)
        for at in range(4, 60, 4):
            speech[at * sr : at * sr + int(0.3 * sr)] *= 0.02
        lead = int(50.3 * sr)
        return np.concatenate([np.zeros(lead, dtype=np.float32), speech]), lead

    def test_silent_lead_in_still_finds_speech_pauses(self):
        audio, lead = self._silent_lead_in_speech()
        self._compare(audio, "silent-lead-in")
        clips, _ = contract.pause_split(audio, np)
        speech_clips = [(start, end) for start, end in clips if end > lead]
        lengths = [(end - start) / contract.SAMPLE_RATE for start, end in speech_clips]
        # Cut at the natural pauses, not forced 30 s windows.
        self.assertTrue(all(length < contract.MAX_CLIP_SEC for length in lengths), lengths)

    def test_clips_skip_leading_digital_silence(self):
        audio, lead = self._silent_lead_in_speech()
        clips, _ = contract.pause_split(audio, np)
        first_speech = next(start for start, end in clips if end > lead)
        margin = int(0.2 * contract.SAMPLE_RATE)
        frame = int(contract.FRAME_SEC * contract.SAMPLE_RATE)
        self.assertLessEqual(abs(first_speech - (lead - margin)), frame)

    def test_real_run5_ja(self):
        self._compare(load_wav_mono_16k(require_eval_wav(self, RUN5_JA)), "run5-ja")

    def test_real_run5_zh(self):
        self._compare(load_wav_mono_16k(require_eval_wav(self, RUN5_ZH)), "run5-zh")

    def test_real_run5_ko(self):
        self._compare(load_wav_mono_16k(require_eval_wav(self, RUN5_KO)), "run5-ko")

    def test_real_coverage_de(self):
        self._compare(load_wav_mono_16k(require_eval_wav(self, COVERAGE_DE)), "coverage-de")


class AssembleMatchesMacLoop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mac = load_mac_module()

    def test_energy_gate_and_overlap_dedup(self):
        rng = np.random.default_rng(3)
        audio = rng.normal(0.0, 0.08, int(45 * contract.SAMPLE_RATE)).astype(np.float32)
        # A quiet tail so some word spans fail the gate.
        audio[-contract.SAMPLE_RATE :] *= 0.0001
        clips, has_speech = contract.pause_split(audio, np)
        mac_clips, mac_speech = self.mac.pause_split(audio, np)
        self.assertEqual(clips, mac_clips)

        decoded = {}
        emitted_mac = 0.0
        emitted_ours = 0.0
        mac_all = []
        our_all = []
        for start, end in clips:
            if not has_speech(start, end):
                self.assertFalse(mac_speech(start, end))
                continue
            duration = (end - start) / contract.SAMPLE_RATE
            result_segments = [
                {
                    "start": 0.0,
                    "end": duration,
                    "text": "hello world",
                    "words": [
                        {"start": 0.1, "end": 0.4, "word": "hello"},
                        {"start": max(0.0, duration - 0.4), "end": duration, "word": " world"},
                    ],
                },
                {
                    "start": 0.0,
                    "end": 0.05,
                    "text": "  ",
                    "words": [],
                },
            ]
            decoded[(start, end)] = result_segments
            mac_added, emitted_mac = mac_collect_clip_segments(
                start, end, result_segments, mac_speech, emitted_mac
            )
            our_added, emitted_ours = contract.collect_clip_segments(
                start, end, result_segments, has_speech, emitted_ours
            )
            self.assertEqual(mac_added, our_added)
            self.assertEqual(emitted_mac, emitted_ours)
            mac_all.extend(mac_added)
            our_all.extend(our_added)

        assembled = contract.assemble_transcription(clips, has_speech, decoded)
        self.assertEqual(assembled, our_all)
        self.assertEqual(contract.bridge_json(assembled), {"transcription": assembled})

    def test_silent_clip_skipped(self):
        audio = np.zeros(12 * contract.SAMPLE_RATE, dtype=np.float32)
        clips, has_speech = contract.pause_split(audio, np)
        decoded = {
            (start, end): [{"start": 0.0, "end": 1.0, "text": "hallucination", "words": []}]
            for start, end in clips
        }
        segments = contract.assemble_transcription(clips, has_speech, decoded)
        self.assertEqual(segments, [])


if __name__ == "__main__":
    unittest.main()
