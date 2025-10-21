import fs from 'fs/promises';
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.includes('application/json')) throw new Error(`NON_JSON ${r.status} ${ct}`);
  return r.json();
}

export async function espnFindTeamId(teamName) {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams';
  const data = await getJSON(url);
  const all = (data?.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team);
  const want = String(teamName).toLowerCase();
  const hit = all.find(
    (t) => (t.displayName || '').toLowerCase().includes(want) || (t.nickname || '').toLowerCase().includes(want),
  );
  return hit ? String(hit.id) : null;
}

export async function espnRosterPlus(teamId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${teamId}`;
  const data = await getJSON(url);
  const athletes = (data?.team?.athletes || []).flatMap((g) => g.items || []);
  const out = athletes.map((a) => ({
    athleteId: a.id ? Number(a.id) : null,
    name: a.displayName || '',
    firstName: a.firstName || null,
    lastName: a.lastName || null,
    position: (a.position?.abbreviation || a.position?.name || '').toUpperCase(),
    jersey: a.jersey ? Number(a.jersey) : null,
    headshot: a.headshot?.href || a.links?.headshot?.href || null,
    side: ['QB', 'RB', 'WR', 'TE', 'FB', 'HB', 'TB', 'SB', 'OT', 'OG', 'C', 'OL'].includes(
      (a.position?.abbreviation || '').toUpperCase(),
    )
      ? 'offense'
      : 'defense',
    stats: { season: null, lastGame: null },
  }));
  await fs.mkdir('data/team', { recursive: true });
  await fs.writeFile('data/team/roster_plus.json', JSON.stringify(out, null, 2));
  return out;
}

export async function espnLastGamePlayers(teamId) {
  const schedURL = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${teamId}/schedule`;
  const sched = await getJSON(schedURL);
  const events = (sched?.events || []).filter((e) => e.status?.type?.completed);
  if (!events.length) return [];
  const latest = events.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  const eventId = latest.id;

  const boxURL = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/boxscore?event=${eventId}`;
  const box = await getJSON(boxURL);

  const teams = box?.boxscore?.players || [];
  const ours = teams.find((t) => String(t.team?.id) === String(teamId));
  if (!ours) return [];

  const seen = new Map();
  for (const stat of ours.statistics || []) {
    for (const a of stat.athletes || []) {
      const id = a.id ? Number(a.id) : null;
      const key = id ? `id:${id}` : `name:${(a.athlete?.fullName || a.athlete?.displayName || a.name || '').toLowerCase()}`;
      const prev =
        seen.get(key) || {
          athleteId: id,
          name: a.athlete?.fullName || a.athlete?.displayName || a.name || '',
          position: (a.athlete?.position?.abbreviation || a.position || '').toUpperCase(),
          side: 'offense',
          lastGame: {},
        };
      prev.lastGame[stat.name] = a.stats || a;
      if ((stat.name || '').toLowerCase().includes('defense')) prev.side = 'defense';
      seen.set(key, prev);
    }
  }
  return Array.from(seen.values());
}

export async function buildSpotlightFromESPN(teamName) {
  const teamId = await espnFindTeamId(teamName);
  if (!teamId) throw new Error('ESPN teamId not found for ' + teamName);
  const roster = await espnRosterPlus(teamId);
  const last = await espnLastGamePlayers(teamId);
  // Split & write spotlight files
  const offSet = new Set(['QB', 'RB', 'WR', 'TE', 'FB', 'HB', 'TB', 'SB', 'OT', 'OG', 'C', 'OL']);
  const offS = roster.filter((p) => offSet.has(p.position));
  const defS = roster.filter((p) => !offSet.has(p.position));
  const offL = last.length ? last.filter((p) => p.side === 'offense') : offS;
  const defL = last.length ? last.filter((p) => p.side === 'defense') : defS;
  const take = (n, a) => (Array.isArray(a) ? a : []).slice(0, n);
  await fs.writeFile('data/spotlight_offense_season.json', JSON.stringify(take(50, offS), null, 2));
  await fs.writeFile('data/spotlight_defense_season.json', JSON.stringify(take(50, defS), null, 2));
  await fs.writeFile('data/spotlight_offense_last.json', JSON.stringify(take(50, offL), null, 2));
  await fs.writeFile('data/spotlight_defense_last.json', JSON.stringify(take(50, defL), null, 2));
  await fs.writeFile('data/spotlight_featured.json', JSON.stringify(take(6, roster), null, 2));
  console.log('[fallback] ESPN teamId:', teamId, 'roster:', roster.length, 'lastGame:', last.length);
}
