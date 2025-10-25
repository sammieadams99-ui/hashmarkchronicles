const ROSTER_PATHS = [
  './data/team/roster_plus.json',
  './data/team/roster.json'
];
const SPOTLIGHT_SOURCES = [
  { id: 'featured', label: 'Featured', path: './data/spotlight_featured.json', cacheKey: 'featured' },
  { id: 'off_last', label: 'Off last', path: './data/spotlight_offense_last.json', cacheKey: 'offense_last' },
  { id: 'def_last', label: 'Def last', path: './data/spotlight_defense_last.json', cacheKey: 'defense_last' },
  { id: 'off_season', label: 'Off season', path: './data/spotlight_offense_season.json', cacheKey: 'offense_season' },
  { id: 'def_season', label: 'Def season', path: './data/spotlight_defense_season.json', cacheKey: 'defense_season' }
];

const TARGET_SEASON = 2025;
const INLINE_ENABLED = typeof window !== 'undefined' && window.__HC_INLINE__ === true;
const BUST = `?v=${Date.now()}`;

function withBust(path) {
  if (!BUST) return path;
  if (path.includes('?')) {
    const joiner = path.endsWith('?') || path.endsWith('&') ? '' : '&';
    return `${path}${joiner}${BUST.slice(1)}`;
  }
  return `${path}${BUST}`;
}

const rosterState = {
  loaded: false,
  rows: [],
  byId: new Map(),
  byName: new Map(),
  count: 0,
  metaSeason: null,
  metaOk: null
};

function normalizeNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIdFromLink(link) {
  if (typeof link !== 'string') return NaN;
  const match = link.match(/\/id\/(\d+)\//);
  if (match) return Number(match[1]);
  return NaN;
}

function resolveAthleteId(entry) {
  if (!entry || typeof entry !== 'object') return NaN;
  const candidates = [
    entry.id,
    entry.athleteId,
    entry.athlete_id,
    entry.playerId,
    entry.player_id,
    entry.athlete?.id,
    entry.athlete?.athleteId
  ];
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }
  const linkCandidates = [entry.espn, entry.url, entry.href, entry.link];
  for (const link of linkCandidates) {
    const parsed = parseIdFromLink(link);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function headshotFromId(id) {
  if (!Number.isFinite(id)) return '';
  return `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`;
}

function slugifyName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function normalizeRosterPayload(payload) {
  const seen = new Map();
  const ingest = (value) => {
    if (!value || typeof value !== 'object') return;
    const id = resolveAthleteId(value);
    const name = fullName(value) || value.name || value.fullName || value.displayName || '';
    if (!name) return;
    const key = Number.isFinite(id) ? `id:${id}` : `name:${normalizeNameKey(name)}`;
    if (seen.has(key)) return;
    const normalized = {
      id: Number.isFinite(id) ? id : null,
      name,
      pos: positionFrom(value) || '',
      number: jerseyFrom(value) || '',
      class: value.class || value.classification || value.year || value.season || null,
      height: value.height || value.displayHeight || null,
      weight: value.weight || value.displayWeight || null,
      headshot: value.headshot || value.image || value.photo || ''
    };
    seen.set(key, normalized);
  };

  if (Array.isArray(payload)) {
    payload.forEach(ingest);
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.players)) payload.players.forEach(ingest);
    if (Array.isArray(payload.rows)) payload.rows.forEach(ingest);
    if (Array.isArray(payload.team)) payload.team.forEach(ingest);
    if (Array.isArray(payload.roster)) payload.roster.forEach(ingest);
    if (payload.byId && typeof payload.byId === 'object') {
      Object.values(payload.byId).forEach(ingest);
    }
  }

  const players = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map();
  const byName = new Map();
  for (const player of players) {
    if (Number.isFinite(player.id)) byId.set(player.id, player);
    const key = normalizeNameKey(player.name);
    if (key) byName.set(key, player);
  }

  return { players, byId, byName };
}

