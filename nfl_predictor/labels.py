"""Target construction: home win, home margin, and ATS cover (with pushes)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def add_labels(games: pd.DataFrame) -> pd.DataFrame:
    games = games.copy()
    has_result = games["home_score"].notna() & games["away_score"].notna()
    has_spread = games["spread_line"].notna()

    games["home_margin"] = games["home_score"] - games["away_score"]
    games["home_win"] = np.where(has_result, (games["home_margin"] > 0).astype(float), np.nan)

    # spread_line: positive => home favored by that many points, so home covers
    # iff its actual margin exceeds the line (works for negative spread_line too).
    games["push"] = has_result & has_spread & np.isclose(games["home_margin"], games["spread_line"])
    games["home_cover"] = np.where(
        has_result & has_spread & ~games["push"],
        (games["home_margin"] > games["spread_line"]).astype(float),
        np.nan,
    )
    return games
