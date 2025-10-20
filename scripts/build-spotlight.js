// scripts/build-spotlight.js  (v2: robust name matching + season aggregator)
import fs from 'fs/promises';
import fetch from 'node-fetch';

const YEAR = process.env.YEAR || new Date().getFullYear();
const TEAM = 'Kentucky';
const CFBD_KEY = process.env.CFBD_KEY;
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

// --- helpers ---
const toN = (x) => (x == null || x === '' || Number.isNaN(Number(x))) ? 0 : Number(x);
const pct = (a,b) => (toN(b) ? Math.round((toN(a)/toN(b))*100) : 0);
const slug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');

// normalize names for fuzzy match
const normalize = s =>
  (s||'')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g,' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g,'')
    .replace(/\s+/g,' ')
    .trim();

async function main(){
  if(!CFBD_KEY) throw new Error('CFBD_KEY missing');

  const mapRaw = await readJSON(ESPN_MAP_FILE, {});
  const mapIndex = buildNameIndex(mapRaw);
  const hist = await readJSON(OUT.hist, { last_featured: "", counts: {} });

  // recent game (for "last")
  const games = await getJSON(`/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const done = (games||[]).filter(g => g.home_points != null && g.away_points != null);
  const recent = done.sort((a,b)=> new Date(b.start_date||b.startDate) - new Date(a.start_date||a.startDate))[0];
  const week = recent?.week;
  const lastOpp = recent ? (recent.home_team === TEAM ? recent.away_team : recent.home_team) : undefined;

  // last game players
  let lastPlayers = [];
  if(week){
    const gp = await getJSON(`/games/players?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${week}&seasonType=regular`);
    lastPlayers = scorePlayers(flatGamePlayers(gp));
  }

  // season players (aggregate across categories)
  const sp = await getJSON(`/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const seasonPlayers = scorePlayers(aggregateSeason(sp));

  // split offense/defense
  const [ol, dl] = splitBySide(lastPlayers, mapRaw);
  const [os, ds] = splitBySide(seasonPlayers, mapRaw);

  const pick3 = arr => arr.sort((a,b)=> b.score - a.score).slice(0,3);
  const topOL = (ol.length ? pick3(ol) : pick3(os)).map(toCard(mapIndex, lastOpp));
  const topDL = (dl.length ? pick3(dl) : pick3(ds)).map(toCard(mapIndex, lastOpp));
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

/* ---------- mapping & matching ---------- */
function buildNameIndex(map){
  const idx = new Map();
  for(const [name, meta] of Object.entries(map)){
    idx.set(normalize(name), meta);
    if(meta && Array.isArray(meta.aliases)){
      for(const a of meta.aliases){
        idx.set(normalize(a), meta);
      }
    }
  }
  return idx;
}
function resolveMeta(index, name){
  return index.get(normalize(name)) || null;
}
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
  players.forEach(p=>{
    const mp = (mapRaw[p.name] && mapRaw[p.name].pos) || p.position;
    const side = sideOf(p.position, mp);
    (side==='OFF'?O:D).push(p);
  });
  return [O,D];
}

/* ---------- stat shaping ---------- */
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

// Aggregate season endpoint (multiple categories per player)
function aggregateSeason(rows){
  const by = new Map();
  (rows||[]).forEach(s => {
    const name = s.player;
    const cat  = (s.category||'').toLowerCase();
    const pos  = s.position;
    const o = by.get(name) || { name, position: pos };
    if(cat === 'passing'){
      o.cmp = toN(s.completions ?? s.cmp);
      o.att = toN(s.attempts ?? s.att);
      o.cmpPct = pct(o.cmp, o.att);
      o.passingYards = toN(s.passing_yards ?? s.passingYards ?? s.pass_yds ?? s.yards);
      o.passingTD    = toN(s.passing_tds  ?? s.passingTD  ?? s.td);
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

// games/players endpoint (single object per player with many keys)
function flatGamePlayers(gps){
  const out = [];
  (gps||[]).forEach(g => (g.teams||[]).forEach(t => (t.players||[]).forEach(pl => {
    const s = pl.stats || {};
    out.push({
      name: pl.player, position: pl.position,
      cmp: toN(s.completions ?? s.cmp),
      att: toN(s.attempts ?? s.att),
      cmpPct: pct(s.completions ?? s.cmp, s.attempts ?? s.att),
      passingYards: toN(s.passingYards ?? s.passing_yards ?? s.pass_yds ?? s.yards_passing ?? s.yards),
      passingTD:    toN(s.passingTD    ?? s.passing_tds    ?? s.pass_td    ?? s.td_passing),
      interceptionsThrown: toN(s.interceptionsThrown ?? s.int_thrown ?? (s.passingInterceptions ?? 0) ?? (s.interceptions ?? 0)),
      rushingYards: toN(s.rushingYards ?? s.rushing_yards ?? s.rush_yds ?? s.yards_rushing),
      rushingTD:    toN(s.rushingTD    ?? s.rushing_tds    ?? s.rush_td),
      receptions:   toN(s.receptions ?? s.rec),
      receivingYards: toN(s.receivingYards ?? s.receiving_yards ?? s.rec_yds ?? s.yards_receiving),
      receivingTD:  toN(s.receivingTD ?? s.receiving_tds ?? s.rec_td),
      tackles:      toN(s.tackles ?? s.totalTackles ?? s.tot_tackles),
      tfl:          toN(s.tfl ?? s.tacklesForLoss ?? s.tackles_for_loss),
      sacks:        toN(s.sacks),
      passesDefended: toN(s.passesDefended ?? s.passes_defended ?? s.pbu),
      defInterceptions: toN(s.interceptionsDef ?? s.def_interceptions ?? s.int_def),
      forcedFumbles:  toN(s.forcedFumbles ?? s.ff),
      fumblesRecovered: toN(s.fumblesRecovered ?? s.fr),
      defensiveTD:   toN(s.defensiveTD ?? s.def_td)
    });
  })));
  return out;
}

/* ---------- output shaping ---------- */
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
      last_game: Object.assign(lastOpp ? {opp:lastOpp} : {}, prettyShort(p, true)),
      season: prettyShort(p, false)
    };
  };
}
function prettyShort(p, preferOffense=false){
  // pick up to 3 compact lines preferring offense then defense
  const off = [];
  if (p.cmp != null && p.att != null && (p.cmp || p.att)) off.push(['CMP/ATT', `${p.cmp}/${p.att}`]);
  if (p.passingYards) off.push(['YDS', String(p.passingYards)]);
  if (p.passingTD)    off.push(['TD', String(p.passingTD)]);
  if (p.interceptionsThrown) off.push(['INT', String(p.interceptionsThrown)]);
  if (p.rushingYards) off.push(['RUSH', String(p.rushingYards)]);
  if (p.rushingTD)    off.push(['R-TD', String(p.rushingTD)]);
  if (p.receptions)   off.push(['REC', String(p.receptions)]);
  if (p.receivingYards) off.push(['REC-YDS', String(p.receivingYards)]);
  if (p.receivingTD)  off.push(['REC-TD', String(p.receivingTD)]);

  const def = [];
  if (p.tackles) def.push(['TKL', String(p.tackles)]);
  if (p.tfl)     def.push(['TFL', String(p.tfl)]);
  if (p.sacks)   def.push(['SACK', String(p.sacks)]);
  if (p.defInterceptions) def.push(['INT', String(p.defInterceptions)]);
  if (p.passesDefended)   def.push(['PBU', String(p.passesDefended)]);
  if (p.defensiveTD)      def.push(['DEF-TD', String(p.defensiveTD)]);

  const pick = preferOffense ? (off.length ? off : def) : (off.length ? off : def);
  // return object instead of array; the front-end will pick first 3 that exist
  const out = {};
  pick.slice(0,3).forEach(([k,v]) => {
    if (k==='CMP/ATT') out.cmp_att = v;
    else if (k==='YDS') out.yds = v;
    else if (k==='TD') out.td = v;
    else if (k==='INT') out.int = v;
    else if (k==='RUSH') out.rush_yds = v;
    else if (k==='R-TD') out.rush_td = v;
    else if (k==='REC') out.rec = v;
    else if (k==='REC-YDS') out.rec_yds = v;
    else if (k==='REC-TD') out.rec_td = v;
    else if (k==='TKL') out.tkl = v;
    else if (k==='TFL') out.tfl = v;
    else if (k==='SACK') out.sck = v;
    else if (k==='PBU') out.pbu = v;
    else if (k==='DEF-TD') out.def_td = v;
  });
  return out;
}

/* ---------- http/io ---------- */
async function getJSON(path){
  const url = `https://api.collegefootballdata.com${path}`;
  const r = await fetch(url, {headers: HEADERS});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText} for ${path}`);
  return r.json();
}
async function readJSON(path, fallback){
  try{ return JSON.parse(await fs.readFile(path,'utf8')); }
  catch{ return fallback; }
}

/* ---------- selection rules ---------- */
function dedupeByName(list){
  const seen = new Set(); const out = [];
  for(const p of list){ if(!seen.has(p.name)){ seen.add(p.name); out.push(p);} }
  return out;
}
function chooseFeatured(pool, hist){
  if(!pool.length) return null;
  const counts = hist.counts || {};
  const ranked = [...pool]; // already sorted by score
  const eligible = ranked.filter(p => (counts[p.name] || 0) < 2);
  let list = eligible.length ? eligible : ranked;
  if (list.length > 1 && list[0].name === hist.last_featured){
    [list[0], list[1]] = [list[1], list[0]];
  }
  return list[0];
}

main().catch(e => { console.error(e); process.exit(1); });
