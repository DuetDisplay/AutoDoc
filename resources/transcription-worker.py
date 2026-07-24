#!/usr/bin/env python3
"""
JSON-lines-over-stdio protocol for the persistent transcription worker.

Requests (one JSON object per line on stdin):
- load: {"id", "op": "load", "engine": "faster-whisper"|"parakeet", "model", "device": "cuda"|"cpu"|"dml", "computeType", "threads": number|null}
- transcribe: {"id", "op": "transcribe", "audio", "language", "window": {"startSec", "endSec"} | null}
- unload: {"id", "op": "unload"}
- ping: {"id", "op": "ping"}

Responses on stdout (one JSON object per line):
- success: {"id", "ok": true, "result": ...}
- failure: {"id", "ok": false, "error": string}

transcribe result shape:
{"transcription": [{"offsets": {"from": ms, "to": ms}, "text": string}]}

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
import sys
import wave
from ctypes import wintypes

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


class TranscriptionWorker:
    def __init__(self) -> None:
        self.model = None
        self.vad = None
        self.loaded_model_name: str | None = None
        self.loaded_device: str | None = None
        self.engine: str | None = None

    def handle_load(self, request_id: int, request: dict) -> None:
        engine = request.get("engine", "faster-whisper")
        if engine == "parakeet":
            self._handle_load_parakeet(request_id, request)
            return

        self._handle_load_faster_whisper(request_id, request)

    def _handle_load_faster_whisper(self, request_id: int, request: dict) -> None:
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
        _respond(request_id, True, {"loaded": True})

    def _handle_load_parakeet(self, request_id: int, request: dict) -> None:
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
            segments, _info = self.model.transcribe(audio, **transcribe_kwargs)
        else:
            segments, _info = self.model.transcribe(audio_path, **transcribe_kwargs)

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

    def handle_unload(self, request_id: int) -> None:
        self.model = None
        self.vad = None
        self.loaded_model_name = None
        self.loaded_device = None
        self.engine = None
        gc.collect()
        _respond(request_id, True, {"loaded": False})

    def handle_ping(self, request_id: int) -> None:
        _respond(request_id, True, {"pong": True})

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
