// scripts/build-spotlight.js
import fs from 'fs/promises';

const YEAR = process.env.YEAR || String(new Date().getFullYear());
const TEAM = 'Kentucky';
const CFBD_KEY = process.env.CFBD_KEY || process.env.CFBD_API_KEY;
console.log('✅ Using built-in Node fetch() — no external dependency needed.');
const FORCE_BUILD = Boolean(process.env.FORCE_BUILD);

if (!CFBD_KEY) {
  console.error('[spotlight] Missing CFBD_KEY env var — aborting.');
  process.exit(1);
}

const HEADERS = { Authorization: `Bearer ${CFBD_KEY}` };

// Helper for FORCE_BUILD: fetch latest completed game directly from CFBD /games
async function getForcedLatestGame() {
  if (!FORCE_BUILD) return null;

  console.log('⚙️ FORCE_BUILD enabled — building from most recent available game.');

  if (!CFBD_KEY) throw new Error('Missing CFBD_KEY');
  const headers = { Authorization: `Bearer ${CFBD_KEY}` };

  async function fetchGames(seasonType) {
    const url = `https://api.collegefootballdata.com/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=${seasonType}`;
    console.log('GET', url);
    const r = await fetch(url, { headers });
    console.log('→', r.status, seasonType);
    if (!r.ok) throw new Error(`CFBD /games ${seasonType} ${r.status}`);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) {
      console.warn('[warn] non-JSON response:', r.status, ct);
      return null;
    }
    let data;
    try {
      data = await r.json();
    } catch (err) {
      console.warn('[warn] JSON parse failed:', err?.message || err);
      return null;
    }
    return data;
  }

  function isFiniteNum(x) {
    return Number.isFinite(typeof x === 'string' ? Number(x) : x);
  }

  function seemsCompleted(g) {
    if (g?.completed === true) return true;

    const stRaw = g?.status?.type || g?.status?.name || g?.status || g?.game_status || '';
    const st = String(stRaw).toLowerCase();
    if (st.includes('final') || st.includes('complete') || st.includes('post')) return true;

    const hp = g?.home_points ?? g?.homePoints ?? g?.home_points_total;
    const ap = g?.away_points ?? g?.awayPoints ?? g?.away_points_total;
    if (isFiniteNum(hp) && isFiniteNum(ap)) return true;

    return false;
  }

  function latestCompleted(list) {
    const rows = Array.isArray(list) ? list.slice() : [];
    const done = rows.filter(seemsCompleted);
    done.sort((a, b) => new Date(b.start_date || b.startDate) - new Date(a.start_date || a.startDate));
    return done[0] || null;
  }

  let latest = null;
  try {
    const reg = await fetchGames('regular');
    console.log(`CFBD regular games found: ${Array.isArray(reg) ? reg.length : 0}`);
    if (Array.isArray(reg) && reg.length) {
      const g0 = reg[reg.length - 1];
      console.log('[CFBD sample] keys:', Object.keys(g0 || {}).slice(0, 20).join(', '));
      console.log('[CFBD sample] fields:', {
        id: g0?.id || g0?.game_id,
        home_team: g0?.home_team || g0?.homeTeam,
        away_team: g0?.away_team || g0?.awayTeam,
        start: g0?.start_date || g0?.startDate,
        status: g0?.status || g0?.game_status || g0?.status?.type || g0?.status?.name,
        completed: g0?.completed,
        home_points: g0?.home_points ?? g0?.homePoints ?? g0?.home_points_total,
        away_points: g0?.away_points ?? g0?.awayPoints ?? g0?.away_points_total
      });
    }
    latest = latestCompleted(reg);
    if (!latest) {
      const post = await fetchGames('postseason');
      console.log(`CFBD postseason games found: ${Array.isArray(post) ? post.length : 0}`);
      latest = latestCompleted(post);
    }
  } catch (e) {
    console.log('CFBD /games fetch error:', e?.message || e);
  }

  let latestGame = null;

  if (latest) {
    const gid = latest.id || latest.game_id;
    const WEEK = latest.week || latest.week_number || latest.weekNum || null;
    console.log(`Using game ${gid} — ${latest.home_team || latest.homeTeam} vs ${latest.away_team || latest.awayTeam} on ${latest.start_date || latest.startDate}`);
    let pick = { ...latest };
    try {
      const key = CFBD_KEY || process.env.CFBD_KEY || process.env.CFBD_API_KEY;
      const url = WEEK
        ? `https://api.collegefootballdata.com/games/players?year=${YEAR}&week=${WEEK}&gameId=${gid}`
        : `https://api.collegefootballdata.com/games/players?year=${YEAR}&gameId=${gid}`;
      console.log('GET', url);
      console.log('[CFBD] Using year', YEAR, 'week', WEEK, 'gameId', gid);
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
      });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      console.log('→', r.status, ct);
      if (r.status === 400) console.log('[warn] CFBD 400:', await r.clone().text().catch(() => '(no body)'));

      let box = null;
      if (!ct.includes('json')) {
        console.warn('[warn] non-JSON response:', r.status, ct);
      } else {
        try {
          box = await r.json();
        } catch (err) {
          console.warn('[warn] JSON parse failed:', err?.message || err);
        }
      }

      if (!box) {
        console.log('[spotlight] ⚠️ No player data returned for game', gid);
      } else {
        const players = Array.isArray(box.players) ? box.players : (Array.isArray(box) ? box : []);
        console.log(`[spotlight] ✅ Retrieved player data for game ${gid} (${players.length} entries)`);
        console.log('[spotlight] ✅ Parsed', players.length, 'entries');
        pick = {
          ...pick,
          sum: {
            ...(pick.sum || {}),
            boxscore: {
              ...(pick.sum?.boxscore || {}),
              players
            }
          }
        };
      }
    } catch (err) {
      console.log('[spotlight] ⚠️ Unable to fetch player data:', err?.message || err);
    }

    latestGame = [pick];
  } else {
    console.log('No completed games found by robust check; continuing with existing data.');
  }

  return latestGame ? latestGame[0] : null;
}

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
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('json')) {
          console.warn('[warn] non-JSON response:', r.status, ct);
          return null;
        }
        try {
          return await r.json();
        } catch (err) {
          console.warn('[warn] JSON parse failed:', err?.message || err);
          return null;
        }
      }
    } catch (err) {
      if (i === 0) console.warn('[spotlight] fetch failed', url, err?.message||err);
      if (i === 1) console.warn('CFBD request failed:', url, err.message || err);
    }
    await sleep(300);
  }
  return null;
}
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function tryNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