function enrichPlayer(entry, roster) {
  if (!entry || typeof entry !== 'object') return null;
  const athleteId = resolveAthleteId(entry);
  const name = fullName(entry) || entry.name || entry.player || '';
  const normName = normalizeNameKey(name);
  const rosterMatch =
    (Number.isFinite(athleteId) ? roster.byId.get(athleteId) : null) ||
    (normName ? roster.byName.get(normName) : null) ||
    null;
  const finalId = Number.isFinite(athleteId) ? athleteId : rosterMatch?.id ?? null;
  const finalName = name || rosterMatch?.name || '';
  if (!finalName) return null;
  const pos = positionFrom(entry) || rosterMatch?.pos || '';
  const jersey = jerseyFrom(entry) || rosterMatch?.number || '';
  const espnLink =
    entry.espn ||
    entry.url ||
    entry.href ||
    entry.link ||
    (Number.isFinite(finalId) ? `https://www.espn.com/college-football/player/_/id/${finalId}/${slugifyName(finalName)}` : rosterMatch?.espn || '');
  const headshot =
    entry.headshot ||
    entry.image ||
    entry.photo ||
    (Number.isFinite(finalId) ? headshotFromId(finalId) : rosterMatch?.headshot || '');
  const lastGame = entry.last_game || entry.lastGame || entry.stats?.lastGame || null;
  const season = entry.season || entry.stats?.season || null;

  return {
    id: Number.isFinite(finalId) ? finalId : null,
    name: finalName,
    pos: (pos || '').toUpperCase(),
    number: jersey || '',
    espn: espnLink,
    headshot,
    last_game: lastGame && typeof lastGame === 'object' ? lastGame : null,
    season: season && typeof season === 'object' ? season : null,
    rosterMatch
  };
}

function isTruthy(value) {
  if (value === true) return true;
  if (value === false) return false;
  const str = String(value || '').toLowerCase();
  if (!str) return false;
  return !['0', 'false', 'off', 'no'].includes(str);
}

function readInlineJSON(id) {
  if (!INLINE_ENABLED) return null;
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || 'null');
  } catch (err) {
    return null;
  }
}

const INLINE_FALLBACKS = INLINE_ENABLED
  ? {
      offense_last: readInlineJSON('fallback-spotlight-offense-last') || [],
      defense_last: readInlineJSON('fallback-spotlight-defense-last') || [],
      offense_season: readInlineJSON('fallback-spotlight-offense-season') || [],
      defense_season: readInlineJSON('fallback-spotlight-defense-season') || [],
      featured: readInlineJSON('fallback-spotlight-offense-last') || []
    }
  : { offense_last: [], defense_last: [], offense_season: [], defense_season: [], featured: [] };

if (typeof window !== 'undefined') {
  const existingInline = window.__HC_SPOTLIGHT_INLINE__ || {};
  window.__HC_SPOTLIGHT_INLINE__ = {
    offense_last:
      INLINE_ENABLED && existingInline.offense_last?.length
        ? existingInline.offense_last
        : INLINE_FALLBACKS.offense_last,
    defense_last:
      INLINE_ENABLED && existingInline.defense_last?.length
        ? existingInline.defense_last
        : INLINE_FALLBACKS.defense_last,
    offense_season:
      INLINE_ENABLED && existingInline.offense_season?.length
        ? existingInline.offense_season
        : INLINE_FALLBACKS.offense_season,
    defense_season:
      INLINE_ENABLED && existingInline.defense_season?.length
        ? existingInline.defense_season
        : INLINE_FALLBACKS.defense_season,
    featured:
      INLINE_ENABLED && existingInline.featured?.length
        ? existingInline.featured
        : INLINE_FALLBACKS.featured
  };
}

const TAG_PRIORITY = new Map([
  ['Featured', 0],
  ['Off last', 1],
  ['Def last', 1],
  ['Off season', 2],
  ['Def season', 2]
]);

