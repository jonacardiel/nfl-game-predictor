const LOGO_DIR = "assets/logos";

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

function fmtClock(gametime) {
  const [h, m] = gametime.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return gametime;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function fmtKickoff(gameday, gametime) {
  if (!gameday) return "";
  const d = new Date(`${gameday}T00:00:00`);
  const dateStr = isNaN(d) ? gameday : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return gametime ? `${dateStr} · ${fmtClock(gametime)} ET` : dateStr;
}

// Betting notation: the number a side gets, so a 2.5-point favorite is "−2.5".
function fmtLine(v) {
  if (v === null || v === undefined) return "—";
  if (Math.abs(v) < 0.05) return "PK";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

// A home-perspective margin (positive = home wins by that much) as "FAV −x".
function favoriteLine(homeMargin, game) {
  if (homeMargin === null || homeMargin === undefined) return "—";
  if (Math.abs(homeMargin) < 0.05) return "Pick'em";
  const fav = homeMargin > 0 ? game.home_team : game.away_team;
  return `${fav} ${fmtLine(-Math.abs(homeMargin))}`;
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

const MIN_SPARKLINE_POINTS = 4; // fewer points than this is just noise, not a trend

function renderSparkline(gameId, homeColor, awayColor) {
  const entries = historyData[gameId];
  if (!entries || entries.length < MIN_SPARKLINE_POINTS) {
    return `<div class="sparkline-empty">Gathering line-movement history — check back after a few weekly updates.</div>`;
  }

  const width = 400;
  const height = 44;
  const vals = entries.map((e) => e.win_prob_home).filter((v) => v !== null && v !== undefined);
  if (vals.length < MIN_SPARKLINE_POINTS) {
    return `<div class="sparkline-empty">Gathering line-movement history — check back after a few weekly updates.</div>`;
  }

  const min = Math.min(...vals, 0.3);
  const max = Math.max(...vals, 0.7);
  const range = max - min || 1;
  const stepX = width / (entries.length - 1);

  const yFor = (v) => height - ((v - min) / range) * height;
  const points = entries.map((e, i) => ({ x: i * stepX, v: e.win_prob_home ?? 0.5 }));

  // Home win prob is zero-sum with away's — a second line for "away" would just be
  // this one mirrored, which shows no new information. Instead, color each segment
  // by whoever's actually favored at that point: home's color above the 50% line,
  // away's below it, splitting any segment that crosses the midline so the color
  // change lands exactly where the favorite flips.
  const home = homeColor || "var(--good)";
  const away = awayColor || "var(--bad)";
  const midY = yFor(0.5);

  let segments = "";
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const aIsHome = a.v >= 0.5;
    const bIsHome = b.v >= 0.5;
    const ay = yFor(a.v);
    const by = yFor(b.v);

    if (aIsHome === bIsHome) {
      const color = aIsHome ? home : away;
      segments += `<line x1="${a.x.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${color}" stroke-width="2" stroke-linecap="round" />`;
    } else {
      const t = (0.5 - a.v) / (b.v - a.v);
      const crossX = a.x + t * (b.x - a.x);
      segments += `<line x1="${a.x.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${crossX.toFixed(1)}" y2="${midY.toFixed(1)}" stroke="${aIsHome ? home : away}" stroke-width="2" stroke-linecap="round" />`;
      segments += `<line x1="${crossX.toFixed(1)}" y1="${midY.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${bIsHome ? home : away}" stroke-width="2" stroke-linecap="round" />`;
    }
  }

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line x1="0" y1="${midY.toFixed(1)}" x2="${width}" y2="${midY.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3,3" />
      ${segments}
    </svg>
  `;
}

// Readable text color for a team-colored slab (black or white, whichever contrasts more).
function onColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#fff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.35 ? "#0d1117" : "#fff";
}

function teamRow(game, side, won) {
  const team = game[side + "_team"];
  const color = game[side + "_color"] || "#3a4250";
  const loser = game.final && !won;
  return `
    <div class="team-row${loser ? " is-loser" : ""}" style="--team:${color};--on-team:${onColor(color)}">
      <img class="team-logo" src="${logoPath(team)}" alt="${team}" onerror="this.style.visibility='hidden'">
      <span class="team-abbr">${team}</span>
      ${game.final ? `<span class="team-score">${game[side + "_score"]}</span>` : ""}
    </div>`;
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
  teamsCol.innerHTML = teamRow(game, "away", awayWon) + teamRow(game, "home", homeWon);


  const kickoffTag = document.createElement("div");
  kickoffTag.className = "kickoff-tag" + (game.final ? " is-final" : "");
  kickoffTag.textContent = game.final ? "FINAL" : fmtKickoff(game.gameday, game.gametime);

  const headline = document.createElement("div");
  headline.className = "headline-stats";

  const winPick = homeFavored ? game.home_team : game.away_team;
  const winProb = homeFavored ? game.win_prob_home : 1 - game.win_prob_home;
  const winProbPct = Math.round(winProb * 100);
  // Once a game is over, a missed pick shouldn't keep glowing in the "confident" color.
  const winColorClass = outcome && !outcome.suCorrect ? "value-muted" : winProbPct >= 60 ? "value-lime" : "value-cyan";
  const winBadge = !outcome ? "" : outcome.suCorrect
    ? `<span class="badge-inline correct">HIT</span>`
    : `<span class="badge-inline incorrect">MISS</span>`;

  let atsHtml = "";
  if (game.spread_line !== null && game.ats_pick !== "N/A") {
    const pickHome = game.ats_pick === "HOME";
    const pickTeam = pickHome ? game.home_team : game.away_team;
    // spread_line is how much the home side is favored by, so home's betting line is its negative.
    const pickLine = pickHome ? -game.spread_line : game.spread_line;
    const edge = Math.abs(game.covers_by);
    const atsMissed = outcome && !outcome.push && !outcome.atsCorrect;
    const atsColorClass = atsMissed ? "value-muted" : edge >= 3 ? "value-lime" : "value-magenta";
    let badge = "";
    if (outcome) {
      if (outcome.push) badge = `<span class="badge-inline push">PUSH</span>`;
      else badge = outcome.atsCorrect
        ? `<span class="badge-inline correct">HIT</span>`
        : `<span class="badge-inline incorrect">MISS</span>`;
    }
    atsHtml = `
      <span class="ats-line ${atsColorClass}"><b>${pickTeam} ${fmtLine(pickLine)}</b> ATS${badge}</span>
      <span class="ats-edge">${edge.toFixed(1)}-pt edge</span>`;
  }

  headline.innerHTML = `
    <div class="win-prob ${winColorClass}">${winPick} ${winProbPct}<small>%</small></div>
    <div class="win-prob-label">Win probability${winBadge}</div>
  `;

  cardTop.appendChild(teamsCol);
  const strip = document.createElement("div");
  strip.className = "card-strip";
  strip.appendChild(kickoffTag);
  if (atsHtml) strip.insertAdjacentHTML("beforeend", atsHtml);
  cardTop.appendChild(headline);
  card.appendChild(cardTop);
  card.appendChild(strip);

  const detailId = `detail-${(game.game_id || `${game.away_team}-${game.home_team}`).replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "expand-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", detailId);
  toggle.innerHTML = `<span class="chevron" aria-hidden="true">&#9656;</span><span>Deeper stats</span>`;
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
      <div class="detail-item"><span class="detail-label">Vegas line</span><span class="detail-value">${favoriteLine(game.spread_line, game)}</span></div>
      <div class="detail-item"><span class="detail-label">Model's line</span><span class="detail-value">${favoriteLine(game.pred_margin_home, game)}</span></div>
      <div class="detail-item"><span class="detail-label">ATS Model P(home covers)</span><span class="detail-value">${fmtPct(game.ats_cover_prob_home)}</span></div>
      <div class="detail-item"><span class="detail-label">Off EPA/play (A / H)</span><span class="detail-value">${d.away_off_epa_play ?? "—"} / ${d.home_off_epa_play ?? "—"}</span></div>
      <div class="detail-item"><span class="detail-label">Def EPA/play allowed (A / H)</span><span class="detail-value">${d.away_def_epa_play ?? "—"} / ${d.home_def_epa_play ?? "—"}</span></div>
      <div class="detail-item"><span class="detail-label">Pace, plays/gm (A / H)</span><span class="detail-value">${d.away_pace ?? "—"} / ${d.home_pace ?? "—"}</span></div>
      <div class="detail-item"><span class="detail-label">Rest days (A / H)</span><span class="detail-value">${d.away_rest ?? "—"} / ${d.home_rest ?? "—"}</span></div>
    </div>
    <div class="sparkline-block">
      <span class="detail-label">Win Probability Movement</span>
      ${renderSparkline(game.game_id, game.home_color, game.away_color)}
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

  // First load: nothing on screen yet, so the full loading state is the content.
  // Switching weeks after that: keep the current cards visible (dimmed) instead of
  // wiping to blank — the fetch is a local JSON file and typically resolves fast.
  const hasExistingContent = gamesList.children.length > 0;

  btn.disabled = true;
  status.textContent = "";
  if (hasExistingContent) {
    gamesList.classList.add("is-refreshing");
  } else {
    loadingScreen.hidden = false;
  }

  try {
    const res = await fetch(`data/predictions/${season}_wk${week}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderGames(payload);
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't load Week ${week} — data may not be generated yet.`;
  } finally {
    loadingScreen.hidden = true;
    gamesList.classList.remove("is-refreshing");
    btn.disabled = false;
  }
}

function populateWeekSelect(manifest) {
  const select = document.getElementById("week-select");
  select.innerHTML = "";
  manifest.weeks.forEach(({ week, status }) => {
    const opt = document.createElement("option");
    opt.value = week;
    const tag = week === manifest.current_week ? "· this week" : status === "final" ? "✓" : status === "live" ? "●" : "";
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

  const SMALL_SAMPLE_THRESHOLD = 96; // roughly 6 weeks — ATS variance stays wide below this
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
    gridlines += `<line x1="${marginLeft}" y1="${y}" x2="${width - 20}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
    gridlines += `<text x="${marginLeft - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-secondary)" font-family="var(--font-mono)">${Math.round(v * 100)}%</text>`;
  });

  backtest.forEach((row, i) => {
    const groupX = marginLeft + i * groupW;
    const winX = groupX + 6;
    const atsX = winX + barW + 4;

    const winY = yFor(row.win_accuracy);
    const atsY = yFor(row.ats_accuracy);

    bars += `<rect x="${winX}" y="${winY}" width="${barW}" height="${marginTop + plotH - winY}" fill="var(--accent)" rx="2">
      <title>${row.season} win accuracy: ${(row.win_accuracy * 100).toFixed(1)}%</title>
    </rect>`;
    bars += `<rect x="${atsX}" y="${atsY}" width="${barW}" height="${marginTop + plotH - atsY}" fill="var(--series-b)" rx="2">
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

/* ---------- Road to Lombardi ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const LOMBARDI_TOP_N = 6;
const MS_PER_WEEK = 650;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const lombardi = {
  data: null,
  race: null,
  t: 0,
  playing: false,
  hasPlayed: false,
  raf: null,
  lastTs: null,
  hovered: null,
  pinned: null,
  chart: null,
  builtWidth: 0,
};

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function oddsLabel(p) {
  if (p >= 0.1) return `${Math.round(p * 100)}%`;
  return `${(p * 100).toFixed(1)}%`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// "Redmean" approximation of perceived color difference — cheap and good enough here.
function colorDistance(a, b) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

// Several teams share near-identical reds/blues (BUF and NE are the exact same red), and
// only teams on the board at the same time need to look different. Start every racer on
// its primary color, then keep swapping one team at a time to an alternate official color
// while it reduces on-screen clashes — favorites keep their primaries when it's a tie.
function assignRaceColors(racers) {
  const GOOD_ENOUGH = 150;
  const options = racers.map((team) => {
    const seen = new Set();
    const valid = (team.colors || [team.color])
      .filter((c) => /^#[0-9a-f]{6}$/i.test(c) && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()))
      .slice(0, 3);
    return valid.length ? valid : [team.color];
  });

  const pairs = [];
  for (let a = 0; a < racers.length; a++) {
    for (let b = a + 1; b < racers.length; b++) {
      if (racers[a].member.some((m, s) => m && racers[b].member[s])) pairs.push([a, b]);
    }
  }

  const choice = racers.map(() => 0);
  const score = () => {
    let clashes = 0;
    let minDist = GOOD_ENOUGH;
    for (const [a, b] of pairs) {
      const d = colorDistance(options[a][choice[a]], options[b][choice[b]]);
      if (d < GOOD_ENOUGH) clashes++;
      minDist = Math.min(minDist, d);
    }
    const cost = choice.reduce((sum, k, rank) => sum + k * (racers.length - rank), 0);
    return [clashes, -minDist, cost];
  };
  const better = (s, t) => (s[0] !== t[0] ? s[0] < t[0] : s[1] !== t[1] ? s[1] < t[1] : s[2] < t[2]);

  let best = score();
  for (let improved = true; improved; ) {
    improved = false;
    for (let i = 0; i < racers.length; i++) {
      for (let k = 0; k < options[i].length; k++) {
        if (k === choice[i]) continue;
        const prev = choice[i];
        choice[i] = k;
        const s = score();
        if (better(s, best)) {
          best = s;
          improved = true;
        } else {
          choice[i] = prev;
        }
      }
    }
  }
  racers.forEach((team, i) => { team.color = options[i][choice[i]]; });
}

function valueAt(series, t) {
  const i = Math.floor(t);
  if (i >= series.length - 1) return series[series.length - 1];
  return series[i] + (series[i + 1] - series[i]) * (t - i);
}

// Membership is sampled finely so a team enters/leaves at the moment its line actually
// crosses into or out of the top six, not only on whole weeks.
const RACE_STEP = 0.02;
const FADE_IN = 0.2;
const FADE_OUT = 0.35;

// Two teams trading 6th place would otherwise flicker in and out of the board.
// Fill short gaps (stay on through a brief dip), then drop blink-length appearances —
// except at the very start or end, which keeps the opening and closing boards full.
const MAX_GAP_WEEKS = 0.5;
const MIN_RUN_WEEKS = 0.3;

function smoothMembership(m) {
  const n = m.length;
  const runs = (on, handle) => {
    for (let s = 0; s < n; ) {
      if (Boolean(m[s]) !== on) { s++; continue; }
      let e = s;
      while (e < n && Boolean(m[e]) === on) e++;
      handle(s, e);
      s = e;
    }
  };
  const maxGap = Math.round(MAX_GAP_WEEKS / RACE_STEP);
  const minRun = Math.round(MIN_RUN_WEEKS / RACE_STEP);
  runs(false, (s, e) => { if (s > 0 && e < n && e - s < maxGap) m.fill(1, s, e); });
  runs(true, (s, e) => { if (s > 0 && e < n && e - s < minRun) m.fill(0, s, e); });
}

function computeRace(data) {
  const last = data.checkpoints.length - 1;
  const samples = Math.round(last / RACE_STEP) + 1;
  const teams = Object.entries(data.teams).map(([abbr, team]) => ({ abbr, ...team }));
  const member = new Map(teams.map((t) => [t.abbr, new Uint8Array(samples)]));

  for (let s = 0; s < samples; s++) {
    const t = Math.min(last, s * RACE_STEP);
    const ranked = teams
      .map((team) => [team.abbr, valueAt(team.super_bowl, t)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, LOMBARDI_TOP_N);
    for (const [abbr] of ranked) member.get(abbr)[s] = 1;
  }

  let maxVisible = 0.01;
  for (const team of teams) {
    const m = member.get(team.abbr);
    smoothMembership(m);
    m.forEach((on, s) => {
      if (on) maxVisible = Math.max(maxVisible, valueAt(team.super_bowl, Math.min(last, s * RACE_STEP)));
    });
  }

  const racers = teams
    .filter((team) => member.get(team.abbr).some(Boolean))
    .map((team) => {
      const m = member.get(team.abbr);
      // runStart[s]: sample where the stretch containing s began (-1 if out at s).
      // lastIn[s]: most recent sample <= s where the team was in the top six (-1 if never).
      const runStart = new Int32Array(samples);
      const lastIn = new Int32Array(samples);
      let start = -1;
      let seen = -1;
      for (let s = 0; s < samples; s++) {
        if (m[s]) {
          if (s === 0 || !m[s - 1]) start = s;
          seen = s;
          runStart[s] = start;
        } else {
          runStart[s] = -1;
        }
        lastIn[s] = seen;
      }
      return { ...team, member: m, runStart, lastIn, peak: Math.max(...team.super_bowl) };
    })
    .sort((a, b) => b.peak - a.peak);

  const current = racers
    .filter((r) => r.member[samples - 1])
    .sort((a, b) => b.super_bowl[last] - a.super_bowl[last]);
  return { racers, current, samples, maxVisible };
}

// Where a racer's line should be drawn at time t, and how opaque it is (null = hidden).
function racerSpan(racer, t, samples) {
  const s = Math.min(samples - 1, Math.max(0, Math.round(t / RACE_STEP)));
  if (racer.member[s]) {
    const start = racer.runStart[s];
    const from = start * RACE_STEP;
    const opacity = start === 0 ? 1 : Math.min(1, (t - from) / FADE_IN);
    return { from, to: t, opacity, active: true };
  }
  const last = racer.lastIn[s];
  if (last < 0) return null;
  const exitT = (last + 1) * RACE_STEP;
  const faded = (t - exitT) / FADE_OUT;
  if (faded >= 1) return null;
  return { from: racer.runStart[last] * RACE_STEP, to: exitT, opacity: Math.max(0, 1 - faded), active: false };
}

function buildLombardiChart() {
  const plot = document.getElementById("lombardi-plot");
  const { data, race } = lombardi;
  const width = Math.max(300, plot.clientWidth);
  const height = Math.round(Math.min(380, Math.max(250, width * 0.46)));
  const narrow = width < 520;
  const m = { left: 40, right: narrow ? 74 : 92, top: 18, bottom: 28 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const n = data.checkpoints.length;

  // Fixed scale for the whole animation, so movement is real movement, not rescaling.
  const step = [0.02, 0.05, 0.1, 0.2, 0.25].find((s) => race.maxVisible / s <= 5) || 0.25;
  const yMax = Math.ceil(race.maxVisible / step) * step;
  // Linear in t, so fractional weeks land between checkpoints.
  const x = (t) => m.left + (n === 1 ? plotW / 2 : (t * plotW) / (n - 1));
  const y = (v) => m.top + plotH * (1 - v / yMax);

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": `Super Bowl odds race. Current top six: ${race.current.map((t) => t.abbr).join(", ")}` });

  for (let v = 0; v <= yMax + 1e-9; v += step) {
    svg.appendChild(svgEl("line", { x1: m.left, x2: width - m.right + 8, y1: y(v), y2: y(v), stroke: "var(--border)" }));
    const label = svgEl("text", { x: m.left - 8, y: y(v) + 4, "text-anchor": "end", class: "chart-axis" });
    label.textContent = `${Math.round(v * 100)}%`;
    svg.appendChild(label);
  }

  const minLabelGap = 40;
  const every = Math.max(1, Math.ceil(minLabelGap / (n > 1 ? plotW / (n - 1) : plotW)));
  data.checkpoints.forEach((cp, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const label = svgEl("text", { x: x(i), y: height - 8, "text-anchor": "middle", class: "chart-axis" });
    label.textContent = cp;
    svg.appendChild(label);
  });

  const markerR = narrow ? 12 : 15;
  // Lowest peak drawn first, so the strongest contenders sit on top where lines cross.
  const teams = [...race.racers].reverse().map((team) => {
    // Outer group: hover/pin dimming (CSS). Inner group: enter/exit fade (inline opacity).
    const group = svgEl("g", { class: "lombardi-team", "data-team": team.abbr });
    const fade = svgEl("g");
    const line = svgEl("polyline", { fill: "none", stroke: team.color, "stroke-width": 2.5,
      "stroke-linejoin": "round", "stroke-linecap": "round" });
    const dots = team.super_bowl.map((v, i) => {
      const dot = svgEl("circle", { cx: x(i), cy: y(v), r: 3, fill: team.color });
      const title = svgEl("title");
      title.textContent = `${team.abbr} · ${data.checkpoints[i]}: ${oddsLabel(v)} to win the Super Bowl`;
      dot.appendChild(title);
      return dot;
    });
    const leader = svgEl("line", { stroke: team.color, "stroke-width": 1.5, opacity: 0.55 });
    const ring = svgEl("circle", { r: markerR, fill: "var(--bg-surface)", stroke: team.color, "stroke-width": 2 });
    const logo = svgEl("image", { href: logoPath(team.abbr), width: markerR * 1.5, height: markerR * 1.5 });
    const value = svgEl("text", { class: "lombardi-value" });
    fade.append(line, ...dots, leader, ring, logo, value);
    group.appendChild(fade);
    group.addEventListener("mouseenter", () => setLombardiHover(team.abbr));
    group.addEventListener("mouseleave", () => setLombardiHover(null));
    svg.appendChild(group);
    return { team, group, fade, line, dots, leader, ring, logo, value };
  });

  plot.replaceChildren(svg);
  lombardi.chart = { svg, teams, x, y, n, markerR, top: m.top, bottom: height - m.bottom };
  lombardi.builtWidth = plot.clientWidth;
  updateLombardi(lombardi.t);
  applyLombardiFocus();
}

function updateLombardi(t) {
  const { teams, x, y, markerR, top, bottom } = lombardi.chart;
  const { samples } = lombardi.race;

  const shown = [];
  for (const entry of teams) {
    const span = racerSpan(entry.team, t, samples);
    if (!span) {
      entry.group.style.display = "none";
      continue;
    }
    entry.group.style.display = "";
    entry.fade.style.opacity = span.opacity;

    const series = entry.team.super_bowl;
    const points = [`${x(span.from)},${y(valueAt(series, span.from))}`];
    for (let i = Math.floor(span.from) + 1; i < span.to; i++) points.push(`${x(i)},${y(series[i])}`);
    points.push(`${x(span.to)},${y(valueAt(series, span.to))}`);
    entry.line.setAttribute("points", points.join(" "));
    entry.dots.forEach((dot, i) => {
      dot.style.display = i >= span.from - 1e-6 && i <= span.to + 1e-6 ? "" : "none";
    });

    // A team that just dropped out loses its logo at once — only its line fades away —
    // so it never sits on top of the contenders still in the race.
    for (const el of [entry.leader, entry.ring, entry.logo, entry.value]) {
      el.style.display = span.active ? "" : "none";
    }
    if (!span.active) continue;

    const v = valueAt(series, span.to);
    shown.push({ entry, v, tipX: x(span.to), tipY: y(v), labelY: y(v) });
  }

  // Keep the contenders' logos from stacking on each other when their odds are close.
  const gap = markerR * 2 + 4;
  const ordered = [...shown].sort((a, b) => a.tipY - b.tipY);
  ordered.forEach((tip, i) => {
    tip.labelY = Math.max(tip.tipY, i === 0 ? top + markerR : ordered[i - 1].labelY + gap);
  });
  for (let i = ordered.length - 1; i >= 0; i--) {
    const limit = i === ordered.length - 1 ? bottom - markerR : ordered[i + 1].labelY - gap;
    ordered[i].labelY = Math.min(ordered[i].labelY, limit);
  }

  for (const { entry, v, tipX, tipY, labelY } of shown) {
    const markerX = tipX + markerR + 8;
    entry.leader.setAttribute("x1", tipX);
    entry.leader.setAttribute("y1", tipY);
    entry.leader.setAttribute("x2", markerX - markerR);
    entry.leader.setAttribute("y2", labelY);
    entry.ring.setAttribute("cx", markerX);
    entry.ring.setAttribute("cy", labelY);
    entry.logo.setAttribute("x", markerX - markerR * 0.75);
    entry.logo.setAttribute("y", labelY - markerR * 0.75);
    entry.value.setAttribute("x", markerX + markerR + 5);
    entry.value.setAttribute("y", labelY + 4);
    entry.value.textContent = oddsLabel(v);
  }

  const { checkpoints } = lombardi.data;
  const label = checkpoints[Math.min(checkpoints.length - 1, Math.round(t))];
  document.getElementById("lombardi-week").textContent = label;
  const scrub = document.getElementById("lombardi-scrub");
  scrub.value = t;
  scrub.setAttribute("aria-valuetext", label);
}

function setPlayLabel() {
  const btn = document.getElementById("lombardi-play");
  const atEnd = lombardi.t >= lombardi.chart.n - 1 - 1e-6;
  btn.textContent = lombardi.playing ? "Pause" : atEnd && lombardi.hasPlayed ? "Replay" : "Play";
}

function playLombardi() {
  const last = lombardi.chart.n - 1;
  if (last === 0) return;
  if (lombardi.t >= last - 1e-6) lombardi.t = 0;
  lombardi.playing = true;
  lombardi.hasPlayed = true;
  lombardi.lastTs = null;
  setPlayLabel();

  const tick = (ts) => {
    if (!lombardi.playing) return;
    if (lombardi.lastTs === null) {
      lombardi.lastTs = ts;
    } else if (reduceMotion.matches) {
      // Reduced motion: jump a whole week at a time instead of gliding.
      if (ts - lombardi.lastTs >= MS_PER_WEEK) {
        lombardi.t = Math.min(last, Math.floor(lombardi.t) + 1);
        lombardi.lastTs = ts;
      }
    } else {
      lombardi.t = Math.min(last, lombardi.t + (ts - lombardi.lastTs) / MS_PER_WEEK);
      lombardi.lastTs = ts;
    }
    updateLombardi(lombardi.t);
    if (lombardi.t >= last) {
      pauseLombardi();
      return;
    }
    lombardi.raf = requestAnimationFrame(tick);
  };
  updateLombardi(lombardi.t);
  lombardi.raf = requestAnimationFrame(tick);
}

function pauseLombardi() {
  lombardi.playing = false;
  cancelAnimationFrame(lombardi.raf);
  setPlayLabel();
}

function setLombardiHover(abbr) {
  lombardi.hovered = abbr;
  applyLombardiFocus();
}

function applyLombardiFocus() {
  const active = lombardi.hovered || lombardi.pinned;
  const plot = document.getElementById("lombardi-plot");
  plot.classList.toggle("has-focus", Boolean(active));
  for (const entry of lombardi.chart.teams) {
    const on = entry.team.abbr === active;
    entry.group.classList.toggle("is-focused", on);
    if (on) entry.group.parentNode.appendChild(entry.group);
  }
  document.querySelectorAll(".lombardi-row").forEach((row) => {
    row.classList.toggle("is-focused", row.dataset.team === active);
    row.setAttribute("aria-pressed", String(row.dataset.team === lombardi.pinned));
  });
}

function renderLombardiLegend() {
  const { data } = lombardi;
  const top = lombardi.race.current;
  const last = data.checkpoints.length - 1;
  const legend = document.getElementById("lombardi-legend");
  legend.replaceChildren();

  for (const team of top) {
    const now = team.super_bowl[last];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "lombardi-row";
    row.dataset.team = team.abbr;
    row.style.setProperty("--team", team.color);

    let delta = "";
    let deltaText = "";
    if (last > 0) {
      const d = (now - team.super_bowl[last - 1]) * 100;
      const cls = d >= 0.05 ? "is-up" : d <= -0.05 ? "is-down" : "";
      const arrow = d >= 0.05 ? "▲" : d <= -0.05 ? "▼" : "–";
      delta = `<span class="row-delta ${cls}">${arrow} ${Math.abs(d).toFixed(1)}</span> since ${data.checkpoints[last - 1]}`;
      deltaText = `${d >= 0 ? "up" : "down"} ${Math.abs(d).toFixed(1)} points since ${data.checkpoints[last - 1]}`;
    }
    const sos = team.sos_remaining_rank ? `${ordinal(team.sos_remaining_rank)}-hardest schedule left` : "Schedule complete";

    row.setAttribute("aria-label",
      `${team.name}, ${team.record}: ${oddsLabel(now)} to win the Super Bowl${deltaText ? `, ${deltaText}` : ""}. ` +
      `Playoff odds ${oddsLabel(team.playoff[last])}. Toggle to highlight on the chart.`);
    row.innerHTML = `
      <img class="row-logo" src="${logoPath(team.abbr)}" alt="" onerror="this.style.visibility='hidden'">
      <span class="row-main">
        <span class="row-top">
          <span class="row-abbr">${team.abbr}</span>
          <span class="row-record">${team.record}</span>
          <span class="row-odds">${oddsLabel(now)}</span>
        </span>
        <span class="row-sub">${delta}</span>
        <span class="row-sub">Playoffs ${oddsLabel(team.playoff[last])} · ${team.proj_wins.toFixed(1)} proj W · ${sos}</span>
      </span>
    `;
    row.addEventListener("mouseenter", () => setLombardiHover(team.abbr));
    row.addEventListener("mouseleave", () => setLombardiHover(null));
    row.addEventListener("click", () => {
      lombardi.pinned = lombardi.pinned === team.abbr ? null : team.abbr;
      applyLombardiFocus();
    });
    legend.appendChild(row);
  }
}

async function loadLombardi() {
  const res = await fetch("data/lombardi.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const last = data.checkpoints.length - 1;

  lombardi.data = data;
  lombardi.race = computeRace(data);
  assignRaceColors(lombardi.race.racers);
  lombardi.t = last;

  document.getElementById("lombardi").hidden = false;
  document.getElementById("lombardi-sims").textContent = data.n_sims.toLocaleString();
  document.getElementById("lombardi-meta").textContent =
    `${data.n_sims.toLocaleString()} sims · ${data.checkpoints[last]}`;

  const scrub = document.getElementById("lombardi-scrub");
  scrub.max = last;
  scrub.disabled = last === 0;
  scrub.addEventListener("input", () => {
    if (lombardi.playing) pauseLombardi();
    lombardi.t = Number(scrub.value);
    updateLombardi(lombardi.t);
    setPlayLabel();
  });
  // Dragging is smooth (step 0.01), but the keyboard jumps a whole week per press.
  scrub.addEventListener("keydown", (e) => {
    const moves = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -1, PageUp: 1 };
    let target;
    if (e.key in moves) {
      target = moves[e.key] < 0 ? Math.ceil(lombardi.t - 1e-6) - 1 : Math.floor(lombardi.t + 1e-6) + 1;
    } else if (e.key === "Home") {
      target = 0;
    } else if (e.key === "End") {
      target = last;
    } else {
      return;
    }
    e.preventDefault();
    if (lombardi.playing) pauseLombardi();
    lombardi.t = Math.max(0, Math.min(last, target));
    updateLombardi(lombardi.t);
    setPlayLabel();
  });
  scrub.setAttribute("aria-valuetext", data.checkpoints[last]);

  const playBtn = document.getElementById("lombardi-play");
  playBtn.disabled = last === 0;
  playBtn.addEventListener("click", () => (lombardi.playing ? pauseLombardi() : playLombardi()));

  renderLombardiLegend();
  buildLombardiChart();
  setPlayLabel();

  new ResizeObserver(() => {
    const plot = document.getElementById("lombardi-plot");
    if (Math.abs(plot.clientWidth - lombardi.builtWidth) > 4) buildLombardiChart();
  }).observe(document.getElementById("lombardi-plot"));
}

loadLombardi().catch((err) => console.error(err));

initConsole().catch((err) => {
  console.error(err);
  document.getElementById("console-status").textContent = "Couldn't load the season manifest.";
});

loadPerformance().catch((err) => console.error(err));
