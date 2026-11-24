"""Assert-based checks for the rules that have broken (or would break silently) before.
Run: python tests/check_core.py  — exits non-zero on the first failure. CI runs it before every export."""
import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from export_web import update_history  # noqa: E402
from nfl_predictor import labels, season_sim, web  # noqa: E402


def check_ats_label_sign():
    # spread_line = 3 means home favored by 3. The -spread_line sign bug once faked a 79.5% backtest.
    g = labels.add_labels(pd.DataFrame({"home_score": [27, 22, 23, 20], "away_score": [20, 20, 20, 20],
                                        "spread_line": [3.0, 3.0, 3.0, -3.0]}))
    assert g["home_cover"].iloc[0] == 1, "home favored by 3 winning by 7 must cover"
    assert g["home_cover"].iloc[1] == 0, "home favored by 3 winning by 2 must not cover"
    assert g["push"].iloc[2] and pd.isna(g["home_cover"].iloc[2]), "winning by exactly the line is a push"
    assert g["home_cover"].iloc[3] == 1, "home underdog by 3 tying must cover"


def check_division_winners_take_top_four():
    divisions = [np.arange(d * 4, d * 4 + 4) for d in range(4)]
    wins = np.array([[13, 12, 11, 2,  9, 8, 7, 6,  5, 4, 3, 1,  10, 3, 2, 1]], dtype=float)
    seeds = season_sim._seed_conference(wins, np.arange(16), divisions)[0]
    assert sorted(seeds[:4]) == [0, 4, 8, 12], f"division winners must take seeds 1-4, got {seeds}"
    assert list(seeds[:4]) == [0, 12, 4, 8], "seeds 1-4 ordered by wins"
    assert list(seeds[4:]) == [1, 2, 5], "wild cards are the best three non-winners, even over a 5-win division winner"


def check_history_keeps_only_pregame_snapshots():
    today = dt.date.today()
    past, future = str(today - dt.timedelta(days=10)), str(today + dt.timedelta(days=3))
    history = {"OLD": [{"date": str(today - dt.timedelta(days=12)), "spread_line": 3, "win_prob_home": 0.5},
                       {"date": str(today - dt.timedelta(days=5)), "spread_line": 3, "win_prob_home": 0.5}]}
    week = {"games": [{"game_id": "OLD", "gameday": past, "spread_line": 3, "win_prob_home": 0.6},
                      {"game_id": "NEW", "gameday": future, "spread_line": 1, "win_prob_home": 0.4}]}
    history = update_history(history, week)
    assert [e["date"] for e in history["OLD"]] == [str(today - dt.timedelta(days=12))], "post-kickoff snapshots dropped"
    assert len(history["NEW"]) == 1, "upcoming game gets today's snapshot"


def check_cancelled_game_does_not_freeze_week():
    today = pd.Timestamp.today().normalize()
    sched = pd.DataFrame({
        "season": 2026, "game_type": "REG", "week": [5, 6, 7],
        "gameday": [str((today - pd.Timedelta(days=d)).date()) for d in (30, 1, -6)],
        "home_score": [np.nan, 20, np.nan], "away_score": [np.nan, 17, np.nan],
    })
    assert web.current_season_week(sched, 2026) == 7, "a month-old unscored game is cancelled, not this week"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("check_"):
            fn()
            print(f"ok  {name}")
