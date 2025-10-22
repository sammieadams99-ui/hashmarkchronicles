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

function readInlineJSON(id) {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || 'null');
  } catch (err) {
    return null;
  }
}

const INLINE_FALLBACKS = {
  offense_last: readInlineJSON('fallback-spotlight-offense-last') || [],
  defense_last: readInlineJSON('fallback-spotlight-defense-last') || [],
  offense_season: readInlineJSON('fallback-spotlight-offense-season') || [],
  defense_season: readInlineJSON('fallback-spotlight-defense-season') || [],
  featured: readInlineJSON('fallback-spotlight-offense-last') || []
};

if (typeof window !== 'undefined') {
  const existingInline = window.__HC_SPOTLIGHT_INLINE__ || {};
  window.__HC_SPOTLIGHT_INLINE__ = {
    offense_last: existingInline.offense_last?.length ? existingInline.offense_last : INLINE_FALLBACKS.offense_last,
    defense_last: existingInline.defense_last?.length ? existingInline.defense_last : INLINE_FALLBACKS.defense_last,
    offense_season: existingInline.offense_season?.length ? existingInline.offense_season : INLINE_FALLBACKS.offense_season,
    defense_season: existingInline.defense_season?.length ? existingInline.defense_season : INLINE_FALLBACKS.defense_season,
    featured: existingInline.featured?.length ? existingInline.featured : INLINE_FALLBACKS.featured
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
  const bust = `${path}?ts=${Date.now()}`;
  return fetch(bust, { cache: 'no-store' })
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

async function loadRoster(errors) {
  for (let i = 0; i < ROSTER_PATHS.length; i += 1) {
    const path = ROSTER_PATHS[i];
    const rows = await fetchList(path, i === ROSTER_PATHS.length - 1 ? errors : null);
    if (Array.isArray(rows) && rows.length) {
      return rows;
    }
    if (i === ROSTER_PATHS.length - 1) {
      return rows;
    }
  }
  return [];
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
  const idFields = ['athleteId', 'athlete_id', 'id', 'playerId'];
  for (const field of idFields) {
    if (field in entry && entry[field] != null) {
      const raw = String(entry[field]).trim();
      if (raw) return `id:${raw}`;
    }
  }
  const name = fullName(entry);
  if (!name) return '';
  const normalizedName = name.toLowerCase().replace(/\s+/g, ' ').trim();
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

function applyDebug(debugEl, rosterStats, spotlightStats, rendered, errors, filterLabel) {
  if (!debugEl) return;
  const label = debugEl.querySelector('.label') || debugEl;
  const dot = debugEl.querySelector('.dot');
  const suffix = filterLabel ? ` [filter=${filterLabel}]` : '';
  const mode = typeof window !== 'undefined'
    ? window.__HC_SPOTLIGHT_MODE || (window.__HC_SPOTLIGHT_LIVE__ ? 'live' : window.__HC_SPOTLIGHT_STATIC__ ? 'static' : 'inline')
    : 'inline';
  const base = `spotlight: roster=${rosterStats.keyed}/${rosterStats.total} keys=${spotlightStats.unique}/${spotlightStats.total} rendered=${rendered}${suffix} • mode=${mode}`;
  if (errors.length) {
    label.textContent = `${base} ⚠️ ${errors[0]}`;
    if (dot) dot.style.background = '#dc2626';
  } else {
    label.textContent = base;
    if (dot) dot.style.background = '#2563eb';
  }
}

function renderCards(mount, cards) {
  mount.innerHTML = '';
  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'tiny';
    empty.textContent = 'No spotlight data available.';
    mount.appendChild(empty);
    return;
  }
  for (const card of cards) {
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
    applyDebug(debugEl, mergedRosterStats, spotlightStats, limited.length, lastErrors, active ? active.label : '');
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

      const rosterRows = await loadRoster(errors);
      rosterStats = { total: Array.isArray(rosterRows) ? rosterRows.length : 0, keyed: 0 };
      const rosterMap = new Map();
      if (Array.isArray(rosterRows)) {
        for (const row of rosterRows) {
          const key = keyFrom(row);
          if (!key) continue;
          rosterStats.keyed += 1;
          if (!rosterMap.has(key)) {
            rosterMap.set(key, {
              ...row,
              name: fullName(row),
              pos: positionFrom(row),
              jersey: jerseyFrom(row)
            });
          }
        }
      }

      const cards = new Map();
      let total = 0;
      const dataPriority = [
        typeof window !== 'undefined' ? window.__HC_SPOTLIGHT_LIVE__ : null,
        typeof window !== 'undefined' ? window.__HC_SPOTLIGHT_STATIC__ : null,
        typeof window !== 'undefined' ? window.__HC_SPOTLIGHT_INLINE__ : null
      ];

      const clone = (entry) => (entry && typeof entry === 'object' ? { ...entry } : {});

      for (const source of SPOTLIGHT_SOURCES) {
        const cacheKey = source.cacheKey || source.id;
        let rows = null;
        for (const bag of dataPriority) {
          if (bag && Array.isArray(bag[cacheKey]) && bag[cacheKey].length) {
            rows = bag[cacheKey].map(clone);
            break;
          }
        }
        if (!rows) {
          rows = await fetchList(source.path, errors);
        }
        if (!Array.isArray(rows) || !rows.length) {
          const fallback = INLINE_FALLBACKS[cacheKey];
          if (Array.isArray(fallback) && fallback.length) {
            rows = fallback.map(clone);
          }
        }
        if (!Array.isArray(rows) || !rows.length) continue;
        total += rows.length;
        rows.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;
          const entryKey = keyFrom(entry);
          if (!entryKey) return;
          const rosterMatch = rosterMap.get(entryKey);
          const existing = cards.get(entryKey) || {
            key: entryKey,
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
            matchedRoster: false
          };

          existing.tags.add(source.label);

          const name = fullName(entry) || rosterMatch?.name || existing.name;
          if (name) {
            existing.name = name;
            existing.initials = initials(name);
          }

          const pos = positionFrom(entry) || rosterMatch?.pos || existing.pos;
          if (pos) existing.pos = pos;

          const jersey = jerseyFrom(entry) || rosterMatch?.jersey || existing.jersey;
          if (jersey) existing.jersey = jersey;

          const headshot = headshotFrom(entry, rosterMatch || existing);
          if (headshot) existing.headshot = headshot;

          const link = linkFrom(entry, rosterMatch || existing);
          if (link) existing.link = link;

          const statline = statlineFrom(entry);
          if (statline && (!existing.statline || existing.statline === '—')) {
            existing.statline = statline;
          }

          if (rosterMatch) existing.matchedRoster = true;

          cards.set(entryKey, existing);
        });
      }

      finalized = Array.from(cards.values()).map((card) => {
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
        if (!card.statline) card.statline = '—';
        if (!card.initials) card.initials = initials(card.name || 'UK');
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
