#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { writeJSON, retry, readJSON, LOG } from './lib/stability.js';

const TEAM_ID = 96;
const SEASON = 2025;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TEAM_DIR = path.join(DATA_DIR, 'team');

const SPOTLIGHT_TARGETS = {
  offense_last: 'data/spotlight_offense_last.json',
  defense_last: 'data/spotlight_defense_last.json',
  offense_season: 'data/spotlight_offense_season.json',
  defense_season: 'data/spotlight_defense_season.json',
  featured: 'data/spotlight_featured.json'
};

const ESPN_SCHEDULE_URL = `https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/teams/${TEAM_ID}/schedule`;
const ESPN_SUMMARY_URL = (eventId) => `https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=${eventId}`;
const ESPN_LEADERS_URL = `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/teams/${TEAM_ID}/leaders?season=${SEASON}`;

async function main() {
  try {
    const rosterPath = path.join(TEAM_DIR, 'roster.json');
    const roster = readJSON(rosterPath, []);
    if (!Array.isArray(roster) || roster.length === 0) {
      throw new Error('Roster unavailable — run build_espn_roster.js first');
    }

    const rosterIds = new Set(roster.map((player) => Number(player.id)).filter((id) => Number.isFinite(id)));
    const nameToId = new Map(
      roster.map((player) => [player.name.toLowerCase(), Number(player.id)]).filter(([, id]) => Number.isFinite(id))
    );

    const outputs = await buildSpotlightPayload(rosterIds, nameToId);
    for (const [key, relativePath] of Object.entries(SPOTLIGHT_TARGETS)) {
      const filePath = path.join(ROOT, relativePath);
      const rows = ensureRosterCoverage(outputs[key] || [], rosterIds, nameToId, key);
      writeJSON(filePath, rows);
    }

    console.log('✅ spotlight build complete');
  } catch (error) {
    console.error('❌ spotlight build failed:', error.message);
    process.exitCode = 1;
  }
}

async function buildSpotlightPayload(rosterIds, nameToId) {
  const fallbacks = loadExistingSpotlights();
  try {
    const seasonLeaders = await loadSeasonLeaders();
    const lastGame = await loadLastGameLeaders();

    const payload = {
      offense_last: selectLeaders(lastGame.offense, rosterIds, nameToId),
      defense_last: selectLeaders(lastGame.defense, rosterIds, nameToId),
      offense_season: selectLeaders(seasonLeaders.offense, rosterIds, nameToId),
      defense_season: selectLeaders(seasonLeaders.defense, rosterIds, nameToId),
      featured: selectFeatured(seasonLeaders, lastGame, rosterIds, nameToId)
    };

    if (Object.values(payload).every((rows) => rows.length > 0)) {
      return payload;
    }

    throw new Error('ESPN payload incomplete');
  } catch (error) {
    if (LOG === 'debug') {
      console.warn('spotlight build using fallback', error);
    } else {
      console.warn('⚠️  spotlight build using last-good cache');
    }
    return fallbacks;
  }
}

function loadExistingSpotlights() {
  const out = {};
  for (const [key, relativePath] of Object.entries(SPOTLIGHT_TARGETS)) {
    const filePath = path.join(ROOT, relativePath);
    const raw = readJSON(filePath, []);
    out[key] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  }
  return out;
}

function ensureRosterCoverage(rows, rosterIds, nameToId, label) {
  const seen = new Set();
  const output = [];
  let dropped = 0;
  for (const row of rows) {
    const enriched = normalizeSpotlightRow(row, nameToId);
    if (!enriched) {
      dropped += 1;
      continue;
    }
    if (!rosterIds.has(enriched.id)) {
      dropped += 1;
      continue;
    }
    if (seen.has(enriched.id)) {
      continue;
    }
    seen.add(enriched.id);
    output.push(enriched);
  }
  if (dropped > 0) {
    console.log(`ℹ️  ${label}: dropped ${dropped} rows outside roster scope`);
  }
  return output;
}

