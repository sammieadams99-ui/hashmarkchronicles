#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { DRY, LOG, writeJSON, retry, readJSON } from './lib/stability.js';

const TEAM_ID = Number(process.env.TEAM_ID || 96);
const DEFAULT_SEASON = 2025;
const TARGET_SEASON = Number(process.env.SEASON || DEFAULT_SEASON);
const STRICT_SEASON = (process.env.STRICT_SEASON ?? 'true').toLowerCase() === 'true';
const PURGE_IF_SEASON_MISMATCH = (process.env.PURGE_IF_SEASON_MISMATCH ?? 'true').toLowerCase() === 'true';
const ESPN_BACKOFF = parseBackoff(process.env.ESPN_BACKOFF || '250,600,1200');
const ESPN_TIMEOUT = Number(process.env.ESPN_TIMEOUT || 9000);

const ESPN_ROSTER_URL = `https://www.espn.com/college-football/team/roster/_/id/${TEAM_ID}/kentucky-wildcats`;
const ESPN_TEAM_API = `https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/teams/${TEAM_ID}?enable=roster`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TEAM_DIR = path.join(DATA_DIR, 'team');
const ROSTER_PATH = path.join(TEAM_DIR, 'roster.json');
const META_PATH = path.join(TEAM_DIR, 'roster_meta.json');
const ROSTER_PLUS_PATH = path.join(TEAM_DIR, 'roster_plus.json');
const STATUS_DIR = path.join(ROOT, 'artifacts', 'status');

let usedLastGood = false;

async function main() {
  try {
    let { players, detectedSeason, seasonResolvedFrom } = await loadRoster();

    const targetSeason = TARGET_SEASON;
    const strict = STRICT_SEASON;
    const purgeIfMismatch = PURGE_IF_SEASON_MISMATCH;

    let source = seasonResolvedFrom || 'espn';
    let detected = Number.isFinite(Number(detectedSeason)) ? Number(detectedSeason) : null;

    if (!Array.isArray(players) || players.length === 0) {
      warn('ESPN roster empty; attempt last-good reuse or alt provider');
      const fallback = loadLastGoodRoster({ targetSeason, strict });
      if (!fallback) {
        throw new Error('No roster data available after fallback attempts');
      }
      ({ players, detectedSeason: detected, seasonResolvedFrom: source } = fallback);
    } else if (strict && detected && detected !== targetSeason) {
      warn(`Detected season ${detected} != target ${targetSeason}`);
      const ukaFallback = attemptUkaIntersection(players, targetSeason, detected);
      if (ukaFallback) {
        ({ players, detectedSeason: detected, seasonResolvedFrom: source } = ukaFallback);
      } else if (purgeIfMismatch) {
        throw new Error('Season mismatch; aborting roster write to prevent publishing wrong year');
      } else {
        const cached = readSafe('data/team/roster_meta.json', null);
        if (!cached || Number(cached.season) !== targetSeason) {
          throw new Error('Season mismatch and last-good not for target season');
        }
        info('Reusing last-good roster for correct season');
        const fallback = loadLastGoodRoster({ targetSeason, strict: true });
        if (!fallback) {
          throw new Error('Season mismatch and last-good roster unavailable for target season');
        }
        ({ players, detectedSeason: detected, seasonResolvedFrom: source } = fallback);
      }
    }

    if (!Array.isArray(players) || players.length === 0) {
      throw new Error('No roster payload available after fallbacks');
    }

    const normalized = normalizeRoster(players);
    const idCoverage = computeIdCoverage(normalized);

    if (!normalized.length) {
      throw new Error('Roster payload was empty after normalization');
    }

    const meta = {
      teamId: TEAM_ID,
      season: targetSeason,
      source: source || 'espn',
      strict,
      lastGoodReuse: usedLastGood,
      generated_at: new Date().toISOString()
    };

    writeJSON(ROSTER_PATH, normalized);
    writeJSON(META_PATH, meta);

    const rosterPlus = buildRosterPlus(normalized);
    writeJSON(ROSTER_PLUS_PATH, rosterPlus);

    if (!DRY) {
      fs.mkdirSync(STATUS_DIR, { recursive: true });
      const flagPath = path.join(STATUS_DIR, 'last-good-roster.flag');
      if (usedLastGood) {
        fs.writeFileSync(flagPath, 'true');
      } else if (fs.existsSync(flagPath)) {
        fs.rmSync(flagPath);
      }
    }

    console.log(`✅ roster build complete — ${normalized.length} players, id coverage ${(idCoverage * 100).toFixed(2)}%`);
    if (usedLastGood) {
      console.log('ℹ️  using last-good cache for roster payload');
    }
  } catch (error) {
    console.error('❌ roster build failed:', error.message);
    process.exitCode = 1;
  }
}

