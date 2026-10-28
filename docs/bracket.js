const LOGO_DIR = "assets/logos";

let teamsMeta = {};
let odds = {};

function logoPath(team) {
  return `${LOGO_DIR}/${team}.png`;
}

function pct(p) {
  if (p === null || p === undefined || p <= 0) return "—";
  if (p < 0.005) return "<1%";
  if (p > 0.995) return ">99%";
  return `${Math.round(p * 100)}%`;
}

function heat(p) {
  return `background: rgba(0, 229, 255, ${(Math.min(1, p) * 0.28).toFixed(3)})`;
}

function teamRow(team, seed, prob, { isOut = false, isBye = false } = {}) {
  const color = teamsMeta[team]?.color || "transparent";
  const seedOdds = seed ? odds[team]?.seed_probs?.[seed - 1] : null;
  const title = seedOdds != null ? `${teamsMeta[team]?.name}: ${pct(seedOdds)} chance of being the ${seed} seed` : "";
  let probHtml = `<span class="bk-prob is-bye">BYE</span>`;
  if (!isBye) {
    const cls = isOut ? "" : prob >= 0.6 ? "value-lime" : "value-cyan";
    probHtml = `<span class="bk-prob ${cls}">${Math.round(prob * 100)}%</span>`;
  }
  return `
    <div class="bk-team${isOut ? " is-out" : ""}" style="--team:${color}" title="${title}">
      <span class="bk-seed">${seed ?? ""}</span>
      <img class="bk-logo" src="${logoPath(team)}" alt="" onerror="this.style.visibility='hidden'">
      <span class="bk-abbr">${team}</span>
      <span class="bk-rec">${odds[team]?.record ?? ""}</span>
      ${probHtml}
    </div>`;
}

function gameCard(game) {
  const label = `${game.home} vs ${game.away}: ${game.home} ${Math.round(game.p_home * 100)}%, ` +
    `${game.away} ${Math.round((1 - game.p_home) * 100)}%. Projected winner ${game.winner}.`;
  return `
    <div class="bk-game" role="group" aria-label="${label}">
      ${teamRow(game.home, game.home_seed, game.p_home, { isOut: game.winner !== game.home })}
      ${teamRow(game.away, game.away_seed, 1 - game.p_home, { isOut: game.winner !== game.away })}
    </div>`;
}

function round(title, gamesHtml) {
  return `
    <div class="bk-round">
      <div class="bk-round-title">${title}</div>
      <div class="bk-round-games">${gamesHtml}</div>
    </div>`;
}

function confBlock(conf, data) {
  const c = data.conferences[conf];
  const top = c.seeds[0].team;
  const [wildCard, divisional, championship] = c.rounds;
  const bye = `
    <div class="bk-game" role="group" aria-label="${top}, 1 seed, first-round bye">
      ${teamRow(top, 1, null, { isBye: true })}
    </div>`;
  return `
    <div class="conf-block is-${conf.toLowerCase()}">
      <h3>${conf}</h3>
      <div class="conf-bracket">
        ${round("Wild Card", bye + wildCard.games.map(gameCard).join(""))}
        ${round("Divisional", divisional.games.map(gameCard).join(""))}
        ${round("Conf. Championship", championship.games.map(gameCard).join(""))}
      </div>
    </div>`;
}

function superBowlBlock(data) {
  const sb = data.super_bowl;
  const seedOf = (conf, team) => data.conferences[conf].seeds.find((s) => s.team === team)?.seed;
  const champ = sb.winner;
  const label = `Super Bowl: ${sb.afc} ${Math.round(sb.p_afc * 100)}%, ${sb.nfc} ${Math.round((1 - sb.p_afc) * 100)}%.`;
  return `
    <div class="sb-block">
      <h3>SUPER BOWL</h3>
      <div class="bk-game" role="group" aria-label="${label}">
        ${teamRow(sb.afc, seedOf("AFC", sb.afc), sb.p_afc, { isOut: champ !== sb.afc })}
        ${teamRow(sb.nfc, seedOf("NFC", sb.nfc), 1 - sb.p_afc, { isOut: champ !== sb.nfc })}
      </div>
      <div class="sb-champ" style="--team:${teamsMeta[champ]?.color || "var(--accent)"}">
        <img src="${logoPath(champ)}" alt="">
        <span class="sb-champ-name">${teamsMeta[champ]?.name ?? champ}</span>
        <span class="sb-champ-odds">Projected champion &middot; ${pct(odds[champ].super_bowl)} to actually win it</span>
      </div>
    </div>`;
}

