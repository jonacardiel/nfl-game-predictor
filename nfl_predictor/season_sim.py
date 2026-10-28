"""Road to Lombardi: Monte Carlo playoff and Super Bowl odds, re-run as of each week."""
from __future__ import annotations

import numpy as np
import pandas as pd

from nfl_predictor import features, model

N_SIMS = 10_000
# Under half a game, so the noise only ever reorders teams that share a record —
# a stand-in for the NFL's real tiebreakers, which this doesn't model.
TIEBREAK_NOISE = 0.4
STRENGTH_STATS = ("off_epa_play", "def_epa_play", "pace")


def _known_inputs(pbp, trades, schedules, season, week):
    """Play-by-play and trades exactly as they stood entering `week` (None = today)."""
    if week is None:
        return pbp, trades
    in_past = (pbp["season"] < season) | (pbp["week"] < week)
    week_games = schedules[
        (schedules["season"] == season) & (schedules["week"] == week) & (schedules["game_type"] == "REG")
    ]
    week_start = pd.to_datetime(week_games["gameday"]).min()
    return pbp[in_past], trades[trades["trade_date"] < week_start]


def _matchup_matrix(models: model.Models, strength: pd.DataFrame) -> np.ndarray:
    """p[i, j] = P(team i beats team j with i at home), from frozen season stats."""
    n = len(strength)
    home, away = np.repeat(np.arange(n), n), np.tile(np.arange(n), n)
    cols = {}
    for stat in STRENGTH_STATS:
        vals = strength[stat].to_numpy()
        cols[f"home_{stat}"] = vals[home]
        cols[f"away_{stat}"] = vals[away]
    for col in ("home_trade_activity", "away_trade_activity", "rest_diff", "trade_diff"):
        cols[col] = np.zeros(n * n)
    p = models.win_model.predict_proba(pd.DataFrame(cols)[features.FEATURE_COLS])[:, 1]
    return p.reshape(n, n)


def _seed_conference(score: np.ndarray, conf_teams: np.ndarray, divisions: list[np.ndarray]) -> np.ndarray:
    """(n_sims, 7) team indices; column k is seed k+1. Division winners take 1-4."""
    rows = np.arange(score.shape[0])[:, None]
    div_winners = np.stack([div[score[:, div].argmax(axis=1)] for div in divisions], axis=1)
    order = np.argsort(-np.take_along_axis(score, div_winners, axis=1), axis=1)
    top4 = np.take_along_axis(div_winners, order, axis=1)

    eligible = np.zeros(score.shape, dtype=bool)
    eligible[:, conf_teams] = True
    eligible[rows, div_winners] = False
    wild_cards = np.argsort(-np.where(eligible, score, -np.inf), axis=1)[:, :3]
    return np.concatenate([top4, wild_cards], axis=1)


def _home_game(home, away, p_home, rng):
    return np.where(rng.random(len(home)) < p_home[home, away], home, away)


def _play_conference(seeds: np.ndarray, p_home: np.ndarray, rng) -> dict:
    """Play one conference's bracket; returns who reached each round, per sim."""
    n_sims = len(seeds)
    teams, team_seeds = [seeds[:, 0]], [np.ones(n_sims, dtype=int)]
    for hi, lo in ((1, 6), (2, 5), (3, 4)):  # wild card round: 2v7, 3v6, 4v5
        winner = _home_game(seeds[:, hi], seeds[:, lo], p_home, rng)
        teams.append(winner)
        team_seeds.append(np.where(winner == seeds[:, hi], hi + 1, lo + 1))

    # Divisional round reseeds: the 1 seed hosts the lowest seed left.
    field, field_seeds = np.column_stack(teams), np.column_stack(team_seeds)
    order = np.argsort(field_seeds, axis=1)
    field = np.take_along_axis(field, order, axis=1)
    field_seeds = np.take_along_axis(field_seeds, order, axis=1)

    a = _home_game(field[:, 0], field[:, 3], p_home, rng)
    b = _home_game(field[:, 1], field[:, 2], p_home, rng)
    a_seed = np.where(a == field[:, 0], field_seeds[:, 0], field_seeds[:, 3])
    b_seed = np.where(b == field[:, 1], field_seeds[:, 1], field_seeds[:, 2])
    host = np.where(a_seed < b_seed, a, b)
    visitor = np.where(a_seed < b_seed, b, a)
    return {
        "divisional": field,
        "conf_game": np.column_stack([a, b]),
        "champion": _home_game(host, visitor, p_home, rng),
    }


