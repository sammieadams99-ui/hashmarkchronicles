// scripts/build-cfbd.mjs
// Pulls latest player stats for Kentucky from CFBD and writes the JSON your index already consumes.
// Safe to run on GitHub Actions only (uses CFBD_KEY secret). No front-end key exposure.

import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_REST = "https://api.collegefootballdata.com";
const YEAR = parseInt(process.env.YEAR || "2025", 10);
const TEAM = process.env.TEAM || "Kentucky";
const TEAM_ID = String(process.env.TEAM_ID || "96");
const DATA_DIR = resolve(process.cwd(), "data");

if (!process.env.CFBD_KEY) {
  throw new Error("CFBD_KEY env var is required");
}

const H = {
  Authorization: `Bearer ${process.env.CFBD_KEY}`,
  "Content-Type": "application/json",
};

async function j(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function normalizeId(value) {
  if (!value && value !== 0) return null;
  if (typeof value === "string" || typeof value === "number") {
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "object") {
    const candidate =
      value.espnId ??
      value.espnid ??
      value.espnID ??
      value.id ??
      value.ID ??
      value.playerId ??
      value.player_id ??
      null;
    return normalizeId(candidate);
  }
  return null;
}

function slugify(name = "") {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function readESPNMap() {
  try {
    const p = resolve(DATA_DIR, "espn_map.json");
    const s = await readFile(p, "utf8");
    const raw = JSON.parse(s);
    const map = new Map();
    for (const [key, value] of Object.entries(raw || {})) {
      const id = normalizeId(value);
      if (!id) continue;
      const cleanKey = key.trim();
      if (cleanKey) {
        map.set(cleanKey, id);
        map.set(cleanKey.toLowerCase(), id);
      }
      const slug = slugify(cleanKey);
      if (slug) {
        map.set(slug, id);
        map.set(slug.toLowerCase(), id);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function lookupESPNId(name, map) {
  if (!name) return "";
  const direct =
    map.get(name) ||
    map.get(name.trim()) ||
    map.get(name.toLowerCase()) ||
    map.get(slugify(name)) ||
    map.get(slugify(name).toLowerCase());
  return direct ? String(direct) : "";
}

function headshotFromESPNId(espnId) {
  return espnId ? `https://a.espncdn.com/i/headshots/college-football/players/full/${espnId}.png` : "";
}

function linkFromESPNId(espnId) {
  return espnId ? `https://www.espn.com/college-football/player/_/id/${espnId}` : "#";
}

function toLetter(score) {
  const b = [
    [97, "A+"],
    [93, "A"],
    [90, "A-"],
    [87, "B+"],
    [83, "B"],
    [80, "B-"],
    [77, "C+"],
    [73, "C"],
    [70, "C-"],
    [67, "D+"],
    [63, "D"],
    [60, "D-"],
  ];
  for (const [cut, L] of b) if (score >= cut) return L;
  return "F";
}

function pctToLetter(scorePct) {
  const pct = Math.max(0, Math.min(100, scorePct));
  return { pct, letter: toLetter(pct) };
}

function rankPercentile(items, key) {
  if (!items.length) return;
  const vals = items.map((x) => x[key] ?? 0);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  for (const it of items) {
    const v = it[key] ?? 0;
    const p = max === min ? 0.5 : (v - min) / (max - min);
    it._scorePct = Math.round(60 + 40 * p);
    const { pct, letter } = pctToLetter(it._scorePct);
    it.grade_pct = pct;
    it.grade_letter = letter;
  }
}

async function latestGameId() {
  const games = await j(
    `${BASE_REST}/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=both`
  );
  const done = games
    .filter((g) => g.home_points != null || g.away_points != null)
    .sort(
      (a, b) =>
        new Date(a.start_date || a.startDate || a.date) -
        new Date(b.start_date || b.startDate || b.date)
    );
  const last = done.at(-1);
  if (!last) throw new Error("No completed game found");
  return { gameId: last.id ?? last.game_id ?? last.gameId, meta: last };
}

function normalizePlayer(row, teamName) {
  const team = (row.team || "").toLowerCase();
  if (team && team !== teamName.toLowerCase()) return null;
  const name = row.name || row.player || row.player_name || "";
  if (!name) return null;
  return {
    team: row.team || teamName,
    id: row.id || row.playerId || row.player_id || null,
    name,
    pos: row.position || row.pos || "",
    passYds: +(row.passingYards ?? row.pass_yds ?? row.passYds ?? 0),
    passAtt: +(row.attempts ?? row.pass_att ?? 0),
    passCmp: +(row.completions ?? row.pass_cmp ?? 0),
    passTd: +(row.passingTds ?? row.pass_td ?? 0),
    ints: +(row.interceptions ?? row.pass_int ?? 0),
    rushYds: +(row.rushingYards ?? row.rush_yds ?? row.rushYds ?? 0),
    rushAtt: +(row.rushingAttempts ?? row.carries ?? row.rush_att ?? 0),
    rushTd: +(row.rushingTds ?? row.rush_td ?? 0),
    recYds: +(row.receivingYards ?? row.rec_yds ?? row.recYds ?? 0),
    rec: +(row.receptions ?? row.rec ?? 0),
    recTd: +(row.receivingTds ?? row.rec_td ?? 0),
    tkl: +(row.tackles ?? row.tot_tackles ?? row.totalTackles ?? row.totl ?? 0),
    solo: +(row.soloTackles ?? row.solo ?? 0),
    tfl: +(row.tacklesForLoss ?? row.tfl ?? 0),
    sack: +(row.sacks ?? row.sack ?? 0),
    pbu: +(row.passesDefended ?? row.pbu ?? 0),
    intDef: +(row.interceptionsThrown ?? row.def_int ?? row.defIntercept ?? 0),
    ff: +(row.forcedFumbles ?? row.ff ?? 0),
    fr: +(row.fumblesRecovered ?? row.fr ?? 0),
  };
}

async function playerGameRows(gameId) {
  const rows = await j(`${BASE_REST}/games/players?gameId=${gameId}`);
  const out = [];
  const push = (team, p) => {
    const normalized = normalizePlayer({ ...p, team }, TEAM);
    if (normalized) out.push(normalized);
  };

  if (Array.isArray(rows) && rows.length && rows[0]?.players) {
    for (const t of rows) {
      if (!t?.players) continue;
      for (const p of t.players) push(t.team, p);
    }
  } else if (Array.isArray(rows)) {
    for (const p of rows) push(p.team, p);
  } else {
    throw new Error("Unexpected CFBD /games/players shape");
  }

  return out;
}

function pickTopOffense(flat) {
  const qbs = flat.filter((p) => (p.pos || "").includes("QB"));
  const rbs = flat.filter((p) => (p.pos || "").includes("RB"));
  const wrs = flat.filter((p) => /WR|TE/i.test(p.pos || ""));

  const top = (arr, key) => arr.slice().sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))[0];

  const qb = top(qbs, "passYds");
  const rb = top(rbs, "rushYds");
  const wr = top(wrs, "recYds");

  const rows = [qb, rb, wr]
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      pos: p.pos,
      statline: (() => {
        if (p.pos?.includes("QB")) {
          return `CMP/ATT ${p.passCmp}/${p.passAtt} • YDS ${p.passYds} • TD ${p.passTd}`;
        }
        if (p.pos?.includes("RB")) {
          const parts = [`RUSH ${p.rushYds}`, `TD ${p.rushTd}`];
          if (p.rec) parts.push(`REC ${p.rec}`);
          return parts.join(" • ");
        }
        return `REC ${p.rec} • YDS ${p.recYds} • TD ${p.recTd}`;
      })(),
      _pass: p.passYds + 20 * p.passTd - 45 * p.ints + 0.4 * p.passCmp,
      _rush: p.rushYds + 15 * p.rushTd + 2 * p.rec,
      _recv: p.recYds + 15 * p.recTd + 5 * p.rec,
      _pos: p.pos,
    }));

  rankPercentile(
    rows.filter((r) => r._pos && r._pos.includes("QB")),
    "_pass"
  );
  rankPercentile(
    rows.filter((r) => r._pos && r._pos.includes("RB")),
    "_rush"
  );
  rankPercentile(rows.filter((r) => /WR|TE/.test(r._pos || "")), "_recv");

  return rows;
}

function pickTopDefense(flat) {
  for (const p of flat) {
    p._defScore =
      (p.tkl || 0) +
      8 * (p.tfl || 0) +
      12 * (p.sack || 0) +
      12 * (p.intDef || 0) +
      7 * (p.pbu || 0) +
      10 * (p.ff || 0) +
      10 * (p.fr || 0);
  }
  const sorted = flat
    .slice()
    .sort((a, b) => (b._defScore || 0) - (a._defScore || 0))
    .slice(0, 3);
  const rows = sorted.map((p) => ({
    id: p.id,
    name: p.name,
    pos: p.pos,
    statline: [
      p.tkl ? `TKL ${p.tkl}` : null,
      p.tfl ? `TFL ${p.tfl}` : null,
      p.sack ? `SACKS ${p.sack}` : null,
      p.intDef ? `INT ${p.intDef}` : null,
    ]
      .filter(Boolean)
      .slice(0, 3)
      .join(" • "),
    _defScore: p._defScore,
  }));

  rankPercentile(rows, "_defScore");
  return rows;
}

async function seasonLeaders() {
  let rows;
  try {
    rows = await j(
      `${BASE_REST}/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`
    );
  } catch {
    rows = await j(
      `${BASE_REST}/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`
    );
  }

  const flat = rows.map((p) => ({
    team: TEAM,
    id: p.playerId || p.id,
    name: p.player || p.name,
    pos: p.position || p.pos || "",
    passYds: +(p.passingYards ?? p.passYards ?? p.pass_yds ?? 0),
    passTd: +(p.passingTds ?? p.passTd ?? p.pass_td ?? 0),
    ints: +(p.interceptions ?? p.int ?? p.pass_int ?? 0),
    rushYds: +(p.rushingYards ?? p.rushYards ?? p.rush_yds ?? 0),
    rushTd: +(p.rushingTds ?? p.rushTd ?? p.rush_td ?? 0),
    recYds: +(p.receivingYards ?? p.recYards ?? p.rec_yds ?? 0),
    rec: +(p.receptions ?? p.rec ?? 0),
    recTd: +(p.receivingTds ?? p.recTd ?? p.rec_td ?? 0),
    tkl: +(p.tackles ?? p.tot_tackles ?? p.totalTackles ?? 0),
    tfl: +(p.tacklesForLoss ?? p.tfl ?? 0),
    sack: +(p.sacks ?? p.sack ?? 0),
    pbu: +(p.passesDefended ?? p.pbu ?? 0),
    intDef: +(p.interceptionsDefended ?? p.def_int ?? 0),
    ff: +(p.forcedFumbles ?? p.ff ?? 0),
    fr: +(p.fumblesRecovered ?? p.fr ?? 0),
  }));

  const qb = flat
    .filter((p) => (p.pos || "").includes("QB"))
    .sort((a, b) => (b.passYds ?? 0) - (a.passYds ?? 0))[0];
  const rb = flat
    .filter((p) => (p.pos || "").includes("RB"))
    .sort((a, b) => (b.rushYds ?? 0) - (a.rushYds ?? 0))[0];
  const wr = flat
    .filter((p) => /WR|TE/i.test(p.pos || ""))
    .sort((a, b) => (b.recYds ?? 0) - (a.recYds ?? 0))[0];

  const off = [qb, rb, wr]
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      pos: p.pos,
      statline: (() => {
        if (p.pos?.includes("QB")) return `YDS ${p.passYds} • TD ${p.passTd} • INT ${p.ints}`;
        if (p.pos?.includes("RB")) return `YDS ${p.rushYds} • TD ${p.rushTd}`;
        return `REC ${p.rec} • YDS ${p.recYds} • TD ${p.recTd}`;
      })(),
      _score:
        (p.passYds || 0) +
        (p.rushYds || 0) +
        (p.recYds || 0) +
        15 * ((p.passTd || 0) + (p.rushTd || 0) + (p.recTd || 0)),
    }));
  rankPercentile(off, "_score");

  const def = flat
    .filter((p) => !/(QB|RB|WR|TE)/i.test(p.pos || ""))
    .sort((a, b) => {
      const Sa =
        (a.tkl || 0) +
        8 * (a.tfl || 0) +
        12 * (a.sack || 0) +
        12 * (a.intDef || 0) +
        7 * (a.pbu || 0) +
        10 * (a.ff || 0) +
        10 * (a.fr || 0);
      const Sb =
        (b.tkl || 0) +
        8 * (b.tfl || 0) +
        12 * (b.sack || 0) +
        12 * (b.intDef || 0) +
        7 * (b.pbu || 0) +
        10 * (b.ff || 0) +
        10 * (b.fr || 0);
      return Sb - Sa;
    })
    .slice(0, 3)
    .map((p) => ({
      id: p.id,
      name: p.name,
      pos: p.pos,
      statline: [
        p.tkl ? `TKL ${p.tkl}` : null,
        p.tfl ? `TFL ${p.tfl}` : null,
        p.sack ? `SACKS ${p.sack}` : null,
        p.intDef ? `INT ${p.intDef}` : null,
      ]
        .filter(Boolean)
        .slice(0, 3)
        .join(" • "),
      _score:
        (p.tkl || 0) +
        8 * (p.tfl || 0) +
        12 * (p.sack || 0) +
        12 * (p.intDef || 0) +
        7 * (p.pbu || 0) +
        10 * (p.ff || 0) +
        10 * (p.fr || 0),
    }));
  rankPercentile(def, "_score");

  return { off, def };
}

