// scripts/build-spotlight.js
import fs from 'fs/promises';
import fetch from 'node-fetch';

const YEAR = process.env.YEAR || new Date().getFullYear();
const TEAM = 'Kentucky';
const KEY = process.env.CFBD_KEY;
if (!KEY) throw new Error('CFBD_KEY missing');
const H = { headers: { Authorization: `Bearer ${KEY}` } };
const OUT = {
  ol:'./data/spotlight_offense_last.json',
  os:'./data/spotlight_offense_season.json',
  dl:'./data/spotlight_defense_last.json',
  ds:'./data/spotlight_defense_season.json',
  feat:'./data/spotlight_featured.json',
  hist:'./data/spotlight_history.json'
};
const MAP = './data/espn_map.json';

const toN = x => (x==null||x===''||Number.isNaN(Number(x)))?0:Number(x);
const pct = (a,b)=> (toN(b)?Math.round((toN(a)/toN(b))*100):0);
const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g,'').replace(/\s+/g,' ').trim();
const slug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');

async function get(p){ const r=await fetch(`https://api.collegefootballdata.com${p}`,H); if(!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); }
async function readJSON(p,f){ try{ return JSON.parse(await fs.readFile(p,'utf8')); }catch{ return f; } }

function buildIndex(map){ const m=new Map(); for(const [k,v] of Object.entries(map||{})){ m.set(norm(k),v); (v.aliases||[]).forEach(a=>m.set(norm(a),v)); } return m; }
function resolveMeta(idx,name){ return idx.get(norm(name))||{}; }

function sideOf(posRaw,mapPos){ const OFF=new Set(['QB','RB','FB','WR','TE','OL','C','G','T']); const DEF=new Set(['DL','DE','DT','NT','EDGE','LB','OLB','ILB','DB','CB','S','SS','FS','NB','STAR','JACK']); const p=(mapPos||posRaw||'').toUpperCase(); if(OFF.has(p))return'OFF'; if(DEF.has(p))return'DEF'; if(/^(QB|RB|WR|TE|OL|C|G|T)/.test(p))return'OFF'; return'DEF'; }
function splitBySide(list,mapRaw){ const O=[],D=[]; list.forEach(p=>{ const mp=(mapRaw[p.name]&&mapRaw[p.name].pos)||p.position; (sideOf(p.position,mp)==='OFF'?O:D).push(p);}); return[O,D]; }
function score(list){ return list.map(p=>{ const passY=toN(p.passingYards),rushY=toN(p.rushingYards),recY=toN(p.receivingYards); const passTD=toN(p.passingTD),rushTD=toN(p.rushingTD),recTD=toN(p.receivingTD); const passINT=toN(p.interceptionsThrown||p.interceptions),fum=toN(p.fumblesLost); const tkl=toN(p.tackles||p.totalTackles),tfl=toN(p.tfl||p.tacklesForLoss),sacks=toN(p.sacks),ints=toN(p.defInterceptions||p.interceptionsDef),pbu=toN(p.passesDefended||p.passesBrokenUp),ff=toN(p.forcedFumbles),fr=toN(p.fumblesRecovered),dtd=toN(p.defensiveTD||p.defTD); const off = passY*0.04+(rushY+recY)*0.10+passTD*4+(rushTD+recTD)*6-passINT*2-fum*2; const def = tkl*0.5+tfl*1+sacks*2+ints*3+pbu*0.5+ff*2+fr*1+dtd*6; return {...p, score: off+def}; }); }

