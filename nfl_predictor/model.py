"""Fit, evaluate, save, and load the win / ATS / margin models."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import joblib
import pandas as pd
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from nfl_predictor.features import FEATURE_COLS

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

ATS_FEATURE_COLS = FEATURE_COLS + ["spread_line"]


def _make_logit() -> Pipeline:
    return Pipeline([("scaler", StandardScaler()), ("clf", LogisticRegression(max_iter=1000))])


def _make_linear() -> Pipeline:
    return Pipeline([("scaler", StandardScaler()), ("reg", LinearRegression())])


@dataclass
class Models:
    win_model: Pipeline
    ats_model: Pipeline
    margin_model: Pipeline

    def save(self) -> None:
        joblib.dump(self.win_model, MODELS_DIR / "win_model.joblib")
        joblib.dump(self.ats_model, MODELS_DIR / "ats_model.joblib")
        joblib.dump(self.margin_model, MODELS_DIR / "margin_model.joblib")

    @classmethod
    def load(cls) -> "Models":
        return cls(
            win_model=joblib.load(MODELS_DIR / "win_model.joblib"),
            ats_model=joblib.load(MODELS_DIR / "ats_model.joblib"),
            margin_model=joblib.load(MODELS_DIR / "margin_model.joblib"),
        )


def fit_models(train_games: pd.DataFrame) -> Models:
    x = train_games[FEATURE_COLS]
    win_model = _make_logit().fit(x, train_games["home_win"])
    margin_model = _make_linear().fit(x, train_games["home_margin"])

    ats_games = train_games.loc[~train_games["push"] & train_games["home_cover"].notna()]
    x_ats = ats_games[ATS_FEATURE_COLS]
    ats_model = _make_logit().fit(x_ats, ats_games["home_cover"])

    return Models(win_model=win_model, ats_model=ats_model, margin_model=margin_model)


def evaluate(models: Models, test_games: pd.DataFrame) -> dict:
    x = test_games[FEATURE_COLS]
    win_pred = models.win_model.predict(x)
    win_proba = models.win_model.predict_proba(x)[:, 1]

    ats_games = test_games.loc[~test_games["push"] & test_games["home_cover"].notna()]
    metrics = {
        "n_games": len(test_games),
        "win_accuracy": accuracy_score(test_games["home_win"], win_pred),
        "win_log_loss": log_loss(test_games["home_win"], win_proba, labels=[0, 1]),
        "n_ats_games": len(ats_games),
        "ats_accuracy": float("nan"),
    }
    if not ats_games.empty:
        x_ats = ats_games[ATS_FEATURE_COLS]
        ats_pred = models.ats_model.predict(x_ats)
        metrics["ats_accuracy"] = accuracy_score(ats_games["home_cover"], ats_pred)
    return metrics
