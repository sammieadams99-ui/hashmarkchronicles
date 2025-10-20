// scripts/build-ticker.js
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
  const seasonAdvArr = await get(`/stats/season/advanced?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const seasonAdv = seasonAdvArr.find(x => x.team === TEAM) || {};

  const gamesAdv = await get(`/stats/game/advanced?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const weeks = gamesAdv.filter(g => g.team === TEAM && g.week != null).map(g => g.week);
  const lastWeek = weeks.length ? Math.max(...weeks) : null;
  const lastAdv = lastWeek ? gamesAdv.find(g => g.team === TEAM && g.week === lastWeek) : {};

  const players = await get(`/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const by = (cat) => players.filter(p => (p.category || '').toLowerCase() === cat);
  const pass = by('passing').sort((a,b) => (b.passing_yards||b.passing_yds||0) - (a.passing_yards||a.passing_yds||0))[0] || {};
  const rush = by('rushing').sort((a,b) => (b.rushing_yards||b.rush_yds||0) - (a.rushing_yards||a.rush_yds||0))[0] || {};
  const recv = by('receiving').sort((a,b) => (b.receiving_yards||b.rec_yds||0) - (a.receiving_yards||a.rec_yds||0))[0] || {};
  const kck = players.filter(p => (p.category||'').toLowerCase() === 'kicking')
                     .sort((a,b) => (b.points||0) - (a.points||0))[0] || {};

  const items = [
    { label: 'Off SR', unit: '%', val: pct(seasonAdv.off_success_rate), last: pct(lastAdv?.off_success_rate), ...dir(seasonAdv.off_success_rate, lastAdv?.off_success_rate) },
    { label: 'Pass SR', unit: '%', val: pct(seasonAdv.off_passing_success_rate), last: pct(lastAdv?.off_passing_success_rate), ...dir(seasonAdv.off_passing_success_rate, lastAdv?.off_passing_success_rate) },
    { label: 'Rush SR', unit: '%', val: pct(seasonAdv.off_rushing_success_rate), last: pct(lastAdv?.off_rushing_success_rate), ...dir(seasonAdv.off_rushing_success_rate, lastAdv?.off_rushing_success_rate) },
    { label: 'Std-Downs SR', unit: '%', val: pct(seasonAdv.off_standard_downs_success_rate), last: pct(lastAdv?.off_standard_downs_success_rate), ...dir(seasonAdv.off_standard_downs_success_rate, lastAdv?.off_standard_downs_success_rate) },
    { label: 'Pass-Downs SR', unit: '%', val: pct(seasonAdv.off_passing_downs_success_rate), last: pct(lastAdv?.off_passing_downs_success_rate), ...dir(seasonAdv.off_passing_downs_success_rate, lastAdv?.off_passing_downs_success_rate) },
    { label: 'Off PPA/play', unit: '', val: seasonAdv.off_ppa == null ? null : seasonAdv.off_ppa.toFixed(2), last: lastAdv?.off_ppa == null ? null : lastAdv.off_ppa.toFixed(2), ...dir(seasonAdv.off_ppa, lastAdv?.off_ppa) },

    { label: 'Havoc Allowed', unit: '%', val: pct(seasonAdv.off_havoc_total), last: pct(lastAdv?.off_havoc_total), ...dir(seasonAdv.off_havoc_total, lastAdv?.off_havoc_total, true) },
    { label: 'Def SR allowed', unit: '%', val: pct(seasonAdv.def_success_rate), last: pct(lastAdv?.def_success_rate), ...dir(seasonAdv.def_success_rate, lastAdv?.def_success_rate, true) },

    { label: (pass.player || 'QB'), unit: 'yd', val: compactNumber(pass.passing_yards || pass.passing_yds), last: null, d: 'steady' },
    { label: (rush.player || 'RB'), unit: 'rush', val: compactNumber(rush.rushing_yards || rush.rush_yds), last: null, d: 'steady' },
    { label: (recv.player || 'WR'), unit: 'rec', val: compactNumber(recv.receiving_yards || recv.rec_yds), last: null, d: 'steady' },
    { label: (kck.player || 'PK'), unit: 'pts', val: compactNumber(kck.points), last: null, d: 'steady' }
  ].filter(x => x.val != null);

  await fs.writeFile('./data/ticker.json', JSON.stringify({ year: YEAR, team: TEAM, lastWeek, items }, null, 2));
  console.log('Wrote data/ticker.json');
}

main().catch(err => { console.error(err); process.exit(1); });
