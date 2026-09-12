"""Shared prediction logic used by both the CLI (predict.py) and the web
export (export_web.py) — kept in one place so the two can't drift apart.
"""
from __future__ import annotations

import pandas as pd

from nfl_predictor import data, features, model


def load_features_for_season(season: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Pull schedules/pbp/trades needed to build features through `season`,
    and return (games, schedules). Falls back to prior-season-only pbp if the
    target season hasn't started yet (no play-by-play exists)."""
    pull_seasons = [season - 1, season]
    schedules = data.load_schedules(pull_seasons, refresh_seasons=[season])
    trades = data.load_trades(refresh=True)

    try:
        pbp = data.load_pbp(pull_seasons, refresh_seasons=[season])
    except ValueError:
        # Target season's play-by-play doesn't exist yet (season hasn't
        # started); build_team_week_features still produces a row for the
        # target week via shrinkage to the prior season.
        pbp = data.load_pbp([season - 1])

    team_week = features.build_team_week_features(pbp, trades, schedules)
    games = features.build_game_features(team_week, schedules)
    return games, schedules


def predict_week(models: model.Models, season: int, week: int) -> pd.DataFrame:
    """Return the prediction table for one week, sorted by home win
    probability descending. Raises SystemExit with a clear message if the
    week has no REG games or features can't be computed."""
    games, _schedules = load_features_for_season(season)

    target = games[
        (games["season"] == season) & (games["week"] == week) & (games["game_type"] == "REG")
    ].copy()
    if target.empty:
        raise SystemExit(f"No regular-season games found for season={season}, week={week}.")

    missing = target[features.FEATURE_COLS].isna().any(axis=1)
    if missing.any():
        bad = target.loc[missing, ["home_team", "away_team"]]
        raise SystemExit(f"Missing features for: {bad.to_dict('records')} — run train.py first / check data availability.")

    x = target[features.FEATURE_COLS]
    target["win_prob_home"] = models.win_model.predict_proba(x)[:, 1]
    target["pred_margin_home"] = models.margin_model.predict(x)

    target["ats_pick"] = "N/A"
    target["covers_by"] = float("nan")
    target["ats_cover_prob_home"] = float("nan")
    has_spread = target["spread_line"].notna()
    if has_spread.any():
        sub = target.loc[has_spread]

        # The live pick and its point margin both come from the margin model vs.
        # the spread, so the table is internally consistent (a positive "covers by"
        # always means the picked side is favored to cover, never the opposite).
        covers_by = sub["pred_margin_home"] - sub["spread_line"]
        target.loc[has_spread, "covers_by"] = covers_by
        target.loc[has_spread, "ats_pick"] = covers_by.apply(lambda v: "HOME" if v > 0 else "AWAY")

        # The dedicated logistic-regression ATS classifier's own probability is
        # still reported (as an independent cross-check, not the source of the pick).
        x_ats = sub[model.ATS_FEATURE_COLS]
        target.loc[has_spread, "ats_cover_prob_home"] = models.ats_model.predict_proba(x_ats)[:, 1]

    return target.sort_values("win_prob_home", ascending=False)
