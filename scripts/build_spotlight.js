#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { mkdir, readFile, writeFile, rm, stat } from 'fs/promises';
import fetch from 'node-fetch';

const TEAM_ID = Number(process.env.TEAM_ID || 96);
const TEAM_NAME = 'Kentucky';
const SEASON_YEAR = Number(process.env.SEASON || 2025);
const CACHE_GUARD_MS = 6 * 60 * 60 * 1000; // 6h
const ROSTER_MIN = 65;
const ROSTER_MAX = 150;
const ROSTER_MISSING_THRESHOLD = 0.1; // 10%
const OFFENSE_POSITIONS = new Set([
  'QB',
  'RB',
  'HB',
  'FB',
  'TB',
  'WR',
  'TE',
  'OL',
  'OT',
  'OG',
  'C',
  'LS'
]);

const DEFENSE_POSITIONS = new Set([
  'DL',
  'DE',
  'DT',
  'NT',
  'LB',
  'OLB',
  'ILB',
  'MLB',
  'CB',
  'DB',
  'S',
  'FS',
  'SS',
  'STAR',
  'NICKEL'
]);

const argv = process.argv.slice(2);
const flags = parseArgs(argv);
const mode = (flags.mode || 'enrich').toLowerCase();
const fastMode = mode === 'fast';
const timeoutSeconds = Number(flags.timeout ?? (fastMode ? 10 : 25));
const retries = Number(flags.retries ?? (fastMode ? 1 : 2));
const shouldPurge = Boolean(flags.purge);
const cacheKey = process.env.SPOTLIGHT_CACHE_KEY || 'v2-2025-10-21';
const cfbdKey = process.env.CFBD_KEY || process.env.CFBD_API_KEY || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_ROOT = path.join(ROOT, '.cache', 'spotlight', cacheKey);
const LAST_GOOD_DIR = path.join(CACHE_ROOT, 'last-good');
const PROVIDER_BYPASS = shouldPurge ? new Set(['espn', 'cfbd']) : new Set();

function readJSONSafe(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

async function main() {
  if (shouldPurge) {
    await rm(path.join(ROOT, '.cache', 'spotlight'), { recursive: true, force: true });
    console.log('🧹 purge requested — cleared spotlight cache directory');
  }
  await mkdir(CACHE_ROOT, { recursive: true });
  await mkdir(LAST_GOOD_DIR, { recursive: true });

  const cacheSummary = [];

  const rosterResponse = await fetchJSONWithCache(
    'espn',
    `roster-${TEAM_ID}-${SEASON_YEAR}`,
    () => fetchJSON(buildEspnRosterUrl(), {
      timeoutMs: timeoutSeconds * 1000,
      retries,
      label: 'espn roster'
    }),
    cacheSummary
  );
  const rosterPath = path.join(DATA_DIR, 'team', 'roster.json');
  let rosterPlayers = normalizeRoster(rosterResponse.data?.team || rosterResponse.data);
  rosterPlayers = validateOrFallbackRoster(rosterPlayers, rosterPath);
  validateRoster(rosterPlayers);
  await persistRoster(rosterPlayers);

  const seasonResult = await fetchJSONWithCache(
    'cfbd',
    `season-${TEAM_ID}-${SEASON_YEAR}`,
    () => fetchCFBD('/player/season', { year: SEASON_YEAR, team: TEAM_NAME }),
    cacheSummary
  );
  const gamesResult = await fetchJSONWithCache(
    'cfbd',
    `games-${TEAM_ID}-${SEASON_YEAR}`,
    () => fetchCFBD('/games', { year: SEASON_YEAR, team: TEAM_NAME, seasonType: 'regular' }),
    cacheSummary
  );

  const games = Array.isArray(gamesResult.data) ? gamesResult.data : [];
  const completedGames = games
    .filter((game) => game && game.completed)
    .sort((a, b) => new Date(b.start_date || b.startDate || 0) - new Date(a.start_date || a.startDate || 0));
  const latestGame = completedGames[0] || null;
  const lastOpponent = latestGame
    ? latestGame.home === TEAM_NAME
      ? latestGame.away
      : latestGame.home
    : '';

  let lastGameResult = { data: null, fromCache: false };
  if (latestGame?.id) {
    lastGameResult = await fetchJSONWithCache(
      'cfbd',
      `game-${latestGame.id}`,
      () => fetchCFBD('/game/player/statistics', { gameId: latestGame.id }),
      cacheSummary
    );
  }

  const seasonPlayers = Array.isArray(seasonResult.data) ? seasonResult.data : [];
  const lastGameData = lastGameResult.data;

  const spotlightPayload = buildSpotlight({
    roster: rosterPlayers,
    seasonPlayers,
    lastGameData,
    opponent: lastOpponent || (latestGame?.home === TEAM_NAME ? latestGame.awayTeam : latestGame?.awayTeam) || '',
    lastGameId: latestGame?.id || null,
    lastGameDate: latestGame ? latestGame.start_date || latestGame.startDate || null : null
  });

  const rosterIds = new Set(rosterPlayers.map((player) => Number(player.id)).filter((id) => Number.isFinite(id)));
  const sealedPayload = sealSpotlightPayload(spotlightPayload, rosterIds);

  await persistSpotlight(sealedPayload, cacheSummary);

  console.log('✅ spotlight build complete');
  if (cacheSummary.length) {
    console.log('cache summary:\n - ' + cacheSummary.join('\n - '));
  }
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const stripped = token.slice(2);
    const [rawKey, rawValue] = stripped.split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (rawValue !== undefined) {
      out[key] = rawValue;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function fetchJSON(url, { timeoutMs, retries: maxRetries, headers = {}, label = 'fetch' }) {
  let attempt = 0;
  let lastError = null;
  while (attempt <= maxRetries) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'hashmark-spotlight/3.0',
          ...headers
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`${label} HTTP ${res.status}`);
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) {
        throw new Error(`${label} expected JSON but received ${ct}`);
      }
      return res.json();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
      const backoff = Math.round(Math.pow(1.5, attempt) * 500);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      attempt += 1;
    }
  }
  throw lastError;
}

