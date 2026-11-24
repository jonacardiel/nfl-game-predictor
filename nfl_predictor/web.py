"""Helpers specific to the web export: figuring out "this week" and scoring
how the model's own picks have done so far this season.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from nfl_predictor import features, labels, model


def current_season_week(schedules: pd.DataFrame, season: int) -> int | None:
    """The earliest REG week that still has an unplayed game this season.
    Returns None if every REG game in the season is complete."""
    reg = schedules[(schedules["season"] == season) & (schedules["game_type"] == "REG")]
    # An unscored game more than a week old was cancelled (e.g. BUF@CIN, 2022 Wk 17), not upcoming.
    recent = pd.to_datetime(reg["gameday"]) >= pd.Timestamp.today().normalize() - pd.Timedelta(days=7)
    incomplete = reg[(reg["home_score"].isna() | reg["away_score"].isna()) & recent]
    if incomplete.empty:
        return None
    return int(incomplete["week"].min())


def _record_str(wins: int, losses: int, pushes: int = 0) -> str:
    return f"{wins}-{losses}-{pushes}" if pushes else f"{wins}-{losses}"


def season_scorecard(models: model.Models, games: pd.DataFrame, season: int) -> dict:
    """Apply the saved models to every completed game this season and compare
    to what actually happened — i.e. how the live picks have performed."""
    reg = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()
    reg = labels.add_labels(reg)
    completed = reg[reg["home_win"].notna() & reg[features.FEATURE_COLS].notna().all(axis=1)]

    if completed.empty:
        return {
            "games_played": 0,
            "straight_up_record": "0-0",
            "straight_up_pct": None,
            "ats_record": "0-0-0",
            "ats_pct": None,
        }

    # Ties grade neither side, so they sit in the record's third slot like ATS pushes.
    decided = completed[completed["home_margin"] != 0]
    ties = len(completed) - len(decided)
    win_pred = models.win_model.predict(decided[features.FEATURE_COLS]) if len(decided) else np.array([])
    su_correct = int((win_pred == decided["home_win"].to_numpy()).sum())
    su_total = len(decided)

    result = {
        "games_played": len(completed),
        "straight_up_record": _record_str(su_correct, su_total - su_correct, ties),
        "straight_up_pct": round(su_correct / su_total, 3) if su_total else None,
    }

    ats_games = completed[completed["push"].eq(False) & completed["home_cover"].notna()]
    pushes = int(completed["push"].sum())
    if not ats_games.empty:
        ats_correct = int((model.ats_pick_home(models, ats_games) == (ats_games["home_cover"] == 1)).sum())
        ats_total = len(ats_games)
        result["ats_record"] = _record_str(ats_correct, ats_total - ats_correct, pushes)
        result["ats_pct"] = round(ats_correct / ats_total, 3)
    else:
        result["ats_record"] = _record_str(0, 0, pushes)
        result["ats_pct"] = None

    return result