def _simulate_checkpoint(models, pbp, trades, schedules, conf_meta, season, week, n_sims, rng) -> dict:
    known_pbp, known_trades = _known_inputs(pbp, trades, schedules, season, week)
    team_week = features.build_team_week_features(known_pbp, known_trades, schedules)
    games = features.build_game_features(team_week, schedules)
    reg = games[(games["season"] == season) & (games["game_type"] == "REG")]

    teams = conf_meta.index.tolist()
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)

    final = reg["home_score"].notna() & reg["away_score"].notna()
    played_mask = final if week is None else final & (reg["week"] < week)
    played, remaining = reg[played_mask], reg[~played_mask]

    base_wins = np.zeros(n)
    margin = (played["home_score"] - played["away_score"]).to_numpy()
    np.add.at(base_wins, played["home_team"].map(idx).to_numpy(), (margin > 0) + 0.5 * (margin == 0))
    np.add.at(base_wins, played["away_team"].map(idx).to_numpy(), (margin < 0) + 0.5 * (margin == 0))

    x = remaining[features.FEATURE_COLS]
    if x.isna().to_numpy().any():
        bad = remaining.loc[x.isna().any(axis=1), "game_id"].tolist()
        raise ValueError(f"Missing features for remaining games: {bad}")
    p_remaining = models.win_model.predict_proba(x)[:, 1] if len(remaining) else np.array([])

    rem_home = remaining["home_team"].map(idx).to_numpy()
    rem_away = remaining["away_team"].map(idx).to_numpy()
    g = np.arange(len(remaining))
    home_onehot = np.zeros((len(remaining), n), dtype=np.float32)
    away_onehot = np.zeros((len(remaining), n), dtype=np.float32)
    home_onehot[g, rem_home] = 1
    away_onehot[g, rem_away] = 1
    home_won = (rng.random((n_sims, len(remaining))) < p_remaining).astype(np.float32)
    wins = base_wins + home_won @ home_onehot + (1 - home_won) @ away_onehot

    season_tw = team_week[team_week["season"] == season]
    strength = season_tw.sort_values("week").groupby("team").tail(1).set_index("team").loc[teams]
    p_home = _matchup_matrix(models, strength)

    score = wins + rng.random(wins.shape) * TIEBREAK_NOISE
    seeds_by_conf, brackets = {}, {}
    for conf in ("AFC", "NFC"):
        in_conf = conf_meta["conf"] == conf
        conf_teams = np.flatnonzero(in_conf.to_numpy())
        divisions = [
            np.flatnonzero((conf_meta["division"] == div).to_numpy())
            for div in sorted(conf_meta.loc[in_conf, "division"].unique())
        ]
        seeds_by_conf[conf] = _seed_conference(score, conf_teams, divisions)
        brackets[conf] = _play_conference(seeds_by_conf[conf], p_home, rng)

    p_neutral = 0.5 * (p_home + (1 - p_home.T))
    afc, nfc = brackets["AFC"]["champion"], brackets["NFC"]["champion"]
    champion = np.where(rng.random(n_sims) < p_neutral[afc, nfc], afc, nfc)

    def share(arrays) -> np.ndarray:
        return np.bincount(np.concatenate([a.ravel() for a in arrays]), minlength=n) / n_sims

    seed_prob = np.zeros((n, 7))
    for seeds in seeds_by_conf.values():
        for k in range(7):
            seed_prob[:, k] += np.bincount(seeds[:, k], minlength=n) / n_sims

    # Remaining strength of schedule: mean net EPA/play of the opponents still to play.
    net = (strength["off_epa_play"] - strength["def_epa_play"]).to_numpy()
    opp_total, opp_count = np.zeros(n), np.zeros(n)
    np.add.at(opp_total, rem_home, net[rem_away])
    np.add.at(opp_total, rem_away, net[rem_home])
    np.add.at(opp_count, rem_home, 1)
    np.add.at(opp_count, rem_away, 1)
    sos = pd.Series(np.where(opp_count > 0, opp_total / np.maximum(opp_count, 1), np.nan), index=teams)

    return {
        "playoff": share(seeds_by_conf.values()),
        "divisional": share(b["divisional"] for b in brackets.values()),
        "conf_game": share(b["conf_game"] for b in brackets.values()),
        "conf_title": share([afc, nfc]),
        "super_bowl": share([champion]),
        "proj_wins": wins.mean(axis=0),
        "sos_rank": sos.rank(ascending=False, method="min"),
        "seed_prob": seed_prob,
        "seeds_by_conf": seeds_by_conf,
        "p_home": p_home,
        "p_neutral": p_neutral,
    }


