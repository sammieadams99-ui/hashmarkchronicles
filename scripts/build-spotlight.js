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

  const games = await getJSON(`https://api.collegefootballdata.com/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const recent = (games||[]).filter(g => g.home_points != null && g.away_points != null)
                            .sort((a,b)=> new Date(b.start_date)-new Date(a.start_date))[0];
  const week = recent?.week;
  const lastOpp = recent ? (recent.home_team === TEAM ? recent.away_team : recent.home_team) : undefined;

  let lastPlayers = [];
  if(week){
    const gp = await getJSON(`https://api.collegefootballdata.com/games/players?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${week}`);
    lastPlayers = scorePlayers(flatGamePlayers(gp));
  }
  const sp = await getJSON(`https://api.collegefootballdata.com/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const seasonPlayers = scorePlayers(flatSeason(sp));

  const [ol, dl] = splitBySide(lastPlayers, map);
  const [os, ds] = splitBySide(seasonPlayers, map);

  const top = arr => arr.sort((a,b)=> b.score - a.score).slice(0,3);
  const topOL = top(ol).map(toCard(map, lastOpp));
  const topOS = top(os).map(toCard(map));
  const topDL = top(dl).map(toCard(map, lastOpp));
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
    const passY = toN(p.passingYards), rushY = toN(p.rushingYards), recY = toN(p.receivingYards);
    const passTD = toN(p.passingTD), rushTD = toN(p.rushingTD), recTD = toN(p.receivingTD);
    const ints = toN(p.interceptions), fum = toN(p.fumblesLost);
    const score = passY*0.04 + (rushY+recY)*0.1 + passTD*4 + (rushTD+recTD)*6 - ints*2 - fum*2;
    return {...p, score};
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

function flatGamePlayers(gps){
  const arr = [];
  (gps||[]).forEach(g => (g.teams||[]).forEach(t => (t.players||[]).forEach(pl => {
    const s = pl.stats || {};
    arr.push({
      name: pl.player,
      position: pl.position,
      cmp: s.completions, att: s.attempts, cmpPct: pct(s.completions, s.attempts),
      passingYards: s.passingYards, passingTD: s.passingTD, interceptions: s.interceptions,
      rushingYards: s.rushingYards, rushingTD: s.rushingTD, fumblesLost: s.fumblesLost,
      receptions: s.receptions, receivingYards: s.receivingYards, receivingTD: s.receivingTD
    });
  })));
  return arr;
}
function flatSeason(sp){
  return (sp||[]).map(s => ({
    name: s.player,
    position: s.position,
    cmp: s.completions, att: s.attempts, cmpPct: pct(s.completions, s.attempts),
    passingYards: s.passingYards, passingTD: s.passingTD, interceptions: s.interceptions,
    rushingYards: s.rushingYards, rushingTD: s.rushingTD, fumblesLost: s.fumblesLost,
    receptions: s.receptions, receivingYards: s.receivingYards, receivingTD: s.receivingTD
  }));
}
function prettyLast(p){
  const out = {};
  if (p.cmp != null && p.att != null) out.cmp_att = `${p.cmp}/${p.att}`;
  if (p.passingYards) out.yds = String(p.passingYards);
  if (p.passingTD) out.td = String(p.passingTD);
  if (p.interceptions) out.int = String(p.interceptions);
  if (p.rushingYards) out.rush_yds = String(p.rushingYards);
  if (p.rushingTD) out.rush_td = String(p.rushingTD);
  if (p.receptions) out.rec = String(p.receptions);
  if (p.receivingYards) out.rec_yds = String(p.receivingYards);
  if (p.receivingTD) out.rec_td = String(p.receivingTD);
  return out;
}
function prettySeason(p){
  const out = {};
  if (p.cmpPct) out.cmp_pct = `${p.cmpPct}%`;
  if (p.passingYards) out.yds = String(p.passingYards);
  if (p.passingTD) out.td = String(p.passingTD);
  if (p.interceptions) out.int = String(p.interceptions);
  if (p.rushingYards) out.rush_yds = String(p.rushingYards);
  if (p.rushingTD) out.rush_td = String(p.rushingTD);
  if (p.receptions) out.rec = String(p.receptions);
  if (p.receivingYards) out.rec_yds = String(p.receivingYards);
  if (p.receivingTD) out.rec_td = String(p.receivingTD);
  return out;
}

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