async function loadRoster() {
  const strategies = [fetchRosterFromApi, fetchRosterFromPage];
  const errors = [];
  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (Array.isArray(result?.players) && result.players.length > 0) {
        return result;
      }
    } catch (error) {
      errors.push(error);
      if (LOG === 'debug') {
        console.warn(`strategy ${strategy.name} failed`, error);
      }
    }
  }

  const fallback = loadLastGoodRoster({ targetSeason: TARGET_SEASON, strict: STRICT_SEASON });
  if (fallback) {
    warn('Using last-good roster payload after ESPN fetch failure');
    return fallback;
  }

  const combinedMessage = errors.map((err) => err?.message || String(err)).join(' | ');
  throw new Error(`Unable to load roster from ESPN: ${combinedMessage || 'no strategies succeeded'}`);
}

async function fetchRosterFromApi() {
  const payload = await retry(async () => {
    const response = await fetch(ESPN_TEAM_API, {
      headers: {
        'User-Agent': 'hashmark-chronicles/1.0 (+https://hashmarkchronicles.com)',
        Accept: 'application/json'
      },
      timeout: ESPN_TIMEOUT
    });
    if (!response.ok) {
      throw new Error(`API responded with status ${response.status}`);
    }
    return response.json();
  }, ESPN_BACKOFF);

  const groups = payload?.team?.athletes || payload?.athletes || [];
  const players = [];
  for (const group of groups) {
    const items = group?.items || group?.athletes || [];
    for (const player of items) {
      if (!player) continue;
      const core = player.athlete || player;
      players.push(core);
    }
  }
  if (!players.length) {
    throw new Error('API payload missing athlete list');
  }

  const detectedSeason = extractSeasonFromApi(payload);
  return { players, detectedSeason, seasonResolvedFrom: 'espn' };
}

async function fetchRosterFromPage() {
  const html = await retry(async () => {
    const response = await fetch(ESPN_ROSTER_URL, {
      headers: {
        'User-Agent': 'hashmark-chronicles/1.0 (+https://hashmarkchronicles.com)',
        Accept: 'text/html'
      },
      timeout: ESPN_TIMEOUT
    });
    if (!response.ok) {
      throw new Error(`Page responded with status ${response.status}`);
    }
    return response.text();
  }, ESPN_BACKOFF);

  let detectedSeason = detectSeasonFromHtml(html);
  const jsonCandidates = extractJsonCandidates(html);
  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!detectedSeason) {
          const fromNode = findSeasonInNode(node);
          if (Number.isFinite(fromNode)) {
            detectedSeason = Number(fromNode);
          }
        }
        const rosterNodes = findAllRosterNodes(node);
        if (rosterNodes.length) {
          return { players: rosterNodes, detectedSeason, seasonResolvedFrom: 'espn' };
        }
      }
    } catch (error) {
      continue;
    }
  }
  throw new Error('Unable to parse roster JSON from page');
}

function extractJsonCandidates(html) {
  const candidates = [];
  const nuxtMatch = html.match(/window\["__NUXT_DATA__"\]\s*=\s*(\{.*?\});/s);
  if (nuxtMatch) {
    candidates.push(nuxtMatch[1]);
  }
  const scriptMatches = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([^<]+)<\/script>/g)];
  for (const [, json] of scriptMatches) {
    candidates.push(json);
  }
  return candidates;
}

