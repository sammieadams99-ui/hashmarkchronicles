#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import { readFile } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROSTER_PATH = path.join(DATA_DIR, 'team', 'roster.json');
const SPOTLIGHT_FILES = [
  { id: 'offense_last', path: path.join(DATA_DIR, 'spotlight_offense_last.json') },
  { id: 'defense_last', path: path.join(DATA_DIR, 'spotlight_defense_last.json') },
  { id: 'offense_season', path: path.join(DATA_DIR, 'spotlight_offense_season.json') },
  { id: 'defense_season', path: path.join(DATA_DIR, 'spotlight_defense_season.json') }
];
const FEATURED_PATH = path.join(DATA_DIR, 'spotlight_featured.json');
const BLACKLIST = ['ray davis', 'will levis'];

async function main() {
  const roster = await readJsonArray(ROSTER_PATH, 'roster');
  validateRoster(roster);

  const rosterIdSet = new Set();
  const rosterNameSet = new Set();
  roster.forEach((player) => {
    const numericId = Number(player.id);
    if (Number.isFinite(numericId)) rosterIdSet.add(numericId);
    const normName = normalizeName(player.name);
    if (normName) rosterNameSet.add(normName);
  });

  const summary = [];
  for (const file of SPOTLIGHT_FILES) {
    const rows = await readJsonArray(file.path, file.id);
    const report = validateSpotlightArray(rows, file.id, rosterIdSet, rosterNameSet);
    summary.push({ label: file.id, ...report });
  }

  const featured = await readJsonObject(FEATURED_PATH, 'featured');
  validateSpotlightEntry(featured, 'featured');
  const featuredId = resolveId(featured);
  if (Number.isFinite(featuredId) && !rosterIdSet.has(featuredId)) {
    const normName = normalizeName(featured.name);
    if (!rosterNameSet.has(normName)) {
      throw new Error(`Spotlight featured id ${featuredId} not present in roster`);
    }
  }

  printSummary(summary, roster.length);
}

async function readJsonArray(file, label) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    throw new Error(`${label} expected array`);
  } catch (error) {
    throw new Error(`Failed to read ${label}: ${error.message}`);
  }
}

async function readJsonObject(file, label) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    throw new Error(`${label} expected object`);
  } catch (error) {
    throw new Error(`Failed to read ${label}: ${error.message}`);
  }
}

function validateRoster(roster) {
  if (roster.length < 65 || roster.length > 150) {
    throw new Error(`Roster size ${roster.length} outside expected range (65-150)`);
  }
  const withIds = roster.filter((player) => Number.isFinite(Number(player.id))).length;
  if (withIds / roster.length < 0.9) {
    throw new Error('Roster must contain numeric ids for at least 90% of players');
  }
  for (const player of roster) {
    const normName = normalizeName(player.name);
    if (normName && BLACKLIST.includes(normName)) {
      throw new Error(`Roster includes blacklisted name: ${player.name}`);
    }
  }
}

function validateSpotlightArray(rows, label, rosterIdSet, rosterNameSet) {
  let total = 0;
  let missingId = 0;
  let mismatches = 0;
  const seen = new Set();
  for (const row of rows) {
    total += 1;
    validateSpotlightEntry(row, label);
    const athleteId = resolveId(row);
    if (!Number.isFinite(athleteId)) {
      missingId += 1;
    } else {
      if (!rosterIdSet.has(athleteId)) {
        const normName = normalizeName(row.name);
        if (!rosterNameSet.has(normName)) {
          mismatches += 1;
        }
      }
      seen.add(athleteId);
    }
  }
  const missRate = total === 0 ? 0 : mismatches / total;
  if (missRate > 0.05) {
    throw new Error(`Spotlight ${label} mismatch rate ${(missRate * 100).toFixed(1)}% exceeds 5% threshold`);
  }
  if (missingId > 0) {
    throw new Error(`Spotlight ${label} has ${missingId} entries without ids`);
  }
  return { total, mismatches, unique: seen.size };
}

function validateSpotlightEntry(entry, label) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Spotlight ${label} entry is not an object`);
  }
  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error(`Spotlight ${label} entry missing name`);
  }
  const normName = normalizeName(entry.name);
  if (normName && BLACKLIST.includes(normName)) {
    throw new Error(`Spotlight ${label} includes blacklisted player: ${entry.name}`);
  }
  const id = resolveId(entry);
  if (!Number.isFinite(id)) {
    throw new Error(`Spotlight ${label} entry ${entry.name} missing numeric id`);
  }
  if (!entry.espn || typeof entry.espn !== 'string') {
    throw new Error(`Spotlight ${label} entry ${entry.name} missing ESPN link`);
  }
  if (!hasStats(entry.last_game) && !hasStats(entry.season)) {
    throw new Error(`Spotlight ${label} entry ${entry.name} missing stats`);
  }
}

function resolveId(entry) {
  if (entry == null || typeof entry !== 'object') return NaN;
  const idFields = ['id', 'athleteId', 'athlete_id'];
  for (const field of idFields) {
    if (field in entry) {
      const raw = entry[field];
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
  }
  if (entry.espn && typeof entry.espn === 'string') {
    const match = entry.espn.match(/\/id\/(\d+)\//);
    if (match) return Number(match[1]);
  }
  return NaN;
}

function hasStats(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Object.values(obj).some((value) => value != null && value !== '');
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function printSummary(rows, rosterSize) {
  console.log('spotlight validation summary');
  console.log('roster size:', rosterSize);
  console.table(
    rows.map((row) => ({
      dataset: row.label,
      entries: row.total,
      mismatches: row.mismatches,
      uniqueIds: row.unique
    }))
  );
}

main().catch((error) => {
  console.error('❌ dataset validation failed:', error.message);
  process.exit(1);
});