function compact(p){ // pick up to 3 short fields
  const out={};
  if(p.cmp!=null&&p.att!=null&&(p.cmp||p.att)) out.cmp_att=`${p.cmp}/${p.att}`;
  if(p.passingYards) out.yds=String(p.passingYards);
  if(p.passingTD) out.td=String(p.passingTD);
  if(p.interceptionsThrown) out.int=String(p.interceptionsThrown);
  if(Object.keys(out).length<3 && p.rushingYards) out.rush_yds=String(p.rushingYards);
  if(Object.keys(out).length<3 && p.rushingTD) out.rush_td=String(p.rushingTD);
  if(Object.keys(out).length<3 && p.receptions) out.rec=String(p.receptions);
  if(Object.keys(out).length<3 && p.receivingYards) out.rec_yds=String(p.receivingYards);
  if(Object.keys(out).length<3 && p.receivingTD) out.rec_td=String(p.receivingTD);
  if(!Object.keys(out).length){ // defense
    if(p.tackles) out.tkl=String(p.tackles);
    if(Object.keys(out).length<3 && p.tfl) out.tfl=String(p.tfl);
    if(Object.keys(out).length<3 && p.sacks) out.sck=String(p.sacks);
    if(Object.keys(out).length<3 && p.defInterceptions) out.int=String(p.defInterceptions);
    if(Object.keys(out).length<3 && p.passesDefended) out.pbu=String(p.passesDefended);
  }
  return out;
}

function toCardLast(idx,lastOpp,seasonIdx){ return p=>{ const meta=resolveMeta(idx,p.name); const id=(meta.id||'').toString(); const pos=p.position||meta.pos||''; const slugStr=meta.slug||slug(p.name); const headshot=id?`https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`:''; const espn=id?`https://www.espn.com/college-football/player/_/id/${id}/${slugStr}`:`https://www.espn.com/search/results?q=${encodeURIComponent(p.name+' Kentucky football')}`; const seasonObj=seasonIdx.get(norm(p.name))||{}; return { name:p.name,pos,slug:slugStr,headshot,espn, last_game:Object.assign(lastOpp?{opp:lastOpp}:{},compact(p)), season:compact(seasonObj) }; }; }
function toCardSeason(idx){ return p=>{ const meta=resolveMeta(idx,p.name); const id=(meta.id||'').toString(); const pos=p.position||meta.pos||''; const slugStr=meta.slug||slug(p.name); const headshot=id?`https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`:''; const espn=id?`https://www.espn.com/college-football/player/_/id/${id}/${slugStr}`:`https://www.espn.com/search/results?q=${encodeURIComponent(p.name+' Kentucky football')}`; return { name:p.name,pos,slug:slugStr,headshot,espn, last_game:{}, season:compact(p) }; }; }