function detectSeasonFromHtml(html) {
  const headingMatch = html.match(/<h[12][^>]*>\s*(\d{4})[^<]*Roster/iu);
  if (headingMatch) {
    const value = Number(headingMatch[1]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function findSeasonInNode(node) {
  const seen = new Set();
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const candidates = [];
    if (typeof current.season === 'object' && current.season) {
      candidates.push(current.season.year, current.season.season, current.season.displayYear);
    }
    candidates.push(current.season, current.year, current.seasonYear);
    if (typeof current.header === 'object' && current.header) {
      candidates.push(current.header.season, current.header.seasonYear);
      if (typeof current.header.season === 'object') {
        candidates.push(current.header.season.year);
      }
    }
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value > 1900) {
        return value;
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return null;
}

function findAllRosterNodes(node) {
  const results = [];
  if (!node || typeof node !== 'object') return results;
  if (Array.isArray(node)) {
    for (const item of node) {
      results.push(...findAllRosterNodes(item));
    }
    return results;
  }
  if (node.items && Array.isArray(node.items) && node.items.every((item) => item?.athlete || item?.id)) {
    for (const item of node.items) {
      const athlete = item?.athlete || item;
      if (athlete?.id) {
        results.push(athlete);
      }
    }
  }
  for (const value of Object.values(node)) {
    results.push(...findAllRosterNodes(value));
  }
  return results;
}

function extractSeasonFromApi(payload) {
  const candidates = [
    payload?.team?.season?.year,
    payload?.team?.record?.season?.year,
    payload?.season?.year,
    payload?.team?.nextEvent?.season?.year,
    payload?.team?.previousEvent?.season?.year
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 1900) {
      return value;
    }
  }
  const groups = payload?.team?.athletes || [];
  for (const group of groups) {
    const items = group?.items || group?.athletes || [];
    for (const player of items) {
      const season = player?.athlete?.season?.year || player?.season?.year;
      const value = Number(season);
      if (Number.isFinite(value) && value > 1900) {
        return value;
      }
    }
  }
  return null;
}

function attemptUkaIntersection(players, targetSeason, detectedSeason) {
  const ukaRoster = readSafe('data/team/uka_roster.json', null);
  if (!Array.isArray(ukaRoster) || ukaRoster.length === 0) {
    return null;
  }
  const ukaMeta = readSafe('data/team/uka_meta.json', null);
  const ukaSeason = Number(ukaMeta?.season);
  const allow = (Number(detectedSeason) === targetSeason) || (Number(ukaSeason) === targetSeason);
  const ukaNames = new Set(
    ukaRoster
      .map((row) => normalizeName(row?.name || row?.displayName || row?.fullName || null))
      .filter(Boolean)
  );
  if (!ukaNames.size) {
    return null;
  }
  const filtered = players.filter((player) => ukaNames.has(normalizeName(player?.displayName || player?.fullName || player?.name)));
  if (!filtered.length) {
    return null;
  }
  if (!allow) {
    warn('UKA intersection available but season metadata does not match target');
    return null;
  }
  info(`Using ESPN+UKA intersection fallback (${filtered.length} players)`);
  return { players: filtered, detectedSeason: targetSeason, seasonResolvedFrom: 'espn+uka' };
}

function loadLastGoodRoster({ targetSeason, strict } = {}) {
  const meta = readSafe('data/team/roster_meta.json', null);
  const roster = readJSON(ROSTER_PATH, null);
  if (Array.isArray(roster) && roster.length) {
    if (!strict || Number(meta?.season) === targetSeason) {
      usedLastGood = true;
      return { players: roster, detectedSeason: Number(meta?.season) || null, seasonResolvedFrom: 'cache' };
    }
  }
  if (!strict) {
    const legacyConverted = transformLegacyRoster(roster);
    if (isViableRoster(legacyConverted)) {
      usedLastGood = true;
      return { players: legacyConverted, detectedSeason: targetSeason || Number(meta?.season) || null, seasonResolvedFrom: 'cache' };
    }
  }
  const fixture = loadFixtureRoster(targetSeason);
  if (fixture) {
    usedLastGood = true;
    return fixture;
  }
  return null;
}

function loadFixtureRoster(targetSeason) {
  if (!Number.isFinite(targetSeason)) {
    return null;
  }
  const fixturePath = path.join(ROOT, 'fixtures', `roster_${targetSeason}.json`);
  const fixture = readJSON(fixturePath, null);
  if (isViableRoster(fixture)) {
    warn(`Falling back to roster fixture for season ${targetSeason}`);
    return { players: fixture, detectedSeason: targetSeason, seasonResolvedFrom: 'cache' };
  }
  return null;
}

function isViableRoster(roster) {
  if (!Array.isArray(roster)) return false;
  if (roster.length < 65) return false;
  const withIds = roster.filter((player) => {
    const candidate = Number(player.id ?? player.athleteId);
    return Number.isFinite(candidate) && candidate > 0;
  });
  return withIds.length / roster.length >= 0.65;
}

function transformLegacyRoster(roster) {
  if (!Array.isArray(roster) || roster.length === 0) return null;
  const knownIds = buildKnownIdMap();
  const converted = [];
  for (const player of roster) {
    if (!player || typeof player !== 'object') continue;
    const name = player.name || [player.firstName, player.lastName].filter(Boolean).join(' ');
    if (!name) continue;
    const lookupKey = name.toLowerCase();
    const id = knownIds.get(lookupKey) || stableIdFromName(name);
    converted.push({
      id,
      name,
      pos: player.position || player.pos || null,
      number: Number.isFinite(Number(player.jersey)) ? Number(player.jersey) : null,
      class: player.class || player.year || null,
      height: player.height || null,
      weight: Number.isFinite(Number(player.weight)) ? Number(player.weight) : null,
      profile_url: null,
      headshot: `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`
    });
  }
  return converted;
}

function stableIdFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return 3000000 + (hash % 6000000);
}

function buildKnownIdMap() {
  const sources = [
    path.join(ROOT, 'fixtures', 'roster_2025.json'),
    path.join(ROOT, 'data', 'spotlight_offense_last.json'),
    path.join(ROOT, 'data', 'spotlight_offense_season.json'),
    path.join(ROOT, 'data', 'spotlight_defense_last.json'),
    path.join(ROOT, 'data', 'spotlight_defense_season.json'),
    path.join(ROOT, 'data', 'spotlight_featured.json')
  ];
  const map = new Map();
  for (const source of sources) {
    const payload = readJSON(source, []);
    const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const name = row.name || row.displayName;
      const id = Number(row.id);
      if (!name || !Number.isFinite(id)) continue;
      const key = name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, id);
      }
    }
  }
  return map;
}

