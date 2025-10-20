// scripts/build-ticker.js  (v2: robust fallbacks if advanced stats are missing)
import fs from 'fs/promises';
import fetch from 'node-fetch';

const YEAR = process.env.YEAR || new Date().getFullYear();
const TEAM = 'Kentucky';
const KEY = process.env.CFBD_KEY;
if (!KEY) throw new Error('CFBD_KEY is required');

const H = { headers: { Authorization: `Bearer ${KEY}` } };
const api = (p) => `https://api.collegefootballdata.com${p}`;

async function get(p) {
  const r = await fetch(api(p), H);
  if (!r.ok) throw new Error(`${r.status} ${p}`);
  return r.json();
}

function pct(x) { return x == null ? null : Math.round(x * 1000) / 10; }
function dir(season, last, invert = false, tol = 0.005) {
  if (season == null || last == null) return { d: 'steady', delta: 0 };
  let delta = last - season;
  if (invert) delta = -delta;
  if (Math.abs(delta) < tol) return { d: 'steady', delta };
  return { d: delta > 0 ? 'up' : 'down', delta };
}
function compactNumber(n) {
  if (n == null) return null;
  return Math.abs(n) >= 1000 ? `${(n/1000).toFixed(1)}k` : `${n}`;
}

async function main() {
  // Try advanced first
  let seasonAdv = {};
  let lastAdv = {};
  let lastWeek = null;

  try {
    const seasonAdvArr = await get(`/stats/season/advanced?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
    seasonAdv = seasonAdvArr.find(x => (x.team === TEAM || x.school === TEAM)) || {};
  } catch {}

  try {
    const gamesAdv = await get(`/stats/game/advanced?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
    const weeks = gamesAdv.filter(g => (g.team === TEAM || g.school===TEAM) && g.week != null).map(g => g.week);
    lastWeek = weeks.length ? Math.max(...weeks) : null;
    lastAdv = lastWeek ? gamesAdv.find(g => (g.team === TEAM || g.school===TEAM) && g.week === lastWeek) : {};
  } catch {}

  // Fallbacks using team basic stats if advanced are empty
  let seasonTeam = {};
  let lastTeam = {};
  try {
    const seasonTeamArr = await get(`/stats/team/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
    seasonTeam = seasonTeamArr[0] || {};
  } catch {}
  try {
    const teamGames = await get(`/stats/team/game?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
    if (!lastWeek) {
      const ws = teamGames.map(g => g.week).filter(Boolean);
      lastWeek = ws.length ? Math.max(...ws) : null;
    }
    lastTeam = teamGames.find(g => g.week === lastWeek) || {};
  } catch {}

  const items = [];

  // Prefer advanced metrics; if absent, use YPP and PPG fallbacks
  const add = (label, seasonVal, lastVal, unit='', invert=false) => {
    if (seasonVal == null && lastVal == null) return;
    const v = seasonVal != null ? seasonVal : lastVal;
    items.push({ label, unit, val: v, last: lastVal ?? null, ...dir(seasonVal, lastVal, invert) });
  };

  if (seasonAdv && Object.keys(seasonAdv).length) {
    add('Off SR', pct(seasonAdv.off_success_rate), pct(lastAdv?.off_success_rate), '%');
    add('Pass SR', pct(seasonAdv.off_passing_success_rate), pct(lastAdv?.off_passing_success_rate), '%');
    add('Rush SR', pct(seasonAdv.off_rushing_success_rate), pct(lastAdv?.off_rushing_success_rate), '%');
    add('Std-Downs SR', pct(seasonAdv.off_standard_downs_success_rate), pct(lastAdv?.off_standard_downs_success_rate), '%');
    add('Pass-Downs SR', pct(seasonAdv.off_passing_downs_success_rate), pct(lastAdv?.off_passing_downs_success_rate), '%');
    add('Off PPA/play', seasonAdv.off_ppa == null ? null : Number(seasonAdv.off_ppa.toFixed(2)),
                        lastAdv?.off_ppa == null ? null : Number(lastAdv.off_ppa.toFixed(2)));
    add('Havoc Allowed', pct(seasonAdv.off_havoc_total), pct(lastAdv?.off_havoc_total), '%', true);
    add('Def SR allowed', pct(seasonAdv.def_success_rate), pct(lastAdv?.def_success_rate), '%', true);
  } else {
    // basic fallbacks
    const yppSeason = seasonTeam.yards_per_play ?? null;
    const yppLast   = lastTeam.yards_per_play ?? null;
    add('Yds/Play', yppSeason, yppLast, '');

    const ppgSeason = seasonTeam.points_per_game ?? null;
    const ptsLast   = lastTeam.points ?? null;
    add('Points/Game', ppgSeason, ptsLast, '');
  }

  // Leaders always
  let players = [];
  try {
    players = await get(`/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  } catch {}
  const by = (cat) => players.filter(p => (p.category || '').toLowerCase() === cat);
  const pass = by('passing').sort((a,b) => (b.passing_yards||b.passing_yds||0) - (a.passing_yards||a.passing_yds||0))[0] || {};
  const rush = by('rushing').sort((a,b) => (b.rushing_yards||b.rush_yds||0) - (a.rushing_yards||a.rush_yds||0))[0] || {};
  const recv = by('receiving').sort((a,b) => (b.receiving_yards||b.rec_yds||0) - (a.receiving_yards||a.rec_yds||0))[0] || {};
  const kck = players.filter(p => (p.category||'').toLowerCase() === 'kicking')
                     .sort((a,b) => (b.points||0) - (a.points||0))[0] || {};

  const leader = (p, label, unit) => {
    const name = p.player || label;
    let val = null;
    if (label==='QB') val = p.passing_yards || p.passing_yds;
    if (label==='RB') val = p.rushing_yards || p.rush_yds;
    if (label==='WR') val = p.receiving_yards || p.rec_yds;
    if (label==='PK') val = p.points;
    if (val != null) items.push({ label: name, unit, val: compactNumber(val), d:'steady' });
  };
  leader(pass, 'QB', 'yd');
  leader(rush, 'RB', 'rush');
  leader(recv, 'WR', 'rec');
  leader(kck,  'PK', 'pts');

  await fs.writeFile('./data/ticker.json', JSON.stringify({ year: YEAR, team: TEAM, lastWeek, items }, null, 2));
  console.log('Wrote data/ticker.json');
}

main().catch(err => { console.error(err); process.exit(1); });
