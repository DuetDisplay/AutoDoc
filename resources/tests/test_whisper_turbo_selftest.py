#!/usr/bin/env python3
"""Turbo readiness must exercise the same contract as a real transcription."""
from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_canary_selftest import load_worker


class WhisperTurboSelftest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_worker()

    def setUp(self):
        self.worker = self.mod.TranscriptionWorker()
        self.worker.engine = "whisper-turbo"
        self.worker.model = Mock()
        segment = SimpleNamespace(
            start=0.3, end=0.6, text="hola", words=[]
        )
        self.worker.model.transcribe.side_effect = lambda *args, **kwargs: (
            iter([segment]), None
        )
        self.audio = self.mod._selftest_audio("whisper-turbo")

    def test_selftest_reaches_decoder_with_production_options(self):
        with patch.object(self.mod, "_emit_segment") as emit:
            count = self.worker._selftest_decode(self.audio, "es")
        self.assertEqual(count, 1)
        self.worker.model.transcribe.assert_called_once()
        options = self.worker.model.transcribe.call_args.kwargs
        self.assertEqual(options["language"], "es")
        self.assertEqual(options["beam_size"], 1)
        self.assertFalse(options["condition_on_previous_text"])
        self.assertTrue(options["word_timestamps"])
        self.assertEqual(options["hallucination_silence_threshold"], 2.0)
        emit.assert_not_called()

    def test_selftest_fails_when_packaged_contract_is_missing(self):
        with patch.dict(sys.modules, {"whisper_turbo_contract": None}):
            with self.assertRaises(ModuleNotFoundError):
                self.worker.handle_selftest(1, {"language": "es"})
        self.worker.model.transcribe.assert_not_called()

    def test_real_transcription_still_emits_segments_and_response(self):
        with (
            patch.object(self.mod, "_read_full_audio", return_value=self.audio),
            patch.object(self.mod, "_emit_segment") as emit,
            patch.object(self.mod, "_respond") as respond,
        ):
            self.worker._handle_transcribe_whisper_turbo(7, "test.wav", "es", None)
        emit.assert_called_once_with(7, 300, 600, "hola")
        respond.assert_called_once_with(
            7, True,
            {"transcription": [{"offsets": {"from": 300, "to": 600}, "text": "hola"}]},
        )


if __name__ == "__main__":
    unittest.main()
