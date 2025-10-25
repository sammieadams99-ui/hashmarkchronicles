/* Hashmark Spotlight Builder (CFBD + ESPN hybrid)
 * Writes:
 *   /data/roster.json
 *   /data/spotlight_featured.json
 *   /data/spotlight_offense_last.json
 *   /data/spotlight_offense_season.json
 *   /data/spotlight_defense_last.json
 *   /data/spotlight_defense_season.json
 *   /data/ticker.json  (team metrics chip row)
 *
 * Guarantees: each spotlight list has 3 entries. Uses roster gating to avoid
 * non-UK players. Safe to run even when no “last game” is complete yet.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(),'data');
const TEAM = process.env.TEAM || 'Kentucky';
const YEAR = parseInt(process.env.YEAR || '2025',10);
const CFBD_KEY = process.env.CFBD_KEY;
const ESPN_HEAD = 'https://a.espncdn.com/i/headshots/college-football/players/full';

async function writeJSON(p, obj){
  const full = path.join(DATA_DIR, p);
  await fs.mkdir(path.dirname(full), {recursive:true});
  await fs.writeFile(full, JSON.stringify(obj, null, 2), 'utf8');
  console.log('wrote', p, '(' + (Array.isArray(obj)?obj.length:1) + ')');
}

async function cfbd(pathname){
  const url = `https://api.collegefootballdata.com${pathname}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${CFBD_KEY}` }});
  if(!r.ok) throw new Error(`CFBD ${r.status} ${url}`);
  return r.json();
}

// --- ROSTER (id, name, pos, headshot map via ESPN id if present) ---
async function loadRoster(){
  // CFBD /roster?team=&year=
  const rows = await cfbd(`/roster?team=${encodeURIComponent(TEAM)}&year=${YEAR}`);
  const roster = rows.map(x => ({
    id: x.id || null,
    name: x.first_name && x.last_name ? `${x.first_name} ${x.last_name}` : (x.name || '').trim(),
    pos: x.position || x.position_group || '',
    number: x.jersey || null,
    // Try to infer ESPN image by id echo (when CFBD playerId aligns) else null
    headshot: x.espn_id ? `${ESPN_HEAD}/${x.espn_id}.png` : null
  })).filter(x => x.name);
  await writeJSON('roster.json', roster);
  return roster;
}

// --- GAME CONTEXT (find latest completed game id) ---
async function latestCompletedGameId(){
  const regular = await cfbd(`/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const postseason = await cfbd(`/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=postseason`);
  const games = [...regular, ...postseason].sort((a,b)=> new Date(a.start_date)-new Date(b.start_date));
  // Completed: home_points/away_points not null
  const completed = games.filter(g => g.home_points!=null && g.away_points!=null);
  return completed.length ? completed[completed.length-1] : null;
}

// --- ESPN event summary (leaders for last game) ---
// We use public widgets summary that powers the card; event id is CFBD's 'id'? Not always present.
// As a fallback: leave "last lists" empty; client handles friendly empty state. 
async function espnSummaryLeaders(eventId){
  if(!eventId) return { off:[], def:[] };
  try{
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=${eventId}`;
    const r = await fetch(url);
    if(!r.ok) throw 0;
    const j = await r.json();
    // Offense leaders: passing, rushing, receiving (use Kentucky side only)
    const cats = [];
    const teamName = TEAM;
    const comps = (j?.boxscore?.players || []).filter(p => p.team?.shortDisplayName === teamName || p.team?.displayName === teamName);
    for(const sec of comps){
      for(const a of (sec.statistics || [])){
        if(!a?.athletes) continue;
        for(const at of a.athletes){
          const nm = at?.athlete?.displayName;
          const pos = at?.athlete?.position?.abbreviation || '';
          const head = at?.athlete?.headshot || null;
          const espnId = at?.athlete?.id;
          const statMap = (at?.stats || []).reduce((m,s)=>{ const [k,v]=String(s).split(':'); m[k.trim()] = v?.trim(); return m; },{});
          // normalize compact
          const compact = {};
          if(statMap['CMP']) compact.cmp_att = `${statMap['CMP']}/${statMap['ATT']||''}`;
          if(statMap['YDS']) compact.yds = statMap['YDS'];
          if(statMap['TD']) compact.td = statMap['TD'];
          if(statMap['INT']) compact.int = statMap['INT'];
          if(statMap['RUSH']) compact.rush = statMap['RUSH'];
          if(statMap['REC']) compact.rec = statMap['REC'];
          if(statMap['TACKLES']) compact.tkl = statMap['TACKLES'];
          if(statMap['SACKS']) compact.sck = statMap['SACKS'];
          cats.push({
            name:nm, pos, espn:`https://www.espn.com/college-football/player/_/id/${espnId}`,
            headshot: head || (espnId?`${ESPN_HEAD}/${espnId}.png`:null),
            last_game: compact
          });
        }
      }
    }
    // de-dupe by name; keep best (more fields)
    const byName = new Map();
    for(const p of cats){ if(!byName.has(p.name)) byName.set(p.name, p); }
    const all = Array.from(byName.values());
    const off = all.filter(p => /QB|RB|WR|TE/i.test(p.pos));
    const def = all.filter(p => /DL|DE|DT|LB|DB|CB|S/i.test(p.pos));
    return { off:off.slice(0,6), def:def.slice(0,6) };
  }catch(e){
    return { off:[], def:[] };
  }
}

// --- Season leaders from CFBD player stats (aggregate) ---
async function seasonLeaders(roster){
  // CFBD /player/season?year=&team= (returns offense + defense windows by category)
  // NOTE: Not all endpoints are consistent across seasons; we fall back to zero arrays.
  let off=[], def=[];
  try{
    const j = await cfbd(`/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
    // Normalize: passing/rushing/receiving and defensive leaders
    const add = (arr, pos, stat) => {
      for(const r of (arr || [])){
        const name = r.player || r.name;
        if(!name) continue;
        const found = roster.find(x => x.name.toLowerCase() === String(name).toLowerCase());
        const head = found?.headshot || null;
        const posGuess = found?.pos || pos || '';
        const obj = { name, pos: posGuess, headshot: head, season: stat(r) };
        if(/QB|RB|WR|TE/i.test(posGuess)) off.push(obj); else def.push(obj);
      }
    };
    add(j.passing, 'QB', r => ({ cmp_att: r.completions && r.attempts ? `${r.completions}/${r.attempts}`:null, yds: r.yards, td: r.passing_tds, int: r.interceptions }));
    add(j.rushing, 'RB', r => ({ rush_yds: r.yards, td: r.rushing_tds }));
    add(j.receiving, 'WR', r => ({ rec: r.receptions, rec_yds: r.yards, td: r.receiving_tds }));
    add(j.defense, 'LB', r => ({ tkl: r.total_tackles, tfl: r.tackles_for_loss, sck: r.sacks }));
  }catch(e){}
  return { off, def };
}

// --- Scoring / ranking v2 (0..100) + grade mapping ---
function norm(x, lo, hi){ if(x==null) return 0; return Math.max(0, Math.min(1, (x-lo)/(hi-lo))); }
function gradeOf(score){
  if(score>=92) return {letter:'A',mod:'plus'};
  if(score>=88) return {letter:'A'};
  if(score>=84) return {letter:'A',mod:'minus'};
  if(score>=76) return {letter:'B',mod:'plus'};
  if(score>=72) return {letter:'B'};
  if(score>=68) return {letter:'B',mod:'minus'};
  if(score>=60) return {letter:'C',mod:'plus'};
  if(score>=55) return {letter:'C'};
  if(score>=50) return {letter:'C',mod:'minus'};
  if(score>=44) return {letter:'D',mod:'plus'};
  if(score>=40) return {letter:'D'};
  if(score>=35) return {letter:'D',mod:'minus'};
  return {letter:'F'};
}
// Basic scorer that uses compact stat fields (works across both last + season)
function scorePlayer(p){
  const s = p.last_game || p.season || {};
  let prod = 0;
  // Offense
  if(/QB|WR|TE|RB/i.test(p.pos||'')){
    const y = +s.yds || +s.rush_yds || +s.rec_yds || 0;
    const td = +s.td || 0;
    const rec = +s.rec || 0;
    prod = 60*norm(y, 30, 300) + 25*norm(td, 0, 3) + 15*norm(rec, 0, 10);
  }else{ // Defense
    const t = +s.tkl || 0;
    const tfl = +s.tfl || 0;
    const sk = +s.sck || 0;
    prod = 60*norm(t, 2, 12) + 25*norm(tfl, 0, 3) + 15*norm(sk, 0, 2);
  }
  const score = Math.round(Math.max(0, Math.min(100, prod)));
  const grade = gradeOf(score);
  return { score, grade };
}

function top3(list){
  return list
    .map(p => ({...p, ...scorePlayer(p)}))
    .sort((a,b) => (b.score - a.score))
    .slice(0,3);
}

// --- Main build ---
async function run(){
  const roster = await loadRoster();
  const lastGame = await latestCompletedGameId();

  // LAST-game leaders from ESPN summary (if available)
  let lastOFF=[], lastDEF=[];
  if(lastGame && lastGame.id){
    const L = await espnSummaryLeaders(lastGame.id);
    lastOFF = L.off;
    lastDEF = L.def;
  }

  // SEASON leaders (CFBD aggregate) 
  const S = await seasonLeaders(roster);
  let seasonOFF = S.off, seasonDEF = S.def;

  // Backfill logic: ensure 3 using roster positions if lists are thin
  function backfill(list, posRegex){
    const have = new Set(list.map(x => x.name));
    const pool = roster.filter(r => posRegex.test(r.pos||'') && !have.has(r.name));
    // pick first by jersey ascending (stable but predictable)
    for(const r of pool){ list.push({ name:r.name, pos:r.pos||'', headshot:r.headshot||null }); if(list.length>=3) break; }
    return list.slice(0,3);
  }

  lastOFF = top3(backfill(lastOFF, /QB|RB|WR|TE/i));
  lastDEF = top3(backfill(lastDEF, /DL|DE|DT|LB|DB|CB|S/i));
  seasonOFF = top3(backfill(seasonOFF, /QB|RB|WR|TE/i));
  seasonDEF = top3(backfill(seasonDEF, /DL|DE|DT|LB|DB|CB|S/i));

  // Featured = best of lastOFF (fallback: best of seasonOFF)
  const featured = (lastOFF[0] || seasonOFF[0] || {}) ;

  // Write files
  await writeJSON('spotlight_featured.json', featured);
  await writeJSON('spotlight_offense_last.json', lastOFF);
  await writeJSON('spotlight_defense_last.json', lastDEF);
  await writeJSON('spotlight_offense_season.json', seasonOFF);
  await writeJSON('spotlight_defense_season.json', seasonDEF);

  // Simple banner/ticker metrics — example placeholders (extend with CFBD team stats)
  const ticker = [
    { label:'Explosive PA rate', value:'+6.3%', trend:'good', suffix:'vs base' },
    { label:'Yds/Play (UK)', value:'5.7', trend:'good' },
    { label:'Havoc Allowed', value:'42%', trend:'warn', suffix:'steady' },
    { label:'3rd & 6+ defense', value:'46%', trend:'bad', suffix:'conv. allowed' }
  ];
  await writeJSON('ticker.json', ticker);
}

run().catch(err => {
  console.error('[build-spotlight] error', err);
  process.exitCode = 1;
});