async function fetchCFBD(pathname, params) {
  if (!cfbdKey) {
    throw new Error('CFBD_KEY environment variable is required');
  }
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value == null || value === '') return;
    query.append(key, value);
  });
  const search = query.toString();
  const url = `https://api.collegefootballdata.com${pathname}${search ? `?${search}` : ''}`;
  return fetchJSON(url, {
    timeoutMs: timeoutSeconds * 1000,
    retries,
    headers: { Authorization: `Bearer ${cfbdKey}` },
    label: `cfbd ${pathname}`
  });
}

async function fetchJSONWithCache(provider, key, loader, summary) {
  const providerDir = path.join(CACHE_ROOT, provider);
  await mkdir(providerDir, { recursive: true });
  const dataPath = path.join(providerDir, `${key}.json`);
  let cachedData = null;
  let cacheAge = Infinity;
  try {
    const raw = await readFile(dataPath, 'utf8');
    cachedData = JSON.parse(raw);
    const info = await stat(dataPath);
    cacheAge = Date.now() - info.mtimeMs;
  } catch (error) {
    cachedData = null;
  }

  const bypass = PROVIDER_BYPASS.has(provider);
  if (bypass) {
    PROVIDER_BYPASS.delete(provider);
  }

  if (!bypass && cachedData && cacheAge < CACHE_GUARD_MS) {
    const duration = formatDuration(cacheAge);
    console.log(`⏸ ${provider.toUpperCase()} guard: last run ${duration} (<6h). Skipping provider.`);
    if (summary) summary.push(`${provider}:${key} cache-hit (${duration})`);
    return { data: cachedData, fromCache: true, stale: false };
  }

  try {
    const data = await loader();
    await writeFile(dataPath, JSON.stringify(data, null, 2));
    if (summary) summary.push(`${provider}:${key} refreshed`);
    return { data, fromCache: false, stale: false };
  } catch (error) {
    if (cachedData) {
      console.warn(`[${provider}] fetch failed (${key}): ${error.message}. Using cached copy.`);
      if (summary) summary.push(`${provider}:${key} fallback-cache`);
      return { data: cachedData, fromCache: true, stale: true };
    }
    throw error;
  }
}

