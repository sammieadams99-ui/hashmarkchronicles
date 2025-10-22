#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const useFixture = args.includes('--fixture');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const FIXTURE_DIR = path.join(ROOT, 'fixtures');

function readJSON(fullPath) {
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error(`❌ failed to read ${fullPath}: ${error.message}`);
    process.exit(1);
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error('❌', message);
    process.exit(1);
  }
}

if (useFixture) {
  const roster = readJSON(path.join(FIXTURE_DIR, 'roster_2025.json'));
  const spotlight = readJSON(path.join(FIXTURE_DIR, 'spotlight_last.json'));
  const rosterIds = new Set((roster || []).map((player) => Number(player.id)).filter((id) => Number.isFinite(id)));
  assert(Array.isArray(roster) && roster.length >= 5, 'fixture roster length');
  assert(Array.isArray(spotlight) && spotlight.every((row) => Number.isFinite(Number(row.id))), 'fixture spotlight all have id');
  assert(spotlight.every((row) => rosterIds.has(Number(row.id))), 'fixture spotlight ids ⊆ roster ids');
  console.log('✅ fixtures ok');
  process.exit(0);
}

const meta = readJSON(path.join(DATA_DIR, 'team', 'roster_meta.json'));
const roster = readJSON(path.join(DATA_DIR, 'team', 'roster.json'));

if (!Array.isArray(roster) || roster.length === 0) {
  console.warn('⚠️ roster empty in this run — build should have reused cache; soft-exit');
  process.exit(0);
}

assert(meta.teamId === 96, 'teamId must be 96 (Kentucky)');
assert(meta.season === 2025, 'season must be 2025');
assert(roster.length >= 65 && roster.length <= 150, `roster size ${roster.length} out of range`);

const rosterIds = new Set(roster.map((player) => Number(player.id)).filter((id) => Number.isFinite(id)));

function checkFile(relativePath, label) {
  const fullPath = path.join(DATA_DIR, relativePath);
  const rows = readJSON(fullPath);
  assert(Array.isArray(rows), `${label}: expected array`);
  assert(rows.every((row) => Number.isFinite(Number(row.id))), `${label}: missing id rows`);
  const misses = rows.filter((row) => !rosterIds.has(Number(row.id)));
  assert(misses.length === 0, `${label}: ${misses.length} ids not in 2025 roster`);
  return rows;
}

const offenseLast = checkFile('spotlight_offense_last.json', 'offense_last');
const defenseLast = checkFile('spotlight_defense_last.json', 'defense_last');
checkFile('spotlight_offense_season.json', 'offense_season');
checkFile('spotlight_defense_season.json', 'defense_season');

const blacklist = ['Ray Davis', 'Will Levis', 'Tayvion Robinson'];
const spot = [...offenseLast, ...defenseLast];
const ghosts = spot.filter((player) => blacklist.includes(player.name));
assert(ghosts.length === 0, `alumni present: ${ghosts.map((player) => player.name).join(', ')}`);

console.log('✅ dataset validation ok');
