#!/usr/bin/env python3
"""Build dist/paperlink-<version>.xpi from src/ and refresh updates.json.
Works on Windows, macOS and Linux."""
import json, pathlib, zipfile

REPO = "zhuzihan728/zotero-paperlink"

root = pathlib.Path(__file__).resolve().parent
src = root / "src"
manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
zotero = manifest["applications"]["zotero"]

out = root / "dist" / f"paperlink-{version}.xpi"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.rglob("*")):
        if f.is_file() and not f.name.startswith("."):
            z.write(f, f.relative_to(src).as_posix())

# Update manifest that installed copies poll via update_url.
updates = {"addons": {zotero["id"]: {"updates": [{
    "version": version,
    "update_link": f"https://github.com/{REPO}/releases/download/v{version}/{out.name}",
    "applications": {"zotero": {
        "strict_min_version": zotero["strict_min_version"],
        "strict_max_version": zotero["strict_max_version"],
    }},
}]}}}
(root / "updates.json").write_text(json.dumps(updates, indent=2) + "\n", encoding="utf-8")
print(out)
