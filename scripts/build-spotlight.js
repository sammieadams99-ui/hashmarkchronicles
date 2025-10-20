// scripts/build-spotlight.js  (v4: fix 'scorePlayers is not defined', use per-game endpoint for 'last', resilient mapping)
import fs from 'fs/promises';
import fetch from 'node-fetch';

const YEAR = process.env.YEAR || new Date().getFullYear();
const TEAM = 'Kentucky';
const CFBD_KEY = process.env.CFBD_KEY;
if(!CFBD_KEY) throw new Error('CFBD_KEY missing');

const HEADERS = { 'Authorization': `Bearer ${CFBD_KEY}` };

const OUT = {
  ol: './data/spotlight_offense_last.json',
  os: './data/spotlight_offense_season.json',
  dl: './data/spotlight_defense_last.json',
  ds: './data/spotlight_defense_season.json',
  feat: './data/spotlight_featured.json',
  hist: './data/spotlight_history.json'
};
const ESPN_MAP_FILE = './data/espn_map.json';

// ------------ utils -------------
const toN = (x) => (x == null || x === '' || Number.isNaN(Number(x))) ? 0 : Number(x);
const pct = (a,b) => (toN(b) ? Math.round((toN(a)/toN(b))*100) : 0);
const slug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
const normalize = s => (s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g,'').replace(/\s+/g,' ').trim();

async function getJSON(path){
  const url = `https://api.collegefootballdata.com${path}`;
  const r = await fetch(url, { headers: HEADERS });
  if(!r.ok) throw new Error(`${r.status} ${r.statusText} for ${path}`);
  return r.json();
}
async function readJSON(path, fallback){ try{ return JSON.parse(await fs.readFile(path,'utf8')); } catch { return fallback; } }

// ------------ name map -------------
function buildNameIndex(map){
  const idx = new Map();
  for(const [name, meta] of Object.entries(map||{})){
    idx.set(normalize(name), meta);
    if(Array.isArray(meta.aliases)){
      for(const a of meta.aliases) idx.set(normalize(a), meta);
    }
  }
  return idx;
}
function resolveMeta(index, name){ return index.get(normalize(name)) || null; }

// ------------ classify -------------
function sideOf(posRaw, mapPos){
  const OFF = new Set(['QB','RB','FB','WR','TE','OL','C','G','T']);
  const DEF = new Set(['DL','DE','DT','NT','EDGE','LB','OLB','ILB','DB','CB','S','SS','FS','NB','STAR','JACK']);
  const p = (mapPos || posRaw || '').toUpperCase();
  if (OFF.has(p)) return 'OFF';
  if (DEF.has(p)) return 'DEF';
  if (/^(QB|RB|WR|TE|OL|C|G|T)/.test(p)) return 'OFF';
  return 'DEF';
}
function splitBySide(players, mapRaw){
  const O=[], D=[];
  for(const p of players){
    const mp = (mapRaw[p.name] && mapRaw[p.name].pos) || p.position;
    const side = sideOf(p.position, mp);
    (side==='OFF'?O:D).push(p);
  }
  return [O,D];
}

// ------------ scoring -------------
function scorePlayers(list){
  return list.map(p => {
    const passY = toN(p.passingYards), rushY = toN(p.rushingYards), recY = toN(p.receivingYards);
    const passTD = toN(p.passingTD), rushTD = toN(p.rushingTD), recTD = toN(p.receivingTD);
    const passINT = toN(p.interceptionsThrown || p.interceptions);
    const fum = toN(p.fumblesLost);

    const tkl = toN(p.tackles || p.totalTackles);
    const tfl = toN(p.tfl || p.tacklesForLoss);
    const sacks = toN(p.sacks);
    const ints = toN(p.defInterceptions || p.interceptionsDef);
    const pbu = toN(p.passesDefended || p.passesBrokenUp);
    const ff  = toN(p.forcedFumbles);
    const fr  = toN(p.fumblesRecovered);
    const dtd = toN(p.defensiveTD || p.defTD);

    const offScore = passY*0.04 + (rushY+recY)*0.10 + passTD*4 + (rushTD+recTD)*6 - passINT*2 - fum*2;
    const defScore = tkl*0.5 + tfl*1 + sacks*2 + ints*3 + pbu*0.5 + ff*2 + fr*1 + dtd*6;

    return {...p, score: offScore + defScore};
  });
}

