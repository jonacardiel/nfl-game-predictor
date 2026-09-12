"""Build the last-10-completed-seasons training set, fit the win/ATS/margin
models, run a season-by-season walk-forward backtest, and save artifacts.

Usage:
    python train.py
    python train.py --seasons 2016 2017 2018 2019 2020 2021 2022 2023 2024 2025
    python train.py --refresh   # force re-download instead of using the parquet cache
"""
from __future__ import annotations

import argparse
import datetime as dt

import pandas as pd

from nfl_predictor import data, features, labels, model, report


def default_seasons() -> list[int]:
    last_completed = dt.date.today().year - 1
    return list(range(last_completed - 9, last_completed + 1))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", type=int, nargs="+", default=None,
                         help="Explicit list of seasons to train on (default: last 10 completed).")
    parser.add_argument("--refresh", action="store_true", help="Force re-download instead of using the cache.")
    args = parser.parse_args()

    seasons = sorted(args.seasons) if args.seasons else default_seasons()
    pull_seasons = [seasons[0] - 1] + seasons  # one extra prior year, used only for shrinkage priors

    print(f"Training seasons: {seasons[0]}-{seasons[-1]}")
    print(f"Pulling pbp/schedules for {pull_seasons[0]}-{pull_seasons[-1]} (nflreadpy, cached under data/cache/)...")

    refresh = pull_seasons if args.refresh else None
    pbp = data.load_pbp(pull_seasons, refresh_seasons=refresh)
    schedules = data.load_schedules(pull_seasons, refresh_seasons=refresh)
    trades = data.load_trades(refresh=args.refresh)

    team_week = features.build_team_week_features(pbp, trades, schedules)
    games = features.build_game_features(team_week, schedules)
    games = games[games["game_type"] == "REG"]
    games = labels.add_labels(games)

    train_games = games[games["season"].isin(seasons) & games["home_win"].notna()].copy()
    train_games = train_games.dropna(subset=features.FEATURE_COLS)
    print(f"\n{len(train_games)} completed regular-season games across {train_games['season'].nunique()} seasons.")

    backtest_rows = []
    eligible_eval_seasons = seasons[3:]  # need >=3 prior in-window seasons to train on
    for eval_season in eligible_eval_seasons:
        train_slice = train_games[train_games["season"] < eval_season]
        test_slice = train_games[train_games["season"] == eval_season]
        if train_slice.empty or test_slice.empty:
            continue
        m = model.fit_models(train_slice)
        metrics = model.evaluate(m, test_slice)
        metrics["season"] = eval_season
        backtest_rows.append(metrics)

    backtest_df = pd.DataFrame(backtest_rows)
    if not backtest_df.empty:
        print("\nWalk-forward backtest by season:")
        print(backtest_df[["season", "n_games", "win_accuracy", "win_log_loss", "n_ats_games", "ats_accuracy"]]
              .to_string(index=False))
        latest = backtest_df.iloc[-1]
        print(f"\nMost recent holdout season {int(latest['season'])}: "
              f"win accuracy={latest['win_accuracy']:.3f}, ATS accuracy={latest['ats_accuracy']:.3f}")

        backtest_path = model.MODELS_DIR / "backtest.json"
        backtest_df.to_json(backtest_path, orient="records", indent=2)
        print(f"Saved backtest results to {backtest_path}")

    final_models = model.fit_models(train_games)
    final_models.save()
    print(f"\nSaved models to {model.MODELS_DIR}")

    if not backtest_df.empty:
        holdout_season = int(backtest_df.iloc[-1]["season"])
        holdout_games = train_games[train_games["season"] == holdout_season]
        holdout_models = model.fit_models(train_games[train_games["season"] < holdout_season])
        report.save_evaluation_plots(holdout_models, holdout_games, backtest_df, holdout_season)
        print(f"Saved evaluation plots to {report.OUTPUT_DIR}")


if __name__ == "__main__":
    main()