const FILTERS = [
  {
    id: 'off',
    label: 'Off',
    predicate: (card) => card.tags.some((tag) => /off/i.test(tag)) || card.tags.includes('Featured')
  },
  {
    id: 'def',
    label: 'Def',
    predicate: (card) => card.tags.some((tag) => /def/i.test(tag)) || card.tags.includes('Featured')
  },
  {
    id: 'season',
    label: 'Season',
    predicate: (card) => card.tags.some((tag) => /season/i.test(tag)) || card.tags.includes('Featured')
  },
  {
    id: 'last',
    label: 'Last',
    predicate: (card) => card.tags.some((tag) => /last/i.test(tag)) || card.tags.includes('Featured')
  }
];

function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

function fetchList(path, errors) {
  const url = withBust(path);
  return fetch(url, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) {
        if (Array.isArray(errors)) errors.push(`HTTP ${res.status} ${path}`);
        return [];
      }
      try {
        const data = await res.json();
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.rows)) return data.rows;
        if (data && typeof data === 'object') return [data];
      } catch (err) {
        if (Array.isArray(errors)) errors.push(`parse ${path}`);
      }
      return [];
    })
    .catch((err) => {
      if (Array.isArray(errors)) errors.push(`${err?.message || 'fetch failed'} ${path}`);
      return [];
    });
}

async function fetchDataMeta(errors) {
  const url = withBust('./data/meta.json');
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      if (Array.isArray(errors)) errors.push(`HTTP ${res.status} data_meta`);
      return null;
    }
    return await res.json();
  } catch (err) {
    if (Array.isArray(errors)) errors.push(`data_meta ${err?.message || err}`);
    return null;
  }
}

async function fetchRosterMeta(errors) {
  if (rosterState.metaOk !== null) return rosterState.metaOk;
  const url = withBust('./data/team/roster_meta.json');
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      if (Array.isArray(errors)) errors.push(`HTTP ${res.status} roster_meta`);
      rosterState.metaOk = false;
      return rosterState.metaOk;
    }
    const meta = await res.json();
    const season = Number(meta?.season);
    rosterState.metaSeason = Number.isFinite(season) ? season : null;
    rosterState.metaOk = Number.isFinite(season) && season === TARGET_SEASON;
    if (!rosterState.metaOk && Array.isArray(errors)) {
      errors.push(`season mismatch ${season ?? 'unknown'}`);
    }
    return rosterState.metaOk;
  } catch (err) {
    if (Array.isArray(errors)) errors.push(`meta ${err?.message || err}`);
    rosterState.metaOk = false;
    return rosterState.metaOk;
  }
}

async function loadRoster(errors) {
  if (rosterState.loaded) return rosterState;
  const metaOk = await fetchRosterMeta(errors);
  if (!metaOk) {
    rosterState.loaded = true;
    rosterState.rows = [];
    rosterState.byId = new Map();
    rosterState.byName = new Map();
    rosterState.count = 0;
    return rosterState;
  }
  for (let i = 0; i < ROSTER_PATHS.length; i += 1) {
    const path = ROSTER_PATHS[i];
    const payload = await fetchList(path, i === ROSTER_PATHS.length - 1 ? errors : null);
    const normalized = normalizeRosterPayload(payload);
    if (normalized.players.length) {
      rosterState.rows = normalized.players;
      rosterState.byId = normalized.byId;
      rosterState.byName = normalized.byName;
      rosterState.count = normalized.players.length;
      rosterState.metaOk = true;
      rosterState.loaded = true;
      return rosterState;
    }
    if (i === ROSTER_PATHS.length - 1) {
      rosterState.rows = normalized.players;
      rosterState.byId = normalized.byId;
      rosterState.byName = normalized.byName;
      rosterState.count = normalized.players.length;
    }
  }
  rosterState.loaded = true;
  rosterState.metaOk = rosterState.metaOk ?? false;
  return rosterState;
}

function fullName(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const direct = entry.name || entry.fullName || entry.full_name || '';
  if (direct && String(direct).trim()) return String(direct).trim();
  const first = entry.firstName || entry.first_name || entry.givenName || entry.given_name || entry.athlete?.firstName;
  const last = entry.lastName || entry.last_name || entry.familyName || entry.family_name || entry.athlete?.lastName;
  const display = entry.athlete?.displayName || entry.displayName || entry.player || '';
  const combo = [first, last].filter(Boolean).join(' ').trim();
  if (combo) return combo;
  if (display && String(display).trim()) return String(display).trim();
  return '';
}

