/**
 * Hashmark Spotlight Builder (v3)
 * - Pulls CFBD game + player stats for TEAM/YEAR
 * - Scores players (offense/defense), guarantees Top‑3 for Last + Season
 * - Merges headshots (ESPN CDN) when available
 * - NEVER publishes empty arrays; preserves last-good JSON if no data
 * - Defensive INTs: uses `interceptionsDef` (NOT offensive interceptions)
 *
 * Usage (CI): node scripts/build_spotlight.js
 * Env: CFBD_KEY (required for live), TEAM (default: Kentucky), YEAR (default: 2025)
 */

import fs from "fs/promises";
import path from "path";
import process from "process";

const TEAM = process.env.TEAM || "Kentucky";
const YEAR = parseInt(process.env.YEAR || "2025", 10);
const DATA_DIR = path.resolve("data");
await fs.mkdir(DATA_DIR, { recursive: true });

// ----------- utilities
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeNum = (x) => (isFinite(+x) ? +x : 0);

function letterFromScore(pct) {
  // pct in [0,100]
  const p = clamp(pct, 0, 100);
  if (p >= 97) return "A+";
  if (p >= 93) return "A";
  if (p >= 90) return "A-";
  if (p >= 87) return "B+";
  if (p >= 83) return "B";
  if (p >= 80) return "B-";
  if (p >= 77) return "C+";
  if (p >= 73) return "C";
  if (p >= 70) return "C-";
  if (p >= 67) return "D+";
  if (p >= 63) return "D";
  if (p >= 60) return "D-";
  return "F";
}

function headshotUrl(espnId) {
  return espnId ? `https://a.espncdn.com/i/headshots/college-football/players/full/${espnId}.png` : null;
}

