#!/usr/bin/env python3
"""find_alignment_from_dtw must match openai / faster-whisper indexing.

Runs against resources/whisper-cpp-turbo-transcribe.py.

Reference (openai whisper/timing.py find_alignment; faster-whisper
transcribe.py find_alignment):

    matrix = matrix[len(tokenizer.sot_sequence) : -1]
    jumps = pad(diff(text_indices), (1, 0), constant_values=1)
    word_boundaries = pad(cumsum([len(t) for t in word_tokens[:-1]]), (1, 0))
    start_times = jump_times[word_boundaries[:-1]]
    end_times   = jump_times[word_boundaries[1:]]

jump_times[0] is the no_timestamps / path-start row. zip() drops the dummy
EOT word, so the last real word ends at its own last text token's jump.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np

RESOURCES = Path(__file__).resolve().parents[1]
BRIDGE = RESOURCES / "whisper-cpp-turbo-transcribe.py"


def load_bridge():
    spec = importlib.util.spec_from_file_location("whisper_cpp_turbo_transcribe", BRIDGE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BRIDGE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load_bridge()
find_alignment_from_dtw = bridge.find_alignment_from_dtw


def reference_spans(word_token_counts: list[int], token_jumps: list[float], path_start: float = 0.0):
    """Exact openai / faster-whisper start/end formula.

    token_jumps[k] is t_dtw of text token k (the jump of matrix row k+1).
    jump_times = [path_start] + token_jumps
    word_boundaries = [0, c0, c0+c1, ..., T]
    """
    jump_times = np.array([path_start, *token_jumps], dtype=float)
    word_boundaries = np.pad(np.cumsum(word_token_counts), (1, 0))
    start_times = jump_times[word_boundaries[:-1]]
    end_times = jump_times[word_boundaries[1:]]
    return list(zip(start_times.tolist(), end_times.tolist()))


def toks(pairs: list[tuple[str, float]]) -> list[dict]:
    return [{"text": text, "t_dtw": t * 100.0, "p": 1.0} for text, t in pairs]


class ReferenceIndexing(unittest.TestCase):
    def test_japanese_one_token_words(self):
        # Four unicode-split words; t_dtw is each token's own jump.
        times = [0.16, 0.32, 0.48, 0.64]
        tokens = toks([(ch, t) for ch, t in zip("ABCD", times)])
        words = find_alignment_from_dtw(tokens, "ja")
        expected = reference_spans([1, 1, 1, 1], times)
        self.assertEqual(len(words), 4)
        self.assertEqual(words[0]["start"], 0.0)
        self.assertEqual(words[-1]["end"], times[-1])
        for word, (start, end) in zip(words, expected):
            self.assertAlmostEqual(word["start"], start)
            self.assertAlmostEqual(word["end"], end)
        # Last word ends at its own last token, not a next-word / EOT / t1.
        self.assertAlmostEqual(words[-1]["end"], words[-1]["start"] + 0.16)

    def test_space_split_multi_token_word(self):
        # " Hello" | " world"+"s"  → counts [1, 2]
        tokens = toks([(" Hello", 0.20), (" world", 0.40), ("s", 0.50)])
        words = find_alignment_from_dtw(tokens, "en")
        expected = reference_spans([1, 2], [0.20, 0.40, 0.50])
        self.assertEqual([w["word"] for w in words], [" Hello", " worlds"])
        self.assertEqual(words[0]["start"], 0.0)
        self.assertAlmostEqual(words[-1]["end"], 0.50)
        for word, (start, end) in zip(words, expected):
            self.assertAlmostEqual(word["start"], start)
            self.assertAlmostEqual(word["end"], end)

    def test_first_word_is_path_start(self):
        tokens = toks([("あ", 0.42), ("い", 0.60)])
        words = find_alignment_from_dtw(tokens, "ja")
        self.assertEqual(words[0]["start"], 0.0)
        self.assertAlmostEqual(words[0]["end"], 0.42)

    def test_last_word_ends_at_own_last_token(self):
        tokens = toks([("あ", 0.10), ("いう", 0.30)])
        words = find_alignment_from_dtw(tokens, "ja")
        self.assertAlmostEqual(words[-1]["end"], 0.30)
        self.assertAlmostEqual(words[-1]["start"], 0.10)

    def test_not_next_word_start_as_end(self):
        # Old bridge: end_w = start of next word = first-token t_dtw of next.
        # Reference: end_w = last-token t_dtw of this word.
        tokens = toks([("あ", 0.16), ("い", 0.32)])
        words = find_alignment_from_dtw(tokens, "ja")
        self.assertAlmostEqual(words[0]["end"], 0.16)
        self.assertNotAlmostEqual(words[0]["end"], 0.32)

    def test_faster_whisper_formula_on_fixed_path(self):
        """Build jump_times the way faster-whisper does from a fixed DTW path."""
        # Path visits text rows 0..3 (no_timestamps + 3 text tokens).
        # text_indices increment at frames 0, 5, 10, 15.
        text_indices = np.array([0, 0, 0, 1, 1, 2, 2, 2, 3])
        time_indices = np.array([0, 2, 4, 5, 8, 10, 12, 14, 15])
        jumps = np.pad(np.diff(text_indices), (1, 0), constant_values=1).astype(bool)
        jump_times = time_indices[jumps] / 50.0  # TOKENS_PER_SECOND
        # jump_times[0] = 0/50; [1]=5/50; [2]=10/50; [3]=15/50
        token_jumps = jump_times[1:].tolist()
        tokens = toks([("a", token_jumps[0]), ("b", token_jumps[1]), ("c", token_jumps[2])])
        words = find_alignment_from_dtw(tokens, "ja")
        word_tokens = [[0], [0], [0], [0]]  # 3 real + dummy eot
        word_boundaries = np.pad(np.cumsum([len(t) for t in word_tokens[:-1]]), (1, 0))
        start_times = jump_times[word_boundaries[:-1]]
        end_times = jump_times[word_boundaries[1:]]
        # zip with 3 words + dummy eot truncates to 3
        for word, start, end in zip(words, start_times, end_times):
            self.assertAlmostEqual(word["start"], float(start))
            self.assertAlmostEqual(word["end"], float(end))
        self.assertEqual(words[0]["start"], 0.0)
        self.assertAlmostEqual(words[-1]["end"], float(jump_times[3]))


if __name__ == "__main__":
    unittest.main()
