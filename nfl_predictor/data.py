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


def _load_cached(name, fetch, team_cols, seasons, refresh_seasons) -> pd.DataFrame:
    """One parquet file per season under CACHE_DIR; re-download only seasons in refresh_seasons."""
    refresh_seasons = set(refresh_seasons or [])
    frames = []
    for season in seasons:
        path = CACHE_DIR / f"{name}_{season}.parquet"
        if path.exists() and season not in refresh_seasons:
            frames.append(pd.read_parquet(path))
            continue
        df = _normalize(fetch(seasons=[season]).to_pandas(), team_cols)
        df.to_parquet(path)
        frames.append(df)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def load_pbp(seasons: list[int], refresh_seasons: list[int] | None = None) -> pd.DataFrame:
    return _load_cached("pbp", nfl.load_pbp, ["posteam", "defteam", "home_team", "away_team"], seasons, refresh_seasons)


def load_schedules(seasons: list[int], refresh_seasons: list[int] | None = None) -> pd.DataFrame:
    return _load_cached("schedules", nfl.load_schedules, ["home_team", "away_team"], seasons, refresh_seasons)


def load_trades(refresh: bool = False) -> pd.DataFrame:
    path = CACHE_DIR / "trades_all.parquet"
    if path.exists() and not refresh:
        return pd.read_parquet(path)
    df = nfl.load_trades().to_pandas()
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    df = _normalize(df, ["gave", "received"])
    df.to_parquet(path)
    return df
