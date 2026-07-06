import argparse
import ctypes
import json
import sys
from ctypes import wintypes

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


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoDoc faster-whisper bridge")
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="en")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--no-eco", action="store_true")
    args = parser.parse_args()

    if sys.platform == "win32" and not args.no_eco:
        _enable_eco_qos()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(f"failed to import faster_whisper: {exc}", file=sys.stderr)
        return 2

    model_kwargs = {
        "device": args.device,
        "compute_type": args.compute_type,
    }
    if args.device == "cpu" and args.threads > 0:
        model_kwargs["cpu_threads"] = args.threads

    try:
        model = WhisperModel(args.model, **model_kwargs)
        segments, _info = model.transcribe(
            args.audio,
            language=args.language,
            beam_size=1,
            vad_filter=True,
            word_timestamps=False,
        )

        payload = {
            "transcription": [
                {
                    "offsets": {
                        "from": int(segment.start * 1000),
                        "to": int(segment.end * 1000),
                    },
                    "text": segment.text,
                }
                for segment in segments
            ]
        }

        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        return 0
    except Exception as exc:
        print(f"faster-whisper transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