// ------------ aggregators -------------
// Aggregate for a single week using /stats/player/game
function aggregateGameWeek(rows){
  const by = new Map();
  (rows||[]).filter(r => r.team === TEAM).forEach(s => {
    const name = s.player;
    const cat  = (s.category || '').toLowerCase();
    const pos  = s.position;
    const o = by.get(name) || { name, position: pos };
    if(cat === 'passing'){
      o.cmp = toN(s.completions ?? s.cmp);
      o.att = toN(s.attempts ?? s.att);
      o.cmpPct = pct(o.cmp, o.att);
      o.passingYards = toN(s.passing_yards ?? s.passingYards ?? s.yards);
      o.passingTD    = toN(s.passing_tds  ?? s.passingTD  ?? s.td);
      o.interceptionsThrown = toN(s.interceptions ?? s.int);
    } else if(cat === 'rushing'){
      o.rushingYards = toN(s.rushing_yards ?? s.rushingYards ?? s.yards);
      o.rushingTD    = toN(s.rushing_tds   ?? s.rushingTD    ?? s.td);
    } else if(cat === 'receiving'){
      o.receptions       = toN(s.receptions ?? s.rec);
      o.receivingYards   = toN(s.receiving_yards ?? s.receivingYards ?? s.yards);
      o.receivingTD      = toN(s.receiving_tds   ?? s.receivingTD    ?? s.td);
    } else if(cat === 'defense'){
      o.tackles          = toN(s.tackles ?? s.total_tackles ?? s.tot_tackles);
      o.tfl              = toN(s.tfl ?? s.tackles_for_loss);
      o.sacks            = toN(s.sacks);
      o.defInterceptions = toN(s.interceptions ?? s.int);
      o.passesDefended   = toN(s.passes_defended ?? s.pbu);
      o.forcedFumbles    = toN(s.forced_fumbles ?? s.ff);
      o.fumblesRecovered = toN(s.fumbles_recovered ?? s.fr);
      o.defensiveTD      = toN(s.defensive_td ?? s.def_td);
    }
    by.set(name, o);
  });
  return Array.from(by.values());
}

// Aggregate season across categories using /stats/player/season
function aggregateSeason(rows){
  const by = new Map();
  (rows||[]).filter(r => r.team === TEAM).forEach(s => {
    const name = s.player;
    const cat  = (s.category||'').toLowerCase();
    const pos  = s.position;
    const o = by.get(name) || { name, position: pos };
    if(cat === 'passing'){
      o.cmp = toN(s.completions ?? s.cmp); o.att = toN(s.attempts ?? s.att);
      o.cmpPct = pct(o.cmp, o.att);
      o.passingYards = toN(s.passing_yards ?? s.passingYards ?? s.pass_yds ?? s.yards);
      o.passingTD    = toN(s.passing_tds   ?? s.passingTD    ?? s.td);
      o.interceptionsThrown = toN(s.interceptions ?? s.int);
    } else if(cat === 'rushing'){
      o.rushingYards = toN(s.rushing_yards ?? s.rushingYards ?? s.rush_yds ?? s.yards);
      o.rushingTD    = toN(s.rushing_tds   ?? s.rushingTD    ?? s.td);
    } else if(cat === 'receiving'){
      o.receptions       = toN(s.receptions ?? s.rec);
      o.receivingYards   = toN(s.receiving_yards ?? s.receivingYards ?? s.rec_yds ?? s.yards);
      o.receivingTD      = toN(s.receiving_tds   ?? s.receivingTD    ?? s.td);
    } else if(cat === 'defense'){
      o.tackles          = toN(s.tackles ?? s.total_tackles ?? s.tot_tackles);
      o.tfl              = toN(s.tfl ?? s.tackles_for_loss);
      o.sacks            = toN(s.sacks);
      o.defInterceptions = toN(s.interceptions ?? s.int);
      o.passesDefended   = toN(s.passes_defended ?? s.pbu);
      o.forcedFumbles    = toN(s.forced_fumbles ?? s.ff);
      o.fumblesRecovered = toN(s.fumbles_recovered ?? s.fr);
      o.defensiveTD      = toN(s.defensive_td ?? s.def_td);
    }
    by.set(name, o);
  });
  return Array.from(by.values());
}

// ------------ output shaping -------------
function prettyShort(p){
  const out = {};
  if (p.cmp != null && p.att != null && (p.cmp || p.att)) out.cmp_att = `${p.cmp}/${p.att}`;
  if (p.passingYards) out.yds = String(p.passingYards);
  if (p.passingTD)    out.td = String(p.passingTD);
  if (p.interceptionsThrown) out.int = String(p.interceptionsThrown);
  if (p.rushingYards) out.rush_yds = String(p.rushingYards);
  if (p.rushingTD)    out.rush_td = String(p.rushingTD);
  if (p.receptions)   out.rec = String(p.receptions);
  if (p.receivingYards) out.rec_yds = String(p.receivingYards);
  if (p.receivingTD)  out.rec_td = String(p.receivingTD);
  if (!Object.keys(out).length) {
    if (p.tackles) out.tkl = String(p.tackles);
    if (p.tfl) out.tfl = String(p.tfl);
    if (p.sacks) out.sck = String(p.sacks);
    if (p.defInterceptions) out.int = String(p.defInterceptions);
    if (p.passesDefended) out.pbu = String(p.passesDefended);
    if (p.defensiveTD) out.def_td = String(p.defensiveTD);
  }
  return out;
}

