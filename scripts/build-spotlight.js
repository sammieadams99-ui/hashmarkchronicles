// scripts/build-spotlight.js
import fs from 'fs/promises';
import fetch from 'node-fetch';

const YEAR = process.env.YEAR || String(new Date().getFullYear());
const TEAM = 'Kentucky';
const CFBD_KEY = process.env.CFBD_KEY || '';
const HDRS = { Authorization: `Bearer ${CFBD_KEY}` };

const OUT = {
  oLast: './data/spotlight_offense_last.json',
  oSeason: './data/spotlight_offense_season.json',
  dLast: './data/spotlight_defense_last.json',
  dSeason: './data/spotlight_defense_season.json',
  featured: './data/spotlight_featured.json',
  ticker: './data/ticker.json'
};

const ESPN_MAP_PATH = './data/espn_map.json';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function get(url) {
  // retry light for transient CFBD hiccups
  for (let i=0;i<2;i++){
    try {
      const r = await fetch(url, { headers: HDRS });
      if (r.ok) return r.json();
    } catch (err) {
      if (i === 0) console.warn('[spotlight] fetch failed', url, err?.message||err);
    }
    await sleep(300);
  }
  return null;
}
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function tryNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

// ---- Player stat folding (CFBD returns row-per-category) ----
function foldPlayers(rows) {
  // rows: [{player, position, stat, category, ...}]
  const byName = new Map();
  for (const r of rows || []) {
    const name = r.player || `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim();
    if (!name) continue;
    const pos = r.position || r.pos || r.position_group || 'ATH';
    const key = r.stat || r.statType || r.category || r.stat_name;
    const val = tryNum(r.value ?? r.stat_value ?? r.stat ?? 0);

    const p = byName.get(name) || { name, pos, stats: {} };
    if (key) p.stats[key] = (p.stats[key] || 0) + val;
    byName.set(name, p);
  }
  return [...byName.values()];
}

function scoreOff(p){
  const s = p.stats;
  return (
    tryNum(s.passingYards) + tryNum(s.rushingYards) + tryNum(s.receivingYards) +
    20*(tryNum(s.passingTDs||s.passingTds)+tryNum(s.rushingTDs||s.rushingTds)+tryNum(s.receivingTDs||s.receivingTds))
  );
}
function scoreDef(p){
  const s = p.stats;
  return (
    tryNum(s.tackles) +
    2*tryNum(s.sacks) +
    1.5*tryNum(s.tfl || s.tacklesForLoss) +
    4*tryNum(s.interceptions) +
    2*tryNum(s.passesDefended || s.pdus || s.passBreakUps || s.pbus) +
    2*tryNum(s.forcedFumbles)
  );
}
function statLineOff(p) {
  const s = p.stats;
  const line = [];
  const py = tryNum(s.passingYards), ptd = tryNum(s.passingTDs || s.passingTds);
  const ry = tryNum(s.rushingYards), rtd = tryNum(s.rushingTDs || s.rushingTds);
  const recy = tryNum(s.receivingYards), rectd = tryNum(s.receivingTDs || s.receivingTds);
  if (py) line.push(`${py} PY`);
  if (ptd) line.push(`${ptd} PTD`);
  if (ry) line.push(`${ry} RY`);
  if (rtd) line.push(`${rtd} RTD`);
  if (recy) line.push(`${recy} RecY`);
  if (rectd) line.push(`${rectd} RecTD`);
  return line.join(' · ') || '—';
}
function statLineDef(p) {
  const s = p.stats;
  const line = [];
  const t = tryNum(s.tackles), sacks = tryNum(s.sacks), tfl = tryNum(s.tfl || s.tacklesForLoss);
  const ints = tryNum(s.interceptions), ff = tryNum(s.forcedFumbles), pd = tryNum(s.passesDefended || s.pdus || s.pbus);
  if (t) line.push(`${t} TKL`);
  if (sacks) line.push(`${sacks} SCK`);
  if (tfl) line.push(`${tfl} TFL`);
  if (ints) line.push(`${ints} INT`);
  if (ff) line.push(`${ff} FF`);
  if (pd) line.push(`${pd} PD`);
  return line.join(' · ') || '—';
}

function resolveMeta(map, key) {
  const raw = map?.[key];
  if (raw == null) return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const id = String(raw).trim();
    return id ? { espnId: id } : null;
  }
  if (typeof raw === 'object') {
    const id = raw.espnId ?? raw.espnid ?? raw.id ?? raw.ID ?? raw.playerId ?? raw.player_id;
    if (!id && typeof raw === 'string') {
      const str = String(raw).trim();
      return str ? { espnId: str } : null;
    }
    return id ? { espnId: id } : null;
  }
  return null;
}

function decorate(p, map) {
  const slug = slugify(p.name);
  const meta =
    resolveMeta(map, slug) ||
    resolveMeta(map, slug.toLowerCase()) ||
    resolveMeta(map, p.name) ||
    resolveMeta(map, p.name?.toLowerCase?.());
  const headshot = meta?.espnId
    ? `https://a.espncdn.com/i/headshots/college-football/players/full/${meta.espnId}.png`
    : ""; // front-end will draw SVG fallback if blank
  const espn = meta?.espnId
    ? `https://www.espn.com/college-football/player/_/id/${meta.espnId}`
    : `https://www.espn.com/search/results?q=${encodeURIComponent(p.name + ' Kentucky football')}`;
  return { ...p, slug, headshot, espn };
}

function topK(list, scorer, k=3){
  return [...list].sort((a,b)=>scorer(b)-scorer(a)).slice(0,k);
}

function formatRow(base, statline, score, span){
  return {
    name: base.name,
    pos: base.pos,
    slug: base.slug,
    headshot: base.headshot,
    espn: base.espn,
    statline,
    score: Number.isFinite(score) ? Number(score) : null,
    span
  };
}

async function ensureDir(){
  try { await fs.mkdir('./data', { recursive: true }); } catch {}
}

async function writeJSON(path, data){
  await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

// ---- Build Ticker ----
async function buildTicker() {
  const base = { year: YEAR, team: TEAM, lastWeek: null, items: [] };

  // last played week
  const games = await get(`https://api.collegefootballdata.com/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const played = (games||[]).filter(g => g.home_points != null && g.away_points != null);
  const lastWeek = played.length ? Math.max(...played.map(g => g.week || g.week_number || 0)) : null;
  base.lastWeek = lastWeek ?? null;

  // season advanced (success rate, havoc)
  const adv = await get(`https://api.collegefootballdata.com/stats/season/advanced?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const advRow = Array.isArray(adv) && adv.length ? adv[0] : null;

  const offSR = advRow?.offense?.successRate ?? null;
  const havocAllowed = advRow?.offense?.havoc?.total ?? null;

  // yards/play (season)
  const season = await get(`https://api.collegefootballdata.com/stats/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  const yppRow = (season||[]).find(r => /yards per play/i.test(r.statName||r.stat_name||''));
  const ypp = yppRow ? Number(yppRow.statValue ?? yppRow.stat_value) : null;

  // PPA last 3 (treat as EPAish trend)
  const ppaGames = await get(`https://api.collegefootballdata.com/metrics/ppa/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}`);
  let ppaLast3 = null;
  if (Array.isArray(ppaGames) && ppaGames.length) {
    const last3 = [...ppaGames].slice(-3);
    const vals = last3.map(g => Number(g.offense?.ppa)).filter(Number.isFinite);
    if (vals.length) ppaLast3 = (vals.reduce((a,b)=>a+b,0)/vals.length);
  }

  function stat(label, value, fmt='raw') {
    let text = '—', trend='steady';
    if (value == null || Number.isNaN(Number(value))) {
      text = '—';
    } else if (fmt === 'pct') {
      text = (Number(value)*100).toFixed(1) + '%';
    } else if (fmt === '1d') {
      text = Number(value).toFixed(2);
    } else {
      text = String(value);
    }
    return { label, value: text, trend };
  }

  const items = [
    stat('Yards/Play (UK)', ypp, '1d'),
    stat('Off SR', offSR, 'pct'),
    stat('EPA/Play last 3', ppaLast3, '1d'),
    stat('Havoc Allowed', havocAllowed, 'pct')
  ];

  base.items = items;
  return base;
}

// ---- Build Spotlight (last + season) ----
async function buildSpotlight() {
  // last week (if none, keep arrays empty)
  const games = await get(`https://api.collegefootballdata.com/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const played = (games||[]).filter(g => g.home_points != null && g.away_points != null);
  const lastWeek = played.length ? Math.max(...played.map(g => g.week || g.week_number || 0)) : null;

  // load ESPN id mapping
  let map = {};
  try { map = JSON.parse(await fs.readFile(ESPN_MAP_PATH, 'utf8')); } catch {}

  // season player stats
  const seasonRows = await get(`https://api.collegefootballdata.com/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`) || [];
  const seasonPlayers = foldPlayers(seasonRows);

  // last-game stats
  const gameRows = lastWeek
    ? (await get(`https://api.collegefootballdata.com/stats/player/game?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${lastWeek}`) || [])
    : [];
  const gamePlayers = foldPlayers(gameRows);

  const offenseLast = topK(gamePlayers.filter(p => /QB|RB|WR|TE|ATH/i.test(p.pos)), scoreOff, 3)
    .map(p => {
      const base = decorate(p, map);
      const statline = statLineOff(p);
      return formatRow(base, statline, scoreOff(p), 'last');
    });

  const defenseLast = topK(gamePlayers.filter(p => !/QB|RB|WR|TE/i.test(p.pos)), scoreDef, 3)
    .map(p => {
      const base = decorate(p, map);
      const statline = statLineDef(p);
      return formatRow(base, statline, scoreDef(p), 'last');
    });

  const offenseSeason = topK(seasonPlayers.filter(p => /QB|RB|WR|TE|ATH/i.test(p.pos)), scoreOff, 3)
    .map(p => {
      const base = decorate(p, map);
      const statline = statLineOff(p);
      return formatRow(base, statline, scoreOff(p), 'season');
    });

  const defenseSeason = topK(seasonPlayers.filter(p => !/QB|RB|WR|TE/i.test(p.pos)), scoreDef, 3)
    .map(p => {
      const base = decorate(p, map);
      const statline = statLineDef(p);
      return formatRow(base, statline, scoreDef(p), 'season');
    });

  // featured = best of the 6 (prefer last-game offense, then defense, else season offense)
  const candidates = [...offenseLast, ...defenseLast, ...offenseSeason];
  const featured = candidates.length ? candidates[0] : {
    name: '—',
    pos: '',
    slug: '—',
    headshot: '',
    espn: `https://www.espn.com/search/results?q=${encodeURIComponent('Kentucky football')}`,
    statline: '—',
    span: 'last'
  };

  return { lastWeek, offenseLast, defenseLast, offenseSeason, defenseSeason, featured };
}

// ---- Run all ----
(async () => {
  await ensureDir();

  const sp = await buildSpotlight();
  await writeJSON(OUT.oLast, sp.offenseLast);
  await writeJSON(OUT.dLast, sp.defenseLast);
  await writeJSON(OUT.oSeason, sp.offenseSeason);
  await writeJSON(OUT.dSeason, sp.defenseSeason);
  await writeJSON(OUT.featured, sp.featured);

  const ticker = await buildTicker();
  await writeJSON(OUT.ticker, ticker);

  console.log('Spotlight + ticker written for', TEAM, YEAR, 'Last week:', sp.lastWeek ?? 'n/a');
})();
