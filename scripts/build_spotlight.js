/**
 * Build spotlight data from CFBD (and ESPN headshots where available).
 * Zero external deps. Requires Node >=18.
 *
 * Env:
 *   CFBD_KEY (required) — bearer token from CollegeFootballData
 *   TEAM      (default: "Kentucky")
 *   YEAR      (default: current UTC year)
 *
 * Output (in /data):
 *   - roster.json                            (full roster with best-effort headshots)
 *   - spotlight_offense_last.json            (top-3 from last completed game)
 *   - spotlight_defense_last.json
 *   - spotlight_offense_season.json          (top-3 cumulative season)
 *   - spotlight_defense_season.json
 *   - spotlight_featured.json                (hero card selection; 1–2 players)
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "..", "data");

const CFBD_KEY = process.env.CFBD_KEY;
const TEAM = process.env.TEAM || "Kentucky";
const YEAR = +(process.env.YEAR || new Date().getUTCFullYear());

if (!CFBD_KEY) {
  console.error("CFBD_KEY missing — add it as a repo secret.");
  process.exit(1);
}

const CFBD = "https://api.collegefootballdata.com";

async function cfbd(endpoint, params = {}) {
  const url = new URL(CFBD + endpoint);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CFBD_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CFBD ${endpoint} ${res.status}: ${text}`);
  }
  return res.json();
}

// --- helpers -----------------------------------------------------------------
const OFF_POS = new Set(["QB","RB","TB","FB","HB","WR","TE","OL","C","G","T"]);
const DEF_POS = new Set(["DL","DE","DT","EDGE","NT","LB","MLB","OLB","DB","CB","S","FS","SS","STAR","NICKEL","NB"]);

function byNumberDesc(key) {
  return (a, b) => (b[key] ?? 0) - (a[key] ?? 0);
}
function sumBy(rows, key) {
  return rows.reduce((acc, r) => acc + (+r[key] || 0), 0);
}
function safeNum(x) {
  const n = +x;
  return Number.isFinite(n) ? n : 0;
}

// Scoring utilities (quick—but sensible—MVP formulas)
function offenseScore(s) {
  // s: aggregate of pass/rush/rec etc (game or season)
  const pass = 0.07 * safeNum(s.passingYards) + 4.0 * safeNum(s.passingTD) - 45 * safeNum(s.interceptions);
  const rush = 0.25 * safeNum(s.rushingYards) + 6.0 * safeNum(s.rushingTD) + 0.05 * safeNum(s.carries);
  const rec  = 0.30 * safeNum(s.receivingYards) + 6.0 * safeNum(s.receivingTD) + 0.3 * safeNum(s.receptions);
  const bonus= 2.0 * safeNum(s.twoPt); // tiny bump
  return pass + rush + rec + bonus;
}
function defenseScore(s) {
  const tackles = 0.7 * safeNum(s.tackles) + 0.8 * safeNum(s.soloTackles);
  const havoc   = 5.0 * safeNum(s.sacks) + 3.0 * safeNum(s.tfl);
  const ball    = 6.0 * safeNum(s.interceptions) + 3.0 * safeNum(s.passesDefended) +
                  4.0 * safeNum(s.forcedFumbles) + 3.0 * safeNum(s.fumblesRecovered);
  const score   = tackles + havoc + ball;
  return score;
}

// Map score -> 0..100 percentile-ish scaler (robust to small samples)
function scale100(val, min, max) {
  if (!Number.isFinite(val)) return 0;
  if (max <= min) return 50;
  const z = (val - min) / (max - min);
  return Math.round(100 * Math.max(0, Math.min(1, z)));
}
function toLetter(percent) {
  // with +/- bands
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  let letter, mod = "";
  if (p >= 93) letter = "A"; else
  if (p >= 85) letter = "A"; else
  if (p >= 77) letter = "B"; else
  if (p >= 70) letter = "C"; else
  if (p >= 63) letter = "D"; else
                letter = "F";

  const band = p % 7; // 0..6 bands inside each letter bucket
  if (letter !== "A" && letter !== "F") {
    if (band >= 5) mod = "+";
    else if (band <= 1) mod = "-";
  } else if (letter === "A") {
    if (p < 89) mod = "-";
    else if (p >= 97) mod = "+";
  }
  return { letter, mod, percent: p };
}

function headshotUrl(espnId) {
  if (espnId) return `https://a.espncdn.com/i/headshots/college-football/players/full/${espnId}.png`;
  return "https://ui-avatars.com/api/?name=UK&background=003087&color=fff&bold=true";
}

// Write JSON helper
async function writeJSON(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const fp = path.join(DATA_DIR, file);
  await fs.writeFile(fp, JSON.stringify(data, null, 2), "utf8");
  console.log("wrote", file, `(${Array.isArray(data) ? data.length : Object.keys(data||{}).length})`);
}

// --- fetch CFBD datasets -----------------------------------------------------
async function loadRoster() {
  // https://api.collegefootballdata.com/roster?team=Kentucky&year=2025
  const rows = await cfbd("/roster", { team: TEAM, year: YEAR });
  // CFBD roster rows: id, athleteId, firstName, lastName, team, position, jersey, height, weight, year, homeCity, homeState, ... may include "espnId" in some datasets; if not, null.
  const players = rows.map(r => ({
    id: r.athleteId || r.id || undefined,
    name: (r.firstName && r.lastName) ? `${r.firstName} ${r.lastName}` : r.name,
    firstName: r.firstName || undefined,
    lastName: r.lastName || undefined,
    number: r.jersey || r.jerseyNumber || undefined,
    position: r.position || r.pos || undefined,
    class: r.year || undefined,
    height: r.height || undefined,
    weight: r.weight || undefined,
    hometown: [r.homeCity, r.homeState].filter(Boolean).join(", ") || undefined,
    espnId: r.espnId || undefined,
    headshot: headshotUrl(r.espnId),
  }));
  return players;
}

async function lastCompletedGameId() {
  // https://api.collegefootballdata.com/games?year=2025&team=Kentucky&seasonType=regular
  const gamesReg = await cfbd("/games", { year: YEAR, team: TEAM, seasonType: "regular" });
  const gamesPost= await cfbd("/games", { year: YEAR, team: TEAM, seasonType: "postseason" });
  const games = [...gamesReg, ...gamesPost].filter(g => g.completed || g.status === "final" || /final/i.test(g.notes||""));
  if (!games.length) return null;
  // sort by start date/time
  games.sort((a,b) => new Date(a.start_date||a.startDate||a.start) - new Date(b.start_date||b.startDate||b.start));
  const g = games[games.length - 1];
  return g.id || g.game_id || g.gameId || g.cid || null;
}

async function loadPlayerGameStats(gameId) {
  // https://api.collegefootballdata.com/player/game?year=2025&team=Kentucky&gameId=40123456789
  if (!gameId) return [];
  const rows = await cfbd("/player/game", { year: YEAR, team: TEAM, gameId });
  return rows;
}
async function loadPlayerSeasonStats() {
  // https://api.collegefootballdata.com/player/season?year=2025&team=Kentucky
  const rows = await cfbd("/player/season", { year: YEAR, team: TEAM });
  return rows;
}

// Normalize CFBD stat rows into a common shape we can score
function normalizeStats(rows) {
  const byPlayer = new Map();
  for (const r of rows) {
    const id = r.athleteId || r.playerId || r.id || `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
    if (!id) continue;
    const cur = byPlayer.get(id) || {
      id,
      name: r.player || r.name || `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
      position: r.position || r.pos || undefined,
      number: r.jersey || r.jerseyNumber || undefined,
      // offense
      passingYards: 0, passingTD: 0, interceptions: 0,
      rushingYards: 0, rushingTD: 0, carries: 0,
      receivingYards: 0, receivingTD: 0, receptions: 0,
      twoPt: 0,
      // defense
      tackles: 0, soloTackles: 0, sacks: 0, tfl: 0,
      passesDefended: 0, interceptionsDef: 0, forcedFumbles: 0, fumblesRecovered: 0,
    };
    // Offense fields (CFBD names vary by feed type)
    cur.passingYards    += safeNum(r.passingYards ?? r.passYards);
    cur.passingTD       += safeNum(r.passingTD ?? r.passTD);
    cur.interceptions   += safeNum(r.interceptions ?? r.passInt);
    cur.rushingYards    += safeNum(r.rushingYards ?? r.rushYards);
    cur.rushingTD       += safeNum(r.rushingTD ?? r.rushTD);
    cur.carries         += safeNum(r.carries ?? r.rushAttempts);
    cur.receivingYards  += safeNum(r.receivingYards ?? r.recYards);
    cur.receivingTD     += safeNum(r.receivingTD ?? r.recTD);
    cur.receptions      += safeNum(r.receptions ?? r.rec);
    cur.twoPt           += safeNum(r.twoPointConv ?? r.twoPt ?? r.twoPoint);

    // Defense fields
    cur.tackles         += safeNum(r.tackles);
    cur.soloTackles     += safeNum(r.soloTackles ?? r.solo ?? r.soloTackles);
    cur.sacks           += safeNum(r.sacks);
    cur.tfl             += safeNum(r.tfl ?? r.tacklesForLoss);
    cur.passesDefended  += safeNum(r.passesDefended ?? r.pd ?? r.breakups);
    cur.interceptionsDef+= safeNum(r.interceptions ?? r.interceptionsThrown); // prefer defensive INTs, CFBD field is 'interceptions'
    cur.forcedFumbles   += safeNum(r.forcedFumbles ?? r.ff);
    cur.fumblesRecovered+= safeNum(r.fumblesRecovered ?? r.fr);

    byPlayer.set(id, cur);
  }
  return [...byPlayer.values()];
}

function pickTop3(rows, kind /*"offense"|"defense"*/) {
  const scored = rows.map(r => {
    const score = kind === "offense" ? offenseScore(r) : defenseScore(r);
    return { ...r, score };
  });
  // compute scaling
  const max = Math.max(...scored.map(s => s.score), 0);
  const min = Math.min(...scored.map(s => s.score), 0);
  const withGrade = scored
    .sort((a,b) => b.score - a.score)
    .slice(0, 3)
    .map(s => {
      const pct = scale100(s.score, min, max);
      const g = toLetter(pct);
      return { ...s, grade: g.letter + (g.mod || ""), percent: g.percent };
    });
  return withGrade;
}

