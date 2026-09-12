"""Generate the JSON the static site (docs/) reads:
  - docs/data/weeks.json                 manifest of available weeks
  - docs/data/predictions/{season}_wk{week}.json   one file per week, fetched on demand
  - docs/data/history.json               daily spread/win-prob snapshots per game (line movement)
  - docs/data/performance.json           backtest history + live season scorecard

Usage:
    python export_web.py
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import nflreadpy as nfl
import pandas as pd

from nfl_predictor import data, model, web
from nfl_predictor.predict_core import load_features_for_season, predict_week

DOCS_DIR = Path(__file__).resolve().parent / "docs"
DATA_DIR = DOCS_DIR / "data"
WEEKS_DIR = DATA_DIR / "predictions"
DATA_DIR.mkdir(parents=True, exist_ok=True)
WEEKS_DIR.mkdir(parents=True, exist_ok=True)


def _team_lookup() -> dict:
    teams = nfl.load_teams().to_pandas()
    lookup = {}
    for _, row in teams.iterrows():
        abbr = row.get("team_abbr")
        if not abbr:
            continue
        lookup[abbr] = {"name": row.get("team_name"), "color": row.get("team_color")}
    return lookup


def _num(value):
    if value is None or pd.isna(value):
        return None
    return round(float(value), 3)


def _resolve_current_season() -> tuple[int, pd.DataFrame]:
    """Pick the season to show (this year, falling back to last year if this
    year's schedule has no games at all yet) and return its full schedule."""
    today = dt.date.today()
    candidates = [today.year - 1, today.year]
    schedules = data.load_schedules(candidates, refresh_seasons=candidates)
    for season in sorted(candidates, reverse=True):
        reg = schedules[(schedules["season"] == season) & (schedules["game_type"] == "REG")]
        if not reg.empty:
            return season, schedules
    return max(candidates), schedules


def _week_status(reg_week_games: pd.DataFrame) -> str:
    final_count = (reg_week_games["home_score"].notna() & reg_week_games["away_score"].notna()).sum()
    total = len(reg_week_games)
    if final_count == 0:
        return "upcoming"
    if final_count == total:
        return "final"
    return "live"


def build_week_payload(models: model.Models, season: int, week: int, team_info: dict) -> dict:
    target = predict_week(models, season, week)
    target = target.sort_values(["gameday", "gametime"], na_position="last")

    games = []
    for _, row in target.iterrows():
        games.append({
            "game_id": row.get("game_id"),
            "away_team": row["away_team"],
            "home_team": row["home_team"],
            "away_color": team_info.get(row["away_team"], {}).get("color"),
            "home_color": team_info.get(row["home_team"], {}).get("color"),
            "gameday": str(row["gameday"]) if pd.notna(row.get("gameday")) else None,
            "gametime": row.get("gametime"),
            "win_prob_home": _num(row["win_prob_home"]),
            "pred_margin_home": _num(row["pred_margin_home"]),
            "spread_line": _num(row["spread_line"]),
            "ats_pick": row["ats_pick"],
            "covers_by": _num(row["covers_by"]),
            "ats_cover_prob_home": _num(row.get("ats_cover_prob_home")),
            "home_score": _num(row.get("home_score")),
            "away_score": _num(row.get("away_score")),
            "final": bool(pd.notna(row.get("home_score")) and pd.notna(row.get("away_score"))),
            "detail": {
                "home_off_epa_play": _num(row.get("home_off_epa_play")),
                "away_off_epa_play": _num(row.get("away_off_epa_play")),
                "home_def_epa_play": _num(row.get("home_def_epa_play")),
                "away_def_epa_play": _num(row.get("away_def_epa_play")),
                "home_pace": _num(row.get("home_pace")),
                "away_pace": _num(row.get("away_pace")),
                "home_rest": _num(row.get("home_rest")),
                "away_rest": _num(row.get("away_rest")),
                "home_trade_activity": _num(row.get("home_trade_activity")),
                "away_trade_activity": _num(row.get("away_trade_activity")),
            },
        })

    return {
        "season": season,
        "week": week,
        "last_updated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "games": games,
    }


def update_history(history: dict, week_payload: dict) -> dict:
    today = dt.date.today().isoformat()
    for game in week_payload["games"]:
        gid = game["game_id"]
        if not gid:
            continue
        entries = history.setdefault(gid, [])
        entries[:] = [e for e in entries if e["date"] != today]
        entries.append({
            "date": today,
            "spread_line": game["spread_line"],
            "win_prob_home": game["win_prob_home"],
        })
        entries.sort(key=lambda e: e["date"])
    return history


def build_performance_payload(models: model.Models, season: int) -> dict:
    backtest_path = model.MODELS_DIR / "backtest.json"
    backtest = json.loads(backtest_path.read_text()) if backtest_path.exists() else []

    season_games, _schedules = load_features_for_season(season)
    scorecard = web.season_scorecard(models, season_games, season)

    return {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "backtest_by_season": backtest,
        "current_season": season,
        "current_season_scorecard": scorecard,
    }


def main() -> None:
    models = model.Models.load()
    team_info = _team_lookup()
    season, schedules = _resolve_current_season()

    reg = schedules[(schedules["season"] == season) & (schedules["game_type"] == "REG")]
    weeks = sorted(reg["week"].unique().tolist())
    current_week = web.current_season_week(schedules, season)
    if current_week is None:
        current_week = weeks[-1]

    print(f"Season {season}: exporting {len(weeks)} weeks (current: week {current_week})")

    history_path = DATA_DIR / "history.json"
    history = json.loads(history_path.read_text()) if history_path.exists() else {}

    week_meta = []
    for week in weeks:
        payload = build_week_payload(models, season, week, team_info)
        (WEEKS_DIR / f"{season}_wk{week}.json").write_text(json.dumps(payload, indent=2))
        history = update_history(history, payload)

        week_games_df = reg[reg["week"] == week]
        week_meta.append({"week": week, "status": _week_status(week_games_df)})
        print(f"  week {week:>2}: {len(payload['games'])} games ({week_meta[-1]['status']})")

    history_path.write_text(json.dumps(history, indent=2))

    weeks_manifest = {
        "season": season,
        "current_week": int(current_week),
        "weeks": week_meta,
    }
    (DATA_DIR / "weeks.json").write_text(json.dumps(weeks_manifest, indent=2))
    print(f"\nWrote manifest + {len(weeks)} week files to {WEEKS_DIR}")

    performance = build_performance_payload(models, season)
    (DATA_DIR / "performance.json").write_text(json.dumps(performance, indent=2))
    print(f"Wrote {DATA_DIR / 'performance.json'}")


if __name__ == "__main__":
    main()