def _records(reg: pd.DataFrame, teams: list[str]) -> dict:
    final = reg[reg["home_score"].notna() & reg["away_score"].notna()]
    margin = final["home_score"] - final["away_score"]
    records = {}
    for t in teams:
        is_home, is_away = final["home_team"] == t, final["away_team"] == t
        w = int(((is_home & (margin > 0)) | (is_away & (margin < 0))).sum())
        l = int(((is_home & (margin < 0)) | (is_away & (margin > 0))).sum())
        ties = int(((is_home | is_away) & (margin == 0)).sum())
        records[t] = f"{w}-{l}-{ties}" if ties else f"{w}-{l}"
    return records


def lombardi_race(models, pbp, trades, schedules, conf_meta, season, current_week, n_sims=N_SIMS) -> tuple[dict, dict]:
    """Odds for every team at each checkpoint (entering weeks 1..current, plus 'Now'
    if games in the current week have finished), and the latest checkpoint's detail."""
    reg = schedules[(schedules["season"] == season) & (schedules["game_type"] == "REG")]
    final = reg["home_score"].notna() & reg["away_score"].notna()
    checkpoints = [(f"Wk {w}", w) for w in range(1, current_week + 1)]
    if (final & (reg["week"] >= current_week)).any():
        checkpoints.append(("Now", None))

    teams = conf_meta.index.tolist()
    results = []
    for i, (label, week) in enumerate(checkpoints):
        rng = np.random.default_rng(season * 100 + i)
        results.append(_simulate_checkpoint(models, pbp, trades, schedules, conf_meta, season, week, n_sims, rng))
        top = teams[int(results[-1]["super_bowl"].argmax())]
        print(f"  {label:>5}: favorite {top} ({results[-1]['super_bowl'].max():.1%})")

    latest, records = results[-1], _records(reg, teams)
    out = {}
    for i, t in enumerate(teams):
        sos_rank = latest["sos_rank"][t]
        out[t] = {
            "super_bowl": [round(float(r["super_bowl"][i]), 4) for r in results],
            "playoff": [round(float(r["playoff"][i]), 4) for r in results],
            "conf_title": [round(float(r["conf_title"][i]), 4) for r in results],
            "record": records[t],
            "proj_wins": round(float(latest["proj_wins"][i]), 1),
            "sos_remaining_rank": None if pd.isna(sos_rank) else int(sos_rank),
        }
    race = {"checkpoints": [label for label, _ in checkpoints], "n_sims": n_sims, "teams": out}
    return race, {**latest, "records": records, "label": checkpoints[-1][0]}


def _game(home: int, away: int, p_home: np.ndarray, teams: list[str], seeds: dict) -> dict:
    p = float(p_home[home, away])
    return {
        "home": teams[home], "away": teams[away],
        "home_seed": seeds.get(home), "away_seed": seeds.get(away),
        "p_home": round(p, 4),
        "winner": teams[home] if p >= 0.5 else teams[away],
    }


