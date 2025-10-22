const FS = await import('fs/promises');
const TEAM = process.env.TEAM || 'Kentucky';
let YEAR = Number(process.env.YEAR || new Date().getUTCFullYear());
if (new Date().getUTCMonth() < 6) YEAR -= 1; // season rolls

const KEY = process.env.CFBD_KEY || '';
const MODE = (process.env.FALLBACK_MODE || '').toLowerCase(); // '', 'espn', 'cfbfastr'

const DATA_FILES = {
  offense_last: 'data/spotlight_offense_last.json',
  defense_last: 'data/spotlight_defense_last.json',
  offense_season: 'data/spotlight_offense_season.json',
  defense_season: 'data/spotlight_defense_season.json',
  featured: 'data/spotlight_featured.json'
};
const ROSTER_FILE = 'data/roster.json';
const ROSTER_PLUS_FILE = 'data/team/roster_plus.json';
const TEAM_ROSTER_FILE = 'data/team/roster.json';

async function readJSONSafe(path) {
  try {
    const raw = await FS.readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

async function readArray(path) {
  const data = await readJSONSafe(path);
  return Array.isArray(data) ? data : [];
}

const CACHE = {
  offense_last: await readArray(DATA_FILES.offense_last),
  defense_last: await readArray(DATA_FILES.defense_last),
  offense_season: await readArray(DATA_FILES.offense_season),
  defense_season: await readArray(DATA_FILES.defense_season),
  featured: await readArray(DATA_FILES.featured),
  roster: await readArray(ROSTER_FILE),
  roster_plus: await readArray(ROSTER_PLUS_FILE),
  team_roster: await readArray(TEAM_ROSTER_FILE)
};

async function cfbd(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const url = `https://api.collegefootballdata.com${path}${q ? `?${q}` : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error(`${path} non-JSON ${ct}`);
  return r.json();
}
const POS_SIDE = (p) => {
  const pos = (p.position || p.pos || '').toUpperCase();
  if (['QB', 'RB', 'WR', 'TE', 'FB', 'HB', 'TB', 'SB', 'OT', 'OG', 'C', 'OL'].includes(pos)) return 'offense';
  if (['DL', 'DE', 'DT', 'NT', 'LB', 'OLB', 'ILB', 'CB', 'DB', 'S', 'FS', 'SS', 'STAR', 'NICKEL'].includes(pos)) return 'defense';
  return 'offense';
};
const OFFENSE_POS = new Set(['QB', 'RB', 'WR', 'TE', 'FB', 'HB', 'TB', 'SB', 'OT', 'OG', 'C', 'OL']);
const take = (n, a) => (Array.isArray(a) ? a : []).slice(0, n);

function keyFor(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const id = entry.athleteId ?? entry.athlete_id ?? entry.id ?? null;
  if (id != null) return `id:${id}`;
  const name = (entry.name || entry.player || entry.fullName || entry.full_name || '').trim();
  if (!name) return '';
  const pos = (entry.pos || entry.position || '').toUpperCase();
  return `${name.toLowerCase()}|${pos}`;
}

function buildCacheMap(cache) {
  const map = new Map();
  const ingest = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const key = keyFor(item);
      if (!key) continue;
      if (!map.has(key)) map.set(key, { ...item });
    }
  };
  ingest(cache.offense_last);
  ingest(cache.defense_last);
  ingest(cache.offense_season);
  ingest(cache.defense_season);
  ingest(cache.featured);
  ingest(cache.roster);
  ingest(cache.team_roster);
  return map;
}

const PREVIOUS_MAP = buildCacheMap(CACHE);

function coerceJersey(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isNaN(num)) return num;
  const str = String(value).trim();
  return str || null;
}

function hasStatData(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return value !== '';
}

function normalizeEntry(entry, prev = {}) {
  const athleteId = entry?.athleteId ?? entry?.athlete_id ?? entry?.id ?? prev?.athleteId ?? prev?.athlete_id ?? null;
  const rawName = (entry?.name || entry?.player || entry?.fullName || entry?.full_name || prev?.name || '').trim();
  const pos = (entry?.pos || entry?.position || prev?.pos || '').toUpperCase();
  const jersey = coerceJersey(entry?.jersey ?? entry?.jerseyNumber ?? entry?.number ?? prev?.jersey ?? prev?.jerseyNumber ?? null);
  const headshot = entry?.headshot || entry?.image || entry?.photo || prev?.headshot || '';
  const espn = entry?.espn || entry?.url || entry?.link || entry?.href || prev?.espn || prev?.url || '';
  const side = (entry?.side || prev?.side || (OFFENSE_POS.has(pos) ? 'offense' : 'defense')).toLowerCase();
  const lastGame = entry?.last_game || entry?.lastGame || entry?.stats?.lastGame || prev?.last_game || prev?.lastGame || null;
  const season = entry?.season || entry?.stats?.season || prev?.season || null;
  return {
    athleteId: athleteId != null ? Number(athleteId) : null,
    name: rawName,
    pos,
    jersey,
    headshot,
    espn,
    side: side === 'defense' ? 'defense' : 'offense',
    last_game: hasStatData(lastGame) ? lastGame : (hasStatData(prev?.last_game) ? prev.last_game : null),
    season: hasStatData(season) ? season : (hasStatData(prev?.season) ? prev.season : null)
  };
}

function combinePlayers(rowsAll = [], rowsLast = []) {
  const map = new Map();
  for (const [key, prev] of PREVIOUS_MAP.entries()) {
    const base = normalizeEntry(prev);
    if (base.name) map.set(key, base);
  }

  for (const row of rowsAll) {
    const key = keyFor(row);
    if (!key) continue;
    const prev = map.get(key) || {};
    const normalized = normalizeEntry(row, prev);
    const next = { ...prev };
    if (normalized.name) next.name = normalized.name;
    if (normalized.athleteId != null) next.athleteId = normalized.athleteId;
    if (normalized.pos) next.pos = normalized.pos;
    if (normalized.side) next.side = normalized.side;
    if (normalized.jersey != null) next.jersey = normalized.jersey;
    if (normalized.headshot) next.headshot = normalized.headshot;
    if (normalized.espn) next.espn = normalized.espn;
    if (hasStatData(normalized.season)) next.season = normalized.season;
    if (hasStatData(normalized.last_game)) next.last_game = normalized.last_game;
    map.set(key, next);
  }

  for (const row of rowsLast) {
    const key = keyFor(row);
    if (!key) continue;
    const prev = map.get(key) || {};
    const normalized = normalizeEntry(row, prev);
    const next = { ...prev };
    if (normalized.name) next.name = normalized.name;
    if (normalized.athleteId != null) next.athleteId = normalized.athleteId;
    if (normalized.pos) next.pos = normalized.pos;
    if (normalized.side) next.side = normalized.side;
    if (normalized.jersey != null) next.jersey = normalized.jersey;
    if (normalized.headshot) next.headshot = normalized.headshot;
    if (normalized.espn) next.espn = normalized.espn;
    if (hasStatData(normalized.last_game)) next.last_game = normalized.last_game;
    if (hasStatData(normalized.season)) next.season = normalized.season;
    map.set(key, next);
  }

  const players = Array.from(map.values()).filter((p) => p && p.name).sort((a, b) => a.name.localeCompare(b.name));
  const offenseSeason = players.filter((p) => (p.side || 'offense') === 'offense');
  const defenseSeason = players.filter((p) => (p.side || 'offense') === 'defense');
  const offenseLast = players.filter((p) => (p.side || 'offense') === 'offense' && hasStatData(p.last_game));
  const defenseLast = players.filter((p) => (p.side || 'offense') === 'defense' && hasStatData(p.last_game));
  const featuredCandidates = players.filter((p) => hasStatData(p.last_game) || hasStatData(p.season));

  return {
    players,
    spotlight: {
      offense_last: take(50, offenseLast.length ? offenseLast : offenseSeason),
      defense_last: take(50, defenseLast.length ? defenseLast : defenseSeason),
      offense_season: take(50, offenseSeason),
      defense_season: take(50, defenseSeason),
      featured: take(6, featuredCandidates.length ? featuredCandidates : players)
    }
  };
}

async function persistSpotlight(spotlight) {
  await FS.mkdir('data', { recursive: true });
  const reused = [];
  for (const [key, path] of Object.entries(DATA_FILES)) {
    const rows = Array.isArray(spotlight[key]) ? spotlight[key] : [];
    const fallback = CACHE[key] || [];
    const final = rows.length ? rows : fallback;
    if (!rows.length && fallback.length) reused.push(key);
    await FS.writeFile(path, JSON.stringify(final, null, 2));
    CACHE[key] = final;
  }
  if (reused.length) {
    console.log('[spotlight] reused cached spotlight data for', reused.join(', '));
  }
}

function splitNameParts(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts.shift() || '';
  const last = parts.join(' ');
  return { first: first || null, last: last || null };
}

function initialsFromName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'UK';
  const [first, ...rest] = parts;
  const last = rest.join('');
  const combo = (first?.[0] || '') + (last?.[0] || (rest[0]?.[0] || ''));
  return combo ? combo.toUpperCase() : parts.map((p) => p[0]).join('').slice(0, 2).toUpperCase() || 'UK';
}

async function persistRoster(players) {
  await FS.mkdir('data', { recursive: true });
  await FS.mkdir('data/team', { recursive: true });

  const simple = players.map((p) => ({
    athleteId: p.athleteId ?? null,
    name: p.name,
    pos: p.pos || '',
    jersey: p.jersey ?? null,
    headshot: p.headshot || '',
    espn: p.espn || '',
    side: p.side || 'offense',
    last_game: p.last_game || null,
    season: p.season || null
  })).filter((p) => p.name);

  const plus = players.map((p) => ({
    athleteId: p.athleteId ?? null,
    name: p.name,
    position: p.pos || '',
    side: p.side || 'offense',
    jersey: p.jersey ?? null,
    headshot: p.headshot || '',
    espn: p.espn || '',
    stats: {
      season: p.season || null,
      lastGame: p.last_game || null
    }
  })).filter((p) => p.name);

  const team = players.map((p) => {
    const parts = splitNameParts(p.name);
    return {
      athleteId: p.athleteId ?? null,
      name: p.name,
      firstName: parts.first,
      lastName: parts.last,
      position: p.pos || '',
      jersey: p.jersey ?? null,
      headshot: p.headshot || null,
      initials: initialsFromName(p.name),
      stats: hasStatData(p.season) || hasStatData(p.last_game)
        ? { season: p.season || null, lastGame: p.last_game || null }
        : null
    };
  }).filter((p) => p.name);

  const finalRoster = simple.length ? simple : CACHE.roster;
  const finalPlus = plus.length ? plus : CACHE.roster_plus;
  const finalTeam = team.length ? team : CACHE.team_roster;

  await FS.writeFile(ROSTER_FILE, JSON.stringify(finalRoster, null, 2));
  await FS.writeFile(ROSTER_PLUS_FILE, JSON.stringify(finalPlus, null, 2));
  await FS.writeFile(TEAM_ROSTER_FILE, JSON.stringify(finalTeam, null, 2));

  CACHE.roster = finalRoster;
  CACHE.roster_plus = finalPlus;
  CACHE.team_roster = finalTeam;
}

async function persistAll(rowsAll, rowsLast) {
  const combined = combinePlayers(rowsAll, rowsLast);
  await persistSpotlight(combined.spotlight);
  await persistRoster(combined.players);
  return combined;
}

async function ensureOutputsFromCache() {
  const rewrites = [];
  for (const [key, path] of Object.entries(DATA_FILES)) {
    const current = await readArray(path);
    if (!current.length && CACHE[key]?.length) {
      await FS.writeFile(path, JSON.stringify(CACHE[key], null, 2));
      rewrites.push(key);
    }
  }
  if (!(await readArray(ROSTER_FILE)).length && CACHE.roster.length) {
    await FS.writeFile(ROSTER_FILE, JSON.stringify(CACHE.roster, null, 2));
    rewrites.push('roster');
  }
  if (!(await readArray(ROSTER_PLUS_FILE)).length && CACHE.roster_plus.length) {
    await FS.writeFile(ROSTER_PLUS_FILE, JSON.stringify(CACHE.roster_plus, null, 2));
    rewrites.push('roster_plus');
  }
  if (!(await readArray(TEAM_ROSTER_FILE)).length && CACHE.team_roster.length) {
    await FS.writeFile(TEAM_ROSTER_FILE, JSON.stringify(CACHE.team_roster, null, 2));
    rewrites.push('team_roster');
  }
  if (rewrites.length) {
    console.log('[spotlight] ensured cached data for', rewrites.join(', '));
  }
}

// MODE overrides to force fallback quickly
if (MODE === 'espn') {
  console.log('[spotlight] FORCED ESPN fallback');
  const { buildSpotlightFromESPN } = await import('./fallback_unofficial.js');
  await buildSpotlightFromESPN(TEAM);
  process.exit(0);
}
if (MODE === 'cfbfastr') {
  console.log('[spotlight] FORCED cfbfastR fallback');
  const { buildSpotlightFromCFBfastR } = await import('./fallback_cfbfastr.js');
  await buildSpotlightFromCFBfastR(TEAM, YEAR);
  process.exit(0);
}

// CFBD: season-first (stable)
let seasonPlayers = [];
let lastPlayers = [];
try {
  const season = await cfbd('/player/season', { team: TEAM, year: YEAR });
  seasonPlayers = season.map((s) => ({
    athleteId: s.athleteId ?? null,
    name: s.player || '',
    position: s.position || '',
    side: POS_SIDE(s),
    season: s,
  }));
  console.log('[spotlight] CFBD season count:', seasonPlayers.length);

  // last game (one try; fallback allowed)
  const games = await cfbd('/games', { year: YEAR, team: TEAM, seasonType: 'regular' });
  const done = (games || []).filter((g) => g.completed).sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
  if (done[0]) {
    const gid = done[0].id;
    const r = await fetch(`https://api.collegefootballdata.com/game/player/statistics?gameId=${gid}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await r.json();
      const out = [];
      for (const t of data.teams || []) {
        const school = (t.school || t.team || '').toLowerCase();
        if (!school.includes(TEAM.toLowerCase())) continue;
        const seen = new Map();
        for (const cat of t.categories || []) {
          for (const ty of cat.types || []) {
            for (const a of ty.athletes || []) {
              const id = a.id ?? a.athleteId ?? null;
              const key = id ? `id:${id}` : `name:${(a.name || '').toLowerCase()}`;
              const prev =
                seen.get(key) || {
                  athleteId: id,
                  name: a.name || '',
                  position: (a.position || a.pos || '').toUpperCase(),
                  side: POS_SIDE(a),
                  lastGame: {},
                };
              prev.lastGame[ty.name] = a.stats;
              seen.set(key, prev);
            }
          }
        }
        out.push(...seen.values());
      }
      lastPlayers = out;
    }
  }
  await persistAll(seasonPlayers, lastPlayers);
  console.log('[spotlight] CFBD wrote spotlight files (season:', seasonPlayers.length, 'last:', lastPlayers.length, ')');
} catch (e) {
  console.warn('[spotlight] CFBD failed:', e.message);
  // ESPN fallback
  try {
    const { buildSpotlightFromESPN } = await import('./fallback_unofficial.js');
    await buildSpotlightFromESPN(TEAM);
    console.log('[spotlight] Spotlight build succeeded via ESPN fallback');
  } catch (e2) {
    console.warn('[spotlight] ESPN fallback failed:', e2.message);
    const { buildSpotlightFromCFBfastR } = await import('./fallback_cfbfastr.js');
    await buildSpotlightFromCFBfastR(TEAM, YEAR);
    console.log('[spotlight] Spotlight build succeeded via cfbfastR fallback');
  }
}

await ensureOutputsFromCache();
