// scripts/build-ticker.js
import fs from 'fs/promises';
import fetch from 'node-fetch';

const YEAR = process.env.YEAR || new Date().getFullYear();
const TEAM = 'Kentucky';
const KEY = process.env.CFBD_KEY;
if (!KEY) throw new Error('CFBD_KEY is required');

const H = { headers: { Authorization: `Bearer ${KEY}` } };
const api = (p) => `https://api.collegefootballdata.com${p}`;
async function get(p){ const r=await fetch(api(p),H); if(!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); }

function pct(x){ return x==null?null:Math.round(x*1000)/10; }
function dir(season,last,invert=false,tol=0.005){
  if (season==null || last==null) return { d:'steady', delta:0 };
  let d = last - season; if(invert) d = -d;
  if (Math.abs(d) < tol) return { d:'steady', delta:d };
  return { d: d>0 ? 'up' : 'down', delta:d };
}
function compact(n){ return n==null ? null : (Math.abs(n)>=1000 ? `${(n/1000).toFixed(1)}k` : `${n}`); }

(async function main(){
  let seasonAdv={}, lastAdv={}, lastWeek=null;

  try{
    const sa=await get(`/stats/season/advanced?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
    seasonAdv = sa.find(x=>x.team===TEAM||x.school===TEAM)||{};
  }catch{}

  try{
    const ga=await get(`/stats/game/advanced?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
    const weeks=ga.filter(g=>(g.team===TEAM||g.school===TEAM)&&g.week!=null).map(g=>g.week);
    lastWeek = weeks.length?Math.max(...weeks):null;
    lastAdv = lastWeek ? ga.find(g=>(g.team===TEAM||g.school===TEAM)&&g.week===lastWeek) : {};
  }catch{}

  let seasonTeam={}, lastTeam={};
  try{ const ts=await get(`/stats/team/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`); seasonTeam = ts[0]||{}; }catch{}
  try{ const tg=await get(`/stats/team/game?year=${YEAR}&team=${encodeURIComponent(TEAM)}`); if(!lastWeek){ const ws=tg.map(g=>g.week).filter(Boolean); lastWeek=ws.length?Math.max(...ws):null; } lastTeam = tg.find(g=>g.week===lastWeek)||{}; }catch{}

  const items=[];
  const add=(label,seasonVal,lastVal,unit='',invert=false)=>{ if(seasonVal==null && lastVal==null) return; const v=seasonVal!=null?seasonVal:lastVal; items.push({label,unit,val:v,last:lastVal??null,...dir(seasonVal,lastVal,invert)}); };

  if(Object.keys(seasonAdv).length){
    add('Off SR', pct(seasonAdv.off_success_rate), pct(lastAdv?.off_success_rate), '%');
    add('Pass SR', pct(seasonAdv.off_passing_success_rate), pct(lastAdv?.off_passing_success_rate), '%');
    add('Rush SR', pct(seasonAdv.off_rushing_success_rate), pct(lastAdv?.off_rushing_success_rate), '%');
    add('Off PPA/play', seasonAdv.off_ppa==null?null:Number(seasonAdv.off_ppa.toFixed(2)),
                         lastAdv?.off_ppa==null?null:Number(lastAdv.off_ppa.toFixed(2)));
    add('Havoc Allowed', pct(seasonAdv.off_havoc_total), pct(lastAdv?.off_havoc_total), '%', true);
    add('Def SR allowed', pct(seasonAdv.def_success_rate), pct(lastAdv?.def_success_rate), '%', true);
  }else{
    add('Yds/Play', seasonTeam.yards_per_play ?? null, lastTeam.yards_per_play ?? null);
    add('Points/Game', seasonTeam.points_per_game ?? null, lastTeam.points ?? null);
  }

  // Leaders (always)
  let players=[]; try{ players = await get(`/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);}catch{}
  const by = c => players.filter(p => (p.category||'').toLowerCase()===c);
  const pass = by('passing').sort((a,b)=>(b.passing_yards||b.passing_yds||0)-(a.passing_yards||a.passing_yds||0))[0]||{};
  const rush = by('rushing').sort((a,b)=>(b.rushing_yards||b.rush_yds||0)-(a.rushing_yards||a.rush_yds||0))[0]||{};
  const recv = by('receiving').sort((a,b)=>(b.receiving_yards||b.rec_yds||0)-(a.receiving_yards||a.rec_yds||0))[0]||{};
  const kick = players.filter(p=>(p.category||'').toLowerCase()==='kicking').sort((a,b)=>(b.points||0)-(a.points||0))[0]||{};

  const leader=(p,label,unit)=>{ let v=null; if(label==='QB') v=p.passing_yards||p.passing_yds; if(label==='RB') v=p.rushing_yards||p.rush_yds; if(label==='WR') v=p.receiving_yards||p.rec_yds; if(label==='PK') v=p.points; if(v!=null) items.push({label:(p.player||label),unit,val:compact(v),d:'steady'}); };
  leader(pass,'QB','yd'); leader(rush,'RB','rush'); leader(recv,'WR','rec'); leader(kick,'PK','pts');

  await fs.writeFile('./data/ticker.json', JSON.stringify({ year: YEAR, team: TEAM, lastWeek, items }, null, 2));
  console.log('Wrote data/ticker.json');
})();
