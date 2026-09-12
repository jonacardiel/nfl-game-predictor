"""One-time download of team logos into docs/assets/logos/ so the site is
self-contained (no hotlinking a third-party CDN that could reorganize).

Resized to 96x96 — the site only ever displays them at ~28px, so ESPN's
500px originals are pure dead weight (roughly 1.6MB vs ~150KB resized).

Usage:
    python scripts/fetch_logos.py
"""
from __future__ import annotations

import io
from pathlib import Path

import nflreadpy as nfl
import requests
from PIL import Image

OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "assets" / "logos"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MAX_SIZE = (96, 96)  # ~3x the largest on-page display size, for retina screens

# Same aliases used in nfl_predictor/data.py — keep the logo filenames matching
# the abbreviations the rest of the pipeline actually uses.
TEAM_ALIASES = {"STL": "LA", "SD": "LAC", "OAK": "LV", "LAR": "LA"}


def main() -> None:
    teams = nfl.load_teams().to_pandas()

    seen = set()
    downloaded = 0
    for _, row in teams.iterrows():
        abbr = row.get("team_abbr")
        url = row.get("team_logo_espn")
        if not abbr or not url:
            continue

        canonical = TEAM_ALIASES.get(abbr, abbr)
        if canonical in seen:
            continue
        seen.add(canonical)

        resp = requests.get(url, timeout=15)
        resp.raise_for_status()

        img = Image.open(io.BytesIO(resp.content)).convert("RGBA")
        img.thumbnail(MAX_SIZE, Image.LANCZOS)

        dest = OUT_DIR / f"{canonical}.png"
        img.save(dest, format="PNG", optimize=True)
        downloaded += 1
        print(f"  {canonical:<4} <- {url}  ({img.width}x{img.height})")

    total_kb = sum(f.stat().st_size for f in OUT_DIR.glob("*.png")) / 1024
    print(f"\nDownloaded {downloaded} logos to {OUT_DIR} ({total_kb:.0f} KB total)")


if __name__ == "__main__":
    main()
