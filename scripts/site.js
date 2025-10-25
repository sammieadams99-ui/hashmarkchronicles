const dom = {
  season: document.querySelector('[data-meta-season]'),
  roster: document.querySelector('[data-meta-roster]'),
  updated: document.querySelector('[data-meta-updated]'),
  tickerGrid: document.querySelector('[data-ticker-grid]'),
  tickerEmpty: document.querySelector('[data-ticker-empty]'),
  tickerUpdated: document.querySelector('[data-ticker-updated]'),
  featuredGrid: document.querySelector('[data-featured-grid]'),
  featuredEmpty: document.querySelector('[data-featured-empty]'),
  featuredSource: document.querySelector('[data-featured-source]'),
  footerYear: document.querySelector('[data-year]'),
  footerUpdated: document.querySelector('[data-footer-updated]'),
};

const state = {
  meta: null,
};

function setText(el, value) {
  if (!el) return;
  el.textContent = value;
}

function show(el, visible) {
  if (!el) return;
  el.hidden = !visible;
}

function formatUpdated(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeTime(iso) {
  const formatted = formatUpdated(iso);
  if (!iso) return formatted;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return formatted;
  const delta = Date.now() - date.getTime();
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("Failed to load", url, err);
    return null;
  }
}

function tickerTrend(trend) {
  switch (trend) {
    case "good":
      return "↑";
    case "bad":
      return "↓";
    case "warn":
      return "↗";
    default:
      return "•";
  }
}

function createTickerCard(item) {
  const card = document.createElement("article");
  card.className = "ticker-card";
  if (item?.trend) card.dataset.trend = item.trend;

  const label = document.createElement("span");
  label.className = "ticker-card__label";
  label.textContent = item?.label || "Metric";

  const value = document.createElement("span");
  value.className = "ticker-card__value";
  value.textContent = item?.value ?? "—";

  const suffix = document.createElement("span");
  suffix.className = "ticker-card__suffix";
  suffix.textContent = item?.suffix || "";

  const trend = document.createElement("span");
  trend.className = "ticker-card__trend";
  trend.textContent = tickerTrend(item?.trend);

  card.append(label, value, suffix, trend);
  return card;
}

function initialsFromName(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function gradeFromEntry(entry) {
  const letter =
    entry?.grade_letter ??
    entry?.gradeLetter ??
    entry?.letter ??
    entry?.grade ??
    null;
  const pctRaw =
    entry?.grade_pct ??
    entry?.gradePct ??
    entry?.pct ??
    entry?.percent ??
    entry?._score ??
    null;
  const pct = typeof pctRaw === "number" ? pctRaw : Number.parseFloat(pctRaw);
  return {
    letter: letter || null,
    pct: Number.isFinite(pct) ? Math.round(pct) : null,
  };
}

function createFeaturedCard(entry) {
  const href = entry?.espn || entry?.link || null;
  const container = document.createElement(href ? "a" : "article");
  container.className = "featured-card";
  if (href) {
    container.href = href;
    container.target = "_blank";
    container.rel = "noopener";
  }

  const avatar = document.createElement("div");
  avatar.className = "featured-card__avatar";
  if (entry?.headshot) {
    const img = document.createElement("img");
    img.src = entry.headshot;
    img.alt = entry?.name || "Player headshot";
    img.loading = "lazy";
    avatar.append(img);
  } else {
    avatar.textContent = initialsFromName(entry?.name || "");
  }

  const meta = document.createElement("div");
  meta.className = "featured-card__meta";

  const name = document.createElement("p");
  name.className = "featured-card__name";
  name.textContent = entry?.name || "Unnamed";

  if (entry?.pos || entry?.position) {
    const pos = document.createElement("span");
    pos.className = "featured-card__pos";
    pos.textContent = entry.pos || entry.position;
    name.append(pos);
  }

  const statline = document.createElement("p");
  statline.className = "featured-card__statline";
  statline.textContent = entry?.statline || entry?.summary || "";

  meta.append(name);
  if (statline.textContent) meta.append(statline);

  const grade = gradeFromEntry(entry);
  if (grade.letter || grade.pct) {
    const badge = document.createElement("span");
    badge.className = "featured-card__grade";
    badge.textContent = grade.letter
      ? `${grade.letter}${grade.pct ? ` · ${grade.pct}%` : ""}`
      : `${grade.pct}%`;
    meta.append(badge);
  }

  container.append(avatar, meta);
  return container;
}

async function hydrateMeta() {
  const meta = await fetchJson("/data/meta.json");
  state.meta = meta;
  if (!meta) return;

  if (meta.season) setText(dom.season, `Season ${meta.season}`);
  if (meta.rosterCount) setText(dom.roster, `${meta.rosterCount} players`);
  if (meta.generated_at) {
    const formatted = formatUpdated(meta.generated_at);
    if (formatted) {
      setText(dom.updated, `Updated ${formatted}`);
      setText(dom.footerUpdated, `Last data refresh · ${formatted}`);
      if (dom.tickerUpdated) {
        setText(dom.tickerUpdated, `Refreshed ${relativeTime(meta.generated_at)}`);
      }
    }
  }
}

async function hydrateTicker() {
  const items = await fetchJson("/data/ticker.json");
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const hasItems = list.length > 0;

  if (dom.tickerGrid) {
    dom.tickerGrid.innerHTML = "";
    list.forEach((item) => dom.tickerGrid.append(createTickerCard(item)));
  }

  show(dom.tickerEmpty, !hasItems);
  if (!hasItems && dom.tickerUpdated && state.meta?.generated_at) {
    setText(dom.tickerUpdated, `Awaiting metrics · ${relativeTime(state.meta.generated_at)}`);
  }
}

async function hydrateFeatured() {
  const payload = await fetchJson("/data/spotlight_featured.json");
  let list = [];
  if (Array.isArray(payload)) {
    list = payload.filter(Boolean);
  } else if (payload && typeof payload === "object") {
    list = [payload];
  }

  if (dom.featuredGrid) {
    dom.featuredGrid.innerHTML = "";
    list.forEach((entry) => dom.featuredGrid.append(createFeaturedCard(entry)));
  }

  const hasItems = list.length > 0;
  show(dom.featuredEmpty, !hasItems);

  if (dom.featuredSource) {
    if (hasItems && state.meta?.generated_at) {
      setText(dom.featuredSource, `Updated ${relativeTime(state.meta.generated_at)}`);
    } else {
      setText(dom.featuredSource, "Waiting for spotlight selections");
    }
  }
}

function hydrateFooter() {
  if (dom.footerYear) {
    const year = new Date().getFullYear();
    setText(dom.footerYear, String(year));
  }
}

async function init() {
  hydrateFooter();
  await hydrateMeta();
  await Promise.all([hydrateTicker(), hydrateFeatured()]);
}

init();
