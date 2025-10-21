// scripts/build_cfbd.js
// Usage: TEAM="Kentucky" YEAR=2025 node scripts/build_cfbd.js
// Builds a merged roster + stat snapshot for the given team and season.
// Designed for GitHub Actions (requires CFBD_API_KEY secret). No browser usage.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TEAM = process.env.TEAM || 'Kentucky';
const YEAR = Number.parseInt(process.env.YEAR || '2025', 10);
const KEY = process.env.CFBD_API_KEY;
const DATA_DIR = resolve(process.cwd(), 'data', 'team');

if (!KEY) {
  throw new Error('CFBD_API_KEY env var is required');
}
if (!Number.isFinite(YEAR)) {
  throw new Error('YEAR must be a number (e.g. 2025)');
}

async function cfbd(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `https://api.collegefootballdata.com${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CFBD ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function headshotUrl(espnId) {
  return espnId ? `https://a.espncdn.com/i/headshots/college-football/players/full/${espnId}.png` : '';
}

function initialsFrom(first, last) {
  const safeFirst = (first || '').trim();
  const safeLast = (last || '').trim();
  const init = `${safeFirst.charAt(0)}${safeLast.charAt(0)}`.toUpperCase();
  return init || 'UK';
}

function statKeyForSeasonRow(row) {
  if (row == null || typeof row !== 'object') return null;
  const id = row.athleteId || row.playerId || row.id;
  if (id) return `id:${id}`;
  const player = (row.player || row.name || '').toLowerCase().trim();
  const pos = (row.position || row.pos || '').toLowerCase().trim();
  if (!player) return null;
  return `name:${player}|${pos}`;
}

function rosterKey(player) {
  const id = player.athleteId || player.id;
  if (id) return `id:${id}`;
  const full = `${player.firstName || ''} ${player.lastName || ''}`.trim().toLowerCase();
  const pos = (player.position || '').trim().toLowerCase();
  if (!full) return null;
  return `name:${full}|${pos}`;
}

function cleanNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSeasonStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stats = {
    passingYards: cleanNumber(raw.passingYards ?? raw.passYards ?? raw.pass_yds),
    passingTouchdowns: cleanNumber(raw.passingTds ?? raw.passTd ?? raw.pass_td),
    interceptions: cleanNumber(raw.interceptions ?? raw.passInt ?? raw.pass_int),
    rushingYards: cleanNumber(raw.rushingYards ?? raw.rushYards ?? raw.rush_yds),
    rushingTouchdowns: cleanNumber(raw.rushingTds ?? raw.rushTd ?? raw.rush_td),
    receivingYards: cleanNumber(raw.receivingYards ?? raw.recYards ?? raw.rec_yds),
    receptions: cleanNumber(raw.receptions ?? raw.rec),
    receivingTouchdowns: cleanNumber(raw.receivingTds ?? raw.recTd ?? raw.rec_td),
    tackles: cleanNumber(raw.tackles ?? raw.totalTackles ?? raw.tot_tackles),
    tacklesForLoss: cleanNumber(raw.tacklesForLoss ?? raw.tfl),
    sacks: cleanNumber(raw.sacks ?? raw.sack),
    passesDefended: cleanNumber(raw.passesDefended ?? raw.pbu),
    defensiveInterceptions: cleanNumber(raw.interceptionsDefended ?? raw.def_int ?? raw.int),
    forcedFumbles: cleanNumber(raw.forcedFumbles ?? raw.ff),
    fumblesRecovered: cleanNumber(raw.fumblesRecovered ?? raw.fr),
  };
  // Remove null entries to keep payload tidy
  return Object.fromEntries(
    Object.entries(stats).filter(([, value]) => value != null)
  );
}

async function main() {
  const [roster, statsRaw] = await Promise.all([
    cfbd('/roster', { team: TEAM, year: YEAR }),
    cfbd('/player/season', { team: TEAM, year: YEAR }).catch(async () => {
      // Fallback for older accounts where the endpoint lives under /stats/player/season
      return cfbd('/stats/player/season', { team: TEAM, year: YEAR });
    }),
  ]);

  const statIndex = new Map();
  for (const row of statsRaw) {
    const key = statKeyForSeasonRow(row);
    if (!key) continue;
    statIndex.set(key, row);
  }

  const merged = roster.map((player) => {
    const key = rosterKey(player);
    const statRow = key ? statIndex.get(key) : undefined;
    const fullName = `${player.firstName || ''} ${player.lastName || ''}`.trim();
    const espnId = player.athleteId || player.espnId || player.espnID || null;
    return {
      athleteId: espnId ? String(espnId) : null,
      name: fullName || player.displayName || player.name || null,
      firstName: player.firstName || null,
      lastName: player.lastName || null,
      position: player.position || null,
      jersey: player.jersey ?? null,
      height: player.height ?? null,
      weight: player.weight ?? null,
      year: player.year || null,
      hometown: player.hometown || null,
      headshot: headshotUrl(espnId),
      initials: initialsFrom(player.firstName, player.lastName),
      stats: normalizeSeasonStats(statRow) || null,
    };
  });

  await mkdir(DATA_DIR, { recursive: true });

  const rosterPath = resolve(DATA_DIR, 'roster.json');
  const metaPath = resolve(DATA_DIR, 'roster_meta.json');
  const meta = {
    team: TEAM,
    year: YEAR,
    generated_at: new Date().toISOString(),
    players: merged.length,
  };

  await writeFile(rosterPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  console.log(`Wrote roster for ${TEAM} ${YEAR} with ${merged.length} players.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