function buildEspnRosterUrl() {
  return `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${TEAM_ID}?enable=roster`;
}

function normalizeRoster(raw) {
  const players = [];
  const seen = new Map();
  const groups = Array.isArray(raw?.athletes) ? raw.athletes : [];
  for (const group of groups) {
    const groupPos = normalizePos(group?.position?.abbreviation || group?.position?.displayName || group?.position);
    const items = Array.isArray(group?.items) ? group.items : Array.isArray(group?.athletes) ? group.athletes : [];
    for (const entry of items) {
      const athlete = entry?.athlete || entry || {};
      const id = Number(athlete.id ?? athlete.athleteId ?? entry?.id);
      if (!Number.isFinite(id)) continue;
      if (athlete.team && Number(athlete.team?.id) !== TEAM_ID) continue;
      const name = (athlete.displayName || athlete.fullName || athlete.name || '').trim();
      if (!name) continue;
      const pos = normalizePos(
        athlete.position?.abbreviation ||
          entry?.position?.abbreviation ||
          entry?.position?.displayName ||
          groupPos
      );
      const jersey = normalizeNumber(athlete.jersey ?? entry?.jersey ?? entry?.jerseyNumber ?? entry?.number);
      const classification = normalizeClass(
        athlete.class?.abbreviation ||
          athlete.experience?.class ||
          athlete.experience?.classification ||
          entry?.class?.abbreviation ||
          entry?.class ||
          ''
      );
      const height = normalizeHeight(athlete.displayHeight || entry?.displayHeight || athlete.height);
      const weight = normalizeNumber(athlete.displayWeight || athlete.weight || entry?.weight);
      const key = id;
      if (seen.has(key)) continue;
      const record = compact({
        id,
        name,
        pos,
        number: jersey,
        class: classification,
        height,
        weight
      });
      seen.set(key, record);
      players.push(record);
    }
  }
  players.sort((a, b) => a.name.localeCompare(b.name));
  return players;
}

function validateOrFallbackRoster(players, cachePath) {
  if (!Array.isArray(players) || players.length === 0) {
    console.warn('⚠️ Provider returned empty roster — using last-known-good cache.');
    const cached = readJSONSafe(cachePath, []);
    if (Array.isArray(cached) && cached.length >= ROSTER_MIN) {
      console.log(`✅ Using cached roster (${cached.length} players)`);
      return cached.map((player) => {
        const numericId = Number(player.id);
        return {
          ...player,
          id: Number.isFinite(numericId) ? numericId : player.id
        };
      });
    }
    throw new Error('Roster fetch failed and no cached roster available.');
  }
  if (players.length < ROSTER_MIN || players.length > ROSTER_MAX) {
    throw new Error(`Roster size ${players.length} outside expected range (${ROSTER_MIN}-${ROSTER_MAX})`);
  }
  return players;
}

function validateRoster(players) {
  const size = players.length;
  if (size < ROSTER_MIN || size > ROSTER_MAX) {
    throw new Error(`Roster size ${size} outside expected range (${ROSTER_MIN}-${ROSTER_MAX}). Check provider season.`);
  }
  const missingId = players.filter((p) => !Number.isFinite(p.id)).length;
  if (missingId / size > ROSTER_MISSING_THRESHOLD) {
    throw new Error(`Roster missing ids for ${(missingId / size * 100).toFixed(1)}% of players.`);
  }
  const missingPos = players.filter((p) => !p.pos).length;
  if (missingPos / size > ROSTER_MISSING_THRESHOLD) {
    throw new Error(`Roster missing positions for ${(missingPos / size * 100).toFixed(1)}% of players.`);
  }
}

