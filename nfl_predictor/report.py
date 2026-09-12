"""Seaborn/matplotlib evaluation plots and the console prediction table."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from sklearn.calibration import calibration_curve
from sklearn.metrics import confusion_matrix

from nfl_predictor.features import FEATURE_COLS
from nfl_predictor.model import ATS_FEATURE_COLS

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

sns.set_theme(style="whitegrid")


def _coef_plot(pipeline, feature_names: list[str], title: str, filename: str) -> None:
    coefs = pipeline.named_steps["clf"].coef_[0]
    df = pd.DataFrame({"feature": feature_names, "coefficient": coefs}).sort_values("coefficient")
    plt.figure(figsize=(8, 5))
    sns.barplot(data=df, x="coefficient", y="feature", hue="feature", palette="vlag", legend=False)
    plt.axvline(0, color="black", linewidth=0.8)
    plt.title(title)
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / filename)
    plt.close()


def _calibration_plot(y_true, y_proba, title: str, filename: str) -> None:
    frac_pos, mean_pred = calibration_curve(y_true, y_proba, n_bins=8, strategy="quantile")
    plt.figure(figsize=(6, 6))
    plt.plot([0, 1], [0, 1], linestyle="--", color="grey", label="Perfectly calibrated")
    plt.plot(mean_pred, frac_pos, marker="o", label="Model")
    plt.xlabel("Predicted probability")
    plt.ylabel("Observed frequency")
    plt.title(title)
    plt.legend()
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / filename)
    plt.close()


def _confusion_plot(y_true, y_pred, title: str, filename: str) -> None:
    cm = confusion_matrix(y_true, y_pred)
    plt.figure(figsize=(5, 4))
    sns.heatmap(cm, annot=True, fmt="d", cmap="Blues", xticklabels=["Pred 0", "Pred 1"], yticklabels=["True 0", "True 1"])
    plt.title(title)
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / filename)
    plt.close()


def save_evaluation_plots(holdout_models, holdout_games: pd.DataFrame, backtest_df: pd.DataFrame, holdout_season: int) -> None:
    x = holdout_games[FEATURE_COLS]
    win_proba = holdout_models.win_model.predict_proba(x)[:, 1]
    win_pred = holdout_models.win_model.predict(x)

    _coef_plot(holdout_models.win_model, FEATURE_COLS, f"Win model coefficients (trained through {holdout_season - 1})", "win_coefficients.png")
    _calibration_plot(holdout_games["home_win"], win_proba, f"Win probability calibration — {holdout_season} holdout", "win_calibration.png")
    _confusion_plot(holdout_games["home_win"], win_pred, f"Win model confusion matrix — {holdout_season} holdout", "win_confusion.png")

    ats_games = holdout_games.loc[~holdout_games["push"] & holdout_games["home_cover"].notna()]
    if not ats_games.empty:
        x_ats = ats_games[ATS_FEATURE_COLS]
        ats_pred = holdout_models.ats_model.predict(x_ats)
        _coef_plot(holdout_models.ats_model, ATS_FEATURE_COLS, f"ATS model coefficients (trained through {holdout_season - 1})", "ats_coefficients.png")
        _confusion_plot(ats_games["home_cover"], ats_pred, f"ATS model confusion matrix — {holdout_season} holdout", "ats_confusion.png")

    if not backtest_df.empty:
        melted = backtest_df.melt(id_vars="season", value_vars=["win_accuracy", "ats_accuracy"], var_name="metric", value_name="accuracy")
        plt.figure(figsize=(9, 5))
        sns.barplot(data=melted, x="season", y="accuracy", hue="metric")
        plt.axhline(0.5, linestyle="--", color="grey")
        plt.ylim(0, 1)
        plt.title("Walk-forward backtest accuracy by season")
        plt.tight_layout()
        plt.savefig(OUTPUT_DIR / "backtest_by_season.png")
        plt.close()


def _side_and_value(home_value: float) -> tuple[str, float]:
    side = "HOME" if home_value >= 0 else "AWAY"
    return side, abs(home_value)


def format_predictions_table(games: pd.DataFrame, season: int, week: int) -> str:
    lines = []
    lines.append(f" NFL WEEK {week} PREDICTIONS  |  Season {season}")
    lines.append("=" * 112)
    lines.append(f"  {'MATCHUP':<30}{'WIN PROB':>10}  {'PREDICTED':>11}  {'SPREAD':>8}  {'ATS PICK':>10}  {'COVERS BY':>10}")
    lines.append(f"  {'-'*30}{'-'*10}  {'-'*11}  {'-'*8}  {'-'*10}  {'-'*10}")

    for _, row in games.iterrows():
        matchup = f"{row['away_team']} @ {row['home_team']}"

        win_side, win_val = _side_and_value(row["win_prob_home"] - 0.5)
        win_prob_display = row["win_prob_home"] if win_side == "HOME" else 1 - row["win_prob_home"]
        win_prob_str = f"{win_side} {win_prob_display * 100:4.1f}%"

        pred_side, pred_val = _side_and_value(row["pred_margin_home"])
        pred_str = f"{pred_side} +{pred_val:4.1f}"

        if pd.notna(row["spread_line"]):
            spread_side, spread_val = _side_and_value(row["spread_line"])
            spread_str = f"{spread_side} +{spread_val:.1f}"
        else:
            spread_str = "N/A"

        ats_pick = row["ats_pick"]
        covers_str = f"{row['covers_by']:+.1f} pts" if pd.notna(row["covers_by"]) else "N/A"

        lines.append(
            f"  {matchup:<30}{win_prob_str:>10}  {pred_str:>11}  {spread_str:>8}  {ats_pick:>10}  {covers_str:>10}"
        )

    return "\n".join(lines)