def project_bracket(latest: dict, conf_meta: pd.DataFrame) -> dict:
    """The single most likely seeding, then the model's favorite advanced through
    every round. Per-slot and per-round odds come from the full simulation."""
    teams = conf_meta.index.tolist()
    idx = {t: i for i, t in enumerate(teams)}
    p_home, seed_prob, proj_wins = latest["p_home"], latest["seed_prob"], latest["proj_wins"]
    n_sims = len(next(iter(latest["seeds_by_conf"].values())))
    div_win_prob = seed_prob[:, :4].sum(axis=1)
    wild_card_prob = seed_prob[:, 4:].sum(axis=1)

    conferences, champs = {}, {}
    for conf, sim_seeds in latest["seeds_by_conf"].items():
        in_conf = conf_meta["conf"] == conf
        # Built to obey the real rules: the likeliest winner of each division takes
        # seeds 1-4, the likeliest wild cards take 5-7, each group ordered by projected wins.
        winners = [
            max(np.flatnonzero((conf_meta["division"] == div).to_numpy()), key=lambda t: div_win_prob[t])
            for div in sorted(conf_meta.loc[in_conf, "division"].unique())
        ]
        others = [t for t in np.flatnonzero(in_conf.to_numpy()) if t not in winners]
        wild_cards = sorted(others, key=lambda t: -wild_card_prob[t])[:3]
        seeded = sorted(winners, key=lambda t: -proj_wins[t]) + sorted(wild_cards, key=lambda t: -proj_wins[t])
        seed_of = {int(team): k + 1 for k, team in enumerate(seeded)}
        exact = float((sim_seeds == np.array(seeded)).all(axis=1).mean())

        wild_card = [_game(seeded[hi], seeded[lo], p_home, teams, seed_of) for hi, lo in ((1, 6), (2, 5), (3, 4))]
        field = sorted([seeded[0]] + [idx[g["winner"]] for g in wild_card], key=seed_of.get)
        divisional = [_game(field[0], field[3], p_home, teams, seed_of), _game(field[1], field[2], p_home, teams, seed_of)]
        finalists = sorted((idx[g["winner"]] for g in divisional), key=seed_of.get)
        conf_game = _game(finalists[0], finalists[1], p_home, teams, seed_of)
        champs[conf] = idx[conf_game["winner"]]

        conferences[conf] = {
            "seeds": [
                {"seed": k + 1, "team": teams[t], "prob": round(float(seed_prob[t, k]), 4)}
                for k, t in enumerate(seeded)
            ],
            "exact_seeding_prob": round(exact, 4),
            "rounds": [
                {"name": "Wild Card", "games": wild_card},
                {"name": "Divisional", "games": divisional},
                {"name": "Conference Championship", "games": [conf_game]},
            ],
        }

    afc, nfc = champs["AFC"], champs["NFC"]
    p_afc = float(latest["p_neutral"][afc, nfc])
    afc_seeds = latest["seeds_by_conf"]["AFC"]
    nfc_seeds = latest["seeds_by_conf"]["NFC"]
    afc_exact = (afc_seeds == np.array([idx[s["team"]] for s in conferences["AFC"]["seeds"]])).all(axis=1)
    nfc_exact = (nfc_seeds == np.array([idx[s["team"]] for s in conferences["NFC"]["seeds"]])).all(axis=1)

    odds = {}
    for i, t in enumerate(teams):
        odds[t] = {
            "conf": conf_meta.loc[t, "conf"],
            "record": latest["records"][t],
            "proj_wins": round(float(latest["proj_wins"][i]), 1),
            "seed_probs": [round(float(p), 4) for p in seed_prob[i]],
            **{k: round(float(latest[k][i]), 4) for k in ("playoff", "divisional", "conf_game", "conf_title", "super_bowl")},
        }

    return {
        "as_of": latest["label"],
        "n_sims": n_sims,
        "exact_bracket_prob": round(float((afc_exact & nfc_exact).mean()), 5),
        "conferences": conferences,
        "super_bowl": {
            "afc": teams[afc], "nfc": teams[nfc],
            "p_afc": round(p_afc, 4),
            "winner": teams[afc] if p_afc >= 0.5 else teams[nfc],
        },
        "odds": odds,
    }
