// npm i
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
const ESPN_MAP = './data/espn_map.json';

const OFF = new Set(['QB','RB','FB','WR','TE','OL','C','G','T']);
const DEF = new Set(['DL','DE','DT','NT','EDGE','LB','OLB','ILB','DB','CB','S','SS','FS','NB','STAR','JACK']);

const toN = x => Number.isFinite(Number(x)) ? Number(x) : 0;
const pct = (a,b) => (toN(b) ? Math.round(toN(a)/toN(b)*100) : 0);
const slug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');

async function main(){
  if(!CFBD_KEY) throw new Error('CFBD_KEY missing');

  const map = await readJSON(ESPN_MAP, {});
  const hist = await readJSON(OUT.hist, { last_featured: "", counts: {} });

  // --- latest completed game (regular season) ---
  const games = await getJSON(`https://api.collegefootballdata.com/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const completed = (games||[]).filter(g => g.home_points != null && g.away_points != null);
  // CFBD fields are usually snake_case
  const recent = completed.sort((a,b)=> new Date(b.start_date||b.startDate) - new Date(a.start_date||a.startDate))[0];
  const week = recent?.week;
  const lastOpp = recent ? (recent.home_team === TEAM ? recent.away_team : recent.home_team) : undefined;

  // --- last game players (if we have a week) ---
  let lastPlayers = [];
  if(week){
    const gp = await getJSON(`https://api.collegefootballdata.com/games/players?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${week}&seasonType=regular`);
    lastPlayers = scorePlayers(flatGamePlayers(gp));
  }

  // --- season players ---
  const sp = await getJSON(`https://api.collegefootballdata.com/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const seasonPlayers = scorePlayers(flatSeason(sp));

  // --- split by side & take tops ---
  const [ol, dl] = splitBySide(lastPlayers, map);
  const [os, ds] = splitBySide(seasonPlayers, map);

  const top = arr => arr.sort((a,b)=> b.score - a.score).slice(0,3);

  // If last-game arrays ended empty (bye/missing feed), fall back to season for homepage continuity
  const topOL = (ol.length ? top(ol) : top(os)).map(toCard(map, lastOpp));
  const topDL = (dl.length ? top(dl) : top(ds)).map(toCard(map, lastOpp));
  const topOS = top(os).map(toCard(map));
  const topDS = top(ds).map(toCard(map));

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

/* ----------------- helpers ----------------- */

function dedupeByName(list){
  const seen = new Set(); const out = [];
  for(const p of list){ if(!seen.has(p.name)){ seen.add(p.name); out.push(p);} }
  return out;
}
function sideOf(posRaw, mapPos){
  const p = (mapPos || posRaw || '').toUpperCase();
  if (OFF.has(p)) return 'OFF';
  if (DEF.has(p)) return 'DEF';
  if (/^(QB|RB|WR|TE|OL|C|G|T)/.test(p)) return 'OFF';
  return 'DEF';
}
function splitBySide(players, map){
  const O=[], D=[];
  players.forEach(p=>{
    const mp = map[p.name]?.pos;
    const side = sideOf(p.position, mp);
    (side==='OFF'?O:D).push(p);
  });
  return [O,D];
}

function scorePlayers(list){
  return list.map(p => {
    // Offense
    const passY = toN(p.passingYards), rushY = toN(p.rushingYards), recY = toN(p.receivingYards);
    const passTD = toN(p.passingTD), rushTD = toN(p.rushingTD), recTD = toN(p.receivingTD);
    const passINT = toN(p.interceptionsThrown || p.interceptions); // QBs
    const fum = toN(p.fumblesLost);

    // Defense
    const tkl = toN(p.tackles || p.totalTackles);
    const tfl = toN(p.tfl || p.tacklesForLoss);
    const sacks = toN(p.sacks);
    const ints = toN(p.defInterceptions || p.interceptionsDef || p.def_int || p.defInterceptionsTotal);
    const pbu = toN(p.passesDefended || p.passesBrokenUp);
    const ff  = toN(p.forcedFumbles);
    const fr  = toN(p.fumblesRecovered);
    const dtd = toN(p.defensiveTD || p.defTD);

    const offScore = passY*0.04 + (rushY+recY)*0.10 + passTD*4 + (rushTD+recTD)*6 - passINT*2 - fum*2;
    const defScore = tkl*0.5 + tfl*1 + sacks*2 + ints*3 + pbu*0.5 + ff*2 + fr*1 + dtd*6;

    return {...p, score: offScore + defScore};
  });
}

function toCard(map, lastOpp){
  return p => {
    const name = p.name || p.player || '';
    const m = map[name] || {};
    const id = (m.id || '').toString();
    const slugStr = m.slug || slug(name);
    const pos = p.position || m.pos || '';
    const headshot = id ? `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png` : '';
    const espn = id ? `https://www.espn.com/college-football/player/_/id/${id}/${slugStr}`
                    : `https://www.espn.com/search/results?q=${encodeURIComponent(name+' Kentucky football')}`;

    return {
      name, pos, slug: slugStr, headshot, espn,
      last_game: Object.assign(lastOpp ? {opp:lastOpp} : {}, prettyLast(p)),
      season: prettySeason(p)
    };
  };
}

