# Windows transcription assets

The Windows speech runtimes and models are zips attached to one GitHub release on `DuetDisplay/AutoDoc`. The app downloads every asset from the tag named by `DEFAULT_WINDOWS_TRANSCRIPTION_RELEASE_TAG` in `src/main/services/distribution-config.ts` (currently `windows-transcription-v3`). `AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL` overrides the base URL for local test servers.

## Publishing a release

A published tag is never modified, because installed versions keep downloading from it. A new tag carries every file of the previous tag, byte-identical, plus the new ones. GitHub limits release files to 2 GB, so larger zips are uploaded only as `.partN` files, which the app concatenates.

Releases are built and published by the manual workflow `.github/workflows/windows-transcription-assets.yml`, in two runs:

1. Run it with `publish_assets` off. It builds every asset from source with `npm run prepare:windows-transcription-assets` (pinned Python packages, Hugging Face files checked against pinned SHA-256s, whisper.cpp v1.9.4 plus `scripts/whisper-cpp/*.patch` built against Vulkan SDK 1.4.341.1). Then it signs the runtimes with DigiCert and runs `scripts/write-windows-transcription-release-manifest.js`. That script fails if a previous-release file changed or is missing, or if an upload file is over 2 GB. The artifact holds the upload files, `SHA256SUMS.md`, `UPLOAD-MANIFEST.md`, `SIGNING-REPORT.md` and the generated `windows-transcription-manifest.json`.
2. Commit that manifest as `resources/windows-transcription-manifest.json` and copy changed hashes into the fallback profiles in `src/main/services/windows-transcription-runtime.ts`. A unit test fails until they match.
3. Run the workflow with `publish_assets` on and `build_run_id` set to the first run. It doesn't rebuild, because signatures are timestamped and a second build can't match. It downloads that run's artifact. `scripts/verify-windows-transcription-release-assets.js` then checks that the committed manifest equals the generated one, that signing wasn't a dry run, and that every upload file has the committed bytes and SHA-256. Only then does it upload to the release.

Model zips and unsigned runtime zips are reproducible: entries are sorted and use a fixed timestamp. Signing changes the runtime zips on every run. To compare a build with another one, compare the zip members' SHA-256s.

To build locally, run `npm run prepare:windows-transcription-assets` with `VULKAN_SDK` set and Visual Studio 2022 installed. Then run `node scripts/sign-windows-transcription-assets.js <dir> [--dry-run]` with the DigiCert environment from `.github/workflows/build.yml`, and the manifest writer.

## Code signing

`scripts/sign-windows-transcription-assets.js` processes the runtimes new in v3: `whisper-cpp-vulkan-runtime-win-x64.zip`, `canary-cuda-runtime-win-x64.zip`, `faster-whisper-runtime-cpu-win-x64-v3.zip`, `faster-whisper-runtime-cuda-win-x64-v3.zip` and `parakeet-runtime-win-x64-v3.zip`. It signs every PE file (`.exe`, `.dll`, `.pyd`) without an Authenticode signature through `scripts/windows-sign.js`, re-zips with the original entry list, and writes `SIGNING-REPORT.md`.

The CPython set signed in every Python runtime is `python.exe`, `pythonw.exe`, `python3.dll`, `python311.dll`, the stdlib `.pyd` files, OpenSSL, libffi and sqlite, plus numpy and OpenBLAS and the protobuf extension.

| Runtime | Signed by us | Left as shipped |
|---|---|---|
| whisper-cpp-vulkan | 6: `whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-vulkan.dll` | none |
| faster-whisper CPU | 67: CPython set, CTranslate2, tokenizers, hf-xet, PyYAML | Vendor-signed (10): onnxruntime (Microsoft), MSVC runtime (Microsoft), Intel OpenMP (Intel), CTranslate2's cuDNN stub (NVIDIA), Tcl/Tk (PSF) |
| faster-whisper CUDA | 67: as CPU | Vendor-signed (19): as CPU plus cuDNN (NVIDIA). Unsigned NVIDIA redistributables (6) under `Lib/site-packages/nvidia/`: cuBLAS, cuBLASLt, NVBLAS, NVRTC |
| parakeet | 62: CPython set | Vendor-signed (9): onnxruntime-directml and DirectML (Microsoft), MSVC runtime (Microsoft), Tcl/Tk (PSF) |
| canary-cuda | 62: CPython set | Vendor-signed (18): cuDNN (NVIDIA), onnxruntime-gpu (Microsoft), MSVC runtime (Microsoft), Tcl/Tk (PSF). Unsigned NVIDIA redistributables (11) under `Lib/site-packages/nvidia/`: cuBLAS, cuBLASLt, NVBLAS, NVRTC, cudart, cuFFT, cuRAND, nvJitLink |

