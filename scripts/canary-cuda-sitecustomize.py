"""Register bundled NVIDIA CUDA / cuDNN DLL directories for onnxruntime-gpu."""
from __future__ import annotations

import os
from pathlib import Path

_root = Path(__file__).resolve().parent
_nvidia = _root / "nvidia"
if _nvidia.is_dir():
    bins: list[str] = []
    for child in sorted(_nvidia.iterdir()):
        bin_dir = child / "bin"
        if bin_dir.is_dir():
            path = str(bin_dir)
            bins.append(path)
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(path)
                except OSError:
                    pass
    if bins:
        os.environ["PATH"] = os.pathsep.join(bins) + os.pathsep + os.environ.get("PATH", "")
