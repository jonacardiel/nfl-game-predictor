const LOGO_DIR = "assets/logos";
const MIN_LOADING_MS = 550;

let weeksManifest = null;
let historyData = {};

function logoPath(team) {
  return `${LOGO_DIR}/${team}.png`;
}

function fmtPct(p) {
  if (p === null || p === undefined) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

function fmtSigned(n, suffix = "") {
  if (n === null || n === undefined) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}${suffix}`;
}

function fmtKickoff(gameday, gametime) {
  if (!gameday) return "";
  const d = new Date(`${gameday}T00:00:00`);
  const dateStr = isNaN(d) ? gameday : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return gametime ? `${dateStr} · ${gametime} ET` : dateStr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gameOutcome(game) {
  if (!game.final) return null;
  const actualMargin = game.home_score - game.away_score;
  const suPickedHome = game.win_prob_home >= 0.5;
  const suCorrect = suPickedHome === (actualMargin > 0);

  let atsCorrect = null;
  let push = false;
  if (game.spread_line !== null && game.ats_pick !== "N/A") {
    push = actualMargin === game.spread_line;
    if (!push) {
      const homeCovered = actualMargin > game.spread_line;
      atsCorrect = (game.ats_pick === "HOME") === homeCovered;
    }
  }
  return { suCorrect, atsCorrect, push, actualMargin };
}

function renderSparkline(gameId) {
  const entries = historyData[gameId];
  if (!entries || entries.length < 2) {
    return `<div class="sparkline-empty">Gathering line-movement history — check back after a few weekly updates.</div>`;
  }

  const width = 400;
  const height = 44;
  const vals = entries.map((e) => e.win_prob_home).filter((v) => v !== null && v !== undefined);
  if (vals.length < 2) {
    return `<div class="sparkline-empty">Gathering line-movement history — check back after a few weekly updates.</div>`;
  }

  const min = Math.min(...vals, 0.3);
  const max = Math.max(...vals, 0.7);
  const range = max - min || 1;
  const stepX = width / (entries.length - 1);

  const points = entries
    .map((e, i) => {
      const x = i * stepX;
      const v = e.win_prob_home ?? 0.5;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polyline points="${points}" fill="none" stroke="var(--accent-cyan)" stroke-width="2" />
    </svg>
  `;
}