NVIDIA's redistributable DLLs are never modified, signed or not. Files carried over unchanged from v2 aren't re-signed: their bytes are fixed by the earlier release. The Authenticode states in the license tables below are as built, before signing.

## Licenses

Exact package, native-library, and model-license inventory for the Windows transcription runtime zips. Source of truth is the zips themselves (plus `resources/windows-transcription-manifest.json` and the asset build's `assets.json` for model provenance). Use this as input for the Settings **Open-source licenses** view. **Regenerate this section when any runtime zip changes.**

Inventoried on 2026-10-05. CPython in every Python runtime is python-build-standalone `cpython-3.11.15+20260414-x86_64-pc-windows-msvc-install_only` (`include/patchlevel.h`: `PY_VERSION "3.11.15"`). Site-packages `pip` / `setuptools` / `wheel` were pruned after install; they are **not** installed distributions. CPython still ships unused `Lib/ensurepip/_bundled/pip-24.0` and `setuptools-79.0.1` wheels.

License column uses `License-Expression`, else `License`, else `Classifier: License ::`. If those disagree or a field is missing, the Notes say so. “LICENSE file” means a `LICENSE` / `NOTICE` / `LICENCE` / `License.txt` in the `.dist-info` directory or its `licenses/` subfolder.

Authenticode CN is from `Get-AuthenticodeSignature` on extracted binaries. `NotSigned` means no Authenticode signature, not that the file is unsigned by its vendor’s own process.

---

### faster-whisper-runtime-cpu-win-x64-v3.zip

English CPU route and Whisper turbo CPU. Pinned in `scripts/prepare-windows-transcription-assets.js` (`CPU_RUNTIME_PACKAGES`); the build fails if any other distribution is installed. Replaces v2's `faster-whisper-runtime-cpu-win-x64.zip`, which is identical except that it also ships PyAV 17.0.1 and its FFmpeg DLLs (including GPL `libx264` / `libx265`). faster-whisper is installed with `--no-deps` so PyAV is left out: it only decodes audio files, and the worker passes faster-whisper decoded WAV samples instead.

#### Python distributions

| Component | Version | License | Notes |
|---|---|---|---|
| annotated-doc | 0.0.4 | MIT | License-Expression; `licenses/LICENSE` |
| anyio | 4.13.0 | MIT | License-Expression; `licenses/LICENSE` |
| certifi | 2026.4.22 | MPL-2.0 | `License` + classifier; `licenses/LICENSE` |
| click | 8.3.3 | BSD-3-Clause | License-Expression; `licenses/LICENSE.txt` |
| colorama | 0.4.6 | BSD-3-Clause | METADATA `License` empty; classifier only “BSD License”; `licenses/LICENSE.txt` is 3-clause BSD |
| ctranslate2 | 4.7.1 | MIT | `License: MIT`; **no LICENSE file** in dist-info |
| faster-whisper | 1.2.1 | MIT | `License` + classifier; dist-info `LICENSE` |
| filelock | 3.29.0 | MIT | License-Expression; `licenses/LICENSE` |
| flatbuffers | 25.12.19 | Apache-2.0 | `License: Apache 2.0`; **no LICENSE file** |
| fsspec | 2026.4.0 | BSD-3-Clause | License-Expression; `licenses/LICENSE` |
| h11 | 0.16.0 | MIT | `License` + classifier; `licenses/LICENSE.txt` |
| hf-xet | 1.5.0 | Apache-2.0 | License-Expression; `licenses/LICENSE` |
| httpcore | 1.0.9 | BSD-3-Clause | License-Expression; `licenses/LICENSE.md` |
| httpx | 0.28.1 | BSD-3-Clause | `License` + classifier; `licenses/LICENSE.md` |
| huggingface_hub | 1.14.0 | Apache-2.0 | `License` + classifier; `licenses/LICENSE`. Transitive via faster-whisper / tokenizers |
| idna | 3.13 | BSD-3-Clause | License-Expression; `licenses/LICENSE.md` |
| markdown-it-py | 4.2.0 | MIT | No License-Expression / License field; classifier MIT; `licenses/LICENSE` + `LICENSE.markdown-it` |
| mdurl | 0.1.2 | MIT | No License-Expression / License field; classifier MIT; dist-info `LICENSE` |
| numpy | 2.4.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | License-Expression; `licenses/LICENSE.txt` plus many vendored third-party license files |
| onnxruntime | 1.25.1 | MIT | `License: MIT License`; **no LICENSE file in dist-info**; package `onnxruntime/LICENSE` is MIT (Microsoft). Also `onnxruntime/ThirdPartyNotices.txt` |
| packaging | 26.2 | Apache-2.0 OR BSD-2-Clause | License-Expression; `licenses/LICENSE`, `LICENSE.APACHE`, `LICENSE.BSD` |
| protobuf | 7.34.1 | BSD-3-Clause | `License: 3-Clause BSD License`; dist-info `LICENSE` |
| Pygments | 2.20.0 | BSD-2-Clause | License-Expression; `licenses/LICENSE` |
| PyYAML | 6.0.3 | MIT | `License` + classifier; `licenses/LICENSE` |
| rich | 15.0.0 | MIT | `License` + classifier; `licenses/LICENSE` |
| shellingham | 1.5.4 | ISC | `License: ISC License`; dist-info `LICENSE` |
| tokenizers | 0.23.1 | Apache Software License (version not stated) | Classifier only; **no License / License-Expression / LICENSE file** |
| tqdm | 4.67.3 | MPL-2.0 AND MIT | `License`; `licenses/LICENCE` |
| typer | 0.25.1 | MIT | License-Expression; `licenses/LICENSE` |
| typing_extensions | 4.15.0 | PSF-2.0 | License-Expression; `licenses/LICENSE` |

#### CPython and bundled libs

| Component | Version | License | Notes |
|---|---|---|---|
| CPython | 3.11.15 | PSF-2.0 | `LICENSE.txt` (PSF License v2). `python.exe` / `pythonw.exe` / `python3.dll` / `python311.dll` **NotSigned** |
| Microsoft Distributable Code | (linked into every `.exe`/`.dll`/`.pyd`) | Microsoft Visual C++ redistributable terms | Called out in `LICENSE.txt` (“Additional Conditions for this Windows binary build”) |
| vcruntime140.dll, vcruntime140_1.dll | (VS 2022 redist) | Microsoft Visual C++ redistributable terms | Root of zip. Authenticode Valid, CN=`Microsoft Windows Hardware Compatibility Publisher` |
| OpenSSL (`DLLs/libssl-3-x64.dll`, `libcrypto-3-x64.dll`) | OpenSSL 3 (filename) | Apache-2.0 (OpenSSL 3) | **Not listed in this zip’s `LICENSE.txt`**. Both **NotSigned** |
| libffi (`DLLs/libffi-8.dll`) | 8 | MIT (libffi) | **Not listed in `LICENSE.txt`**. **NotSigned** |
| SQLite (`DLLs/sqlite3.dll`) | (unspecified in zip) | public domain (SQLite) | **Not listed in `LICENSE.txt`**. **NotSigned** |
| bzip2 (`DLLs/_bz2.pyd`) | 1.0.8 | bzip2 | Enumerated in `LICENSE.txt` |
| xz / liblzma (`DLLs/_lzma.pyd`) | (unspecified) | 0BSD / public domain (XZ Utils) | Present as extension; **no standalone xz DLL**; **not listed in `LICENSE.txt`** |
| zlib | (no `DLLs/zlib1.dll`) | zlib | No separate zlib DLL; typically linked into `python311.dll`. **Not listed in `LICENSE.txt`** |
| Tcl/Tk (`tcl86t.dll`, `tk86t.dll`, plus `tcl/dde1.4`, `tcl/reg1.3`, `tcl/tix8.4.3`) | 8.6 | Tcl/Tk BSD-style | Enumerated in `LICENSE.txt`. `tcl86t.dll` / `tk86t.dll` Authenticode Valid, CN=`Python Software Foundation` |

#### Native / vendor DLLs

| Component | Version | License | Notes |
|---|---|---|---|
| `ctranslate2/ctranslate2.dll` | 4.7.1 | MIT (wheel) | **NotSigned** |
| `ctranslate2/cudnn64_9.dll` | (266 KB stub from CTranslate2 CPU wheel) | NVIDIA proprietary (cuDNN) | Unexpected on the **CPU** zip. Authenticode Valid, CN=`NVIDIA Corporation` |
| `ctranslate2/libiomp5md.dll` | (Intel OpenMP) | Intel Simplified Software License (not in a dist-info) | Authenticode Valid, CN=`Intel Corporation` |
| `onnxruntime/capi/onnxruntime.dll` | 1.25.1 | MIT | Authenticode Valid, CN=`Microsoft Corporation` |
| `onnxruntime/capi/onnxruntime_providers_shared.dll` | 1.25.1 | MIT | Authenticode Valid, CN=`Microsoft Corporation` |
| `numpy.libs/msvcp140-*.dll` | (VS redist, hashed name) | Microsoft Visual C++ redistributable terms | Authenticode Valid, CN=`Microsoft Windows Software Compatibility Publisher` |
| `numpy.libs/libscipy_openblas64_*.dll` | (OpenBLAS, hashed) | BSD-3-Clause (OpenBLAS; covered by numpy License-Expression) | Not separately signed-checked |

---

### faster-whisper-runtime-cuda-win-x64-v3.zip

English NVIDIA and Whisper turbo NVIDIA. Same Python set as the CPU zip **plus** the three pinned CUDA wheels. CPython / OpenSSL / libffi / sqlite / Tcl/Tk / MSVC / CTranslate2 / ORT CPU DLLs match the CPU zip (same versions; `ctranslate2.dll` also **NotSigned**). Replaces v2's `faster-whisper-runtime-cuda-win-x64.zip`; the only difference is that PyAV is removed, as in the CPU zip.

#### Additional Python distributions

| Component | Version | License | Notes |
|---|---|---|---|
| nvidia-cublas-cu12 | 12.9.2.10 | LicenseRef-NVIDIA-Proprietary | License-Expression; `licenses/License.txt` is the NVIDIA CUDA Toolkit EULA. **METADATA gives no license URL** |
| nvidia-cuda-nvrtc-cu12 | 12.9.86 | LicenseRef-NVIDIA-Proprietary | `License` + classifier `Other/Proprietary License`; `licenses/License.txt` (same EULA family). No license URL in METADATA |
| nvidia-cudnn-cu12 | 9.21.1.3 | LicenseRef-NVIDIA-Proprietary | License-Expression; `licenses/License.txt`. No license URL in METADATA |

CPU-zip Python rows that are identical here (not repeated): annotated-doc 0.0.4 through typing_extensions 4.15.0, including ctranslate2 4.7.1, faster-whisper 1.2.1, huggingface_hub 1.14.0, numpy 2.4.4, onnxruntime 1.25.1, tokenizers 0.23.1.

#### Additional native / vendor DLLs

| Component | Version | License | Notes |
|---|---|---|---|
| `nvidia/cublas/bin/cublas64_12.dll` | 12.9.2.10 | NVIDIA proprietary (CUDA EULA / Attachment A) | |
| `nvidia/cublas/bin/cublasLt64_12.dll` | 12.9.2.10 | NVIDIA proprietary | |
| `nvidia/cublas/bin/nvblas64_12.dll` | 12.9.2.10 | NVIDIA proprietary | **NotSigned** |
| `nvidia/cuda_nvrtc/bin/nvrtc64_120_0.dll` | 12.9.86 | NVIDIA proprietary | |
| `nvidia/cuda_nvrtc/bin/nvrtc64_120_0.alt.dll` | 12.9.86 | NVIDIA proprietary | |
| `nvidia/cuda_nvrtc/bin/nvrtc-builtins64_129.dll` | 12.9.86 | NVIDIA proprietary | **NotSigned** |
| `nvidia/cudnn/bin/cudnn64_9.dll` | 9.21.1.3 | NVIDIA proprietary (cuDNN EULA) | Plus `cudnn_adv64_9`, `cudnn_cnn64_9`, `cudnn_engines_precompiled64_9`, `cudnn_engines_runtime_compiled64_9`, `cudnn_engines_tensor_ir64_9`, `cudnn_graph64_9`, `cudnn_heuristic64_9`, `cudnn_ops64_9` |
| `ctranslate2/cudnn64_9.dll` | (CTranslate2-bundled stub) | NVIDIA proprietary | Also present here; Valid, CN=`NVIDIA Corporation` (checked on the CPU copy of the same wheel) |

No `cudart` / `cufft` / `curand` wheels in this zip (unlike canary-cuda). No `vulkan-1.dll`.

---

### parakeet-runtime-win-x64-v3.zip

English Parakeet and Canary CPU. Pinned in `PARAKEET_RUNTIME_PACKAGES`, at the versions v2 shipped. Replaces v2's `parakeet-runtime-win-x64.zip`, which is identical except that it also ships `huggingface_hub` 1.22.0 and its dependency tree (anyio, certifi, click, colorama, filelock, fsspec, h11, hf-xet, httpcore, httpx, idna, PyYAML, tqdm, typing_extensions). That was installed only to download models during the build; the build now downloads through the faster-whisper CPU runtime. `sympy` / `mpmath` come from `onnxruntime-directml` (`Requires-Dist: sympy`), not from onnx-asr.

#### Python distributions

| Component | Version | License | Notes |
|---|---|---|---|
| flatbuffers | 25.12.19 | Apache-2.0 | Via onnxruntime-directml. **no LICENSE file** |
| mpmath | 1.3.0 | BSD | Via sympy. `License: BSD`; dist-info `LICENSE` |
| numpy | 2.4.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | License-Expression; `licenses/LICENSE.txt` |
| onnx-asr | 0.11.0 | MIT | License-Expression; `licenses/LICENSE`. Requires only numpy (and typing-extensions on older Python) |
| onnxruntime-directml | 1.24.4 | MIT | `License: MIT License`; **no LICENSE file in dist-info**; package `onnxruntime/LICENSE` is MIT. Requires sympy |
| packaging | 26.2 | Apache-2.0 OR BSD-2-Clause | Via ORT |
| protobuf | 7.35.1 | BSD-3-Clause | Via ORT (newer than the faster-whisper pin) |
| sympy | 1.14.0 | BSD | Via onnxruntime-directml. `License: BSD`; `licenses/LICENSE` |

#### CPython and bundled libs

Same CPython 3.11.15 standalone layout as the faster-whisper CPU zip (same `LICENSE.txt`, same `DLLs/libssl-3-x64.dll`, `libcrypto-3-x64.dll`, `libffi-8.dll`, `sqlite3.dll`, `tcl86t.dll`, `tk86t.dll`, `_bz2.pyd`, `_lzma.pyd`, root `vcruntime140.dll` / `vcruntime140_1.dll`). `python.exe` **NotSigned**. `vcruntime140.dll` Valid, CN=`Microsoft Windows Hardware Compatibility Publisher`.

#### Native / vendor DLLs

| Component | Version | License | Notes |
|---|---|---|---|
| `onnxruntime/capi/onnxruntime.dll` | 1.24.4 (DirectML build) | MIT | Authenticode Valid, CN=`Microsoft Corporation` (21 111 880 bytes; different binary from ORT 1.25.1 CPU) |
| `onnxruntime/capi/onnxruntime_providers_shared.dll` | 1.24.4 | MIT | |
| `onnxruntime/capi/DirectML.dll` | (shipped by onnxruntime-directml) | Microsoft DirectML redistributable terms (not in dist-info) | Authenticode Valid, CN=`Microsoft Windows Publisher` |
| `numpy.libs/msvcp140-*.dll` | (VS redist) | Microsoft Visual C++ redistributable terms | Same hashed file as faster-whisper |
| `numpy.libs/libscipy_openblas64_*.dll` | (OpenBLAS) | BSD-3-Clause (via numpy) | |

---

### canary-cuda-runtime-win-x64.zip

Canary NVIDIA. Pinned in `CANARY_CUDA_RUNTIME_PACKAGES`. The build copies `scripts/canary-cuda-sitecustomize.py` to `Lib/site-packages/sitecustomize.py`, which registers the NVIDIA `bin` dirs, and deletes `onnxruntime_providers_tensorrt.dll`: the worker only requests the CUDA and CPU providers, and no TensorRT redistributable is bundled. Not in v2.

#### Python distributions

| Component | Version | License | Notes |
|---|---|---|---|
| flatbuffers | 25.12.19 | Apache-2.0 | Via onnxruntime-gpu. **no LICENSE file** |
| numpy | 2.4.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | License-Expression; `licenses/LICENSE.txt` |
| onnx-asr | 0.11.0 | MIT | License-Expression; `licenses/LICENSE` |
| onnxruntime-gpu | 1.25.1 | MIT | `License: MIT License`; **no LICENSE file in dist-info**; package `onnxruntime/LICENSE` is MIT. Hard deps: flatbuffers, numpy, packaging, protobuf (no sympy) |
| packaging | 26.2 | Apache-2.0 OR BSD-2-Clause | Via ORT |
| protobuf | 7.35.1 | BSD-3-Clause | Via ORT |
| nvidia-cuda-runtime-cu12 | 12.9.79 | LicenseRef-NVIDIA-Proprietary | `License` + classifier `Other/Proprietary License`; `licenses/License.txt`. **No license URL in METADATA** |
| nvidia-cufft-cu12 | 11.4.1.4 | LicenseRef-NVIDIA-Proprietary | Same; classifier `Other/Proprietary License`; `licenses/License.txt`. Requires nvidia-nvjitlink-cu12 |
| nvidia-nvjitlink-cu12 | 12.9.86 | LicenseRef-NVIDIA-Proprietary | Via nvidia-cufft-cu12. Classifier `Other/Proprietary License`; `licenses/License.txt` |
| nvidia-curand-cu12 | 10.3.10.19 | NVIDIA Proprietary Software | `License: NVIDIA Proprietary Software`; classifier `Other/Proprietary License`; dist-info root `License.txt` (not under `licenses/`) |
| nvidia-cublas-cu12 | 12.9.2.10 | LicenseRef-NVIDIA-Proprietary | Same wheel as faster-whisper-cuda |
| nvidia-cudnn-cu12 | 9.21.1.3 | LicenseRef-NVIDIA-Proprietary | Same wheel as faster-whisper-cuda |
| nvidia-cuda-nvrtc-cu12 | 12.9.86 | LicenseRef-NVIDIA-Proprietary | Same wheel as faster-whisper-cuda |

#### CPython and bundled libs

Same CPython 3.11.15 standalone as parakeet. Same `LICENSE.txt` and `DLLs/` set. Same MSVC `vcruntime140.dll` / `vcruntime140_1.dll`.

#### Native / vendor DLLs

| Component | Version | License | Notes |
|---|---|---|---|
| `nvidia/cuda_runtime/bin/cudart64_12.dll` | 12.9.79 | NVIDIA proprietary (CUDA EULA / Attachment A) | **NotSigned** |
| `nvidia/cufft/bin/cufft64_11.dll` | 11.4.1.4 | NVIDIA proprietary | **NotSigned** (287 136 768 bytes) |
| `nvidia/cufft/bin/cufftw64_11.dll` | 11.4.1.4 | NVIDIA proprietary | |
| `nvidia/curand/bin/curand64_10.dll` | 10.3.10.19 | NVIDIA proprietary | **NotSigned** |
| `nvidia/nvjitlink/bin/nvJitLink_120_0.dll` | 12.9.86 | NVIDIA proprietary | |
| `nvidia/cublas/bin/cublas64_12.dll`, `cublasLt64_12.dll`, `nvblas64_12.dll` | 12.9.2.10 | NVIDIA proprietary | |
| `nvidia/cuda_nvrtc/bin/nvrtc64_120_0.dll`, `nvrtc64_120_0.alt.dll`, `nvrtc-builtins64_129.dll` | 12.9.86 | NVIDIA proprietary | |
| `nvidia/cudnn/bin/cudnn64_9.dll` + `cudnn_*64_9.dll` (8 extra) | 9.21.1.3 | NVIDIA proprietary (cuDNN) | Same set as faster-whisper-cuda |
| `onnxruntime/capi/onnxruntime.dll` | 1.25.1 (GPU build) | MIT | Authenticode Valid, CN=`Microsoft Corporation` (16 200 504 bytes; different from CPU and DirectML builds) |
| `onnxruntime/capi/onnxruntime_providers_shared.dll` | 1.25.1 | MIT | |
| `onnxruntime/capi/onnxruntime_providers_cuda.dll` | 1.25.1 | MIT | Authenticode Valid, CN=`Microsoft Corporation` |
| `numpy.libs/msvcp140-*.dll`, `libscipy_openblas64_*.dll` | (same numpy wheel as parakeet) | MSVC redist / BSD-3-Clause | |

---

### whisper-cpp-vulkan-runtime-win-x64.zip

Whisper turbo on AMD/Intel via Vulkan. Self-built whisper.cpp; no Python. Files in the zip (complete):

| File | Version | License | Notes |
|---|---|---|---|
| `BUILD.txt` | — | (build record) | Tag **v1.9.4**, commit **927cfce** (`ggml-org/whisper.cpp`). Patch: `whisper-dtw-median-filter-short-window.patch` only (skip median filter when leftover window `n <= filter_width/2`). CMake: `-DGGML_VULKAN=ON -DWHISPER_BUILD_EXAMPLES=ON`, VS 2022, Vulkan SDK 1.4.341.1. Full patch diff is appended in this file |
| `whisper-cli.exe` | v1.9.4 + patch | MIT (whisper.cpp) | **NotSigned** |
| `whisper.dll` | v1.9.4 + patch | MIT (whisper.cpp) | **NotSigned** |
| `ggml.dll` | v1.9.4 | MIT (ggml) | **NotSigned** |
| `ggml-base.dll` | v1.9.4 | MIT (ggml) | **NotSigned** |
| `ggml-cpu.dll` | v1.9.4 | MIT (ggml) | **NotSigned** |
| `ggml-vulkan.dll` | v1.9.4 | MIT (ggml) | **NotSigned**. Links the **system** Vulkan loader |
| `vulkan-1.dll` | — | — | **Not bundled** (confirmed: 7 files only). Comes with the GPU driver |

---

### Models

No model zips were extracted. Licenses and sources from `resources/windows-transcription-manifest.json` (`sources`, `licenses`) and the asset build's `assets.json`. `silero_vad.onnx` is inside a model zip only where the manifest `expectedFiles` lists it.

| Zip | Upstream model | License | Attribution needed |
|---|---|---|---|
| canary-1b-v2-int8.zip | nvidia/canary-1b-v2 via istupakov/canary-1b-v2-onnx (int8); `silero_vad.onnx` from istupakov/silero-vad-onnx | CC-BY-4.0 (NVIDIA weights) + MIT (Silero VAD) | **Yes — CC-BY-4.0** |
| canary-1b-v2-fp32.zip | nvidia/canary-1b-v2 via istupakov/canary-1b-v2-onnx (fp32); `silero_vad.onnx` | CC-BY-4.0 + MIT (Silero VAD) | **Yes — CC-BY-4.0** |
| parakeet-tdt-0.6b-v3-fp32.zip | nvidia/parakeet-tdt-0.6b-v3 via istupakov/parakeet-tdt-0.6b-v3-onnx (fp32); `silero_vad.onnx` | CC-BY-4.0 (NVIDIA weights) + MIT (Silero VAD) | **Yes — CC-BY-4.0** |
| parakeet-tdt-0.6b-v3-int8.zip | nvidia/parakeet-tdt-0.6b-v3 via istupakov/parakeet-tdt-0.6b-v3-onnx (int8); `silero_vad.onnx` | CC-BY-4.0 + MIT (Silero VAD) | **Yes — CC-BY-4.0** |
| faster-whisper-distil-large-v3-ct2.zip | distil-whisper/distil-large-v3, Systran CT2 (`Systran/faster-distil-whisper-large-v3`) | MIT | MIT copyright notice |
| faster-whisper-small-en-ct2-int8.zip | openai/whisper-small.en, CT2 int8 (`Systran/faster-whisper-small.en`) | MIT | MIT copyright notice |
| faster-whisper-large-v3-turbo-ct2.zip | openai/whisper-large-v3-turbo, mobiuslabsgmbh CT2 | MIT | MIT copyright notice |
| ggml-large-v3-turbo.zip | openai/whisper-large-v3-turbo, ggerganov/whisper.cpp F16 ggml | MIT | MIT copyright notice |

ONNX conversions of Canary and Parakeet are by **istupakov** on Hugging Face (`istupakov/canary-1b-v2-onnx`, `istupakov/parakeet-tdt-0.6b-v3-onnx`).

#### CC-BY-4.0 attribution (Canary-1B-v2)

> Canary-1B-v2 © NVIDIA. Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Model: <https://huggingface.co/nvidia/canary-1b-v2>. ONNX conversion by istupakov: <https://huggingface.co/istupakov/canary-1b-v2-onnx>.

#### CC-BY-4.0 attribution (Parakeet TDT 0.6B v3)

> Parakeet TDT 0.6B v3 © NVIDIA. Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Model: <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>. ONNX conversion by istupakov: <https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx>.

---

### Needs legal review

1. **NVIDIA CUDA / cuDNN EULA** — `LicenseRef-NVIDIA-Proprietary` / “NVIDIA Proprietary Software” / classifier `Other/Proprietary License`. Bundled `License.txt` is the CUDA Toolkit EULA (redistribute only Attachment A runtime DLLs; not a full toolkit; GPU-only use). **METADATA does not include a license URL.** Sampled wheel DLLs (`cudart64_12.dll`, `cufft64_11.dll`, `curand64_10.dll`, `nvrtc-builtins64_129.dll`, `nvblas64_12.dll`) are **NotSigned**.
2. **MSVC redistributables** — root `vcruntime140.dll` / `vcruntime140_1.dll` and numpy’s hashed `msvcp140-*.dll`. Also CPython `LICENSE.txt` “Microsoft Distributable Code” conditions on every linked `.exe`/`.dll`/`.pyd`.
3. **CPython `LICENSE.txt` gap** — OpenSSL 3, libffi, SQLite, zlib, and xz binaries/extensions are in the runtime, but this standalone `LICENSE.txt` only spells out PSF-2.0, Microsoft Distributable Code, bzip2 1.0.8, and Tcl/Tk.
4. **tokenizers 0.23.1** — Apache classifier only; no License field, License-Expression, or LICENSE file (Apache 1.1 vs 2.0 not stated in-tree).
5. **colorama 0.4.6** — METADATA license empty; classifier only “BSD License”. LICENSE.txt is BSD-3-Clause.
6. **DirectML.dll** (parakeet) — Microsoft-signed; redistributable terms are not in the wheel METADATA (ORT itself is MIT).
7. **Intel OpenMP `libiomp5md.dll`** (CTranslate2) — Intel-signed; no dist-info license file.
8. **onnxruntime `ThirdPartyNotices.txt`** — includes Intel MKL ISSL and a notice that LGPL components may be reverse-engineered to debug modifications. ORT 1.24.4 DirectML still hard-depends on **sympy**.
9. **MPL-2.0** — `certifi` and `tqdm` (`MPL-2.0 AND MIT`) in the faster-whisper runtimes. File-level copyleft if those files are modified.
10. **ctranslate2 CPU wheel ships `cudnn64_9.dll`** (NVIDIA-signed stub) even in the CPU-only zip.
11. **ensurepip bundled wheels** (`pip-24.0`, `setuptools-79.0.1`) remain inside every Python runtime under `Lib/ensurepip/_bundled/`.
