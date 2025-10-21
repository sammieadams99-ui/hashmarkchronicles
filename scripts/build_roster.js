// scripts/build_roster.js
// Build full roster JSON (plus optional joined season stats) into data/team/roster.json
// Env: CFBD_KEY (secret), TEAM, YEAR (optional)
//
// Usage (in Actions):
//   TEAM="Kentucky" YEAR=2025 node scripts/build_roster.js

import fs from 'fs/promises';

const TEAM = process.env.TEAM || 'Kentucky';
let YEAR = Number(process.env.YEAR || defaultSeasonYear());
const KEY = process.env.CFBD_KEY;

if (!KEY) { console.error('Missing CFBD_KEY'); process.exit(1); }

function defaultSeasonYear(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0..11
  return m >= 6 ? y : y - 1; // season starts Jul/Aug
}

async function cfbd(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const url = `https://api.collegefootballdata.com${path}${q ? `?${q}` : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
const head = id => id ? `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png` : null;
const init = (f,l) => `${(f?.[0]||'').toUpperCase()}${(l?.[0]||'').toUpperCase()}` || '??';

async function main() {
  // 1) Full roster (may be large)
  let roster = await cfbd('/roster', { team: TEAM, year: YEAR });
  if (!Array.isArray(roster) || roster.length === 0) {
    console.warn(`No roster for ${TEAM} ${YEAR}; trying ${YEAR - 1}`);
    const fb = await cfbd('/roster', { team: TEAM, year: YEAR - 1 });
    if (Array.isArray(fb) && fb.length) { roster = fb; YEAR = YEAR - 1; }
  }

  // 2) Optional season stats (only players who recorded stats)
  let stats = [];
  try { stats = await cfbd('/player/season', { team: TEAM, year: YEAR }); } catch {}

  const idx = new Map(stats.map(s => {
    const k = s.athleteId ? `id:${s.athleteId}` : `name:${(s.player||'').toLowerCase()}|${s.position||''}`;
    return [k, s];
  }));

  const merged = roster.map(p => {
    const k = p.athleteId ? `id:${p.athleteId}` :
      `name:${(p.firstName+' '+p.lastName).toLowerCase()}|${p.position||''}`;
    const s = idx.get(k);
    return {
      athleteId: p.athleteId ?? null,
      name: `${p.firstName||''} ${p.lastName||''}`.trim(),
      firstName: p.firstName ?? null,
      lastName: p.lastName ?? null,
      position: p.position ?? null,
      jersey: p.jersey ?? null,
      headshot: head(p.athleteId),
      initials: init(p.firstName, p.lastName),
      stats: s || null
    };
  });

  await fs.mkdir('data/team', { recursive: true });
  await fs.writeFile('data/team/roster.json', JSON.stringify(merged, null, 2));
  await fs.writeFile('data/team/roster_meta.json', JSON.stringify({ team: TEAM, year: YEAR, generated_at: new Date().toISOString(), count: merged.length }, null, 2));
  console.log(`✅ Wrote data/team/roster.json with ${merged.length} players for ${TEAM} ${YEAR}`);
}
main().catch(e => { console.error(e); process.exit(1); });
