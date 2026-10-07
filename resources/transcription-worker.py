#!/usr/bin/env python3
"""
JSON-lines-over-stdio protocol for the persistent transcription worker.

Requests (one JSON object per line on stdin):
- load: {"id", "op": "load", "engine": "faster-whisper"|"parakeet"|"canary"|"whisper-turbo", "model", "device": "cuda"|"cpu"|"dml", "computeType", "threads": number|null}
- transcribe: {"id", "op": "transcribe", "audio", "language", "window": {"startSec", "endSec"} | null}
- unload: {"id", "op": "unload"}
- ping: {"id", "op": "ping"}
- selftest: {"id", "op": "selftest", "engine"?, "model"?, "device"?, "computeType"?, "threads"?, "language"?}
  If model/engine are present, loads first (releasing any previous model). Then
  decodes synthetic audio on the loaded device path. Canary uses the raw
  onnx_asr model (no VAD) and ~MAX_SPEECH_SEC of audio so the encoder/decoder
  actually run. Other engines use a 1 s tone.

Responses on stdout (one JSON object per line):
- success: {"id", "ok": true, "result": ...}
- failure: {"id", "ok": false, "error": string}

transcribe result shape (every engine):
{"transcription": [{"offsets": {"from": ms, "to": ms}, "text": string}]}

selftest result shape:
{"ok": true, "engine": string, "device": string, "elapsedMs": number, "loadMs": number, "transcribeMs": number, "segments": number}

canary load: engine "canary", device "cpu"|"cuda", computeType "int8"|"fp32".
  quantization int8 or None (fp32); Silero VAD batch_size=1,
  max_speech_duration_s=MAX_SPEECH_SEC (Mac canary-mlx-transcribe.py);
  max_sequence_length 266; recognize language = target_language = request language.
  The raw onnx_asr adapter is kept for selftest so VAD cannot skip the encoder.

whisper-turbo load: engine "whisper-turbo", same WhisperModel load as faster-whisper
  (CUDA float16 or CPU int8 per computeType). transcribe uses the Mac pause-split
  contract (whisper_turbo_contract.py): beam_size=1, condition_on_previous_text=False,
  word_timestamps=True, hallucination_silence_threshold=2.0, temperature fallback
  is the faster-whisper/openai default, zh initial prompt.

When window is set, segment offsets in transcribe results and segment events are
RELATIVE TO THE WINDOW START (the caller adds chunkStart * 1000, matching existing chunk logic).

Unsolicited progress events on stdout:
{"event": "segment", "id", "startMs", "endMs", "text"}
Emitted as each segment decodes. Window-relative when windowed.
"""

import argparse
import ctypes
import gc
import json
import os
import sys
import time
import wave
from ctypes import wintypes

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

# Mac canary-mlx-transcribe.py MAX_SPEECH_SEC: longest VAD speech window.
MAX_SPEECH_SEC = 25

for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1
PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1
ProcessPowerThrottling = 4


class PROCESS_POWER_THROTTLING_STATE(ctypes.Structure):
    _fields_ = [
        ("Version", wintypes.ULONG),
        ("ControlMask", wintypes.ULONG),
        ("StateMask", wintypes.ULONG),
    ]


def _enable_eco_qos() -> None:
    # Same mechanism Defender/OneDrive use (routes to E-cores, green-leaf in Task Manager).
    try:
        state = PROCESS_POWER_THROTTLING_STATE()
        state.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION
        state.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED
        state.StateMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Without explicit argtypes/restype the 64-bit pseudo-handle from
        # GetCurrentProcess is truncated and SetProcessInformation fails
        # with ERROR_INVALID_HANDLE.
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetProcessInformation.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetProcessInformation.restype = wintypes.BOOL
        if (
            kernel32.SetProcessInformation(
                kernel32.GetCurrentProcess(),
                ProcessPowerThrottling,
                ctypes.byref(state),
                ctypes.sizeof(state),
            )
            == 0
        ):
            error = ctypes.get_last_error()
            print(
                f"EcoQoS unavailable: SetProcessInformation failed (error {error})",
                file=sys.stderr,
            )
    except Exception as exc:
        print(f"EcoQoS unavailable: {exc}", file=sys.stderr)