function chooseFeatured(pool, hist){
  if(!pool.length) return null;
  const counts = hist.counts || {};
  const ranked = [...pool].sort((a,b)=> b.score - a.score);
  const eligible = ranked.filter(p => (counts[p.name] || 0) < 2);
  let list = eligible.length ? eligible : ranked;
  if (list.length > 1 && list[0].name === hist.last_featured){
    [list[0], list[1]] = [list[1], list[0]];
  }
  return list[0];
}

/* --- CFBD shape flatteners --- */
function flatGamePlayers(gps){
  const arr = [];
  (gps||[]).forEach(g => (g.teams||[]).forEach(t => (t.players||[]).forEach(pl => {
    const s = pl.stats || {};
    arr.push({
      name: pl.player, position: pl.position,

      // offense
      cmp: s.completions, att: s.attempts, cmpPct: pct(s.completions, s.attempts),
      passingYards: s.passingYards, passingTD: s.passingTD, interceptionsThrown: s.interceptions,
      rushingYards: s.rushingYards, rushingTD: s.rushingTD, fumblesLost: s.fumblesLost,
      receptions: s.receptions, receivingYards: s.receivingYards, receivingTD: s.receivingTD,

      // defense (common CFBD fields)
      tackles: s.tackles, tfl: s.tfl, sacks: s.sacks,
      passesDefended: s.passesDefended, defInterceptions: s.interceptionsDef,
      forcedFumbles: s.forcedFumbles, fumblesRecovered: s.fumblesRecovered,
      defensiveTD: s.defensiveTD
    });
  })));
  return arr;
}
function flatSeason(sp){
  return (sp||[]).map(s => ({
    name: s.player, position: s.position,

    // offense
    cmp: s.completions, att: s.attempts, cmpPct: pct(s.completions, s.attempts),
    passingYards: s.passingYards, passingTD: s.passingTD, interceptionsThrown: s.interceptions,
    rushingYards: s.rushingYards, rushingTD: s.rushingTD, fumblesLost: s.fumblesLost,
    receptions: s.receptions, receivingYards: s.receivingYards, receivingTD: s.receivingTD,

    // defense
    tackles: s.tackles, tfl: s.tacklesForLoss || s.tfl, sacks: s.sacks,
    passesDefended: s.passesDefended, defInterceptions: s.interceptionsDef,
    forcedFumbles: s.forcedFumbles, fumblesRecovered: s.fumblesRecovered,
    defensiveTD: s.defensiveTD
  }));
}

/* --- pretty printers --- */
function prettyLast(p){
  const out = {};
  // offense (useful quick hits)
  if (p.cmp != null && p.att != null) out.cmp_att = `${p.cmp}/${p.att}`;
  if (p.passingYards) out.yds = String(p.passingYards);
  if (p.passingTD) out.td = String(p.passingTD);
  if (p.interceptionsThrown) out.int = String(p.interceptionsThrown);
  if (p.rushingYards) out.rush_yds = String(p.rushingYards);
  if (p.rushingTD) out.rush_td = String(p.rushingTD);
  if (p.receptions) out.rec = String(p.receptions);
  if (p.receivingYards) out.rec_yds = String(p.receivingYards);
  if (p.receivingTD) out.rec_td = String(p.receivingTD);

  // defense (fill if offensive fields absent)
  if (!Object.keys(out).length) {
    if (p.tackles) out.tkl = String(p.tackles);
    if (p.tfl) out.tfl = String(p.tfl);
    if (p.sacks) out.sck = String(p.sacks);
    if (p.defInterceptions) out.int = String(p.defInterceptions);
    if (p.passesDefended) out.pbu = String(p.passesDefended);
    if (p.forcedFumbles) out.ff = String(p.forcedFumbles);
    if (p.fumblesRecovered) out.fr = String(p.fumblesRecovered);
    if (p.defensiveTD) out.def_td = String(p.defensiveTD);
  }
  return out;
}
function prettySeason(p){
  const out = {};
  if (p.cmpPct) out.cmp_pct = `${p.cmpPct}%`;
  if (p.passingYards) out.yds = String(p.passingYards);
  if (p.passingTD) out.td = String(p.passingTD);
  if (p.interceptionsThrown) out.int = String(p.interceptionsThrown);
  if (p.rushingYards) out.rush_yds = String(p.rushingYards);
  if (p.rushingTD) out.rush_td = String(p.rushingTD);
  if (p.receptions) out.rec = String(p.receptions);
  if (p.receivingYards) out.rec_yds = String(p.receivingYards);
  if (p.receivingTD) out.rec_td = String(p.receivingTD);

  if (!Object.keys(out).length) {
    if (p.tackles) out.tkl = String(p.tackles);
    if (p.tfl) out.tfl = String(p.tfl);
    if (p.sacks) out.sck = String(p.sacks);
    if (p.defInterceptions) out.int = String(p.defInterceptions);
    if (p.passesDefended) out.pbu = String(p.passesDefended);
    if (p.forcedFumbles) out.ff = String(p.forcedFumbles);
    if (p.fumblesRecovered) out.fr = String(p.fumblesRecovered);
    if (p.defensiveTD) out.def_td = String(p.defensiveTD);
  }
  return out;
}

/* --- io --- */
async function getJSON(url){
  const r = await fetch(url, {headers: HEADERS});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function readJSON(path, fallback){
  try{ return JSON.parse(await fs.readFile(path,'utf8')); }
  catch{ return fallback; }
}

main().catch(e => { console.error(e); process.exit(1); });
