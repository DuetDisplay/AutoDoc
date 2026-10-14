#!/usr/bin/env python3
"""Parse and match whisper-cli ggml_vulkan device lines."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

RESOURCES = Path(__file__).resolve().parents[1]
BRIDGE = RESOURCES / "whisper-cpp-turbo-transcribe.py"

# Captured from this machine: whisper-cli --help (r7-lastword vulkan build).
THIS_MACHINE_HELP = """
ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = Intel(R) Iris(R) Xe Graphics (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | fp4: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none
ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1 | fp4: 0 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2
usage: whisper-cli.exe [options] file0 file1 ...
"""


def load_bridge():
    spec = importlib.util.spec_from_file_location("whisper_cpp_turbo_transcribe", BRIDGE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BRIDGE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class VulkanDeviceParse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_bridge()
        cls.devices = cls.mod.parse_vulkan_devices(THIS_MACHINE_HELP)

    def test_parses_this_machine_iris_and_rtx(self):
        self.assertEqual(
            self.devices,
            [
                (0, "Intel(R) Iris(R) Xe Graphics (Intel Corporation)"),
                (1, "NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA)"),
            ],
        )

    def test_rtx_4060_substring(self):
        index, name = self.mod.match_vulkan_device(self.devices, "RTX 4060")
        self.assertEqual(index, 1)
        self.assertIn("RTX 4060", name)

    def test_iris_resolves_to_intel(self):
        index, name = self.mod.match_vulkan_device(self.devices, "Iris")
        self.assertEqual(index, 0)
        self.assertIn("Intel", name)
        self.assertIn("Iris", name)

    def test_match_is_case_insensitive(self):
        index, _name = self.mod.match_vulkan_device(self.devices, "rtx 4060")
        self.assertEqual(index, 1)
        index, _name = self.mod.match_vulkan_device(self.devices, "iris")
        self.assertEqual(index, 0)

    def test_unmatched_name_does_not_fall_back_to_zero(self):
        with self.assertRaises(self.mod.VulkanDeviceError) as caught:
            self.mod.match_vulkan_device(self.devices, "AMD Radeon RX 7600")
        self.assertNotIn("device 0", str(caught.exception).lower())
        self.assertEqual(caught.exception.devices[0]["index"], 0)
        self.assertEqual(caught.exception.devices[1]["index"], 1)

    def test_explicit_device_wins_over_name(self):
        listed = []

        def list_devices():
            listed.append(True)
            return self.devices

        index, name = self.mod.resolve_vulkan_device(
            0, "RTX 4060", list_devices=list_devices
        )
        self.assertEqual(index, 0)
        self.assertIn("Iris", name)
        self.assertTrue(listed)

    def test_name_only_resolves_rtx(self):
        index, name = self.mod.resolve_vulkan_device(
            None, "RTX 4060", devices=self.devices
        )
        self.assertEqual(index, 1)
        self.assertIn("RTX 4060", name)

    def test_neither_flag_leaves_device_unset(self):
        called = []

        def list_devices():
            called.append(True)
            return self.devices

        index, name = self.mod.resolve_vulkan_device(None, None, list_devices=list_devices)
        self.assertIsNone(index)
        self.assertIsNone(name)
        self.assertEqual(called, [])


if __name__ == "__main__":
    unittest.main()
