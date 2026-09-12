"""nflreadpy wrappers with local parquet caching (one file per season/dataset)."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import nflreadpy as nfl

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Franchise relocations that occurred within the modeling window — normalize
# so a team's history isn't split across two abbreviations.
TEAM_ALIASES = {"STL": "LA", "SD": "LAC", "OAK": "LV"}


def _normalize(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    for col in cols:
        if col in df.columns:
            df[col] = df[col].replace(TEAM_ALIASES)
    return df


def _cache_path(name: str, season: int) -> Path:
    return CACHE_DIR / f"{name}_{season}.parquet"


def load_pbp(seasons: list[int], refresh_seasons: list[int] | None = None) -> pd.DataFrame:
    refresh_seasons = set(refresh_seasons or [])
    frames = []
    for season in seasons:
        path = _cache_path("pbp", season)
        if path.exists() and season not in refresh_seasons:
            frames.append(pd.read_parquet(path))
            continue
        df = nfl.load_pbp(seasons=[season]).to_pandas()
        df = _normalize(df, ["posteam", "defteam", "home_team", "away_team"])
        df.to_parquet(path)
        frames.append(df)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def load_schedules(seasons: list[int], refresh_seasons: list[int] | None = None) -> pd.DataFrame:
    refresh_seasons = set(refresh_seasons or [])
    frames = []
    for season in seasons:
        path = _cache_path("schedules", season)
        if path.exists() and season not in refresh_seasons:
            frames.append(pd.read_parquet(path))
            continue
        df = nfl.load_schedules(seasons=[season]).to_pandas()
        df = _normalize(df, ["home_team", "away_team"])
        df.to_parquet(path)
        frames.append(df)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def load_trades(refresh: bool = False) -> pd.DataFrame:
    path = CACHE_DIR / "trades_all.parquet"
    if path.exists() and not refresh:
        return pd.read_parquet(path)
    df = nfl.load_trades().to_pandas()
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    df = _normalize(df, ["gave", "received"])
    df.to_parquet(path)
    return df