function toCard(index, lastOpp){
  return p => {
    const name = p.name || p.player || '';
    const meta = resolveMeta(index, name) || {};
    const id = (meta.id || '').toString();
    const pos = p.position || meta.pos || '';
    const slugStr = meta.slug || slug(name);
    const headshot = id ? `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png` : '';
    const espn = id ? `https://www.espn.com/college-football/player/_/id/${id}/${slugStr}`
                    : `https://www.espn.com/search/results?q=${encodeURIComponent(name+' Kentucky football')}`;
    return {
      name, pos, slug: slugStr, headshot, espn,
      last_game: Object.assign(lastOpp ? {opp:lastOpp} : {}, prettyShort(p)),
      season: prettyShort(p._season || {})
    };
  };
}

// ------------ pick featured -------------
function dedupeByName(list){
  const seen = new Set(); const out = [];
  for(const p of list){ if(!seen.has(p.name)){ seen.add(p.name); out.push(p);} }
  return out;
}
function chooseFeatured(pool, hist){
  if(!pool.length) return null;
  const counts = hist.counts || {};
  const ranked = [...pool];
  const eligible = ranked.filter(p => (counts[p.name] || 0) < 2);
  let list = eligible.length ? eligible : ranked;
  if (list.length > 1 && list[0].name === hist.last_featured){
    [list[0], list[1]] = [list[1], list[0]];
  }
  return list[0];
}

// ------------ main -------------
async function main(){
  const mapRaw = await readJSON(ESPN_MAP_FILE, {});
  const mapIndex = buildNameIndex(mapRaw);
  const hist = await readJSON(OUT.hist, { last_featured: "", counts: {} });

  // recent completed game
  const games = await getJSON(`/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const done = (games||[]).filter(g => g.home_points != null && g.away_points != null);
  const recent = done.sort((a,b)=> new Date(b.start_date||b.startDate) - new Date(a.start_date||a.startDate))[0];
  const week = recent?.week;
  const lastOpp = recent ? (recent.home_team === TEAM ? recent.away_team : recent.home_team) : undefined;

  // LAST: per-game stats for last week, aggregated across categories
  let lastPlayers = [];
  if(week){
    const gp = await getJSON(`/stats/player/game?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${week}`);
    lastPlayers = scorePlayers(aggregateGameWeek(gp)).filter(p => p.score > 0.01);
  }

  // SEASON: aggregate across categories
  const sp = await getJSON(`/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const seasonAgg = scorePlayers(aggregateSeason(sp)).filter(p => p.score > 0.01);

  // attach season snapshot onto lastPlayers for toCard()
  const seasonIndex = new Map(seasonAgg.map(x => [normalize(x.name), x]));
  lastPlayers.forEach(p => { p._season = seasonIndex.get(normalize(p.name)) || {}; });

  // if lastPlayers is too thin, fall back to seasonAgg
  const baseForSides = (lastPlayers.length >= 3) ? lastPlayers : seasonAgg;

  const [ol, dl] = splitBySide(baseForSides, mapRaw);
  const [os, ds] = splitBySide(seasonAgg, mapRaw);

  const pick3 = arr => arr.sort((a,b)=> b.score - a.score).slice(0,3);
  const topOL = pick3(ol).map(toCard(mapIndex, lastOpp));
  const topDL = pick3(dl).map(toCard(mapIndex, lastOpp));
  const topOS = pick3(os).map(toCard(mapIndex));
  const topDS = pick3(ds).map(toCard(mapIndex));

  const featured = chooseFeatured(dedupeByName([...topOL, ...topOS, ...topDL, ...topDS]), hist);

  await fs.writeFile(OUT.ol, JSON.stringify(topOL, null, 2));
  await fs.writeFile(OUT.os, JSON.stringify(topOS, null, 2));
  await fs.writeFile(OUT.dl, JSON.stringify(topDL, null, 2));
  await fs.writeFile(OUT.ds, JSON.stringify(topDS, null, 2));
  if(featured) await fs.writeFile(OUT.feat, JSON.stringify(featured, null, 2));

  if(featured){
    hist.last_featured = featured.name;
    hist.counts[featured.name] = (hist.counts[featured.name] || 0) + 1;
    await fs.writeFile(OUT.hist, JSON.stringify(hist, null, 2));
  }

  console.log('Spotlight JSON updated.');
}

main().catch(e => { console.error(e); process.exit(1); });