function normalizePos(value) {
  if (!value) return '';
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw).trim().toUpperCase();
}

function positionFrom(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return (
    normalizePos(entry.pos) ||
    normalizePos(entry.position) ||
    normalizePos(entry.role) ||
    normalizePos(entry.position_group) ||
    normalizePos(entry.group) ||
    normalizePos(entry.athlete?.position?.abbreviation) ||
    normalizePos(entry.athlete?.position?.displayName)
  );
}

function jerseyFrom(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const jersey =
    entry.jersey ??
    entry.jerseyNumber ??
    entry.number ??
    entry.num ??
    entry.uniform ??
    entry.uniformNumber ??
    entry.athlete?.jersey;
  if (jersey == null) return '';
  const str = String(jersey).trim();
  return str ? str : '';
}

function headshotFrom(entry, fallback) {
  const raw =
    entry?.headshot ??
    entry?.head ??
    entry?.photo ??
    entry?.image ??
    entry?.athlete?.headshot ??
    entry?.athlete?.images?.default ??
    fallback?.headshot;
  if (!raw) return '';
  const str = String(raw).trim();
  if (str.startsWith('http')) return str;
  return str;
}

function linkFrom(entry, fallback) {
  const raw =
    entry?.espn ??
    entry?.url ??
    entry?.href ??
    entry?.link ??
    entry?.athlete?.links?.espn ??
    fallback?.espn ??
    fallback?.url ??
    fallback?.link;
  const str = raw ? String(raw).trim() : '';
  return str;
}

function statPartsFromObject(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj)
    .map(([k, v]) => {
      if (v == null || v === '') return '';
      const label = String(k).replace(/_/g, ' ').toUpperCase();
      return `${label} ${v}`;
    })
    .filter(Boolean);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function featuredSeasonStatline(season) {
  if (!season || typeof season !== 'object') return '';
  const cmpAttRaw = season.cmp_att ?? season.cmpAtt ?? '';
  const cmpAtt = typeof cmpAttRaw === 'string' ? cmpAttRaw.trim() : String(cmpAttRaw || '').trim();
  const yds = numberOrNull(season.yds ?? season.yards ?? season.passYards);
  const td = numberOrNull(season.td ?? season.touchdowns ?? season.passTouchdowns);
  const ints = numberOrNull(season.int ?? season.ints ?? season.interceptions ?? season.passInterceptions);
  const qbParts = [];
  if (cmpAtt) qbParts.push(`CMP/ATT ${cmpAtt}`);
  if (yds != null) qbParts.push(`YDS ${yds}`);
  if (td != null && ints != null) qbParts.push(`TD ${td} / INT ${ints}`);
  if (qbParts.length) return qbParts.join(' • ');

  const tkl = numberOrNull(season.tkl ?? season.tackles ?? season.tacklesTotal);
  const tfl = numberOrNull(season.tfl ?? season.tacklesForLoss ?? season.tfls);
  const defInts = numberOrNull(season.ints ?? season.int ?? season.interceptions);
  const defParts = [];
  if (tkl != null) defParts.push(`TKL ${tkl}`);
  if (tfl != null) defParts.push(`TFL ${tfl}`);
  if (defInts != null) defParts.push(`INT ${defInts}`);
  return defParts.join(' • ');
}

function formatGrade(rawGrade) {
  if (!rawGrade || typeof rawGrade !== 'object') return '';
  const letter = (rawGrade.letter || rawGrade.grade || '').toString().trim();
  const pctRaw = rawGrade.pct ?? rawGrade.percent ?? rawGrade.score ?? rawGrade.value ?? '';
  const pctNum = pctRaw === '' ? NaN : Number(pctRaw);
  let pct = '';
  if (Number.isFinite(pctNum)) {
    const normalized = pctNum > 1 ? pctNum : pctNum * 100;
    const rounded = Math.round(normalized);
    if (Number.isFinite(rounded)) pct = `${rounded}%`;
  } else if (typeof pctRaw === 'string' && pctRaw.trim()) {
    pct = pctRaw.trim();
    if (!pct.endsWith('%')) pct += '%';
  }
  if (letter && pct) return `Grade ${letter} (${pct})`;
  if (letter) return `Grade ${letter}`;
  if (pct) return `Grade ${pct}`;
  return '';
}

