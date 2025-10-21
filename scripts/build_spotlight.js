const FS = await import('fs/promises');
const TEAM = process.env.TEAM || 'Kentucky';
let YEAR = Number(process.env.YEAR || new Date().getUTCFullYear());
if (new Date().getUTCMonth() < 6) YEAR -= 1; // season rolls

const KEY = process.env.CFBD_KEY || '';
const MODE = (process.env.FALLBACK_MODE || '').toLowerCase(); // '', 'espn', 'cfbfastr'

async function cfbd(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const url = `https://api.collegefootballdata.com${path}${q ? `?${q}` : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error(`${path} non-JSON ${ct}`);
  return r.json();
}
const POS_SIDE = (p) => {
  const pos = (p.position || p.pos || '').toUpperCase();
  if (['QB', 'RB', 'WR', 'TE', 'FB', 'HB', 'TB', 'SB', 'OT', 'OG', 'C', 'OL'].includes(pos)) return 'offense';
  if (['DL', 'DE', 'DT', 'NT', 'LB', 'OLB', 'ILB', 'CB', 'DB', 'S', 'FS', 'SS', 'STAR', 'NICKEL'].includes(pos)) return 'defense';
  return 'offense';
};
const take = (n, a) => (Array.isArray(a) ? a : []).slice(0, n);
const bySide = (rows, side) => rows.filter((p) => p.side === side);

async function writeSpotlightFromRows(rowsAll, rowsLast = []) {
  const offS = bySide(rowsAll, 'offense');
  const defS = bySide(rowsAll, 'defense');
  const offL = rowsLast.length ? bySide(rowsLast, 'offense') : offS;
  const defL = rowsLast.length ? bySide(rowsLast, 'defense') : defS;
  await FS.mkdir('data', { recursive: true });
  await FS.writeFile('data/spotlight_offense_season.json', JSON.stringify(take(50, offS), null, 2));
  await FS.writeFile('data/spotlight_defense_season.json', JSON.stringify(take(50, defS), null, 2));
  await FS.writeFile('data/spotlight_offense_last.json', JSON.stringify(take(50, offL), null, 2));
  await FS.writeFile('data/spotlight_defense_last.json', JSON.stringify(take(50, defL), null, 2));
  await FS.writeFile('data/spotlight_featured.json', JSON.stringify(take(6, rowsAll), null, 2));
}

async function writeRosterPlus(rowsAll, rowsLast = []) {
  const lastMap = new Map();
  for (const lp of rowsLast) {
    const key = lp.athleteId ? `id:${lp.athleteId}` : `name:${(lp.name || '').toLowerCase()}`;
    lastMap.set(key, lp.lastGame || {});
  }
  const roster = rowsAll.map((p) => {
    const key = p.athleteId ? `id:${p.athleteId}` : `name:${(p.name || '').toLowerCase()}`;
    return {
      athleteId: p.athleteId ?? null,
      name: p.name || '',
      position: p.position || '',
      side: p.side || 'offense',
      stats: {
        season: p.season || null,
        lastGame: lastMap.get(key) || null,
      },
    };
  });
  await FS.mkdir('data/team', { recursive: true });
  await FS.writeFile('data/team/roster_plus.json', JSON.stringify(roster, null, 2));
}

// MODE overrides to force fallback quickly
if (MODE === 'espn') {
  console.log('[spotlight] FORCED ESPN fallback');
  const { buildSpotlightFromESPN } = await import('./fallback_unofficial.js');
  await buildSpotlightFromESPN(TEAM);
  process.exit(0);
}
if (MODE === 'cfbfastr') {
  console.log('[spotlight] FORCED cfbfastR fallback');
  const { buildSpotlightFromCFBfastR } = await import('./fallback_cfbfastr.js');
  await buildSpotlightFromCFBfastR(TEAM, YEAR);
  process.exit(0);
}

// CFBD: season-first (stable)
let seasonPlayers = [];
let lastPlayers = [];
try {
  const season = await cfbd('/player/season', { team: TEAM, year: YEAR });
  seasonPlayers = season.map((s) => ({
    athleteId: s.athleteId ?? null,
    name: s.player || '',
    position: s.position || '',
    side: POS_SIDE(s),
    season: s,
  }));
  console.log('[spotlight] CFBD season count:', seasonPlayers.length);

  // last game (one try; fallback allowed)
  const games = await cfbd('/games', { year: YEAR, team: TEAM, seasonType: 'regular' });
  const done = (games || []).filter((g) => g.completed).sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
  if (done[0]) {
    const gid = done[0].id;
    const r = await fetch(`https://api.collegefootballdata.com/game/player/statistics?gameId=${gid}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await r.json();
      const out = [];
      for (const t of data.teams || []) {
        const school = (t.school || t.team || '').toLowerCase();
        if (!school.includes(TEAM.toLowerCase())) continue;
        const seen = new Map();
        for (const cat of t.categories || []) {
          for (const ty of cat.types || []) {
            for (const a of ty.athletes || []) {
              const id = a.id ?? a.athleteId ?? null;
              const key = id ? `id:${id}` : `name:${(a.name || '').toLowerCase()}`;
              const prev =
                seen.get(key) || {
                  athleteId: id,
                  name: a.name || '',
                  position: (a.position || a.pos || '').toUpperCase(),
                  side: POS_SIDE(a),
                  lastGame: {},
                };
              prev.lastGame[ty.name] = a.stats;
              seen.set(key, prev);
            }
          }
        }
        out.push(...seen.values());
      }
      lastPlayers = out;
    }
  }
  await writeSpotlightFromRows(seasonPlayers, lastPlayers);
  await writeRosterPlus(seasonPlayers, lastPlayers);
  console.log('[spotlight] CFBD wrote spotlight files (season:', seasonPlayers.length, 'last:', lastPlayers.length, ')');
} catch (e) {
  console.warn('[spotlight] CFBD failed:', e.message);
  // ESPN fallback
  try {
    const { buildSpotlightFromESPN } = await import('./fallback_unofficial.js');
    await buildSpotlightFromESPN(TEAM);
    console.log('[spotlight] Spotlight build succeeded via ESPN fallback');
  } catch (e2) {
    console.warn('[spotlight] ESPN fallback failed:', e2.message);
    const { buildSpotlightFromCFBfastR } = await import('./fallback_cfbfastr.js');
    await buildSpotlightFromCFBfastR(TEAM, YEAR);
    console.log('[spotlight] Spotlight build succeeded via cfbfastR fallback');
  }
}
