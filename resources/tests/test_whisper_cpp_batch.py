#!/usr/bin/env python3
"""whisper-cli batching stays under the Windows 32767-char limit and keeps order."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

RESOURCES = Path(__file__).resolve().parents[1]
BRIDGE = RESOURCES / "whisper-cpp-turbo-transcribe.py"


def load_bridge():
    spec = importlib.util.spec_from_file_location("whisper_cpp_turbo_transcribe", BRIDGE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BRIDGE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CommandLineBatching(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_bridge()

    def test_limit_constant_is_windows_createprocess(self):
        self.assertEqual(self.mod.WINDOWS_CMDLINE_LIMIT, 32767)

    def test_single_batch_when_short(self):
        base = self.mod.build_whisper_cli_base(
            Path("whisper-cli.exe"),
            Path("m.bin"),
            "ja",
            None,
            None,
        )
        clips = [Path(f"{i}.wav") for i in range(5)]
        batches = self.mod.batch_clip_wavs(base, clips)
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0], clips)
        cmd = list(base)
        for wav in batches[0]:
            cmd.extend(["-f", str(wav)])
        self.assertLessEqual(self.mod.command_line_length(cmd), self.mod.WINDOWS_CMDLINE_LIMIT)

    def test_splits_before_limit_and_preserves_order(self):
        # Long paths so a handful of -f entries exceed 32767.
        long_dir = Path("C:/") / ("x" * 200) / ("y" * 200) / ("z" * 200)
        clips = [long_dir / f"{i:04d}.wav" for i in range(80)]
        base = self.mod.build_whisper_cli_base(
            Path("C:/whisper-cli.exe"),
            Path(str(long_dir / "ggml-large-v3-turbo.bin")),
            "ja",
            0,
            4,
        )
        batches = self.mod.batch_clip_wavs(base, clips)
        self.assertGreater(len(batches), 1)
        flattened = [wav for batch in batches for wav in batch]
        self.assertEqual(flattened, clips)
        for batch in batches:
            self.assertTrue(batch)
            cmd = list(base)
            for wav in batch:
                cmd.extend(["-f", str(wav)])
            self.assertLessEqual(
                self.mod.command_line_length(cmd),
                self.mod.WINDOWS_CMDLINE_LIMIT,
                self.mod.command_line_length(cmd),
            )

    def test_zh_prompt_is_in_base_command(self):
        base = self.mod.build_whisper_cli_base(
            Path("whisper-cli.exe"),
            Path("m.bin"),
            "zh",
            None,
            None,
        )
        self.assertIn("--prompt", base)
        self.assertIn("以下是普通话的句子，使用简体中文。", base)
        self.assertIn("-mc", base)
        self.assertEqual(base[base.index("-mc") + 1], "0")
        self.assertIn("-nfa", base)
        self.assertIn("large.v3.turbo", base)

    def test_ja_has_no_prompt(self):
        base = self.mod.build_whisper_cli_base(
            Path("whisper-cli.exe"),
            Path("m.bin"),
            "ja",
            None,
            None,
        )
        self.assertNotIn("--prompt", base)

    def test_cli_flags_match_indexfix_research(self):
        """r10 B used r7 indexfix: -mc 0 -bs 1 -tp 0 -tpi 0.2 -ojf --dtw -sns -nfa."""
        base = self.mod.build_whisper_cli_base(
            Path("whisper-cli.exe"),
            Path("m.bin"),
            "ja",
            1,
            None,
        )
        pairs = list(zip(base, base[1:]))
        self.assertIn(("-mc", "0"), pairs)
        self.assertIn(("-bs", "1"), pairs)
        self.assertIn(("-tp", "0"), pairs)
        self.assertIn(("-tpi", "0.2"), pairs)
        self.assertIn(("-dtw", "large.v3.turbo"), pairs)
        self.assertIn(("-dev", "1"), pairs)
        self.assertIn("-sns", base)
        self.assertIn("-nfa", base)
        self.assertIn("-ojf", base)


if __name__ == "__main__":
    unittest.main()
