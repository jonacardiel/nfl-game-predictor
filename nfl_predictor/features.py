"""Feature engineering: offensive/defensive EPA-per-play, pace, rest days,
and recent trade activity — all computed using only information available
strictly before each game (no leakage from the game being predicted).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

REGRESSION_GAMES = 4  # shrinkage strength toward prior-season rate (higher = slower to trust in-season data)
TRADE_WINDOW_DAYS = 14

STAT_COLS = ["off_epa_play", "def_epa_play", "pace", "trade_activity"]
FEATURE_COLS = (
    [f"home_{c}" for c in STAT_COLS]
    + [f"away_{c}" for c in STAT_COLS]
    + ["rest_diff", "trade_diff"]
)


def _scrimmage_plays(pbp: pd.DataFrame) -> pd.DataFrame:
    plays = pbp
    if "season_type" in plays.columns:
        plays = plays[plays["season_type"] == "REG"]
    is_scrimmage = plays.get("rush_attempt", 0).eq(1) | plays.get("pass_attempt", 0).eq(1)
    plays = plays.loc[is_scrimmage, ["season", "week", "posteam", "defteam", "epa"]].dropna()
    return plays


def _team_week_epa(plays: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    off = (
        plays.groupby(["season", "week", "posteam"])
        .agg(off_epa_sum=("epa", "sum"), off_plays=("epa", "size"))
        .reset_index()
        .rename(columns={"posteam": "team"})
    )
    de = (
        plays.groupby(["season", "week", "defteam"])
        .agg(def_epa_sum=("epa", "sum"), def_plays=("epa", "size"))
        .reset_index()
        .rename(columns={"defteam": "team"})
    )
    return off, de


def _full_team_week_grid(schedules: pd.DataFrame) -> pd.DataFrame:
    """Every (season, week, team) a team is scheduled to play REG, including
    weeks that haven't happened yet (no pbp rows) — so a not-yet-played week
    still gets a row that can fall back to prior-season/league stats."""
    reg = schedules[schedules["game_type"] == "REG"]
    home = reg[["season", "week", "home_team"]].rename(columns={"home_team": "team"})
    away = reg[["season", "week", "away_team"]].rename(columns={"away_team": "team"})
    return pd.concat([home, away], ignore_index=True).drop_duplicates()


def _merge_team_week(off: pd.DataFrame, de: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    grid = _full_team_week_grid(schedules)
    tw = grid.merge(off, on=["season", "week", "team"], how="left")
    tw = tw.merge(de, on=["season", "week", "team"], how="left")
    fill_cols = ["off_epa_sum", "off_plays", "def_epa_sum", "def_plays"]
    tw[fill_cols] = tw[fill_cols].fillna(0)
    return tw.sort_values(["season", "team", "week"]).reset_index(drop=True)


def _add_cumulative_before(tw: pd.DataFrame) -> pd.DataFrame:
    grp = tw.groupby(["season", "team"])
    games_before = grp.cumcount()
    off_sum_before = grp["off_epa_sum"].cumsum() - tw["off_epa_sum"]
    off_plays_before = grp["off_plays"].cumsum() - tw["off_plays"]
    def_sum_before = grp["def_epa_sum"].cumsum() - tw["def_epa_sum"]
    def_plays_before = grp["def_plays"].cumsum() - tw["def_plays"]

    tw["games_before"] = games_before
    tw["off_epa_play_ytd"] = off_sum_before / off_plays_before.replace(0, np.nan)
    tw["def_epa_play_ytd"] = def_sum_before / def_plays_before.replace(0, np.nan)
    tw["pace_ytd"] = off_plays_before / games_before.replace(0, np.nan)
    return tw


def _season_final_stats(tw: pd.DataFrame) -> pd.DataFrame:
    season_totals = (
        tw.groupby(["season", "team"])
        .agg(
            off_epa_sum=("off_epa_sum", "sum"),
            off_plays=("off_plays", "sum"),
            def_epa_sum=("def_epa_sum", "sum"),
            def_plays=("def_plays", "sum"),
            games=("week", "nunique"),
        )
        .reset_index()
    )
    season_totals["off_epa_play_season"] = season_totals.off_epa_sum / season_totals.off_plays.replace(0, np.nan)
    season_totals["def_epa_play_season"] = season_totals.def_epa_sum / season_totals.def_plays.replace(0, np.nan)
    season_totals["pace_season"] = season_totals.off_plays / season_totals.games.replace(0, np.nan)
    season_totals["season"] = season_totals["season"] + 1  # align as "prior season" feature for next year
    return season_totals[["season", "team", "off_epa_play_season", "def_epa_play_season", "pace_season"]]


def _league_avg_before(tw: pd.DataFrame) -> pd.DataFrame:
    league = (
        tw.groupby(["season", "week"])[["off_epa_play_ytd", "def_epa_play_ytd", "pace_ytd"]]
        .mean()
        .reset_index()
    )
    return league.rename(
        columns={
            "off_epa_play_ytd": "league_off_epa_play_ytd",
            "def_epa_play_ytd": "league_def_epa_play_ytd",
            "pace_ytd": "league_pace_ytd",
        }
    )


def _blend(tw: pd.DataFrame, weight_prior: pd.Series, current_col: str, prior_col: str, league_col: str) -> pd.Series:
    current_filled = tw[current_col].fillna(tw[league_col])
    prior_filled = tw[prior_col].fillna(tw[league_col]).fillna(current_filled)
    current_filled = current_filled.fillna(prior_filled)
    return weight_prior * prior_filled + (1 - weight_prior) * current_filled


def _team_week_gamedays(schedules: pd.DataFrame) -> pd.DataFrame:
    home = schedules[["season", "week", "home_team", "gameday"]].rename(columns={"home_team": "team"})
    away = schedules[["season", "week", "away_team", "gameday"]].rename(columns={"away_team": "team"})
    gamedays = pd.concat([home, away], ignore_index=True)
    gamedays["gameday"] = pd.to_datetime(gamedays["gameday"])
    return gamedays


def _trade_activity(tw: pd.DataFrame, trades: pd.DataFrame, schedules: pd.DataFrame) -> pd.Series:
    gamedays = _team_week_gamedays(schedules)
    merged = tw.merge(gamedays, on=["season", "week", "team"], how="left")

    trades_long = pd.concat(
        [
            trades[["trade_date", "gave"]].rename(columns={"gave": "team"}),
            trades[["trade_date", "received"]].rename(columns={"received": "team"}),
        ],
        ignore_index=True,
    ).dropna(subset=["team"])

    result = pd.Series(0, index=merged.index, dtype=int)
    for team, team_trades in trades_long.groupby("team"):
        dates = np.sort(team_trades["trade_date"].to_numpy())
        mask = merged["team"] == team
        game_dates = merged.loc[mask, "gameday"].to_numpy()
        valid = ~pd.isna(game_dates)
        idx_hi = np.searchsorted(dates, game_dates[valid], side="left")
        idx_lo = np.searchsorted(dates, game_dates[valid] - np.timedelta64(TRADE_WINDOW_DAYS, "D"), side="left")
        counts = np.zeros(len(game_dates), dtype=int)
        counts[valid] = idx_hi - idx_lo
        result.loc[merged.index[mask]] = counts

    return result.reindex(tw.index).fillna(0).astype(int)


def build_team_week_features(pbp: pd.DataFrame, trades: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    """One row per (season, week, team) with leakage-safe features."""
    plays = _scrimmage_plays(pbp)
    off, de = _team_week_epa(plays)
    tw = _merge_team_week(off, de, schedules)
    tw = _add_cumulative_before(tw)

    prior = _season_final_stats(tw)
    tw = tw.merge(prior, on=["season", "team"], how="left")

    league = _league_avg_before(tw)
    tw = tw.merge(league, on=["season", "week"], how="left")

    weight_prior = REGRESSION_GAMES / (tw["games_before"] + REGRESSION_GAMES)
    tw["off_epa_play"] = _blend(tw, weight_prior, "off_epa_play_ytd", "off_epa_play_season", "league_off_epa_play_ytd")
    tw["def_epa_play"] = _blend(tw, weight_prior, "def_epa_play_ytd", "def_epa_play_season", "league_def_epa_play_ytd")
    tw["pace"] = _blend(tw, weight_prior, "pace_ytd", "pace_season", "league_pace_ytd")

    tw["trade_activity"] = _trade_activity(tw, trades, schedules)

    return tw[["season", "week", "team", "off_epa_play", "def_epa_play", "pace", "trade_activity"]]


def build_game_features(team_week: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    """Merge home/away team-week features onto every scheduled game."""
    home_stats = team_week.rename(columns={c: f"home_{c}" for c in STAT_COLS}).rename(columns={"team": "home_team"})
    away_stats = team_week.rename(columns={c: f"away_{c}" for c in STAT_COLS}).rename(columns={"team": "away_team"})

    games = schedules.merge(
        home_stats[["season", "week", "home_team"] + [f"home_{c}" for c in STAT_COLS]],
        on=["season", "week", "home_team"],
        how="left",
    )
    games = games.merge(
        away_stats[["season", "week", "away_team"] + [f"away_{c}" for c in STAT_COLS]],
        on=["season", "week", "away_team"],
        how="left",
    )

    games["rest_diff"] = games["home_rest"] - games["away_rest"]
    games["trade_diff"] = games["home_trade_activity"] - games["away_trade_activity"]
    return games