function normalizeSpotlightRow(row, nameToId) {
  if (!row || typeof row !== 'object') return null;
  let id = Number(row.id);
  if (!Number.isFinite(id) && typeof row.espn === 'string') {
    const match = row.espn.match(/\/id\/(\d+)/);
    if (match) {
      id = Number(match[1]);
    }
  }
  if (!Number.isFinite(id) && row.name) {
    id = nameToId.get(row.name.toLowerCase()) || null;
  }
  if (!Number.isFinite(id)) return null;
  const name = row.name || null;
  if (!name) return null;
  return { ...row, id };
}

async function loadSeasonLeaders() {
  const json = await fetchJson(ESPN_LEADERS_URL);
  const categories = json?.categories || json?.leaders || [];
  const offense = [];
  const defense = [];
  for (const category of categories) {
    const type = (category?.displayCategory || category?.name || '').toLowerCase();
    const isDefense = /def/i.test(type) || ['tackles', 'sacks', 'interceptions'].some((key) => type.includes(key));
    const bucket = isDefense ? defense : offense;
    const leaders = category?.leaders || category?.athletes || [];
    for (const leader of leaders) {
      const athlete = leader?.athlete || leader;
      if (!athlete) continue;
      bucket.push({
        id: Number(athlete.id),
        name: athlete.displayName || athlete.fullName,
        pos: athlete.position?.abbreviation || null,
        espn: athlete.links?.find?.((link) => /player\//.test(link.href))?.href || null,
        stats: leader?.statistics || leader?.stats || null
      });
    }
  }
  return { offense, defense };
}

async function loadLastGameLeaders() {
  const schedule = await fetchJson(ESPN_SCHEDULE_URL);
  const events = schedule?.events || [];
  const completed = events
    .filter((event) => event?.status?.type?.completed)
    .sort((a, b) => new Date(b.date || b.startDate || 0) - new Date(a.date || a.startDate || 0));
  const lastEvent = completed[0];
  if (!lastEvent) {
    throw new Error('No completed events in schedule');
  }
  const summary = await fetchJson(ESPN_SUMMARY_URL(lastEvent.id || lastEvent.eventId));
  const categories = summary?.leaders?.leaders || [];
  const offense = [];
  const defense = [];
  for (const category of categories) {
    const displayName = (category?.displayName || category?.name || '').toLowerCase();
    const isDefense = /def/i.test(displayName) || ['tackles', 'sacks', 'interceptions'].some((key) => displayName.includes(key));
    const bucket = isDefense ? defense : offense;
    for (const leader of category?.leaders || []) {
      const athlete = leader?.athlete || leader?.athleteId || leader;
      if (!athlete) continue;
      const player = typeof athlete === 'object' ? athlete : { id: athlete };
      bucket.push({
        id: Number(player.id),
        name: player.displayName || player.fullName || player.name,
        pos: player.position?.abbreviation || null,
        espn: player.links?.find?.((link) => /player\//.test(link.href))?.href || null,
        last_game: leader?.statistics || leader?.stats || leader?.summary || null
      });
    }
  }
  return { offense, defense };
}

function selectLeaders(entries, rosterIds, nameToId) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    const normalized = normalizeSpotlightRow(entry, nameToId);
    if (!normalized) continue;
    if (!rosterIds.has(normalized.id)) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    output.push(normalized);
  }
  return output.slice(0, 5);
}

function selectFeatured(season, lastGame, rosterIds, nameToId) {
  const pool = [...(season.offense || []), ...(lastGame.offense || []), ...(season.defense || []), ...(lastGame.defense || [])];
  const unique = selectLeaders(pool, rosterIds, nameToId);
  return unique.slice(0, 6);
}

async function fetchJson(url) {
  return retry(async () => {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'hashmark-chronicles/1.0 (+https://hashmarkchronicles.com)',
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }
    return response.json();
  }, [250, 600, 1200]);
}

main();