async function persistRoster(players) {
  const minimal = players.map((p) => compact({
    id: p.id,
    name: p.name,
    number: p.number ?? null,
    pos: p.pos || null,
    class: p.class || null,
    height: p.height || null,
    weight: p.weight || null
  }));

  const byId = {};
  const byName = {};
  for (const player of players) {
    const normName = normalizeName(player.name);
    byId[player.id] = player;
    if (normName) byName[normName] = player;
  }

  const payloadPlus = {
    players,
    byId,
    byName,
    meta: {
      teamId: TEAM_ID,
      team: TEAM_NAME,
      season: SEASON_YEAR,
      updatedAt: new Date().toISOString()
    }
  };

  await writeJSON(path.join(DATA_DIR, 'team', 'roster.json'), minimal);
  await writeJSON(path.join(DATA_DIR, 'team', 'roster_plus.json'), payloadPlus);
  await writeJSON(
    path.join(DATA_DIR, 'team', 'roster_meta.json'),
    {
      teamId: TEAM_ID,
      season: SEASON_YEAR,
      generated_at: new Date().toISOString(),
      source: 'espn'
    }
  );
}

function buildSpotlight({ roster, seasonPlayers, lastGameData, opponent, lastGameId, lastGameDate }) {
  const rosterById = new Map(roster.map((player) => [player.id, player]));
  const rosterByName = new Map(roster.map((player) => [normalizeName(player.name), player]));
  const combined = new Map();

  for (const row of seasonPlayers || []) {
    const id = Number(row.athleteId ?? row.id ?? row.playerId);
    if (!Number.isFinite(id)) continue;
    const name = (row.player || row.name || '').trim();
    if (!name) continue;
    const pos = normalizePos(row.position || row.pos);
    const rosterMatch = rosterById.get(id) || rosterByName.get(normalizeName(name)) || null;
    const seasonStats = summarizeSeasonStats(row);
    const entry = getOrCreatePlayer(combined, id, name, rosterMatch, pos);
    if (Object.keys(seasonStats).length) {
      entry.season = { ...entry.season, ...seasonStats };
    }
  }

  const teamStats = extractGameStats(lastGameData, opponent);
  for (const stat of teamStats) {
    const rosterMatch = stat.id ? rosterById.get(stat.id) : rosterByName.get(normalizeName(stat.name));
    const entry = getOrCreatePlayer(combined, stat.id, stat.name, rosterMatch, stat.pos);
    entry.last_game = mergeStatObjects(entry.last_game, stat.stats);
    if (opponent && entry.last_game && !entry.last_game.opp) {
      entry.last_game.opp = opponent;
    }
  }

  const players = Array.from(combined.values())
    .map((player) => finalizePlayer(player, rosterById))
    .filter((player) => Number.isFinite(player.id));

  const offenseSeason = players.filter((player) => player.side === 'offense' && hasStats(player.season));
  const defenseSeason = players.filter((player) => player.side === 'defense' && hasStats(player.season));
  const offenseLast = players.filter((player) => player.side === 'offense' && hasStats(player.last_game));
  const defenseLast = players.filter((player) => player.side === 'defense' && hasStats(player.last_game));

  const featuredCandidate = offenseLast[0] || defenseLast[0] || offenseSeason[0] || defenseSeason[0] || players[0] || null;

  return {
    offense_last: offenseLast,
    defense_last: defenseLast,
    offense_season: offenseSeason,
    defense_season: defenseSeason,
    featured: featuredCandidate || null,
    metadata: {
      season: SEASON_YEAR,
      lastGameId,
      lastGameDate
    }
  };
}