async function readJson(file) {
  try {
    const buf = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

async function writeJson(file, obj) {
  const out = JSON.stringify(obj, null, 2) + "\n";
  await fs.writeFile(path.join(DATA_DIR, file), out, "utf8");
  console.log(`wrote ${file} (${Array.isArray(obj) ? obj.length : "1"})`);
}

function byScoreDesc(a, b) {
  return (b.score ?? 0) - (a.score ?? 0);
}

// ----------- CFBD fetch (with graceful fallback)
const CFBD = {
  base: "https://api.collegefootballdata.com",
  key: process.env.CFBD_KEY || null,
  async get(route, qs = {}) {
    const url = new URL(this.base + route);
    Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
    const headers = this.key ? { Authorization: `Bearer ${this.key}` } : {};
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${route} -> ${res.status}`);
    return res.json();
  },
};

// ----------- normalize helpers
function normalizeRoster(list) {
  // schema: { id?, name, pos, number?, espnId? }
  return (list || []).map(p => ({
    id: p.id ?? `${p.name}|${p.pos}`,
    name: p.name,
    pos: p.pos,
    number: p.number ?? null,
    espnId: p.espnId ?? null,
  }));
}

function scoreOffense(s) {
  // Light MVP blend – weights are hand-tuned to behave sanely.
  const pass = 0.05 * safeNum(s.passingYards) + 6.0 * safeNum(s.passingTDs) - 3.0 * safeNum(s.interceptions);
  const rush = 0.10 * safeNum(s.rushingYards) + 6.0 * safeNum(s.rushingTDs);
  const rec  = 0.10 * safeNum(s.receivingYards) + 6.0 * safeNum(s.receivingTDs);
  const bonus = 1.0 * safeNum(s.firstDowns || 0); // if available
  return pass + rush + rec + bonus;
}

function scoreDefense(s) {
  // NOTE: use interceptionsDef — defensive picks (not offensive interception throws)
  const tackles = 0.7 * safeNum(s.tackles) + 0.8 * safeNum(s.soloTackles);
  const havoc   = 5.0 * safeNum(s.sacks) + 3.0 * safeNum(s.tfl);
  const ball    = 6.0 * safeNum(s.interceptionsDef) + 4.0 * safeNum(s.passesDefended)
                + 3.0 * safeNum(s.forcedFumbles) + 3.0 * safeNum(s.fumblesRecovered);
  return tackles + havoc + ball;
}

function percentileRank(values, x) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = sorted.findIndex(v => v > x);
  const rank = (idx < 0 ? sorted.length : idx) / sorted.length;
  return clamp(Math.round(rank * 100), 0, 100);
}

// ----------- dataset builders
async function ensureRoster() {
  // If you already curate data/roster.json, we keep it.
  // If missing, build a minimal roster from last known spotlight or fall back to empty.
  const existing = await readJson("roster.json");
  if (existing && Array.isArray(existing.players) && existing.players.length) {
    return existing;
  }
  // Minimal scaffold
  const roster = { team: TEAM, season: YEAR, players: [] };
  await writeJson("roster.json", roster);
  return roster;
}

function formatOffStatline(s) {
  const parts = [];
  if (safeNum(s.passingYards) || safeNum(s.passingTDs) || safeNum(s.interceptions)) {
    parts.push(`CMP-ATT ${s.cmpAtt ?? ""}`, `YDS ${safeNum(s.passingYards)}`, `TD ${safeNum(s.passingTDs)}`, `INT ${safeNum(s.interceptions)}`);
  }
  if (safeNum(s.rushingYards) || safeNum(s.rushingTDs)) {
    parts.push(`RUSH ${safeNum(s.rushingYards)} YDS`, `TD ${safeNum(s.rushingTDs)}`);
  }
  if (safeNum(s.receivingYards) || safeNum(s.receivingTDs)) {
    parts.push(`REC ${safeNum(s.receivingYards)} YDS`, `TD ${safeNum(s.receivingTDs)}`);
  }
  return parts.filter(Boolean).join(" • ");
}

function formatDefStatline(s) {
  const parts = [];
  parts.push(`T ${safeNum(s.tackles)}`, `S ${safeNum(s.sacks)}`, `TFL ${safeNum(s.tfl)}`, `PD ${safeNum(s.passesDefended)}`, `INT ${safeNum(s.interceptionsDef)}`);
  return parts.join(" • ");
}

function shapeEntry(p, side, statline, score, pct, letter) {
  return {
    id: p.id,
    name: p.name,
    pos: p.pos,
    number: p.number ?? null,
    headshot: headshotUrl(p.espnId),
    side,             // "offense" | "defense"
    statline,
    score: Math.round(score * 10) / 10,
    pct: pct,         // 0..100
    letter,           // "B+" etc.
  };
}

async function buildLastGame(roster) {
  // Find most recent completed game
  let games;
  try {
    games = await CFBD.get("/games", { year: YEAR, team: TEAM, seasonType: "regular" });
  } catch (e) {
    console.warn("CFBD /games failed:", e.message);
    return null;
  }
  const done = (games || []).filter(g => g.completed || (g.home_points != null && g.away_points != null));
  if (!done.length) return null;
  const last = done.sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
  const gameId = last.id || last.game_id;
  if (!gameId) return null;

  // Pull player stats for that game
  let gp;
  try {
    gp = await CFBD.get("/games/players", { gameId, team: TEAM });
  } catch (e) {
    console.warn("CFBD /games/players failed:", e.message);
    return null;
  }
  const rows = (gp?.[0]?.players || []).map(row => {
    // normalize fields commonly returned by CFBD
    return {
      name: row.player || row.name,
      pos: row.position || row.pos || "",
      // offense
      passingYards: row.passingYards,
      passingTDs: row.passingTDs,
      interceptions: row.interceptions, // offensive (QB throws)
      cmpAtt: row.completions != null && row.attempts != null ? `${row.completions}/${row.attempts}` : undefined,
      rushingYards: row.rushingYards,
      rushingTDs: row.rushingTDs,
      receivingYards: row.receivingYards,
      receivingTDs: row.receivingTDs,
      // defense (map defensive ints into interceptionsDef if available)
      tackles: row.tackles,
      soloTackles: row.soloTackles,
      sacks: row.sacks,
      tfl: row.tacklesForLoss ?? row.tfl,
      passesDefended: row.passesDefended ?? row.passesDefensed,
      interceptionsDef: row.interceptionsDef ?? row.defensiveInterceptions ?? 0,
      forcedFumbles: row.fumblesForced,
      fumblesRecovered: row.fumblesRecovered,
    };
  });

  // join with roster for IDs/headshots
  const byName = new Map(roster.players.map(p => [p.name, p]));
  const off = [];
  const def = [];

  for (const s of rows) {
    const p = byName.get(s.name) || { name: s.name, pos: s.pos ?? "", id: `${s.name}|${s.pos}`, espnId: null };
    // offense
    const os = scoreOffense(s);
    if (os > 0) {
      off.push({ p, s, score: os, statline: formatOffStatline(s) });
    }
    // defense
    const ds = scoreDefense(s);
    if (ds > 0) {
      def.push({ p, s, score: ds, statline: formatDefStatline(s) });
    }
  }

  // Rank to percentiles for letter grades
  const offScores = off.map(o => o.score);
  const defScores = def.map(d => d.score);

  const offTop = off.sort(byScoreDesc).slice(0, 10).map(o => {
    const pct = percentileRank(offScores, o.score);
    return shapeEntry(o.p, "offense", o.statline, o.score, pct, letterFromScore(pct));
  });

  const defTop = def.sort(byScoreDesc).slice(0, 10).map(d => {
    const pct = percentileRank(defScores, d.score);
    return shapeEntry(d.p, "defense", d.statline, d.score, pct, letterFromScore(pct));
  });

  return {
    offense: offTop.slice(0, 3),
    defense: defTop.slice(0, 3),
    _rawCounts: { offense: offTop.length, defense: defTop.length },
  };
}

async function buildSeason(roster) {
  // Try CFBD season player stats
  let season;
  try {
    season = await CFBD.get("/stats/player/season", { year: YEAR, team: TEAM });
  } catch (e) {
    console.warn("CFBD /stats/player/season failed:", e.message);
    return null;
  }

  // normalize a common subset
  const rows = (season || []).map(r => ({
    name: r.player ?? r.name,
    pos: r.position ?? r.pos ?? "",
    passingYards: r.passingYards,
    passingTDs: r.passingTDs,
    interceptions: r.interceptions,  // QB thrown
    rushingYards: r.rushingYards,
    rushingTDs: r.rushingTDs,
    receivingYards: r.receivingYards,
    receivingTDs: r.receivingTDs,
    tackles: r.tackles,
    soloTackles: r.soloTackles,
    sacks: r.sacks,
    tfl: r.tacklesForLoss ?? r.tfl,
    passesDefended: r.passesDefended,
    interceptionsDef: r.interceptionsDef ?? r.defensiveInterceptions ?? 0,
    forcedFumbles: r.fumblesForced,
    fumblesRecovered: r.fumblesRecovered,
  }));

  const byName = new Map(roster.players.map(p => [p.name, p]));
  const off = [];
  const def = [];

  for (const s of rows) {
    const p = byName.get(s.name) || { name: s.name, pos: s.pos ?? "", id: `${s.name}|${s.pos}`, espnId: null };
    const os = scoreOffense(s);
    if (os > 0) off.push({ p, s, score: os, statline: formatOffStatline(s) });
    const ds = scoreDefense(s);
    if (ds > 0) def.push({ p, s, score: ds, statline: formatDefStatline(s) });
  }

  const offScores = off.map(o => o.score);
  const defScores = def.map(d => d.score);

  const offTop = off.sort(byScoreDesc).slice(0, 10).map(o => {
    const pct = percentileRank(offScores, o.score);
    return shapeEntry(o.p, "offense", o.statline, o.score, pct, letterFromScore(pct));
  });

  const defTop = def.sort(byScoreDesc).slice(0, 10).map(d => {
    const pct = percentileRank(defScores, d.score);
    return shapeEntry(d.p, "defense", d.statline, d.score, pct, letterFromScore(pct));
  });

  return {
    offense: offTop.slice(0, 3),
    defense: defTop.slice(0, 3),
    _rawCounts: { offense: offTop.length, defense: defTop.length },
  };
}

function backfillTop3(list, roster, side) {
  // If we don't have 3, backfill from Featured or Roster QBs/RBs/WRs/LBs
  if (list.length >= 3) return list.slice(0,3);
  const need = 3 - list.length;
  const picks = [];
  const pool = roster.players.slice(0, 50); // cheap heuristic: first 50

  for (const p of pool) {
    if (list.find(x => x.name === p.name) || picks.find(x => x.name === p.name)) continue;
    // Fake a neutral statline
    const stat = side === "offense" ? "— ESPN →" : "— ESPN →";
    picks.push(shapeEntry(p, side, stat, 0, 50, "C"));
    if (picks.length >= need) break;
  }
  return list.concat(picks).slice(0,3);
}

async function preserveOrWrite(file, arr) {
  if (Array.isArray(arr) && arr.length > 0) {
    await writeJson(file, arr);
  } else {
    const prev = await readJson(file);
    if (prev) {
      console.log(`kept previous ${file} (${prev.length})`);
    } else {
      await writeJson(file, []); // first time
    }
  }
}

async function main() {
  console.log(`TEAM: ${TEAM} • YEAR: ${YEAR}`);
  console.log(`Using ${CFBD.key ? "CFBD live API" : "offline"} mode.`);

  const roster = await ensureRoster();
  roster.players = normalizeRoster(roster.players || []);

  const last = await buildLastGame(roster);
  const season = await buildSeason(roster);

  const offense_last  = backfillTop3(last?.offense  || [], roster, "offense");
  const defense_last  = backfillTop3(last?.defense  || [], roster, "defense");
  const offense_season= backfillTop3(season?.offense|| [], roster, "offense");
  const defense_season= backfillTop3(season?.defense|| [], roster, "defense");

  await preserveOrWrite("spotlight_offense_last.json", offense_last);
  await preserveOrWrite("spotlight_defense_last.json", defense_last);
  await preserveOrWrite("spotlight_offense_season.json", offense_season);
  await preserveOrWrite("spotlight_defense_season.json", defense_season);

  // Featured: first item of each side from season if available, otherwise roster[0..1]
  const featured = [];
  if (offense_season[0]) featured.push(offense_season[0]);
  if (defense_season[0]) featured.push(defense_season[0]);
  await writeJson("spotlight_featured.json", featured);

  // Optional ticker aggregator could be written here if you want it in the same pass.
}

main().catch(async (err) => {
  console.error("Builder failed:", err);
  // do not crash CI — leave files as-is
  process.exitCode = 0;
});