function statlineFrom(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const strings = [entry.statline, entry.line, entry.summary]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  if (strings.length) {
    const pick = strings.find((v) => v && v !== '—');
    if (pick) return pick;
  }
  const arrayParts = Array.isArray(entry.statline_parts)
    ? entry.statline_parts
    : Array.isArray(entry.stats)
      ? entry.stats
      : null;
  if (arrayParts) {
    const joined = arrayParts.map((v) => String(v).trim()).filter(Boolean).join(' • ');
    if (joined) return joined;
  }
  const inline = entry.last_game || entry.lastGame || entry.season || entry.career;
  const inlineParts = statPartsFromObject(inline).slice(0, 3).join(' • ');
  if (inlineParts) return inlineParts;
  const grade = formatGrade(entry.grade || entry.grades || entry.rating);
  if (grade) return grade;
  const score = entry.score ?? entry.value ?? entry.points ?? null;
  if (Number.isFinite(score)) return `Score ${Number(score).toFixed(1)}`;
  return '';
}

function keyFrom(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const id = resolveAthleteId(entry);
  if (Number.isFinite(id)) return `id:${id}`;
  const name = fullName(entry);
  const normalizedName = normalizeNameKey(name);
  if (!normalizedName) return '';
  const pos = (positionFrom(entry) || 'UNK').toUpperCase();
  return `${normalizedName}|${pos}`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function applyDebug(debugEl, rosterStats, spotlightStats, rendered, errors, filterLabel, mode) {
  if (!debugEl) return;
  const label = debugEl.querySelector('.label') || debugEl;
  const dot = debugEl.querySelector('.dot');
  const suffix = filterLabel ? ` [filter=${filterLabel}]` : '';
  const resolvedMode = mode || 'inline';
  const base = `data-mode: ${resolvedMode} • roster:${rosterStats.total} (ids:${rosterStats.keyed}) • spotlight:${spotlightStats.unique}/${spotlightStats.total} • rendered:${rendered}${suffix}`;
  debugEl.setAttribute('data-mode', resolvedMode);
  debugEl.dataset.rosterCount = String(rosterStats.total);
  if (errors.length) {
    label.textContent = `${base} ⚠️ ${errors[0]}`;
    if (dot) dot.style.background = '#dc2626';
  } else {
    label.textContent = base;
    if (dot) dot.style.background = '#2563eb';
  }
}

function renderCards(mount, cards) {
  const list = Array.isArray(cards) ? cards : [];
  mount.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'tiny';
    empty.textContent = 'No data available for this view.';
    mount.appendChild(empty);
    return;
  }
  for (const card of list) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.tags = card.tags.join(',');

    const avatar = document.createElement(card.headshot ? 'img' : 'div');
    avatar.setAttribute('aria-hidden', card.headshot ? 'false' : 'true');
    avatar.style.width = '48px';
    avatar.style.height = '48px';
    avatar.style.borderRadius = '8px';
    avatar.style.display = 'grid';
    avatar.style.placeItems = 'center';
    avatar.style.background = '#0033a0';
    avatar.style.color = '#fff';
    avatar.style.font = '800 14px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif';
    avatar.style.border = '1px solid var(--muted)';

    if (card.headshot) {
      avatar.src = card.headshot;
      avatar.alt = `${card.name} headshot`;
      avatar.style.objectFit = 'cover';
      avatar.style.display = 'block';
      avatar.addEventListener('error', () => {
        avatar.replaceWith(createInitialsAvatar(card));
      });
    } else {
      avatar.textContent = card.initials;
    }

    const body = document.createElement('div');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = card.name;

    const metaParts = [];
    if (card.pos) metaParts.push(card.pos);
    if (card.jersey) metaParts.push(`#${card.jersey}`);
    if (metaParts.length) {
      const meta = document.createElement('span');
      meta.className = 'tiny';
      meta.textContent = ` • ${metaParts.join(' • ')}`;
      who.appendChild(meta);
    }

    const stat = document.createElement('div');
    stat.className = 'stat';
    stat.textContent = card.statline || '—';
    if (card.link) {
      const link = document.createElement('a');
      link.className = 'tiny';
      link.href = card.link;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'ESPN ↗';
      stat.appendChild(document.createTextNode(' '));
      stat.appendChild(link);
    }

    if (card.displayTag) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = card.displayTag;
      body.appendChild(tag);
    }

    body.insertBefore(stat, body.firstChild);
    body.insertBefore(who, body.firstChild);

    row.appendChild(avatar);
    row.appendChild(body);
    mount.appendChild(row);
  }
}

