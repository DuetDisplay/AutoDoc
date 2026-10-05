#!/usr/bin/env python3
"""Collect static notices from the exact runtimes about to be packaged. No network."""
import csv
import json
import re
from email.parser import BytesParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
notices = []
for runtime in ("mlx-python-runtime", "canary-mlx-runtime"):
    python = ROOT / "vendor" / runtime / "darwin-arm64" / "python"
    site = python / "lib" / "python3.11" / "site-packages"
    if not site.is_dir():
        raise SystemExit(f"Prepare {runtime} before collecting license notices")
    notices.append({
        "name": "Python", "version": "3.11.15", "license": "PSF-2.0",
        "runtime": runtime, "url": "https://docs.python.org/3.11/license.html",
        "text": (python / "lib" / "python3.11" / "LICENSE.txt").read_text(),
    })
    for info in sorted(site.glob("*.dist-info")):
        metadata = BytesParser().parsebytes((info / "METADATA").read_bytes())
        license_name = metadata.get("License-Expression") or metadata.get("License", "")
        if not license_name or len(license_name) > 200:
            license_name = ", ".join(value.split(" :: ")[-1] for value in metadata.get_all("Classifier", []) if value.startswith("License ::")) or "See license text"
        files = set()
        for path in info.rglob("*"):
            if path.is_file() and ("licenses" in path.parts or re.match(r"(?i)^(licen[sc]e|copying|notice|authors)", path.name)):
                files.add(path)
        # Some wheels put native-library notices in the package rather than dist-info.
        for record in csv.reader((info / "RECORD").read_text().splitlines()):
            path = (site / record[0]).resolve()
            if path.is_relative_to(python.resolve()) and path.is_file() and re.match(r"(?i)^(licen[sc]e|copying|notice)", path.name):
                files.add(path)
        text = "\n\n".join(f"{path.relative_to(python)}\n{path.read_text(errors='replace')}" for path in sorted(files))
        notices.append({
            "name": metadata["Name"], "version": metadata["Version"],
            "license": license_name, "runtime": runtime,
            "url": f'https://pypi.org/project/{metadata["Name"]}/{metadata["Version"]}/',
            "text": text,
        })

output = ROOT / "vendor" / "speech-runtime-licenses" / "darwin-arm64.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(notices, ensure_ascii=False, indent=2) + "\n")
print(f"Collected {len(notices)} runtime package notices: {output}")
