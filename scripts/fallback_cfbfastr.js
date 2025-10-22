import fs from 'fs/promises';

// Robust CSV fetch with retry and year fallback
async function fetchRosterCSV(year) {
  const base = `https://raw.githubusercontent.com/cfbfastR/data/master/rosters/rosters_${year}.csv`;
  const headers = { 'cache-control': 'no-cache', 'user-agent': 'hashmark-bot' };
  let r = await fetch(base, { headers });
  if (!r.ok) {
    r = await fetch(`${base}?plain=1`, { headers });
    if (!r.ok) throw new Error(`CSV ${r.status}`);
  }
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  const headersRow = lines[0].split(',');
  const rows = lines.slice(1).map((row) => {
    const cols = row.split(',');
    const obj = {};
    headersRow.forEach((h, i) => {
      obj[h] = cols[i];
    });
    return obj;
  });
  return rows;
}

async function safeRosterCSV(year) {
  for (const y of [year, year - 1, year - 2]) {
    try {
      return { rows: await fetchRosterCSV(y), y };
    } catch (e) {
      // continue trying previous seasons
    }
  }
  throw new Error('CSV roster not found for last 3 seasons');
}

export async function cfbRosterPlus(teamName, year) {
  const { rows, y } = await safeRosterCSV(year);
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
  console.log('[fallback-cfbfastR] year used:', y, 'roster:', out.length);
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
