#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { DRY, LOG, writeJSON, retry, readJSON } from './lib/stability.js';

const TEAM_ID = 96;
const SEASON = 2025;
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
    const players = await loadRoster();
    const normalized = normalizeRoster(players);
    const idCoverage = computeIdCoverage(normalized);

    if (!normalized.length) {
      throw new Error('Roster payload was empty after normalization');
    }

    const meta = {
      teamId: TEAM_ID,
      season: SEASON,
      source: 'espn',
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
      if (Array.isArray(result) && result.length > 0) {
        return result;
      }
    } catch (error) {
      errors.push(error);
      if (LOG === 'debug') {
        console.warn(`strategy ${strategy.name} failed`, error);
      }
    }
  }

  const fallback = loadLastGoodRoster();
  if (fallback) {
    usedLastGood = true;
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
      }
    });
    if (!response.ok) {
      throw new Error(`API responded with status ${response.status}`);
    }
    return response.json();
  }, [250, 600, 1200]);

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
  return players;
}

async function fetchRosterFromPage() {
  const html = await retry(async () => {
    const response = await fetch(ESPN_ROSTER_URL, {
      headers: {
        'User-Agent': 'hashmark-chronicles/1.0 (+https://hashmarkchronicles.com)',
        Accept: 'text/html'
      }
    });
    if (!response.ok) {
      throw new Error(`Page responded with status ${response.status}`);
    }
    return response.text();
  }, [250, 600, 1200]);

  const jsonCandidates = extractJsonCandidates(html);
  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const rosterNodes = findAllRosterNodes(node);
        if (rosterNodes.length) {
          return rosterNodes;
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

function loadLastGoodRoster() {
  const current = readJSON(ROSTER_PATH, null);
  if (isViableRoster(current)) {
    return current;
  }
  const legacyConverted = transformLegacyRoster(current);
  if (isViableRoster(legacyConverted)) {
    console.warn('⚠️  transformed legacy roster payload');
    usedLastGood = true;
    return legacyConverted;
  }
  const fixturePath = path.join(ROOT, 'fixtures', 'roster_2025.json');
  const fixture = readJSON(fixturePath, null);
  if (isViableRoster(fixture)) {
    console.warn('⚠️  falling back to fixture roster payload');
    usedLastGood = true;
    return fixture;
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

main();
