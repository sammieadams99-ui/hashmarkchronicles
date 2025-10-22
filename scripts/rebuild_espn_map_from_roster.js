#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJSON, readJSON } from './lib/stability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ROSTER_PATH = path.join(ROOT, 'data', 'team', 'roster.json');
const MAP_PATH = path.join(ROOT, 'data', 'espn_map.json');

function main() {
  const roster = readJSON(ROSTER_PATH, []);
  if (!Array.isArray(roster) || roster.length === 0) {
    console.error('❌ unable to rebuild map — roster missing');
    process.exitCode = 1;
    return;
  }

  const map = {};
  for (const player of roster) {
    if (!player || !player.name || !Number.isFinite(Number(player.id))) continue;
    const id = Number(player.id);
    map[player.name] = id;
    map[slugify(player.name)] = id;
  }

  writeJSON(MAP_PATH, map);
  console.log(`✅ rebuilt espn_map.json with ${Object.keys(map).length} entries`);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

main();