function ensureSpotlightId(row) {
  if (!row || typeof row !== 'object') return null;
  let id = Number(row.id);
  if (!Number.isFinite(id) && typeof row.espn === 'string') {
    const match = row.espn.match(/\/id\/(\d+)\//);
    if (match) id = Number(match[1]);
  }
  if (!Number.isFinite(id)) return null;
  return { ...row, id };
}

function sealSpotlightEntry(row, rosterIds) {
  const normalized = ensureSpotlightId(row);
  if (!normalized) return null;
  if (!rosterIds.has(Number(normalized.id))) return null;
  return normalized;
}

function sealSpotlightArray(rows, rosterIds) {
  return (rows || []).map((row) => sealSpotlightEntry(row, rosterIds)).filter(Boolean);
}

function sealSpotlightPayload(payload, rosterIds) {
  const offenseLast = sealSpotlightArray(payload.offense_last, rosterIds);
  const defenseLast = sealSpotlightArray(payload.defense_last, rosterIds);
  const offenseSeason = sealSpotlightArray(payload.offense_season, rosterIds);
  const defenseSeason = sealSpotlightArray(payload.defense_season, rosterIds);
  const featured = sealSpotlightEntry(payload.featured, rosterIds);

  return {
    ...payload,
    offense_last: offenseLast,
    defense_last: defenseLast,
    offense_season: offenseSeason,
    defense_season: defenseSeason,
    featured: featured || null
  };
}

function getOrCreatePlayer(map, id, name, rosterMatch, inferredPos) {
  const key = Number.isFinite(id) ? `id:${id}` : `name:${normalizeName(name)}`;
  if (!map.has(key)) {
    const rosterPos = rosterMatch?.pos || inferredPos || '';
    map.set(key, {
      id: Number.isFinite(id) ? id : rosterMatch?.id ?? null,
      name,
      pos: normalizePos(rosterPos),
      number: rosterMatch?.number ?? null,
      side: sideFromPos(rosterPos),
      espn: Number.isFinite(id) ? buildEspnLink(id, name) : rosterMatch?.id ? buildEspnLink(rosterMatch.id, rosterMatch.name) : '',
      season: {},
      last_game: {}
    });
  }
  return map.get(key);
}

function finalizePlayer(player, rosterById) {
  const rosterMatch = Number.isFinite(player.id) ? rosterById.get(player.id) : null;
  const merged = {
    id: player.id ?? rosterMatch?.id ?? null,
    name: player.name,
    pos: normalizePos(player.pos || rosterMatch?.pos),
    number: player.number ?? rosterMatch?.number ?? null,
    espn: player.espn || (Number.isFinite(player.id) ? buildEspnLink(player.id, player.name) : ''),
    last_game: cleanStats(player.last_game),
    season: cleanStats(player.season)
  };
  if (!merged.pos && rosterMatch?.pos) {
    merged.pos = rosterMatch.pos;
  }
  if (!merged.espn && Number.isFinite(merged.id)) {
    merged.espn = buildEspnLink(merged.id, merged.name);
  }
  merged.side = sideFromPos(merged.pos || rosterMatch?.pos);
  if (merged.number == null) delete merged.number;
  if (!merged.last_game) delete merged.last_game;
  if (!merged.season) delete merged.season;
  if (!merged.espn) delete merged.espn;
  delete merged.side;
  return merged;
}

function mergeStatObjects(base, addition) {
  const output = { ...(base || {}) };
  for (const [key, value] of Object.entries(addition || {})) {
    if (value == null || value === '') continue;
    if (!(key in output) || !output[key]) {
      output[key] = value;
    }
  }
  return output;
}

function cleanStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const entries = Object.entries(stats)
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
    .filter(([, value]) => value != null && value !== '' && !(typeof value === 'object' && !Object.keys(value).length));
  if (!entries.length) return null;
  return Object.fromEntries(entries);
}

function hasStats(stats) {
  return !!cleanStats(stats);
}

function summarizeSeasonStats(row) {
  const out = {};
  const pos = normalizePos(row.position || row.pos);
  const games = row.games ?? row.gamesPlayed ?? row.gp;
  if (games) out.games = String(games);
  if (pos === 'QB') {
    const completions = row.completions ?? row.passingCompletions;
    const attempts = row.attempts ?? row.passingAttempts;
    if (completions != null && attempts != null) out.cmp_att = `${completions}/${attempts}`;
    if (row.passingYards != null) out.yds = String(row.passingYards);
    if (row.passingTouchdowns != null) out.td = String(row.passingTouchdowns);
    if (row.interceptions != null) out.int = String(row.interceptions);
  } else if (['RB', 'HB', 'FB', 'TB'].includes(pos)) {
    if (row.rushingAttempts != null) out.att = String(row.rushingAttempts);
    if (row.rushingYards != null) out.yds = String(row.rushingYards);
    if (row.rushingTouchdowns != null) out.td = String(row.rushingTouchdowns);
  } else if (['WR', 'TE'].includes(pos)) {
    if (row.receptions != null) out.rec = String(row.receptions);
    if (row.receivingYards != null) out.yds = String(row.receivingYards);
    if (row.receivingTouchdowns != null) out.td = String(row.receivingTouchdowns);
  } else {
    if (row.tackles != null) out.tackles = String(row.tackles);
    if (row.tacklesForLoss != null) out.tfl = String(row.tacklesForLoss);
    if (row.sacks != null) out.sacks = String(row.sacks);
    if (row.interceptions != null) out.int = String(row.interceptions);
  }
  return cleanStats(out) || {};
}