function renderGameCard(game) {
  const outcome = gameOutcome(game);
  const homeFavored = game.win_prob_home >= 0.5;
  const homePct = Math.round(game.win_prob_home * 100);
  const awayPct = 100 - homePct;

  const card = document.createElement("div");
  card.className = "game-card" + (game.final ? " is-final" : "");

  const awayWon = game.final && game.away_score > game.home_score;
  const homeWon = game.final && game.home_score > game.away_score;

  const cardTop = document.createElement("div");
  cardTop.className = "card-top";

  const teamsCol = document.createElement("div");
  teamsCol.className = "matchup-teams";
  teamsCol.innerHTML = `
    <div class="team-row${game.final && !awayWon ? " is-loser" : ""}">
      <img class="team-logo" src="${logoPath(game.away_team)}" alt="${game.away_team}" onerror="this.style.visibility='hidden'">
      <span class="team-abbr">${game.away_team}</span>
      ${game.final ? `<span class="team-score">${game.away_score}</span>` : ""}
    </div>
    <div class="team-row${game.final && !homeWon ? " is-loser" : ""}">
      <img class="team-logo" src="${logoPath(game.home_team)}" alt="${game.home_team}" onerror="this.style.visibility='hidden'">
      <span class="team-abbr">${game.home_team}</span>
      ${game.final ? `<span class="team-score">${game.home_score}</span>` : ""}
    </div>
  `;

  const kickoffTag = document.createElement("div");
  kickoffTag.className = "kickoff-tag" + (game.final ? " is-final" : "");
  kickoffTag.textContent = game.final ? "FINAL" : fmtKickoff(game.gameday, game.gametime);

  const headline = document.createElement("div");
  headline.className = "headline-stats";

  const winPick = homeFavored ? game.home_team : game.away_team;
  const winProb = homeFavored ? game.win_prob_home : 1 - game.win_prob_home;
  const winProbPct = Math.round(winProb * 100);
  const winColorClass = winProbPct >= 60 ? "value-lime" : "value-cyan";

  let atsHtml = "";
  if (game.spread_line !== null && game.ats_pick !== "N/A") {
    const confident = Math.abs(game.covers_by) >= 3;
    const atsColorClass = confident ? "value-lime" : "value-magenta";
    let badge = "";
    if (outcome) {
      if (outcome.push) badge = `<span class="badge-inline push">PUSH</span>`;
      else badge = outcome.atsCorrect
        ? `<span class="badge-inline correct">HIT</span>`
        : `<span class="badge-inline incorrect">MISS</span>`;
    }
    atsHtml = `<div class="ats-line ${atsColorClass}">${game.ats_pick} ${fmtSigned(game.covers_by, "")}${badge}</div>`;
  }

  headline.innerHTML = `
    <div class="win-prob ${winColorClass}">${winPick} ${winProbPct}%</div>
    <div class="win-prob-label">WIN PROB</div>
    ${atsHtml}
  `;

  cardTop.appendChild(teamsCol);
  cardTop.appendChild(kickoffTag);
  cardTop.appendChild(headline);
  card.appendChild(cardTop);

  const detailId = `detail-${(game.game_id || `${game.away_team}-${game.home_team}`).replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "expand-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", detailId);
  toggle.innerHTML = `<span class="chevron" aria-hidden="true">&#9656;</span><span>DEEPER STATS</span>`;
  toggle.addEventListener("click", () => {
    const expanded = card.classList.toggle("is-expanded");
    toggle.setAttribute("aria-expanded", String(expanded));
  });
  card.appendChild(toggle);

  const detail = document.createElement("div");
  detail.id = detailId;
  detail.className = "card-detail";
  const d = game.detail || {};
  detail.innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">Predicted Margin</span><span class="detail-value">${fmtSigned(game.pred_margin_home)} (home)</span></div>
      <div class="detail-item"><span class="detail-label">ATS Model P(home covers)</span><span class="detail-value">${fmtPct(game.ats_cover_prob_home)}</span></div>
      <div class="detail-item"><span class="detail-label">Off EPA/play (A / H)</span><span class="detail-value">${d.away_off_epa_play ?? "—"} / ${d.home_off_epa_play ?? "—"}</span></div>
      <div class="detail-item"><span class="detail-label">Def EPA/play allowed (A / H)</span><span class="detail-value">${d.away_def_epa_play ?? "—"} / ${d.home_def_epa_play ?? "—"}</span></div>
      <div class="detail-item"><span class="detail-label">Pace, plays/gm (A / H)</span><span class="detail-value">${d.away_pace ?? "—"} / ${d.home_pace ?? "—"}</span></div>
      <div class="detail-item"><span class="detail-label">Rest days (A / H)</span><span class="detail-value">${d.away_rest ?? "—"} / ${d.home_rest ?? "—"}</span></div>
    </div>
    <div class="sparkline-block">
      <span class="detail-label">Win Probability Movement</span>
      ${renderSparkline(game.game_id)}
    </div>
  `;
  card.appendChild(detail);

  return card;
}

function renderGames(payload) {
  document.getElementById("week-title").textContent = `Week ${payload.week} — ${payload.season}`;
  const updated = new Date(payload.last_updated);
  document.getElementById("last-updated").textContent =
    `Updated ${updated.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;

  const list = document.getElementById("games-list");
  list.innerHTML = "";
  payload.games.forEach((game) => list.appendChild(renderGameCard(game)));
}

async function loadWeek(season, week) {
  const btn = document.getElementById("run-btn");
  const loadingScreen = document.getElementById("loading-screen");
  const gamesList = document.getElementById("games-list");
  const status = document.getElementById("console-status");

  btn.disabled = true;
  loadingScreen.hidden = false;
  gamesList.innerHTML = "";
  status.textContent = "";

  const start = Date.now();
  try {
    const res = await fetch(`data/predictions/${season}_wk${week}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();

    const elapsed = Date.now() - start;
    if (elapsed < MIN_LOADING_MS) await sleep(MIN_LOADING_MS - elapsed);

    renderGames(payload);
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't load Week ${week} — data may not be generated yet.`;
  } finally {
    loadingScreen.hidden = true;
    btn.disabled = false;
  }
}

function populateWeekSelect(manifest) {
  const select = document.getElementById("week-select");
  select.innerHTML = "";
  manifest.weeks.forEach(({ week, status }) => {
    const opt = document.createElement("option");
    opt.value = week;
    const tag = status === "final" ? "✓" : status === "live" ? "●" : "";
    opt.textContent = `Week ${week} ${tag}`.trim();
    if (week === manifest.current_week) opt.selected = true;
    select.appendChild(opt);
  });
}

function populateSeasonSelect(manifest) {
  const select = document.getElementById("season-select");
  select.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = manifest.season;
  opt.textContent = manifest.season;
  opt.selected = true;
  select.appendChild(opt);
}

async function initConsole() {
  const [manifestRes, historyRes] = await Promise.all([
    fetch("data/weeks.json", { cache: "no-store" }),
    fetch("data/history.json", { cache: "no-store" }).catch(() => null),
  ]);
  weeksManifest = await manifestRes.json();
  historyData = historyRes && historyRes.ok ? await historyRes.json() : {};

  populateSeasonSelect(weeksManifest);
  populateWeekSelect(weeksManifest);

  document.getElementById("run-btn").addEventListener("click", () => {
    const season = document.getElementById("season-select").value;
    const week = document.getElementById("week-select").value;
    loadWeek(season, week);
  });

  await loadWeek(weeksManifest.season, weeksManifest.current_week);
}

function renderScorecard(scorecard) {
  const container = document.getElementById("scorecard-cards");
  container.innerHTML = "";

  const cards = [
    { label: "Games Scored", value: scorecard.games_played },
    { label: "Straight-Up Record", value: scorecard.straight_up_record },
    { label: "Straight-Up Accuracy", value: fmtPct(scorecard.straight_up_pct) },
    { label: "ATS Record", value: scorecard.ats_record },
    { label: "ATS Accuracy", value: fmtPct(scorecard.ats_pct) },
  ];

  cards.forEach(({ label, value }) => {
    const el = document.createElement("div");
    el.className = "stat-card";
    el.innerHTML = `<div class="stat-value">${value}</div><div class="stat-label">${label}</div>`;
    container.appendChild(el);
  });

  const SMALL_SAMPLE_THRESHOLD = 16; // roughly one full week of games
  const caveat = document.getElementById("scorecard-caveat");
  if (scorecard.games_played > 0 && scorecard.games_played < SMALL_SAMPLE_THRESHOLD) {
    caveat.textContent = `Small sample (${scorecard.games_played} game${scorecard.games_played === 1 ? "" : "s"}) — these numbers will be noisy until more of the season is in the books.`;
    caveat.hidden = false;
  } else {
    caveat.hidden = true;
  }
}

function renderChart(backtest) {
  const container = document.getElementById("chart-container");
  if (!backtest.length) {
    container.innerHTML = `<p class="muted">No backtest data yet.</p>`;
    return;
  }

  const width = 800;
  const height = 320;
  const marginLeft = 40;
  const marginBottom = 30;
  const marginTop = 10;
  const plotW = width - marginLeft - 20;
  const plotH = height - marginTop - marginBottom;

  const groupW = plotW / backtest.length;
  const barW = groupW / 2 - 8;

  const yFor = (v) => marginTop + plotH * (1 - v);

  let bars = "";
  let labels = "";
  let gridlines = "";

  [0, 0.25, 0.5, 0.75, 1.0].forEach((v) => {
    const y = yFor(v);
    gridlines += `<line x1="${marginLeft}" y1="${y}" x2="${width - 20}" y2="${y}" stroke="var(--border-glass)" stroke-width="1" />`;
    gridlines += `<text x="${marginLeft - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-secondary)" font-family="var(--font-mono)">${Math.round(v * 100)}%</text>`;
  });

  backtest.forEach((row, i) => {
    const groupX = marginLeft + i * groupW;
    const winX = groupX + 6;
    const atsX = winX + barW + 4;

    const winY = yFor(row.win_accuracy);
    const atsY = yFor(row.ats_accuracy);

    bars += `<rect x="${winX}" y="${winY}" width="${barW}" height="${marginTop + plotH - winY}" fill="var(--accent-cyan)" rx="2">
      <title>${row.season} win accuracy: ${(row.win_accuracy * 100).toFixed(1)}%</title>
    </rect>`;
    bars += `<rect x="${atsX}" y="${atsY}" width="${barW}" height="${marginTop + plotH - atsY}" fill="var(--accent-magenta)" rx="2">
      <title>${row.season} ATS accuracy: ${(row.ats_accuracy * 100).toFixed(1)}%</title>
    </rect>`;

    labels += `<text x="${groupX + groupW / 2}" y="${height - 8}" text-anchor="middle" font-size="12" fill="var(--text-secondary)" font-family="var(--font-mono)">${row.season}</text>`;
  });

  const coinFlipY = yFor(0.5);

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${gridlines}
      <line x1="${marginLeft}" y1="${coinFlipY}" x2="${width - 20}" y2="${coinFlipY}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="4,4" />
      ${bars}
      ${labels}
    </svg>
  `;
}

async function loadPerformance() {
  const res = await fetch("data/performance.json", { cache: "no-store" });
  const data = await res.json();
  renderScorecard(data.current_season_scorecard);
  renderChart(data.backtest_by_season);
}

initConsole().catch((err) => {
  console.error(err);
  document.getElementById("console-status").textContent = "Couldn't load the season manifest.";
});

loadPerformance().catch((err) => console.error(err));
