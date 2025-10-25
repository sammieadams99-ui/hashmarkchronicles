/*
 * Robust spotlight builder:
 * - Pulls roster (resilient), games, game players, builds:
 *   data/roster.json
 *   data/spotlight_featured.json
 *   data/spotlight_offense_last.json
 *   data/spotlight_defense_last.json
 *   data/spotlight_offense_season.json
 *   data/spotlight_defense_season.json
 *   data/ticker.json  (left as-is if you already have a script)
 *
 * Safe-writes: never overwrite non-empty files with empty arrays.
 */

import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve("data");
await fs.mkdir(DATA, { recursive: true });

const TEAM = process.env.TEAM || "Kentucky";
const YEAR = Number(process.env.YEAR || 2025);
const CFBD_KEY = process.env.CFBD_KEY || "";

const CFBD = "https://api.collegefootballdata.com";

async function j(pathname) {
  const p = path.join(DATA, pathname);
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return null; }
}
async function w(pathname, obj) {
  const p = path.join(DATA, pathname);
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
  console.log(`wrote ${pathname} (${Array.isArray(obj) ? obj.length : 1})`);
}

async function safeWriteArray(file, arr) {
  // do not overwrite with empty/short arrays
  if (!Array.isArray(arr) || arr.length === 0) {
    const prev = await j(file);
    if (Array.isArray(prev) && prev.length > 0) {
      console.log(`kept last-good ${file} (${prev.length})`);
      return;
    }
  }
  await w(file, arr);
}

async function cfbd(pathname, params = {}) {
  const url = new URL(CFBD + pathname);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, {
    headers: CFBD_KEY ? { Authorization: `Bearer ${CFBD_KEY}` } : {},
    // Be nice to CFBD
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`${pathname} -> HTTP ${r.status}`);
  return r.json();
}

/* -------------------- ROSTER (resilient) -------------------- */
async function fetchRoster() {
  // Try /player/roster first, then /roster
  const tryOnce = async (p) => {
    try {
      const data = await cfbd(p, { year: YEAR, team: TEAM });
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  };
  let roster = await tryOnce("/player/roster");
  if (roster.length === 0) roster = await tryOnce("/roster");

  // Normalize minimal shape we need
  roster = roster.map((p) => ({
    id: p.id ?? p.playerId ?? null,
    name: p.player || p.name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
    position: p.position ?? p.pos ?? "",
    jersey: p.jersey ?? p.number ?? null,
  })).filter((p) => p.name);

  // Fallback to last-good if empty
  if (roster.length === 0) {
    const last = await j("roster.json");
    if (Array.isArray(last) && last.length > 0) {
      console.log("roster empty from CFBD; using last-good roster.json");
      return last;
    }
  }
  return roster;
}

/* -------------------- GAMES & PLAYERS -------------------- */
async function completedGames() {
  const regs = await cfbd("/games", { year: YEAR, team: TEAM, seasonType: "regular" });
  const posts = await cfbd("/games", { year: YEAR, team: TEAM, seasonType: "postseason" });
  const all = [...(regs || []), ...(posts || [])];
  // CFBD marks completed with 'completed' OR we infer from non-null points
  const done = all.filter(g =>
    g.completed === true ||
    (g.home_points != null && g.away_points != null)
  );
  // sort newest -> oldest
  return done.sort((a,b) => new Date(b.start_date||b.startDate) - new Date(a.start_date||a.startDate));
}

async function gamePlayers(gameId) {
  // CFBD: /games/players?gameId=xxxx
  const gp = await cfbd("/games/players", { gameId: gameId });
  // Shape: [{ team, players:[{ name, statCategories:[{name,stat}], ...}] }]
  return gp;
}

/* -------------------- RANKERS (scores) -------------------- */
function num(n){ return (n==null||n==="") ? 0 : Number(n); }

// Extract tallies for a player entry (one game or season aggregate)
function offensiveScore(p) {
  // sum: passing, rushing, receiving
  const passY = num(p.passYds||p.passingYards);
  const passTD = num(p.passTD||p.passingTDs);
  const ints = num(p.interceptions||p.passInt);
  const rushY = num(p.rushYds||p.rushingYards);
  const rushTD = num(p.rushTD||p.rushingTDs);
  const recY = num(p.recYds||p.receivingYards);
  const recTD = num(p.recTD||p.receivingTDs);

  // A lightweight, stable score
  return (passY*0.05 + passTD*5 - ints*6) +
         (rushY*0.08 + rushTD*6) +
         (recY*0.07 + recTD*5);
}

function defensiveScore(p) {
  const tkl = num(p.tackles||p.totalTackles||p.tacklesTotal);
  const tfl = num(p.tfl||p.tacklesForLoss);
  const sack = num(p.sacks);
  const pbu = num(p.passDefended||p.passesDefended);
  const ints = num(p.interceptions);
  const ff = num(p.forcedFumbles||p.fumblesForced);
  const fr = num(p.fumblesRecovered);

  // Give big plays weight; tackles provide floor
  return tkl*1 + tfl*2 + sack*4 + pbu*1.5 + ints*6 + ff*3 + fr*3;
}

/* -------------------- HELPERS -------------------- */
function indexByName(roster) {
  const m = new Map();
  roster.forEach(p => m.set(p.name.toLowerCase(), p));
  return m;
}

function materializeFromGamePlayers(gp, rosterIndex, side /* "offense"|"defense" */) {
  // gp (from CFBD) includes both teams; pick Kentucky
  const block = (gp||[]).find(b => (b.team||"").toLowerCase().includes("kentucky"));
  if (!block || !Array.isArray(block.players)) return [];

  // Flatten per-player stats into a simple object
  const rows = block.players.map(pl => {
    const row = { name: pl.name, position: pl.position || "" };
    (pl.statCategories||[]).forEach(cat => {
      (cat.stats||[]).forEach(s => {
        const key = s.name?.replace(/\s+/g,'') || "";
        const v = Number(s.stat ?? s.value ?? 0);
        // map some common CFBD names
        if (/PassingYards/i.test(s.name)) row.passingYards = v;
        if (/PassingTDs?/i.test(s.name)) row.passingTDs = v;
        if (/InterceptionsThrown/i.test(s.name)) row.passInt = v;
        if (/RushingYards/i.test(s.name)) row.rushingYards = v;
        if (/RushingTDs?/i.test(s.name)) row.rushingTDs = v;
        if (/ReceivingYards/i.test(s.name)) row.receivingYards = v;
        if (/ReceivingTDs?/i.test(s.name)) row.receivingTDs = v;

        if (/TotalTackles/i.test(s.name)) row.totalTackles = v;
        if (/TacklesForLoss/i.test(s.name)) row.tacklesForLoss = v;
        if (/Sacks/i.test(s.name)) row.sacks = v;
        if (/PassesDefended/i.test(s.name)) row.passesDefended = v;
        if (/Interceptions$/i.test(s.name)) row.interceptions = v;
        if (/FumblesForced/i.test(s.name)) row.fumblesForced = v;
        if (/FumblesRecovered/i.test(s.name)) row.fumblesRecovered = v;
      });
    });
    return row;
  });

  const scored = rows.map(r => {
    const rkey = (r.name||"").toLowerCase();
    if (!rosterIndex.has(rkey)) return null;  // ensure roster subset
    const base = rosterIndex.get(rkey);
    const score = (side==="offense") ? offensiveScore(r) : defensiveScore(r);
    return {
      name: r.name,
      pos: base.position || r.position || "",
      score,
      last_game: r
    };
  }).filter(Boolean);

  return scored.sort((a,b)=>b.score - a.score);
}

function compactTop3(list) {
  // unique by name, top 3
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = x.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length===3) break;
  }
  return out;
}