function extractGameStats(raw, opponent) {
  const teams = Array.isArray(raw?.teams) ? raw.teams : [];
  const out = [];
  const teamEntry = teams.find((team) => {
    const school = (team?.school || team?.team || team?.name || '').toString().toLowerCase();
    return school.includes('kentucky');
  });
  if (!teamEntry) return out;
  for (const category of teamEntry.categories || []) {
    for (const type of category.types || []) {
      const typeName = (type.name || category.name || '').toString();
      for (const athlete of type.athletes || []) {
        const id = Number(athlete.id ?? athlete.athleteId ?? athlete.playerId);
        const name = (athlete.name || athlete.athlete?.displayName || athlete.athlete?.fullName || '').trim();
        if (!name) continue;
        const stats = mapGameStat(typeName, athlete.stats || []);
        if (opponent) stats.opp = opponent;
        const pos = normalizePos(athlete.position || athlete.pos || athlete.athlete?.position?.abbreviation);
        out.push({ id: Number.isFinite(id) ? id : null, name, pos, stats });
      }
    }
  }
  return out;
}

function mapGameStat(typeName, statsArray) {
  const stats = (statsArray || []).map((value) => (value == null ? '' : String(value).trim()));
  const key = typeName.toLowerCase();
  const out = {};
  if (key === 'passing') {
    if (stats[0]) out.cmp_att = stats[0].replace('-', '/');
    if (stats[1]) out.yds = stats[1];
    if (stats[2]) out.td = stats[2];
    if (stats[3]) out.int = stats[3];
  } else if (key === 'rushing') {
    if (stats[0]) out.att = stats[0];
    if (stats[1]) out.yds = stats[1];
    if (stats[2]) out.td = stats[2];
  } else if (key === 'receiving') {
    if (stats[0]) out.rec = stats[0];
    if (stats[1]) out.yds = stats[1];
    if (stats[2]) out.td = stats[2];
  } else if (key === 'defense') {
    if (stats[0]) out.tackles = stats[0];
    if (stats[3]) out.tfl = stats[3];
    if (stats[4]) out.sacks = stats[4];
    if (stats[7]) out.int = stats[7];
  } else if (key === 'interceptions') {
    if (stats[0]) out.int = stats[0];
    if (stats[1]) out.yds = stats[1];
    if (stats[3]) out.td = stats[3];
  } else if (key === 'kick returns') {
    if (stats[0]) out.kr = stats[0];
    if (stats[1]) out.yds = stats[1];
    if (stats[2]) out.td = stats[2];
  } else if (key === 'punt returns') {
    if (stats[0]) out.pr = stats[0];
    if (stats[1]) out.yds = stats[1];
    if (stats[2]) out.td = stats[2];
  } else if (key === 'punting') {
    if (stats[0]) out.punts = stats[0];
    if (stats[1]) out.yds = stats[1];
    if (stats[2]) out.avg = stats[2];
  } else if (key === 'kicking') {
    if (stats[0]) out.fgm_fga = stats[0].replace('-', '/');
    if (stats[1]) out.long = stats[1];
    if (stats[3]) out.pts = stats[3];
  } else {
    const normalizedKey = key.replace(/\s+/g, '_');
    const value = stats.filter(Boolean).join(' / ');
    if (value) out[normalizedKey] = value;
  }
  return cleanStats(out) || {};
}

