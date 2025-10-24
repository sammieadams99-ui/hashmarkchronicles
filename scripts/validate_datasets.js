#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const useFixture = argv.includes('--fixture');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TEAM_DIR = path.join(DATA_DIR, 'team');
const ARTIFACT_STATUS = path.join(ROOT, 'artifacts', 'status', 'last-good-roster.flag');
const TEAM_ID = Number(process.env.TEAM_ID || 96);
const TARGET_SEASON = Number(process.env.SEASON || 2025);
const STRICT_SEASON = (process.env.STRICT_SEASON ?? 'true').toLowerCase() === 'true';

function readJSONSafe(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (fallback !== null) return fallback;
    fail(`failed to read ${filePath}: ${error.message}`);
  }
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function softExit(message) {
  console.warn(`⚠️  ${message}`);
  process.exit(0);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

if (useFixture) {
  const roster = readJSONSafe(path.join(ROOT, 'fixtures', `roster_${TARGET_SEASON}.json`), []);
  const spotlight = readJSONSafe(path.join(ROOT, 'fixtures', 'spotlight_last.json'), []);
  const rosterIds = new Set(roster.map((player) => Number(player.id)).filter((id) => Number.isFinite(id)));
  if (roster.length === 0) fail('fixture roster missing entries');
  for (const row of spotlight) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) fail('fixture spotlight missing id');
    if (!rosterIds.has(id)) fail('fixture spotlight id not in roster');
  }
  console.log('✅ fixtures ok');
  process.exit(0);
}

const metaPath = path.join(TEAM_DIR, 'roster_meta.json');
const rosterPath = path.join(TEAM_DIR, 'roster.json');
const meta = readJSONSafe(metaPath);
const roster = readJSONSafe(rosterPath, []);

if (!meta || typeof meta !== 'object') fail('roster_meta.json missing');
if (!Array.isArray(roster) || roster.length === 0) softExit('roster missing — builder should reuse cache');

const metaSeason = Number(meta.season);
if (meta.teamId !== TEAM_ID) fail(`teamId must equal ${TEAM_ID}`);
if (!Number.isFinite(metaSeason)) fail('roster_meta season must be numeric');
if (metaSeason !== TARGET_SEASON) {
  fail(`season must equal ${TARGET_SEASON}`);
}
const allowedSources = new Set(['espn', 'espn+uka', 'cache']);
if (!allowedSources.has(meta.source)) fail('source must be one of "espn", "espn+uka", or "cache"');
if (!meta.generated_at) fail('generated_at timestamp missing');
if (STRICT_SEASON && meta.strict === false) fail('strict flag must remain enabled under STRICT_SEASON');

if (roster.length < 65 || roster.length > 150) {
  fail(`roster size ${roster.length} out of range (65-150)`);
}

const rosterIds = new Set();
const rosterNames = new Set();
for (const player of roster) {
  if (!player || typeof player !== 'object') fail('roster entry must be object');
  const id = Number(player.id);
  const name = player.name;
  if (!Number.isFinite(id)) fail(`roster entry missing numeric id for ${name || 'unknown'}`);
  if (!name) fail('roster entry missing name');
  if (rosterIds.has(id)) fail(`duplicate roster id detected: ${id}`);
  rosterIds.add(id);
  rosterNames.add(name);
  if (!player.headshot || !player.headshot.includes(`/players/full/${id}.png`)) {
    fail(`invalid headshot url for ${name}`);
  }
}

const idCoverage = rosterIds.size / roster.length;
if (idCoverage < 0.98) {
  if (fs.existsSync(ARTIFACT_STATUS)) {
    softExit(`id coverage ${idCoverage.toFixed(3)} below threshold but last-good cache flagged`);
  }
  fail(`id coverage ${idCoverage.toFixed(3)} below 0.98`);
}

validateEspnMap();
validateSpotlightFiles();
validateBlacklist();
randomRosterAudit();

console.log('✅ dataset validation ok');

function validateEspnMap() {
  const mapPath = path.join(DATA_DIR, 'espn_map.json');
  const map = readJSONSafe(mapPath, {});
  const validKeys = new Set();
  for (const name of rosterNames) {
    validKeys.add(name);
    validKeys.add(slugify(name));
  }
  for (const [key, value] of Object.entries(map)) {
    if (!validKeys.has(key)) {
      fail(`espn_map contains foreign key: ${key}`);
    }
    const id = Number(value);
    if (!rosterIds.has(id)) {
      fail(`espn_map id ${id} not in roster`);
    }
  }
}

function validateSpotlightFiles() {
  const files = [
    ['spotlight_offense_last.json', 'offense_last'],
    ['spotlight_defense_last.json', 'defense_last'],
    ['spotlight_offense_season.json', 'offense_season'],
    ['spotlight_defense_season.json', 'defense_season'],
    ['spotlight_featured.json', 'featured']
  ];
  for (const [relative, label] of files) {
    const payload = readJSONSafe(path.join(DATA_DIR, relative), []);
    if (!Array.isArray(payload)) fail(`${label}: expected array`);
    const seen = new Set();
    for (const row of payload) {
      if (!row || typeof row !== 'object') fail(`${label}: invalid row`);
      const id = Number(row.id);
      if (!Number.isFinite(id)) fail(`${label}: missing id`);
      if (!rosterIds.has(id)) fail(`${label}: id ${id} not in roster`);
      if (seen.has(id)) fail(`${label}: duplicate id ${id}`);
      seen.add(id);
    }
  }
}

function validateBlacklist() {
  const blacklistPath = path.join(DATA_DIR, 'blacklist_names.json');
  if (!fs.existsSync(blacklistPath)) return;
  const names = readJSONSafe(blacklistPath, []);
  const rosterLower = new Set([...rosterNames].map((name) => name.toLowerCase()));
  for (const name of names) {
    if (typeof name !== 'string') continue;
    if (rosterLower.has(name.toLowerCase())) {
      fail(`blacklist names include active roster member: ${name}`);
    }
  }
  const spotlightNames = [];
  const spotlightFiles = [
    'spotlight_offense_last.json',
    'spotlight_defense_last.json',
    'spotlight_offense_season.json',
    'spotlight_defense_season.json',
    'spotlight_featured.json'
  ];
  for (const file of spotlightFiles) {
    const rows = readJSONSafe(path.join(DATA_DIR, file), []);
    for (const row of rows) {
      if (row?.name) {
        spotlightNames.push(row.name.toLowerCase());
      }
    }
  }
  for (const name of names) {
    if (spotlightNames.includes(name.toLowerCase())) {
      fail(`blacklist names include spotlight row: ${name}`);
    }
  }
}

function randomRosterAudit() {
  const sample = [];
  const players = [...roster];
  const take = Math.min(3, players.length);
  while (sample.length < take && players.length) {
    const index = Math.floor(Math.random() * players.length);
    const [player] = players.splice(index, 1);
    if (!player) continue;
    if (!Number.isFinite(Number(player.id))) fail('random audit: missing id');
    if (!player.headshot.includes(`/players/full/${player.id}.png`)) fail(`random audit: invalid headshot for ${player.name}`);
    sample.push(player);
  }
}