function aggregateGame(rows){ // /stats/player/game
  const by=new Map();
  (rows||[]).filter(r=>r.team===TEAM||r.school===TEAM).forEach(s=>{
    const k=s.player, cat=(s.category||'').toLowerCase(); const o=by.get(k)||{name:k,position:s.position};
    if(cat==='passing'){ o.cmp=toN(s.completions??s.cmp); o.att=toN(s.attempts??s.att); o.cmpPct=pct(o.cmp,o.att); o.passingYards=toN(s.passing_yards??s.passingYards??s.yards); o.passingTD=toN(s.passing_tds??s.passingTD??s.td); o.interceptionsThrown=toN(s.interceptions??s.int); }
    else if(cat==='rushing'){ o.rushingYards=toN(s.rushing_yards??s.rushingYards??s.yards); o.rushingTD=toN(s.rushing_tds??s.rushingTD??s.td); }
    else if(cat==='receiving'){ o.receptions=toN(s.receptions??s.rec); o.receivingYards=toN(s.receiving_yards??s.receivingYards??s.yards); o.receivingTD=toN(s.receiving_tds??s.receivingTD??s.td); }
    else if(cat==='defense'){ o.tackles=toN(s.tackles??s.total_tackles??s.tot_tackles); o.tfl=toN(s.tfl??s.tackles_for_loss); o.sacks=toN(s.sacks); o.defInterceptions=toN(s.interceptions??s.int); o.passesDefended=toN(s.passes_defended??s.pbu); }
    by.set(k,o);
  });
  return Array.from(by.values());
}
function aggregateSeason(rows){ // /stats/player/season
  const by=new Map();
  (rows||[]).filter(r=>r.team===TEAM||r.school===TEAM).forEach(s=>{
    const k=s.player, cat=(s.category||'').toLowerCase(); const o=by.get(k)||{name:k,position:s.position};
    if(cat==='passing'){ o.cmp=toN(s.completions??s.cmp); o.att=toN(s.attempts??s.att); o.cmpPct=pct(o.cmp,o.att); o.passingYards=toN(s.passing_yards??s.passingYards??s.pass_yds??s.yards); o.passingTD=toN(s.passing_tds??s.passingTD??s.td); o.interceptionsThrown=toN(s.interceptions??s.int); }
    else if(cat==='rushing'){ o.rushingYards=toN(s.rushing_yards??s.rushingYards??s.rush_yds??s.yards); o.rushingTD=toN(s.rushing_tds??s.rushingTD??s.td); }
    else if(cat==='receiving'){ o.receptions=toN(s.receptions??s.rec); o.receivingYards=toN(s.receiving_yards??s.receivingYards??s.rec_yds??s.yards); o.receivingTD=toN(s.receiving_tds??s.receivingTD??s.td); }
    else if(cat==='defense'){ o.tackles=toN(s.tackles??s.total_tackles??s.tot_tackles); o.tfl=toN(s.tfl??s.tackles_for_loss); o.sacks=toN(s.sacks); o.defInterceptions=toN(s.interceptions??s.int); o.passesDefended=toN(s.passes_defended??s.pbu); }
    by.set(k,o);
  });
  return Array.from(by.values());
}

function top3(arr){ return arr.sort((a,b)=>b.score-a.score).slice(0,3); }

(async function main(){
  const mapRaw = await readJSON(MAP, {});
  const mapIdx = buildIndex(mapRaw);
  const hist   = await readJSON(OUT.hist, { last_featured:"", counts:{} });

  // latest completed game
  const games = await get(`/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const done  = (games||[]).filter(g=>g.home_points!=null && g.away_points!=null);
  const recent= done.sort((a,b)=>new Date(b.start_date||b.startDate)-new Date(a.start_date||a.startDate))[0];
  const week  = recent?.week;
  const lastOpp = recent ? (recent.home_team===TEAM ? recent.away_team : recent.home_team) : undefined;

  // last week
  let lastAgg = [];
  if(week){
    const gp = await get(`/stats/player/game?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${week}`);
    lastAgg = score(aggregateGame(gp)).filter(p=>p.score>0.01);
  }

  // season
  const sp  = await get(`/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const seasonAgg = score(aggregateSeason(sp)).filter(p=>p.score>0.01);
  const seasonIdx = new Map(seasonAgg.map(x=>[norm(x.name),x]));

  const base = lastAgg.length>=3 ? lastAgg : seasonAgg;

  const [ol,dl] = splitBySide(base, mapRaw);
  const [os,ds] = splitBySide(seasonAgg, mapRaw);

  const topOL = top3(ol).map(toCardLast(mapIdx,lastOpp,seasonIdx));
  const topDL = top3(dl).map(toCardLast(mapIdx,lastOpp,seasonIdx));
  const topOS = top3(os).map(toCardSeason(mapIdx));
  const topDS = top3(ds).map(toCardSeason(mapIdx));

  const featured = (function pick(pool){
    const dedup = []; const seen=new Set();
    for(const p of [...topOL, ...topOS, ...topDL, ...topDS]){ if(!seen.has(p.name)){ seen.add(p.name); dedup.push(p);} }
    const counts=hist.counts||{};
    const list = dedup.filter(p=>(counts[p.name]||0)<2);
    if(list.length>1 && hist.last_featured===list[0].name) [list[0],list[1]]=[list[1],list[0]];
    return (list[0] || dedup[0] || null);
  })();

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
})().catch(e => { console.error(e); process.exit(1); });