function exactLabel(p, nSims) {
  if (p <= 0) return `under ${(100 / nSims).toFixed(2)}%`;
  return `${(p * 100).toFixed(2)}%`;
}

function renderIntro(data) {
  const afc = exactLabel(data.conferences.AFC.exact_seeding_prob, data.n_sims);
  const nfc = exactLabel(data.conferences.NFC.exact_seeding_prob, data.n_sims);
  document.getElementById("bracket-meta").textContent = `${data.n_sims.toLocaleString()} sims · as of ${data.as_of}`;
  document.getElementById("bracket-intro").innerHTML =
    `The single likeliest bracket: the most likely winner of each division takes seeds 1–4, the likeliest wild cards ` +
    `take 5–7, and in every game the model's favorite advances. Percentages are each matchup's win probability; ` +
    `each team's odds of landing its seed are in the table below. Chance this exact seeding happens: ` +
    `<strong>${exactLabel(data.exact_bracket_prob, data.n_sims)}</strong> for the whole field ` +
    `(AFC ${afc}, NFC ${nfc}) — which is exactly why the <a href="#odds-section">odds table</a> below is the real answer.`;
}

function oddsTable(conf, data) {
  const seeded = data.conferences[conf].seeds.map((s) => s.team);
  const rest = Object.entries(odds)
    .filter(([team, o]) => o.conf === conf && !seeded.includes(team))
    .sort((a, b) => b[1].playoff - a[1].playoff)
    .map(([team]) => team);
  const order = [...seeded, ...rest];

  const cols = [
    ["playoff", "Playoffs"],
    ["divisional", "Div Rd"],
    ["conf_game", "Conf Gm"],
    ["conf_title", "Reach SB"],
    ["super_bowl", "Win SB"],
  ];

  const rows = order.map((team, i) => {
    const o = odds[team];
    const seed = i < seeded.length ? i + 1 : null;
    const seedCell = seed ? `<td>${seed}</td><td>${pct(o.seed_probs[seed - 1])}</td>` : `<td class="muted-cell">—</td><td class="muted-cell">—</td>`;
    return `
      <tr${i === seeded.length - 1 ? ' class="is-cutline"' : ""}>
        <td class="team-col">
          <span class="team-cell">
            <img src="${logoPath(team)}" alt="" onerror="this.style.visibility='hidden'">${team}
          </span>
        </td>
        <td>${o.record}</td>
        <td>${o.proj_wins.toFixed(1)}</td>
        ${seedCell}
        ${cols.map(([key]) => `<td style="${heat(o[key])}">${pct(o[key])}</td>`).join("")}
      </tr>`;
  });

  return `
    <div>
      <h3>${conf}</h3>
      <div class="table-scroll">
        <table class="odds-table">
          <thead>
            <tr>
              <th class="team-col" scope="col">Team</th>
              <th scope="col">Rec</th>
              <th scope="col" title="Projected wins, averaged across all simulations">Proj W</th>
              <th scope="col">Seed</th>
              <th scope="col" title="Chance of landing exactly this seed">Seed odds</th>
              ${cols.map(([, label]) => `<th scope="col">${label}</th>`).join("")}
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    </div>`;
}

async function loadBracket() {
  const res = await fetch("data/bracket.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  teamsMeta = data.teams;
  odds = data.odds;

  renderIntro(data);
  document.getElementById("bracket").innerHTML =
    confBlock("AFC", data) + superBowlBlock(data) + confBlock("NFC", data);
  document.getElementById("odds-grid").innerHTML = oddsTable("AFC", data) + oddsTable("NFC", data);
}

loadBracket().catch((err) => {
  console.error(err);
  document.getElementById("bracket-intro").textContent =
    "Couldn't load the playoff simulation — it's generated by the weekly update and may not exist yet.";
});