def _respond(request_id: int, ok: bool, result=None, error: str | None = None) -> None:
    payload = {"id": request_id, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error or "request failed"
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _emit_segment(request_id: int, start_ms: int, end_ms: int, text: str) -> None:
    print(
        json.dumps(
            {
                "event": "segment",
                "id": request_id,
                "startMs": start_ms,
                "endMs": end_ms,
                "text": text,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def _read_window_audio(audio_path: str, window: dict):
    import numpy as np

    start_sec = float(window["startSec"])
    end_sec = float(window["endSec"])
    with wave.open(audio_path, "rb") as handle:
        framerate = handle.getframerate()
        start_frame = int(start_sec * framerate)
        end_frame = int(end_sec * framerate)
        handle.setpos(start_frame)
        raw_frames = handle.readframes(max(0, end_frame - start_frame))

    return np.frombuffer(raw_frames, dtype=np.int16).astype(np.float32) / 32768.0


def _read_full_audio(audio_path: str):
    import numpy as np

    with wave.open(audio_path, "rb") as handle:
        nframes = handle.getnframes()
        raw_frames = handle.readframes(nframes)
    return np.frombuffer(raw_frames, dtype=np.int16).astype(np.float32) / 32768.0


def _require_cuda_sessions(asr) -> None:
    """ONNX Runtime silently retries on CPU when CUDA fails to initialise.
    A CUDA load that ended up on CPU must fail, so the self-test records the
    failure and the app moves to the int8 CPU engine instead of running fp32
    on the processor under a CUDA label."""
    sessions = [value for value in vars(asr).values() if hasattr(value, "get_providers")]
    for session in sessions:
        if "CUDAExecutionProvider" not in session.get_providers():
            raise RuntimeError(
                "CUDA is unavailable: ONNX Runtime fell back to CPUExecutionProvider"
            )


def _selftest_tone(sample_rate: int = 16000, seconds: float = 1.0):
    """440 Hz tone so the decoder path is exercised (silence can skip VAD / energy gate)."""
    import numpy as np

    n = int(sample_rate * seconds)
    t = np.arange(n, dtype=np.float32) / float(sample_rate)
    return (0.1 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)


def _selftest_audio(engine: str | None):
    """Canary must fill one max VAD window; other engines only need a short decode."""
    if engine == "canary":
        return _selftest_tone(seconds=MAX_SPEECH_SEC)
    return _selftest_tone()


def _word_field(word, name):
    """faster-whisper Word is a dataclass; mlx-whisper used dict keys."""
    if isinstance(word, dict):
        return word[name]
    return getattr(word, name)


class TranscriptionWorker:
    def __init__(self) -> None:
        self.model = None
        self.asr_model = None
        self.vad = None
        self.loaded_model_name: str | None = None
        self.loaded_device: str | None = None
        self.engine: str | None = None

    def _release_loaded(self) -> None:
        self.model = None
        self.asr_model = None
        self.vad = None
        self.loaded_model_name = None
        self.loaded_device = None
        self.engine = None
        gc.collect()

    def handle_load(self, request_id: int, request: dict) -> None:
        # One speech model at a time: drop the previous load before the next.
        self._release_loaded()
        engine = request.get("engine", "faster-whisper")
        if engine == "parakeet":
            self._handle_load_parakeet(request_id, request)
            return
        if engine == "canary":
            self._handle_load_canary(request_id, request)
            return
        if engine == "whisper-turbo":
            self._handle_load_faster_whisper(request_id, request)
            self.engine = "whisper-turbo"
            return

        self._handle_load_faster_whisper(request_id, request)

    def _handle_load_faster_whisper(self, request_id: int, request: dict) -> None:
        self._load_faster_whisper(request)
        _respond(request_id, True, {"loaded": True})

    def _handle_load_parakeet(self, request_id: int, request: dict) -> None:
        self._load_parakeet(request)
        _respond(request_id, True, {"loaded": True})

    def _handle_load_canary(self, request_id: int, request: dict) -> None:
        self._load_canary(request)
        _respond(request_id, True, {"loaded": True})

    def handle_transcribe(self, request_id: int, request: dict) -> None:
        if self.model is None:
            raise RuntimeError("No model loaded")

        audio_path = request["audio"]
        language = request.get("language", "en")
        window = request.get("window")

        if self.engine == "parakeet":
            self._handle_transcribe_parakeet(request_id, audio_path, language, window)
            return
        if self.engine == "canary":
            self._handle_transcribe_canary(request_id, audio_path, language, window)
            return
        if self.engine == "whisper-turbo":
            self._handle_transcribe_whisper_turbo(request_id, audio_path, language, window)
            return

        self._handle_transcribe_faster_whisper(request_id, audio_path, language, window)

    def _handle_transcribe_faster_whisper(
        self,
        request_id: int,
        audio_path: str,
        language: str,
        window: dict | None,
    ) -> None:
        transcribe_kwargs = {
            "language": language,
            "beam_size": 1,
            "vad_filter": True,
            "word_timestamps": False,
        }

        if window:
            audio = _read_window_audio(audio_path, window)
        else:
            audio = _read_full_audio(audio_path)
        segments, _info = self.model.transcribe(audio, **transcribe_kwargs)

        transcription = []
        for segment in segments:
            start_ms = int(segment.start * 1000)
            end_ms = int(segment.end * 1000)
            text = segment.text
            _emit_segment(request_id, start_ms, end_ms, text)
            transcription.append(
                {
                    "offsets": {"from": start_ms, "to": end_ms},
                    "text": text,
                }
            )

        _respond(request_id, True, {"transcription": transcription})

    def _handle_transcribe_parakeet(
        self,
        request_id: int,
        audio_path: str,
        language: str,
        window: dict | None,
    ) -> None:
        if window:
            audio = _read_window_audio(audio_path, window)
            segments = self.model.recognize(audio, language=language)
        else:
            segments = self.model.recognize(audio_path, language=language)

        transcription = []
        for segment in segments:
            start_ms = round(segment.start * 1000)
            end_ms = round(segment.end * 1000)
            text = segment.text
            _emit_segment(request_id, start_ms, end_ms, text)
            transcription.append(
                {
                    "offsets": {"from": start_ms, "to": end_ms},
                    "text": text,
                }
            )

        _respond(request_id, True, {"transcription": transcription})

    def _handle_transcribe_canary(
        self,
        request_id: int,
        audio_path: str,
        language: str,
        window: dict | None,
    ) -> None:
        if window:
            audio = _read_window_audio(audio_path, window)
            segments = self.model.recognize(
                audio, language=language, target_language=language
            )
        else:
            segments = self.model.recognize(
                audio_path, language=language, target_language=language
            )

        transcription = []
        for segment in segments:
            start_ms = round(segment.start * 1000)
            end_ms = round(segment.end * 1000)
            text = segment.text
            _emit_segment(request_id, start_ms, end_ms, text)
            transcription.append(
                {
                    "offsets": {"from": start_ms, "to": end_ms},
                    "text": text,
                }
            )

        _respond(request_id, True, {"transcription": transcription})

    def _handle_transcribe_whisper_turbo(
        self,
        request_id: int,
        audio_path: str,
        language: str,
        window: dict | None,
    ) -> None:
        import numpy as np
        from whisper_turbo_contract import (
            HALLUCINATION_SILENCE_SEC,
            INITIAL_PROMPTS,
            collect_clip_segments,
            pause_split,
        )

        if window:
            audio = _read_window_audio(audio_path, window)
        else:
            audio = _read_full_audio(audio_path)
        audio = np.asarray(audio, dtype=np.float32)
        clips, has_speech = pause_split(audio, np)
        transcription = []
        emitted_until = 0.0
        for start, end in clips:
            # Whisper invents text on silence; skip clips with no speech energy.
            if not has_speech(start, end):
                continue
            clip = audio[start:end]
            result_segments, _info = self.model.transcribe(
                clip,
                language=language,
                beam_size=1,
                vad_filter=False,
                condition_on_previous_text=False,
                initial_prompt=INITIAL_PROMPTS.get(language),
                word_timestamps=True,
                hallucination_silence_threshold=HALLUCINATION_SILENCE_SEC,
            )
            normalized = []
            for segment in result_segments:
                words = []
                for word in list(segment.words or []):
                    words.append(
                        {
                            "start": float(_word_field(word, "start")),
                            "end": float(_word_field(word, "end")),
                            "word": str(_word_field(word, "word")),
                        }
                    )
                normalized.append(
                    {
                        "start": float(segment.start),
                        "end": float(segment.end),
                        "text": segment.text or "",
                        "words": words,
                    }
                )
            added, emitted_until = collect_clip_segments(
                start, end, normalized, has_speech, emitted_until
            )
            for item in added:
                _emit_segment(
                    request_id,
                    item["offsets"]["from"],
                    item["offsets"]["to"],
                    item["text"],
                )
            transcription.extend(added)

        _respond(request_id, True, {"transcription": transcription})

    def handle_unload(self, request_id: int) -> None:
        self._release_loaded()
        _respond(request_id, True, {"loaded": False})

    def handle_ping(self, request_id: int) -> None:
        _respond(request_id, True, {"pong": True})

    def handle_selftest(self, request_id: int, request: dict) -> None:
        load_ms = 0.0
        if request.get("model"):
            load_t0 = time.perf_counter()
            self._release_loaded()
            engine = request.get("engine", "faster-whisper")
            if engine == "parakeet":
                self._load_parakeet(request)
            elif engine == "canary":
                self._load_canary(request)
            elif engine == "whisper-turbo":
                self._load_faster_whisper(request)
                self.engine = "whisper-turbo"
            else:
                self._load_faster_whisper(request)
            load_ms = (time.perf_counter() - load_t0) * 1000.0

        if self.model is None and self.asr_model is None:
            raise RuntimeError("No model loaded")

        audio = _selftest_audio(self.engine)
        language = request.get("language", "en")
        transcribe_t0 = time.perf_counter()
        segment_count = self._selftest_decode(audio, language)
        transcribe_ms = (time.perf_counter() - transcribe_t0) * 1000.0
        _respond(
            request_id,
            True,
            {
                "ok": True,
                "engine": self.engine,
                "device": self.loaded_device,
                "elapsedMs": round(load_ms + transcribe_ms, 1),
                "loadMs": round(load_ms, 1),
                "transcribeMs": round(transcribe_ms, 1),
                "segments": segment_count,
            },
        )

    def _load_faster_whisper(self, request: dict) -> None:
        import types

        # Runtime ships without PyAV; faster_whisper imports it at module load
        # but only uses it to decode file paths, which the worker never passes.
        try:
            import av
        except ImportError:
            sys.modules["av"] = types.ModuleType("av")
        from faster_whisper import WhisperModel

        model_name = request["model"]
        device = request["device"]
        compute_type = request["computeType"]
        threads = request.get("threads")

        model_kwargs = {
            "device": device,
            "compute_type": compute_type,
        }
        if device == "cpu" and isinstance(threads, int) and threads > 0:
            model_kwargs["cpu_threads"] = threads

        self.model = WhisperModel(model_name, **model_kwargs)
        self.vad = None
        self.loaded_model_name = model_name
        self.loaded_device = device
        self.engine = "faster-whisper"
        print(
            f"model loaded: {model_name} device={device}",
            file=sys.stderr,
            flush=True,
        )

    def _load_parakeet(self, request: dict) -> None:
        import onnx_asr
        import onnxruntime as rt

        model_dir = request["model"]
        device = request["device"]
        compute_type = request["computeType"]
        threads = request.get("threads")

        quantization = None if compute_type == "fp32" else "int8"
        providers = (
            ["DmlExecutionProvider", "CPUExecutionProvider"]
            if device == "dml"
            else ["CPUExecutionProvider"]
        )

        sess_options = rt.SessionOptions()
        if device == "cpu" and isinstance(threads, int) and threads > 0:
            sess_options.intra_op_num_threads = threads

        # Pin the VAD to the same providers as the model: without this it picks
        # up every registered provider (including DML) even on the CPU tier.
        self.vad = onnx_asr.load_vad("silero", model_dir, providers=providers)
        self.model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v3",
            model_dir,
            quantization=quantization,
            providers=providers,
            sess_options=sess_options,
        ).with_vad(self.vad, max_speech_duration_s=25)
        self.loaded_model_name = model_dir
        self.loaded_device = device
        self.engine = "parakeet"
        print(
            f"model loaded: parakeet-tdt-0.6b-v3 device={device}",
            file=sys.stderr,
            flush=True,
        )

    def _load_canary(self, request: dict) -> None:
        import onnx_asr
        import onnxruntime as rt

        model_dir = request["model"]
        device = request["device"]
        compute_type = request["computeType"]
        threads = request.get("threads")

        quantization = None if compute_type == "fp32" else "int8"
        if device == "cuda":
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]

        sess_options = rt.SessionOptions()
        if device == "cpu" and isinstance(threads, int) and threads > 0:
            sess_options.intra_op_num_threads = threads

        # VAD stays on CPU (R1 prototype). batch_size=1 + max 25 s match the Mac.
        self.vad = onnx_asr.load_vad(
            "silero",
            model_dir,
            providers=["CPUExecutionProvider"],
            sess_options=sess_options,
        )
        model = onnx_asr.load_model(
            "nemo-canary-1b-v2",
            model_dir,
            quantization=quantization,
            providers=providers,
            sess_options=sess_options,
        )
        if device == "cuda":
            _require_cuda_sessions(model.asr)
        # Mac max_tokens=256; Canary prompt is 10 tokens → 266.
        model.asr.config["max_sequence_length"] = 266
        # Keep the pre-VAD adapter: Silero finds no speech on a tone, so
        # selftest must call recognize on this object to hit encoder/decoder.
        self.asr_model = model
        self.model = model.with_vad(
            self.vad, batch_size=1, max_speech_duration_s=MAX_SPEECH_SEC
        )
        self.loaded_model_name = model_dir
        self.loaded_device = device
        self.engine = "canary"
        print(
            f"model loaded: nemo-canary-1b-v2 device={device}",
            file=sys.stderr,
            flush=True,
        )

    def _selftest_decode(self, audio, language: str) -> int:
        if self.engine == "parakeet":
            segments = list(self.model.recognize(audio, language=language))
            return len(segments)
        if self.engine == "canary":
            raw = self.asr_model
            if raw is None:
                raise RuntimeError("Canary selftest needs the raw onnx_asr model")
            result = raw.recognize(audio, language=language, target_language=language)
            if isinstance(result, str):
                return 1 if result.strip() else 0
            return len(list(result))
        segments, _info = self.model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=False,
        )
        return sum(1 for _ in segments)

    def dispatch(self, request: dict) -> None:
        request_id = request["id"]
        op = request.get("op")

        try:
            if op == "load":
                self.handle_load(request_id, request)
            elif op == "transcribe":
                self.handle_transcribe(request_id, request)
            elif op == "unload":
                self.handle_unload(request_id)
            elif op == "ping":
                self.handle_ping(request_id)
            elif op == "selftest":
                self.handle_selftest(request_id, request)
            else:
                _respond(request_id, False, error=f"unknown op: {op}")
        except Exception as exc:
            _respond(request_id, False, error=str(exc))


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc persistent transcription worker")
    parser.add_argument("--no-eco", action="store_true")
    args = parser.parse_args()

    if sys.platform == "win32" and not args.no_eco:
        _enable_eco_qos()

    worker = TranscriptionWorker()

    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError as exc:
            print(f"invalid request json: {exc}", file=sys.stderr, flush=True)
            continue

        worker.dispatch(request)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
