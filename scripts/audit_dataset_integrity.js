#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON } from './lib/stability.js';

const argv = new Set(process.argv.slice(2));
const SLOW = argv.has('--deep') || (process.env.SLOW_AUDIT || '').toLowerCase() === 'true';

const TARGET_SEASON = Number(process.env.SEASON || 2025);
const STRICT_SEASON = (process.env.STRICT_SEASON ?? 'true').toLowerCase() === 'true';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TEAM_DIR = path.join(DATA_DIR, 'team');

function main() {
  const dataMetaPath = path.join(DATA_DIR, 'meta.json');
  const dataMeta = readJSON(dataMetaPath, null);
  if (!dataMeta) {
    fail('data/meta.json missing');
  }

  if (Number(dataMeta.season) !== TARGET_SEASON) {
    fail(`data/meta.json season ${dataMeta.season} mismatch (expected ${TARGET_SEASON})`);
  }

  if (!['live', 'cache'].includes(dataMeta.mode)) {
    fail('data/meta.json mode must be "live" or "cache"');
  }

  if (!dataMeta.generated_at) {
    fail('data/meta.json missing generated_at timestamp');
  }

  if (STRICT_SEASON && dataMeta.mode === 'cache') {
    warn('STRICT_SEASON true but meta.mode=cache — investigate data source availability');
  }

  if (typeof dataMeta.strict === 'boolean' && dataMeta.strict !== STRICT_SEASON) {
    warn(`meta.strict flag (${dataMeta.strict}) differs from STRICT_SEASON=${STRICT_SEASON}`);
  }

  const rosterPath = path.join(TEAM_DIR, 'roster.json');
  const roster = readJSON(rosterPath, []);
  if (!Array.isArray(roster) || roster.length === 0) {
    fail('team roster payload missing or empty');
  }

  if (Number(dataMeta.rosterCount) !== roster.length) {
    fail(`meta rosterCount ${dataMeta.rosterCount} mismatch (actual ${roster.length})`);
  }

  const rosterMetaPath = path.join(TEAM_DIR, 'roster_meta.json');
  const rosterMeta = readJSON(rosterMetaPath, null);
  if (!rosterMeta) {
    fail('team roster metadata missing');
  }

  if (Number(rosterMeta.season) !== TARGET_SEASON) {
    fail(`roster_meta season ${rosterMeta.season} mismatch (expected ${TARGET_SEASON})`);
  }

  if (SLOW) {
    auditForStaleArtifacts();
  } else {
    quickStaleScan();
  }

  console.log('🧪 dataset audit ok');
}

function auditForStaleArtifacts() {
  const stale = findStaleArtifacts(DATA_DIR).concat(findStaleArtifacts(TEAM_DIR));
  if (stale.length) {
    fail(`stale dataset artifacts detected: ${stale.join(', ')}`);
  }
}

function quickStaleScan() {
  const suspects = findStaleArtifacts(TEAM_DIR);
  if (suspects.length) {
    fail(`stale team artifacts detected: ${suspects.join(', ')}`);
  }
}

function findStaleArtifacts(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  return entries.filter((entry) => /2023|2024|backup|old/i.test(entry));
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`⚠️  ${message}`);
}

main();