function rosterSubset(players, idsWanted) {
  const set = new Set(idsWanted);
  return players.filter(p => set.has(p.id) || set.has(p.name));
}

// --- main --------------------------------------------------------------------
async function run() {
  console.log("TEAM:", TEAM, "YEAR:", YEAR);
  const roster = await loadRoster();

  // Write roster
  await writeJSON("roster.json", { team: TEAM, year: YEAR, count: roster.length, players: roster });

  // SEASON leaders
  const seasonStatsRows = await loadPlayerSeasonStats();
  const season = normalizeStats(seasonStatsRows);
  const seasonOff = season.filter(p => OFF_POS.has(p.position));
  const seasonDef = season.filter(p => DEF_POS.has(p.position));
  const topSeasonOff = pickTop3(seasonOff, "offense");
  const topSeasonDef = pickTop3(seasonDef, "defense");

  // LAST GAME leaders
  const gid = await lastCompletedGameId();
  const gameRows = await loadPlayerGameStats(gid);
  const last = normalizeStats(gameRows);
  const lastOff = last.filter(p => OFF_POS.has(p.position));
  const lastDef = last.filter(p => DEF_POS.has(p.position));
  const topLastOff = pickTop3(lastOff, "offense");
  const topLastDef = pickTop3(lastDef, "defense");

  // Attach headshots (if CFBD lacked espnId, keep generic avatar)
  const byName = new Map(roster.map(r => [r.name, r]));
  const attach = (arr) => arr.map(x => {
    const hit = byName.get(x.name);
    const headshot = hit?.headshot || headshotUrl(hit?.espnId);
    const number = x.number ?? hit?.number;
    const position = x.position ?? hit?.position;
    return { ...x, number, position, headshot, espnId: hit?.espnId };
  });

  // Write spotlight feeds
  await writeJSON("spotlight_offense_season.json", attach(topSeasonOff));
  await writeJSON("spotlight_defense_season.json", attach(topSeasonDef));
  await writeJSON("spotlight_offense_last.json",   attach(topLastOff));
  await writeJSON("spotlight_defense_last.json",   attach(topLastDef));

  // Featured: best of last offense if present, else best season offense
  const featured = (topLastOff[0] || topSeasonOff[0]) ? [attach([topLastOff[0] || topSeasonOff[0]])[0]] : [];
  await writeJSON("spotlight_featured.json", featured);

  console.log("done");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