async function persistSpotlight(payload, cacheSummary) {
  const targets = {
    offense_last: 'spotlight_offense_last.json',
    defense_last: 'spotlight_defense_last.json',
    offense_season: 'spotlight_offense_season.json',
    defense_season: 'spotlight_defense_season.json'
  };

  for (const [key, file] of Object.entries(targets)) {
    const rows = Array.isArray(payload[key]) ? payload[key] : [];
    await writeSpotlightFile(path.join(DATA_DIR, file), rows, cacheSummary, key);
  }

  await writeSpotlightFeatured(path.join(DATA_DIR, 'spotlight_featured.json'), payload.featured, cacheSummary);
  await writeJSON(path.join(DATA_DIR, 'spotlight_history.json'), payload.metadata || {});
}

async function writeSpotlightFile(fullPath, rows, summary, label) {
  const finalRows = rows.filter((row) => Number.isFinite(row.id));
  let output = finalRows;
  if (!finalRows.length) {
    const existing = await readJSON(fullPath, []);
    if (existing.length) {
      console.warn(`[${label}] no fresh data — keeping existing file (${existing.length} rows).`);
      output = existing;
    } else {
      throw new Error(`Spotlight ${label} has no data to write.`);
    }
  }
  await writeJSON(fullPath, output);
  await saveLastGood(fullPath, output);
  if (summary) summary.push(`write:${label} rows=${output.length}`);
}

async function writeSpotlightFeatured(fullPath, entry, summary) {
  let output = entry && Number.isFinite(entry.id) ? entry : null;
  if (!output) {
    const existing = await readJSON(fullPath, null);
    if (existing && Number.isFinite(existing.id)) {
      console.warn('[featured] using existing featured entry.');
      output = existing;
    } else {
      throw new Error('Spotlight featured entry missing.');
    }
  }
  await writeJSON(fullPath, output);
  await saveLastGood(fullPath, output);
  if (summary) summary.push('write:featured');
}

async function saveLastGood(fullPath, data) {
  const fileName = path.basename(fullPath);
  const target = path.join(LAST_GOOD_DIR, fileName);
  await writeJSON(target, data);
}

async function writeJSON(fullPath, data) {
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(data, null, 2));
}

async function readJSON(fullPath, fallback = null) {
  try {
    const raw = await readFile(fullPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function normalizePos(value) {
  if (!value) return '';
  return String(value).trim().toUpperCase();
}

function normalizeNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(String(value).replace(/[^0-9.-]/g, ''));
  if (Number.isFinite(num)) return num;
  const str = String(value).trim();
  return str || null;
}

function normalizeHeight(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;
  const feetInchesMatch = str.match(/(\d+)[-'\s]*(\d+)?/);
  if (feetInchesMatch) {
    const feet = feetInchesMatch[1];
    const inches = feetInchesMatch[2] || '0';
    return `${feet}-${inches}`;
  }
  return str;
}

function normalizeClass(value) {
  if (!value) return null;
  const str = String(value).trim().toUpperCase();
  const map = {
    FR: 'FR',
    FRESHMAN: 'FR',
    RFR: 'RFR',
    RSFR: 'RFR',
    SO: 'SO',
    SOPHOMORE: 'SO',
    JR: 'JR',
    JUNIOR: 'JR',
    SR: 'SR',
    SENIOR: 'SR',
    GR: 'GR',
    GRADUATE: 'GR'
  };
  return map[str] || str || null;
}

function sideFromPos(pos) {
  const normalized = normalizePos(pos);
  if (OFFENSE_POSITIONS.has(normalized)) return 'offense';
  if (DEFENSE_POSITIONS.has(normalized)) return 'defense';
  return 'offense';
}

function buildEspnLink(id, name) {
  const slug = slugify(name);
  return `https://www.espn.com/college-football/player/_/id/${id}/${slug}`;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(obj) {
  const out = {};
  Object.entries(obj || {}).forEach(([key, value]) => {
    if (value == null || value === '') return;
    out[key] = value;
  });
  return out;
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m ago`;
  }
  return `${remainingMinutes}m ago`;
}

main().catch((error) => {
  console.error('❌ spotlight build failed:', error.stack || error.message);
  process.exit(1);
});