function adaptForFrontEnd(rows, espnMap) {
  return rows.map((p) => {
    const espnId = lookupESPNId(p.name, espnMap);
    return {
      name: p.name,
      pos: p.pos || "",
      headshot: headshotFromESPNId(espnId),
      espn: linkFromESPNId(espnId),
      statline: p.statline || "",
      grade_pct: p.grade_pct ?? undefined,
      grade_letter: p.grade_letter ?? undefined,
    };
  });
}

async function run() {
  const espnMap = await readESPNMap();

  const { gameId } = await latestGameId();
  const flatLast = await playerGameRows(gameId);
  const offLast = pickTopOffense(flatLast);
  const defLast = pickTopDefense(flatLast);

  const { off: offSeason, def: defSeason } = await seasonLeaders();

  const write = (file, data) =>
    writeFile(resolve(DATA_DIR, file), JSON.stringify(data, null, 2) + "\n", "utf8");

  await write("spotlight_offense_last.json", adaptForFrontEnd(offLast, espnMap));
  await write("spotlight_defense_last.json", adaptForFrontEnd(defLast, espnMap));
  await write("spotlight_offense_season.json", adaptForFrontEnd(offSeason, espnMap));
  await write("spotlight_defense_season.json", adaptForFrontEnd(defSeason, espnMap));

  if (offLast.length) {
    const f = adaptForFrontEnd([offLast[0]], espnMap)[0];
    await write("spotlight_featured.json", f);
  }

  console.log("[cfbd] wrote spotlight JSON");
}

run().catch((err) => {
  console.error("cfbd build error:", err);
  process.exit(1);
});