const clamp = (min,max,v) => Math.min(Math.max(Number(v)||0,min),max);
function letterFromPct(pct){
  const cut=[97,93,90,87,83,80,77,73,70,67,63,60];
  const lab=['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
  const n=Math.round(clamp(0,100,pct));
  for(let i=0;i<cut.length;i++){
    if(n>=cut[i]) return { pct:n, letter:lab[i], band:lab[i][0].toLowerCase() };
  }
  return { pct:n, letter:'F', band:'f' };
}
function gradeFromScores(scores){
  if(!scores.length) return [];
  const valid=scores.filter(s=>Number.isFinite(s));
  if(!valid.length) return scores.map(()=>letterFromPct(72));
  const hi=Math.max(...valid);
  const lo=Math.min(...valid);
  if(hi===lo){
    const base=hi>0?88:72;
    return scores.map(()=>letterFromPct(base));
  }
  return scores.map(s=>{
    const pct = 68 + ((s - lo) / (hi - lo)) * 28;
    return letterFromPct(pct);
  });
}

function offenseDetails(p){
  const s=p.stats||{};
  return {
    passingYards: tryNum(s.passingYards),
    passingTDs: tryNum(s.passingTDs || s.passingTds),
    interceptions: tryNum(s.passingInterceptions || s.interceptions),
    completions: tryNum(s.passingCompletions || s.completions),
    attempts: tryNum(s.passingAttempts || s.attempts),
    rushingYards: tryNum(s.rushingYards),
    rushingTDs: tryNum(s.rushingTDs || s.rushingTds),
    carries: tryNum(s.rushingAttempts || s.carries),
    receivingYards: tryNum(s.receivingYards),
    receivingTDs: tryNum(s.receivingTDs || s.receivingTds),
    receptions: tryNum(s.receptions || s.receivingReceptions || s.rec)
  };
}
function defenseDetails(p){
  const s=p.stats||{};
  return {
    tackles: tryNum(s.tackles),
    solo: tryNum(s.soloTackles || s.solo),
    tfl: tryNum(s.tfl || s.tacklesForLoss),
    sacks: tryNum(s.sacks),
    interceptions: tryNum(s.interceptions),
    passesDefended: tryNum(s.passesDefended || s.pdus || s.passBreakUps || s.pbus),
    forcedFumbles: tryNum(s.forcedFumbles)
  };
}

function rankPlayers(players, scorer, summary, detailFn, map, meta={}){
  const list = topK(players, scorer, meta.k || 3);
  const scores=list.map(scorer);
  const grades=gradeFromScores(scores);
  return list.map((p,i)=>{
    const base=decorate(p,map);
    const entry={
      name: base.name,
      pos: base.pos,
      headshot: base.headshot,
      espn: base.espn,
      statline: summary(p),
      grade: grades[i] || letterFromPct(72),
      side: meta.side || '',
      span: meta.span || '',
      source: 'cfbd'
    };
    const rawScore=scores[i];
    if(Number.isFinite(rawScore)) entry.score = Number(rawScore.toFixed(2));
    const details = detailFn ? detailFn(p) : null;
    if(details && Object.values(details).some(v=>Number.isFinite(v) && v !== 0)) entry.details = details;
    return entry;
  });
}

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

function pickTeamPlayers(raw, teamName = TEAM) {
  if (!raw) return [];
  const target = String(teamName || '').toLowerCase();
  const matchTeam = (value) => {
    if (!value) return false;
    return String(value).toLowerCase() === target;
  };

  if (Array.isArray(raw?.players)) {
    return raw.players;
  }

  if (Array.isArray(raw?.teams)) {
    for (const team of raw.teams) {
      if (matchTeam(team.team || team.school || team.school_name || team.schoolName)) {
        if (Array.isArray(team.players)) return team.players;
      }
    }
  }

  if (Array.isArray(raw)) {
    if (raw.length && Array.isArray(raw[0]?.players)) {
      for (const entry of raw) {
        if (matchTeam(entry.team || entry.school || entry.school_name || entry.schoolName || entry.name)) {
          if (Array.isArray(entry.players)) return entry.players;
        }
      }
      return Array.isArray(raw[0].players) ? raw[0].players : [];
    }
    const filtered = raw.filter(item => matchTeam(item.team || item.school || item.school_name || item.schoolName));
    if (filtered.length) return filtered;
  }

  if (typeof raw === 'object' && raw) {
    if (Array.isArray(raw.players)) return raw.players;
  }

  return [];
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

async function ensureDir(){
  try { await fs.mkdir('./data', { recursive: true }); } catch {}
}

async function writeJSON(path, data){
  await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

// ---- Build Ticker ----
async function buildTicker(latestGame = null) {
  const base = { year: YEAR, team: TEAM, lastWeek: null, items: [] };

  // last played week
  const games = await get(`https://api.collegefootballdata.com/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const played = (games||[]).filter(g => g.home_points != null && g.away_points != null);
  let lastWeek = played.length ? Math.max(...played.map(g => g.week || g.week_number || 0)) : null;

  if (latestGame) {
    const forcedWeek = latestGame.week ?? latestGame.week_number ?? latestGame.weekNumber ?? null;
    if (forcedWeek != null) {
      lastWeek = forcedWeek;
    }
  }

  if (lastWeek == null) {
    console.log('[spotlight] No completed games yet — skipping update.');
    process.exit(0);
  }

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
async function buildSpotlight(latestGame = null) {
  // last week (if none, keep arrays empty)
  const games = await get(`https://api.collegefootballdata.com/games?year=${YEAR}&team=${encodeURIComponent(TEAM)}&seasonType=regular`);
  const played = (games||[]).filter(g => g.home_points != null && g.away_points != null);
  let lastWeek = played.length ? Math.max(...played.map(g => g.week || g.week_number || g.weekNumber || 0)) : null;
  let lastSeasonType = 'regular';
  let match = null;

  if (lastWeek != null) {
    match = played.find(g => (g.week || g.week_number || g.weekNumber || null) === lastWeek) || null;
    const st = match?.season_type || match?.seasonType;
    if (st) lastSeasonType = String(st).toLowerCase();
  }

  if (latestGame) {
    const forcedWeek = latestGame.week ?? latestGame.week_number ?? latestGame.weekNumber ?? null;
    if (forcedWeek != null) {
      lastWeek = forcedWeek;
    }
    const forcedSeasonType = latestGame.season_type || latestGame.seasonType;
    if (forcedSeasonType) {
      lastSeasonType = String(forcedSeasonType).toLowerCase();
    }
  }

  // load ESPN id mapping
  let map = {};
  try { map = JSON.parse(await fs.readFile(ESPN_MAP_PATH, 'utf8')); } catch {}

  // season player stats
  const seasonRows = await get(`https://api.collegefootballdata.com/stats/player/season?year=${YEAR}&team=${encodeURIComponent(TEAM)}`) || [];
  const seasonPlayers = foldPlayers(seasonRows);

  // last-game stats
  let gameRows = [];
  const seasonTypeParam = lastSeasonType && lastSeasonType !== 'regular' ? `&seasonType=${lastSeasonType}` : '';
  if (lastWeek != null) {
    gameRows = await get(`https://api.collegefootballdata.com/stats/player/game?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${lastWeek}${seasonTypeParam}`) || [];
  }
  const gamePlayers = foldPlayers(gameRows);

  let box = null;
  const latestPlayers = latestGame?.sum?.boxscore?.players;
  if (Array.isArray(latestPlayers) && latestPlayers.length) {
    box = { players: latestPlayers };
  }

  if (!box) {
    let boxResp = null;
    const forcedGameId = latestGame?.id || latestGame?.game_id || match?.id || match?.game_id || null;
    if (forcedGameId != null) {
      boxResp = await get(`https://api.collegefootballdata.com/games/players?year=${YEAR}&gameId=${forcedGameId}${seasonTypeParam}`);
    }
    if (!boxResp && lastWeek != null) {
      boxResp = await get(`https://api.collegefootballdata.com/games/players?year=${YEAR}&team=${encodeURIComponent(TEAM)}&week=${lastWeek}${seasonTypeParam}`);
    }
    if (!boxResp) {
      boxResp = await get(`https://api.collegefootballdata.com/games/players?year=${YEAR}&team=${encodeURIComponent(TEAM)}${seasonTypeParam}`);
    }
    if (boxResp) {
      const extracted = pickTeamPlayers(boxResp, TEAM);
      if (extracted.length) {
        box = { players: extracted };
      } else {
        box = boxResp;
      }
    }
  }

  let offenseLast = [];
  let defenseLast = [];

  {
    const players = Array.isArray(box?.players) ? box.players : (Array.isArray(box) ? box : []);
    const num = v => Number(String(v||'').replace(/[^0-9.-]/g,''))||0;
    const mk = (name,pos,head,espn,line) => ({ name, pos, headshot: head||'', espn: espn||'#', statline: line||'' });

    const passers = players.filter(p => /pass/i.test(p?.statCategory || p?.category || '') || /qb/i.test(p?.athlete?.position?.abbreviation||''));
    const rushers = players.filter(p => /rush/i.test(p?.statCategory || p?.category || '') || /rb/i.test(p?.athlete?.position?.abbreviation||''));
    const receivers = players.filter(p => /rec/i.test(p?.statCategory || p?.category || '') || /wr|te/i.test(p?.athlete?.position?.abbreviation||''));

    function topRow(list, keyRx) {
      if (!list.length) return null;
      const rows = list.map(e => {
        const id = e?.athlete?.id || e?.id;
        const head = id ? `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png` : '';
        const name = e?.athlete?.displayName || e?.displayName || 'Unknown';
        const pos = e?.athlete?.position?.abbreviation || '';
        const stats = Array.isArray(e?.stats) ? e.stats : [];
        const yds = stats.reduce((acc,s)=>acc+(keyRx.test(String(s?.label||'').toUpperCase())?num(s.value):0),0);
        const line = stats.map(s=>`${String(s?.label||'').toUpperCase().replace('_','-')} ${s?.value||''}`).filter(Boolean).slice(0,3).join(' • ');
        return { name,pos,id,head,espn:`https://www.espn.com/college-football/player/_/id/${id}`,line,yds };
      }).sort((a,b)=>b.yds-a.yds);
      const b=rows[0]; return b?mk(b.name,b.pos,b.head,b.espn,b.line):null;
    }

    const offenseBox = [ topRow(passers,/YDS|PASS/), topRow(rushers,/YDS|RUSH/), topRow(receivers,/YDS|REC|RECEIVE/) ].filter(Boolean);

    const defenders = players.filter(p => /def/i.test(p?.statCategory || p?.category || '') || /lb|db|dl|de|nt|cb|s|fs|ss/i.test(p?.athlete?.position?.abbreviation||''));
    const defenseBox = defenders.slice(0,3).map(e=>{
      const id = e?.athlete?.id || e?.id;
      const head = id?`https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`:'';
      const name = e?.athlete?.displayName || e?.displayName || 'Unknown';
      const pos = e?.athlete?.position?.abbreviation || '';
      const stats = Array.isArray(e?.stats)?e.stats:[];
      const line = stats.map(s=>`${String(s?.label||'').toUpperCase().replace('_','-')} ${s?.value||''}`).filter(Boolean).slice(0,3).join(' • ');
      return mk(name,pos,head,`https://www.espn.com/college-football/player/_/id/${id}`,line);
    });

    if (offenseBox.length) offenseLast = offenseBox;
    if (defenseBox.length) defenseLast = defenseBox;
  }

  if (!offenseLast.length) {
    offenseLast = rankPlayers(
      gamePlayers.filter(p => /QB|RB|WR|TE|ATH/i.test(p.pos)),
      scoreOff,
      statLineOff,
      offenseDetails,
      map,
      { side: 'offense', span: 'last' }
    );
  }

  if (!defenseLast.length) {
    defenseLast = rankPlayers(
      gamePlayers.filter(p => !/QB|RB|WR|TE/i.test(p.pos)),
      scoreDef,
      statLineDef,
      defenseDetails,
      map,
      { side: 'defense', span: 'last' }
    );
  }

  await fs.writeFile('data/spotlight_offense_last.json', JSON.stringify(offenseLast,null,2));
  await fs.writeFile('data/spotlight_defense_last.json', JSON.stringify(defenseLast,null,2));
  console.log(`✅ wrote offense_last (${offenseLast.length}) and defense_last (${defenseLast.length})`);

  const offenseSeason = rankPlayers(
    seasonPlayers.filter(p => /QB|RB|WR|TE|ATH/i.test(p.pos)),
    scoreOff,
    statLineOff,
    offenseDetails,
    map,
    { side: 'offense', span: 'season' }
  );

  const defenseSeason = rankPlayers(
    seasonPlayers.filter(p => !/QB|RB|WR|TE/i.test(p.pos)),
    scoreDef,
    statLineDef,
    defenseDetails,
    map,
    { side: 'defense', span: 'season' }
  );

  const candidates = [offenseLast[0], defenseLast[0], offenseSeason[0]].filter(Boolean);
  const featured = candidates.length
    ? [...candidates].sort((a,b)=>(b.grade?.pct||0)-(a.grade?.pct||0))[0]
    : {
        name: '—',
        pos: '',
        headshot: '',
        espn: `https://www.espn.com/search/results?q=${encodeURIComponent('Kentucky football')}`,
        statline: '—',
        grade: letterFromPct(72),
        source: 'cfbd'
      };

  return { lastWeek, offenseLast, defenseLast, offenseSeason, defenseSeason, featured };
}

// ---- Run all ----
async function main() {
  await ensureDir();

  const latestGame = await getForcedLatestGame();

  const sp = await buildSpotlight(latestGame);
  const oArr = sp.offenseLast;
  const dArr = sp.defenseLast;
  await writeJSON(OUT.oLast, oArr);
  console.log(`✅ wrote data/spotlight_offense_last.json (${oArr.length})`);
  await writeJSON(OUT.dLast, dArr);
  console.log(`✅ wrote data/spotlight_defense_last.json (${dArr.length})`);
  await writeJSON(OUT.oSeason, sp.offenseSeason);
  console.log(`✅ wrote ${OUT.oSeason.replace(/^\.\//, '')} (${sp.offenseSeason.length})`);
  await writeJSON(OUT.dSeason, sp.defenseSeason);
  console.log(`✅ wrote ${OUT.dSeason.replace(/^\.\//, '')} (${sp.defenseSeason.length})`);
  await writeJSON(OUT.featured, sp.featured);
  console.log(`✅ wrote ${OUT.featured.replace(/^\.\//, '')}`);

  const ticker = await buildTicker(latestGame);
  await writeJSON(OUT.ticker, ticker);
  console.log(`✅ wrote ${OUT.ticker.replace(/^\.\//, '')} (${Array.isArray(ticker.items) ? ticker.items.length : 0})`);

  console.log('Spotlight + ticker written for', TEAM, YEAR, 'Last week:', sp.lastWeek ?? 'n/a');
}

main().catch(err => {
  console.error('[spotlight] Non-fatal build error:', err);
  process.exit(0);
});