/* -------------------- SEASON ACCUMULATION -------------------- */
function addAgg(dst, src, keys) {
  keys.forEach(k => dst[k]=(dst[k]||0)+num(src[k]));
}

function seasonFromGames(gameBlocks, rosterIndex, side) {
  const book = new Map(); // name -> totals
  for (const gp of gameBlocks) {
    const rows = materializeFromGamePlayers(gp, rosterIndex, side);
    for (const r of rows) {
      const k = r.name.toLowerCase();
      const dst = book.get(k) || { name: r.name, pos: r.pos };
      if (side==="offense") {
        addAgg(dst, r.last_game, [
          "passingYards","passingTDs","passInt",
          "rushingYards","rushingTDs",
          "receivingYards","receivingTDs"
        ]);
      } else {
        addAgg(dst, r.last_game, [
          "totalTackles","tacklesForLoss","sacks",
          "passesDefended","interceptions","fumblesForced","fumblesRecovered"
        ]);
      }
      book.set(k, dst);
    }
  }
  // score and rank
  const list = [];
  for (const item of book.values()) {
    const score = (side==="offense") ? offensiveScore(item) : defensiveScore(item);
    list.push({ name: item.name, pos: item.pos, score, season: item });
  }
  return list.sort((a,b)=>b.score-a.score);
}

/* -------------------- MAIN -------------------- */
(async function run(){
  // 1) Roster
  const roster = await fetchRoster();
  await safeWriteArray("roster.json", roster);

  const rosterIdx = indexByName(roster);
  console.log(`roster loaded: ${roster.length}`);

  // 2) Games
  const games = await completedGames();
  if (games.length === 0) {
    console.warn("No completed games found; keeping last-good spotlight files.");
    return;
  }

  // 3) LAST game
  const last = games[0];
  const gpLast = await gamePlayers(last.id || last.gameId || last.idGame || last.game_id);
  const offLastRank = compactTop3(materializeFromGamePlayers(gpLast, rosterIdx, "offense"));
  const defLastRank = compactTop3(materializeFromGamePlayers(gpLast, rosterIdx, "defense"));

  await safeWriteArray("spotlight_offense_last.json", offLastRank);
  await safeWriteArray("spotlight_defense_last.json", defLastRank);

  // 4) SEASON (aggregate all completed games)
  //    If API is hot, keep it to most recent 12 games for safety.
  const keep = games.slice(0, 12);
  const allBlocks = [];
  for (const g of keep) {
    try {
      const b = await gamePlayers(g.id || g.gameId || g.idGame || g.game_id);
      allBlocks.push(b);
    } catch(e) {
      console.warn("games/players failed for a game, continuing:", e.message);
    }
  }
  const offSeasonRank = compactTop3(seasonFromGames(allBlocks, rosterIdx, "offense"));
  const defSeasonRank = compactTop3(seasonFromGames(allBlocks, rosterIdx, "defense"));

  await safeWriteArray("spotlight_offense_season.json", offSeasonRank);
  await safeWriteArray("spotlight_defense_season.json", defSeasonRank);

  // 5) Featured: first entry from offense season if available,
  //    else offense last, else keep existing.
  let featured = null;
  if (offSeasonRank.length > 0) featured = offSeasonRank[0];
  else if (offLastRank.length > 0) featured = offLastRank[0];

  if (featured) {
    await w("spotlight_featured.json", featured);
  } else {
    const prev = await j("spotlight_featured.json");
    if (prev) console.log("kept spotlight_featured.json (no new)");
  }

  // NOTE: ticker.json is handled by your existing script.
  console.log("done.");
})().catch(err => {
  console.error("build_spotlight error:", err);
  process.exitCode = 1;
});
