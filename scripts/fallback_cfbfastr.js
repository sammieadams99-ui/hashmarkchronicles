import fs from 'fs/promises';
import { execFile } from 'child_process';
import { setDefaultResultOrder } from 'dns';

try {
  setDefaultResultOrder('ipv4first');
} catch {}

function fetchText(url){
  return new Promise((resolve, reject) => {
    const child = execFile('curl', ['-fsSL', '--no-progress-meter', url], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.url = url;
        reject(err);
        return;
      }
      resolve(stdout);
    });
    child.on('error', reject);
  });
}

function isNotFound(error){
  if (!error) return false;
  if (typeof error.code === 'number' && error.code === 22) {
    const txt = String(error.stderr || error.message || '').toLowerCase();
    if (txt.includes('404')) return true;
  }
  return false;
}

async function getCSV(url){
  const text = await fetchText(url);
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map(row => {
    const cols = row.split(',');
    const obj = {};
    headers.forEach((h,i)=> obj[h] = cols[i]);
    return obj;
  });
}

// 1) Roster (season-level; many seasons available)
// Kentucky example: filter by team == "Kentucky"
export async function cfbRosterPlus(teamName, year){
  const startYear = Number.isFinite(Number(year)) ? Number(year) : new Date().getUTCFullYear();
  let chosenYear = startYear;
  let rows = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1){
    const targetYear = startYear - attempt;
    const url = `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/rosters/csv/cfb_rosters_${targetYear}.csv`;
    try {
      rows = await getCSV(url);
      chosenYear = targetYear;
      if (!Array.isArray(rows) || !rows.length) {
        console.warn(`[fallback-cfbfastR] roster_${targetYear}.csv returned no rows`);
      }
      break;
    } catch (err) {
      lastError = err;
      if (isNotFound(err) && attempt < 2) {
        console.log(`[fallback-cfbfastR] roster_${targetYear}.csv missing; trying ${targetYear - 1}`);
        continue;
      }
      throw err;
    }
  }
  if (!rows) throw lastError || new Error('No roster rows');
  const want = String(teamName).toLowerCase();
  const out = rows.filter(r => (r.team||'').toLowerCase().includes(want)).map(r => {
    const fullName = (r.name || `${r.first_name || ''} ${r.last_name || ''}`).trim();
    return {
      athleteId: r.athlete_id ? Number(r.athlete_id) : null,
      name: fullName,
      firstName: r.first_name || null,
      lastName: r.last_name || null,
      position: (r.position||'').toUpperCase(),
      jersey: r.jersey || null,
      headshot: null,
      stats: { season: null, lastGame: null }
    };
  });
  await fs.mkdir('data/team', { recursive: true });
  await fs.writeFile('data/team/roster_plus.json', JSON.stringify(out, null, 2));
  return { count: out.length, year: chosenYear };
}

// 2) Season player stats (optional, slower)
// Map by athleteId/name and attach into roster_plus
export async function cfbAttachSeasonStats(teamName, year){
  const url = `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/player_stats/csv/player_stats_${year}.csv`;
  const rows = await getCSV(url);
  const want = String(teamName).toLowerCase();
  const teamRows = rows.filter(r => (r.team||'').toLowerCase().includes(want));
  // index by athleteId/name
  const idx = new Map();
  for (const r of teamRows){
    const id = r.athlete_id ? `id:${r.athlete_id}` : `name:${(r.player||'').toLowerCase()}`;
    const prev = idx.get(id) || [];
    prev.push(r);
    idx.set(id, prev);
  }
  // attach
  const raw = JSON.parse(await fs.readFile('data/team/roster_plus.json','utf8'));
  for (const p of raw){
    const key = p.athleteId ? `id:${p.athleteId}` : `name:${(p.name||'').toLowerCase()}`;
    const stats = idx.get(key) || null;
    if (stats) p.stats.season = stats; // raw rows; client can summarize
  }
  await fs.writeFile('data/team/roster_plus.json', JSON.stringify(raw, null, 2));
  return true;
}

// 3) Spotlight files from roster_plus (static version)
// Split by position family and write all spotlight_*.json
export async function buildSpotlightFromCFBfastR(teamName, year){
  const rosterResult = await cfbRosterPlus(teamName, year);
  const count = typeof rosterResult === 'number' ? rosterResult : rosterResult?.count || 0;
  const rosterYear = typeof rosterResult === 'object' && rosterResult ? rosterResult.year : year;
  try { await cfbAttachSeasonStats(teamName, rosterYear); } catch {}

  const raw = JSON.parse(await fs.readFile('data/team/roster_plus.json','utf8'));
  const offSet = new Set(['QB','RB','WR','TE','FB','HB','TB','SB','OT','OG','C','OL']);
  const off = raw.filter(p => offSet.has(p.position));
  const def = raw.filter(p => !offSet.has(p.position));

  const take = (n, arr)=> (Array.isArray(arr)?arr:[]).slice(0,n);
  await fs.writeFile('data/spotlight_offense_last.json', JSON.stringify(take(50, off), null, 2));
  await fs.writeFile('data/spotlight_defense_last.json', JSON.stringify(take(50, def), null, 2));
  await fs.writeFile('data/spotlight_offense_season.json', JSON.stringify(take(50, off), null, 2));
  await fs.writeFile('data/spotlight_defense_season.json', JSON.stringify(take(50, def), null, 2));
  await fs.writeFile('data/spotlight_featured.json', JSON.stringify(take(6, raw), null, 2));
  console.log('[fallback-cfbfastR] roster:', count, 'off:', off.length, 'def:', def.length, 'year:', rosterYear);
}