function createInitialsAvatar(card) {
  const fallback = document.createElement('div');
  fallback.style.width = '48px';
  fallback.style.height = '48px';
  fallback.style.borderRadius = '8px';
  fallback.style.display = 'grid';
  fallback.style.placeItems = 'center';
  fallback.style.background = '#0033a0';
  fallback.style.color = '#fff';
  fallback.style.font = '800 14px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif';
  fallback.style.border = '1px solid var(--muted)';
  fallback.textContent = card.initials || 'UK';
  return fallback;
}

onReady(async () => {
  const mount = document.getElementById('hc-spotlight');
  if (!mount) return;
  const debugEl = document.getElementById('hc-spotlight-debug');
  const cardContainer = mount.parentElement;

  let toggles = null;
  if (cardContainer) {
    toggles = cardContainer.querySelector('[data-spotlight-toggles]');
    if (!toggles) {
      toggles = document.createElement('div');
      toggles.className = 'toggles';
      toggles.dataset.spotlightToggles = 'true';
      cardContainer.insertBefore(toggles, mount);
    }
    toggles.innerHTML = '';
  }

  const buttons = new Map();
  const preferredFilter = FILTERS.find((filter) => filter.id === 'last') ? 'last' : FILTERS[0]?.id || '';
  const state = { filter: preferredFilter };
  let finalized = [];
  let rosterStats = { total: 0, keyed: 0 };
  let spotlightStats = { unique: 0, total: 0 };
  let mergedRosterStats = { total: 0, keyed: 0 };
  let lastErrors = [];
  let hydrating = false;
  let dataMode = 'inline';

  function updateButtons(activeId) {
    buttons.forEach((btn, id) => {
      const isActive = id === activeId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function applyFilter(filterId) {
    const active = FILTERS.find((filter) => filter.id === filterId) || FILTERS[0];
    state.filter = active ? active.id : '';
    updateButtons(state.filter);
    const list = active ? finalized.filter((card) => active.predicate(card)) : finalized;
    const limited = list.slice(0, 24);
    renderCards(mount, limited);
    applyDebug(debugEl, mergedRosterStats, spotlightStats, limited.length, lastErrors, active ? active.label : '', dataMode);
  }

  if (toggles) {
    FILTERS.forEach((filter) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = filter.label;
      btn.dataset.filter = filter.id;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        if (state.filter === filter.id) return;
        applyFilter(filter.id);
      });
      toggles.appendChild(btn);
      buttons.set(filter.id, btn);
    });
  }

  async function hydrate() {
    if (hydrating) return;
    hydrating = true;
    const errors = [];
    lastErrors = errors;
    try {
      const staticPromise = typeof window !== 'undefined' ? window.__HC_SPOTLIGHT_STATIC_PROMISE : null;
      if (staticPromise && typeof staticPromise.then === 'function') {
        try {
          await staticPromise;
        } catch (err) {
          errors.push(err?.message || 'static preload');
        }
      }

      const spotlightMeta = await fetchDataMeta(errors);
      const spotlightSeason = Number(spotlightMeta?.season);
      if (!spotlightMeta || !Number.isFinite(spotlightSeason) || spotlightSeason !== TARGET_SEASON) {
        if (Array.isArray(errors)) {
          errors.push(`season mismatch meta ${spotlightSeason ?? 'unknown'}`);
        }
        console.warn('Season mismatch — skipping spotlight hydrate.');
        dataMode = 'stale';
        finalized = [];
        spotlightStats = { unique: 0, total: 0 };
        mergedRosterStats = { total: rosterStats.total, keyed: rosterStats.keyed };
        if (typeof window !== 'undefined') {
          window.__HC_SPOTLIGHT_MODE = dataMode;
        }
        applyFilter(state.filter);
        return;
      }

      const rosterData = await loadRoster(errors);
      rosterStats = { total: rosterData.count, keyed: rosterData.byId.size };

      const rosterIds = new Set(
        (Array.isArray(rosterData.rows) ? rosterData.rows : [])
          .map((player) => Number(player.id))
          .filter((id) => Number.isFinite(id))
      );
      const keepEntry = (entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const resolved = resolveAthleteId(entry);
        if (Number.isFinite(resolved)) return rosterIds.has(resolved);
        const fallback = Number(entry.id);
        return Number.isFinite(fallback) && rosterIds.has(fallback);
      };

      if (rosterData.metaOk === false || rosterData.metaSeason !== null && rosterData.metaSeason !== TARGET_SEASON) {
        dataMode = 'stale';
        finalized = [];
        spotlightStats = { unique: 0, total: 0 };
        mergedRosterStats = { total: rosterStats.total, keyed: rosterStats.keyed };
        if (typeof window !== 'undefined') {
          window.__HC_SPOTLIGHT_MODE = dataMode;
        }
        applyFilter(state.filter);
        return;
      }

      const cards = new Map();
      let total = 0;

      const liveBag = typeof window !== 'undefined' ? window.__HC_SPOTLIGHT_LIVE__ : null;
      const staticBag = typeof window !== 'undefined' ? window.__HC_SPOTLIGHT_STATIC__ : null;
      const inlineBag = INLINE_ENABLED && typeof window !== 'undefined' ? window.__HC_SPOTLIGHT_INLINE__ : null;
      const forceStatic = typeof window !== 'undefined' ? isTruthy(window.FRONTEND_FORCE_STATIC) : false;
      dataMode = forceStatic ? 'static' : 'inline';
      const dataPriority = forceStatic ? [staticBag, inlineBag] : [liveBag, staticBag, inlineBag];

      const clone = (entry) => (entry && typeof entry === 'object' ? { ...entry } : {});

      for (const source of SPOTLIGHT_SOURCES) {
        const cacheKey = source.cacheKey || source.id;
        let rows = null;
        let sourceMode = 'inline';

        for (const bag of dataPriority) {
          if (!bag) continue;
          const candidate = bag[cacheKey];
          if (Array.isArray(candidate) && candidate.length) {
            rows = candidate.map(clone);
            if (bag === liveBag) sourceMode = 'live';
            else if (bag === staticBag) sourceMode = 'static';
            else sourceMode = 'inline';
            break;
          }
        }

        if (!rows) {
          const fetched = await fetchList(source.path, errors);
          if (Array.isArray(fetched) && fetched.length) {
            rows = fetched.map(clone);
            sourceMode = 'static';
          }
        }

        if (!rows && INLINE_ENABLED) {
          const fallback = INLINE_FALLBACKS[cacheKey];
          if (Array.isArray(fallback) && fallback.length) {
            rows = fallback.map(clone);
            sourceMode = 'inline';
          }
        }

        if (Array.isArray(rows)) {
          rows = rows.filter(keepEntry);
        }
        if (!Array.isArray(rows) || !rows.length) continue;

        if (sourceMode === 'live') {
          dataMode = 'live';
        } else if (sourceMode === 'static' && dataMode !== 'live') {
          dataMode = 'static';
        }

        total += rows.length;
        rows.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;
          const enriched = enrichPlayer(entry, rosterData) || {};
          const entryKey = Number.isFinite(enriched.id) ? `id:${enriched.id}` : keyFrom(entry);
          if (!entryKey) return;

          const existing = cards.get(entryKey) || {
            key: entryKey,
            id: enriched.id ?? null,
            tags: new Set(),
            name: '',
            pos: '',
            jersey: '',
            headshot: '',
            link: '',
            statline: '',
            initials: '',
            displayTag: '',
            priority: 99,
            matchedRoster: false,
            last_game: null,
            season: null
          };

          existing.tags.add(source.label);

          if (Number.isFinite(enriched.id)) {
            existing.id = enriched.id;
          }

          const name = enriched.name || fullName(entry) || existing.name;
          if (name) {
            existing.name = name;
            existing.initials = initials(name);
          }

          const pos = enriched.pos || positionFrom(entry) || existing.pos;
          if (pos) existing.pos = pos;

          const jersey = enriched.number || jerseyFrom(entry) || existing.jersey;
          if (jersey) existing.jersey = jersey;

          const headshot =
            enriched.headshot ||
            headshotFrom(entry, enriched.rosterMatch || existing) ||
            (Number.isFinite(existing.id) ? headshotFromId(existing.id) : '');
          if (headshot) existing.headshot = headshot;

          const link = enriched.espn || linkFrom(entry, enriched.rosterMatch || existing) || existing.link;
          if (link) existing.link = link;

          const combinedStats = {
            ...entry,
            last_game: enriched.last_game || entry.last_game || existing.last_game,
            season: enriched.season || entry.season || existing.season
          };
          const statline = statlineFrom(combinedStats);
          if (statline && (!existing.statline || existing.statline === '—')) {
            existing.statline = statline;
          }

          if (enriched.last_game) existing.last_game = enriched.last_game;
          if (enriched.season) existing.season = enriched.season;
          if (enriched.rosterMatch) existing.matchedRoster = true;

          cards.set(entryKey, existing);
        });
      }

      const filteredCards = Array.from(cards.values()).filter((card) => {
        const id = Number(card.id);
        return Number.isFinite(id) && rosterData.byId.has(id);
      });

      total = filteredCards.length;

      finalized = filteredCards.map((card) => {
        const tags = Array.from(card.tags);
        const sortedTags = tags.sort((a, b) => {
          const pa = TAG_PRIORITY.get(a) ?? 9;
          const pb = TAG_PRIORITY.get(b) ?? 9;
          if (pa !== pb) return pa - pb;
          return a.localeCompare(b);
        });
        card.tags = sortedTags;
        card.displayTag = sortedTags[0] || '';
        const topPriority = sortedTags.length ? TAG_PRIORITY.get(sortedTags[0]) ?? 9 : 9;
        card.priority = topPriority;
        if (typeof card.statline === 'string') {
          card.statline = card.statline.trim();
        }
        const isFeatured = sortedTags.includes('Featured');
        if (isFeatured && (!card.statline || card.statline === '—')) {
          const featuredLine = featuredSeasonStatline(card.season);
          if (featuredLine) {
            card.statline = featuredLine;
          }
        }
        if (!card.statline) card.statline = '—';
        if (!card.initials) card.initials = initials(card.name || 'UK');
        if (!card.headshot && Number.isFinite(card.id)) {
          card.headshot = headshotFromId(card.id);
        }
        if (!card.link && Number.isFinite(card.id)) {
          card.link = `https://www.espn.com/college-football/player/_/id/${card.id}/${slugifyName(card.name || '')}`;
        }
        return card;
      });

      finalized.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.name.localeCompare(b.name);
      });

      spotlightStats = { unique: finalized.length, total };
      mergedRosterStats = {
        total: rosterStats.total,
        keyed: rosterStats.keyed
      };

      if (typeof window !== 'undefined') {
        window.__HC_SPOTLIGHT_MODE = dataMode;
      }

      applyFilter(state.filter);
    } finally {
      hydrating = false;
    }
  }

  document.addEventListener('hc:spotlight:hydrate', () => {
    hydrate().catch((err) => {
      console.warn('[HC] spotlight hydrate failed', err);
    });
  });

  await hydrate();
});
