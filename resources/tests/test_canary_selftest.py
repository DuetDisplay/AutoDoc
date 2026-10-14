#!/usr/bin/env python3
"""Canary selftest must bypass VAD and fill one max speech window."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import Mock

import numpy as np

RESOURCES = Path(__file__).resolve().parents[1]
WORKER = RESOURCES / "transcription-worker.py"


def load_worker():
    spec = importlib.util.spec_from_file_location("transcription_worker", WORKER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {WORKER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CanarySelftest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_worker()

    def test_max_speech_matches_mac(self):
        self.assertEqual(self.mod.MAX_SPEECH_SEC, 25)

    def test_canary_audio_is_one_max_window(self):
        audio = self.mod._selftest_audio("canary")
        self.assertEqual(len(audio), 16000 * self.mod.MAX_SPEECH_SEC)

    def test_turbo_audio_stays_one_second(self):
        audio = self.mod._selftest_audio("whisper-turbo")
        self.assertEqual(len(audio), 16000)

    def test_canary_decode_uses_raw_model_not_vad(self):
        worker = self.mod.TranscriptionWorker()
        worker.engine = "canary"
        raw = Mock()
        raw.recognize.return_value = "x"
        vad = Mock()
        worker.asr_model = raw
        worker.model = vad
        audio = np.zeros(16000, dtype=np.float32)
        count = worker._selftest_decode(audio, "de")
        self.assertEqual(count, 1)
        raw.recognize.assert_called_once()
        kwargs = raw.recognize.call_args.kwargs
        self.assertEqual(kwargs.get("language"), "de")
        self.assertEqual(kwargs.get("target_language"), "de")
        vad.recognize.assert_not_called()

    def test_cuda_load_rejects_cpu_provider_fallback(self):
        asr = type("Asr", (), {})()
        asr._encoder = Mock(get_providers=Mock(return_value=["CPUExecutionProvider"]))
        asr._decoder = Mock(get_providers=Mock(return_value=["CPUExecutionProvider"]))
        with self.assertRaises(RuntimeError):
            self.mod._require_cuda_sessions(asr)

    def test_cuda_load_accepts_cuda_sessions(self):
        asr = type("Asr", (), {})()
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        asr._encoder = Mock(get_providers=Mock(return_value=providers))
        asr._decoder = Mock(get_providers=Mock(return_value=providers))
        self.mod._require_cuda_sessions(asr)

    def test_release_clears_raw_model(self):
        worker = self.mod.TranscriptionWorker()
        worker.asr_model = object()
        worker.model = object()
        worker._release_loaded()
        self.assertIsNone(worker.asr_model)
        self.assertIsNone(worker.model)


if __name__ == "__main__":
    unittest.main()