function normalizeRoster(players) {
  const normalized = [];
  for (const player of players) {
    if (!player) continue;
    const id = Number(player.id ?? player.athleteId ?? player.athlete?.id ?? player.playerId);
    if (!Number.isFinite(id)) continue;
    const name = player.displayName || player.fullName || player.name || [player.firstName, player.lastName].filter(Boolean).join(' ');
    if (!name) continue;

    const pos = player.position?.abbreviation || player.position?.displayName || player.pos || null;
    const number = Number.isFinite(Number(player.jersey || player.uniform || player.number))
      ? Number(player.jersey || player.uniform || player.number)
      : null;
    const classYear = player.class || player.experienceClass || player.year || null;
    const height = parseHeight(player?.displayHeight || player.height || player.ht || null);
    const weight = Number(player.displayWeight || player.weight || player.wt);
    const profileUrl = player.links?.find?.((link) => /player\//.test(link.href))?.href || player.profileUrl || null;

    normalized.push({
      id,
      name,
      pos: pos || null,
      number: Number.isFinite(number) ? number : null,
      class: classYear || null,
      height: height || null,
      weight: Number.isFinite(weight) ? Number(weight) : null,
      profile_url: profileUrl,
      headshot: `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`
    });
  }
  const deduped = dedupeById(normalized);
  return deduped.sort((a, b) => a.name.localeCompare(b.name));
}

function parseHeight(value) {
  if (!value) return null;
  if (typeof value === 'string' && value.includes('-')) {
    return value;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  return String(value);
}

function dedupeById(players) {
  const seen = new Map();
  for (const player of players) {
    if (!seen.has(player.id)) {
      seen.set(player.id, player);
    }
  }
  return Array.from(seen.values());
}

function buildRosterPlus(players) {
  const byId = {};
  const byName = {};
  for (const player of players) {
    byId[player.id] = player;
    byName[player.name.toLowerCase()] = player.id;
  }
  return { byId, byName, count: players.length };
}

function computeIdCoverage(players) {
  if (!players.length) return 0;
  const withId = players.filter((player) => Number.isFinite(player.id));
  return withId.length / players.length;
}

function normalizeName(value) {
  if (!value || typeof value !== 'string') return null;
  return value.trim().toLowerCase();
}

function readSafe(relativePath, fallback) {
  const filePath = path.join(ROOT, relativePath);
  return readJSON(filePath, fallback);
}

function warn(message) {
  console.warn(`⚠️  ${message}`);
}

function info(message) {
  console.log(`ℹ️  ${message}`);
}

function parseBackoff(input) {
  if (!input) return [250, 600, 1200];
  const parts = String(input)
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return parts.length ? parts : [250, 600, 1200];
}

main();
