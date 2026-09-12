"""Print win probability / ATS predictions for one week.

Usage:
    python predict.py --season 2026 --week 1
"""
from __future__ import annotations

import argparse

from nfl_predictor import model, report
from nfl_predictor.predict_core import predict_week


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()

    models = model.Models.load()
    target = predict_week(models, args.season, args.week)

    table = report.format_predictions_table(target, args.season, args.week)
    print(table)

    out_path = report.OUTPUT_DIR / f"predictions_{args.season}_wk{args.week}.csv"
    cols = [
        "away_team", "home_team", "win_prob_home", "pred_margin_home",
        "spread_line", "ats_pick", "covers_by", "ats_cover_prob_home",
    ]
    target[cols].to_csv(out_path, index=False)
    print(f"\nSaved to {out_path}")


if __name__ == "__main__":
    main()
