import fs from 'fs/promises';

async function getCSV(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`CSV ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((row) => {
    const cols = row.split(',');
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i];
    });
    return obj;
  });
}

export async function cfbRosterPlus(teamName, year) {
  const url = `https://raw.githubusercontent.com/cfbfastR/data/master/rosters/rosters_${year}.csv`;
  const rows = await getCSV(url);
  const want = String(teamName).toLowerCase();
  const out = rows
    .filter((r) => (r.team || '').toLowerCase().includes(want))
    .map((r) => ({
      athleteId: r.athlete_id ? Number(r.athlete_id) : null,
      name: r.name || '',
      firstName: r.first_name || null,
      lastName: r.last_name || null,
      position: (r.position || '').toUpperCase(),
      jersey: r.jersey || null,
      headshot: null,
      side: ['QB', 'RB', 'WR', 'TE', 'FB', 'HB', 'TB', 'SB', 'OT', 'OG', 'C', 'OL'].includes((r.position || '').toUpperCase())
        ? 'offense'
        : 'defense',
      stats: { season: null, lastGame: null },
    }));
  await fs.mkdir('data/team', { recursive: true });
  await fs.writeFile('data/team/roster_plus.json', JSON.stringify(out, null, 2));
  return out;
}

export async function buildSpotlightFromCFBfastR(teamName, year) {
  const roster = await cfbRosterPlus(teamName, year);
  const offS = roster.filter((p) => p.side === 'offense');
  const defS = roster.filter((p) => p.side === 'defense');
  const take = (n, a) => (Array.isArray(a) ? a : []).slice(0, n);
  await fs.writeFile('data/spotlight_offense_season.json', JSON.stringify(take(50, offS), null, 2));
  await fs.writeFile('data/spotlight_defense_season.json', JSON.stringify(take(50, defS), null, 2));
  await fs.writeFile('data/spotlight_offense_last.json', JSON.stringify(take(50, offS), null, 2)); // static fallback
  await fs.writeFile('data/spotlight_defense_last.json', JSON.stringify(take(50, defS), null, 2));
  await fs.writeFile('data/spotlight_featured.json', JSON.stringify(take(6, roster), null, 2));
  console.log('[fallback-cfbfastR] roster:', roster.length, 'off:', offS.length, 'def:', defS.length);
}
