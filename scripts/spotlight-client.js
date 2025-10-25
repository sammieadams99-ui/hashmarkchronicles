/**
 * Minimal, resilient client for the sidebar Player Spotlight.
 * Renders top-3 Offense/Defense for Last Game and Season.
 * Expects JSON files in /data written by the builder.
 *
 * Mount point in index.html:
 *   <section id="player-spotlight"></section>
 */

(function () {
  const mount = document.getElementById("player-spotlight");
  if (!mount) return;

  mount.classList.add("hc-spotlight-root");

  const state = {
    side: "offense",   // "offense" | "defense"
    span: "last",      // "last" | "season"
    datasets: {},      // cache
  };

  const files = {
    offense_last:  "/data/spotlight_offense_last.json",
    offense_season:"/data/spotlight_offense_season.json",
    defense_last:  "/data/spotlight_defense_last.json",
    defense_season:"/data/spotlight_defense_season.json",
    featured:      "/data/spotlight_featured.json",
  };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  function normalizeGrade(entry) {
    const letter =
      entry?.letter ??
      entry?.grade_letter ??
      entry?.gradeLetter ??
      entry?.grade ??
      "C";
    const pctRaw =
      entry?.pct ??
      entry?.grade_pct ??
      entry?.gradePct ??
      entry?.percent ??
      entry?._score ??
      50;
    const pct = Number.isFinite(pctRaw)
      ? pctRaw
      : Number.parseFloat(typeof pctRaw === "string" ? pctRaw.replace(/[^0-9.]/g, "") : pctRaw) || 50;
    return { letter, pct: Math.round(pct) };
  }

  function gradeBadge(letter, pct) {
    const span = h("span", { class: "hc-grade" }, `${letter} `, h("small", {}, `${pct}%`));
    span.style.display = "inline-flex";
    span.style.alignItems = "center";
    span.style.gap = "6px";
    span.style.fontWeight = "700";
    span.style.background = "#0b3a82";
    span.style.color = "white";
    span.style.padding = "2px 8px";
    span.style.borderRadius = "12px";
    return span;
  }

  function card(entry = {}) {
    const initials = (entry.name || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "UK";

    const tag = entry.espn ? "a" : "div";
    const attrs = { class: "hc-card" };
    if (entry.espn) {
      attrs.href = entry.espn;
      attrs.target = "_blank";
      attrs.rel = "noopener";
    }

    const img = entry.headshot
      ? h("img", {
          src: entry.headshot,
          alt: entry.name || "Player headshot",
          referrerpolicy: "no-referrer",
          loading: "lazy",
        })
      : h("div", { class: "hc-avatar" }, initials);
    const posText = entry.pos || entry.position || "";
    const name = h(
      "div",
      { class: "hc-name" },
      entry.name || "Unnamed",
      posText ? " " : "",
      posText ? h("span", { class: "hc-pos" }, `• ${posText}`) : null,
    );
    const stats = h("div", { class: "hc-stat" }, entry.statline || entry.summary || (entry.espn ? "View on ESPN" : "—"));
    const gradeInfo = normalizeGrade(entry);
    const grade = gradeBadge(gradeInfo.letter, gradeInfo.pct);

    const row = h("div", { class: "hc-row" }, img, h("div", { class: "hc-meta" }, name, stats));
    const wrap = h(tag, attrs, row, h("div", { class: "hc-grade-wrap" }, grade));

    // styles (scoped)
    wrap.style.display = "grid";
    wrap.style.gridTemplateColumns = "1fr auto";
    wrap.style.gap = "6px";
    wrap.style.alignItems = "center";
    wrap.style.padding = "10px";
    wrap.style.border = "1px solid #e5e8ef";
    wrap.style.borderRadius = "10px";
    wrap.style.background = "white";
    if (tag === "a") {
      wrap.style.textDecoration = "none";
      wrap.style.color = "inherit";
    }

    (img.style||{}).width = "42px";
    (img.style||{}).height = "42px";
    (img.style||{}).borderRadius = "50%";
    (img.style||{}).objectFit = "cover";

    const meta = wrap.querySelector(".hc-meta");
    meta.style.display = "grid";
    meta.style.gap = "2px";

    const pos = wrap.querySelector(".hc-pos");
    pos.style.color = "#6b7280";
    pos.style.fontWeight = "600";
    pos.style.marginLeft = "6px";

    const stat = wrap.querySelector(".hc-stat");
    stat.style.color = "#1f2937";
    stat.style.fontSize = ".92rem";

    return wrap;
  }

  function emptyState(msg) {
    const box = h("div", { class: "hc-empty" }, msg);
    box.style.padding = "12px";
    box.style.border = "1px dashed #b6c2d9";
    box.style.borderRadius = "10px";
    box.style.background = "#f8fbff";
    box.style.color = "#0b3a82";
    return box;
  }

  function header() {
    function makeChip(label, active, onClick) {
      const chip = h("button", { class: "hc-chip", type: "button" }, label);
      chip.onclick = onClick;
      chip.style.border = "1px solid #D1DAEC";
      chip.style.borderRadius = "999px";
      chip.style.padding = "6px 12px";
      chip.style.background = active ? "#0b3a82" : "white";
      chip.style.color = active ? "white" : "#0b3a82";
      chip.style.fontWeight = active ? "700" : "600";
      chip.style.cursor = "pointer";
      chip.style.transition = "background 0.15s ease, color 0.15s ease";
      chip.setAttribute("aria-pressed", active ? "true" : "false");
      return chip;
    }

    const off = makeChip("Offense", state.side === "offense", () => {
      state.side = "offense";
      render();
    });
    const def = makeChip("Defense", state.side === "defense", () => {
      state.side = "defense";
      render();
    });
    const last = makeChip("Last", state.span === "last", () => {
      state.span = "last";
      render();
    });
    const seas = makeChip("Season", state.span === "season", () => {
      state.span = "season";
      render();
    });

    const spacer = h("span", { style: "display:inline-block;width:8px" });
    const bar = h("div", { class: "hc-bar" }, off, def, spacer, last, seas);
    bar.style.display = "flex";
    bar.style.flexWrap = "wrap";
    bar.style.gap = "8px";
    bar.style.margin = "4px 0 12px";
    return bar;
  }

  async function loadOnce(key) {
    if (state.datasets[key]) return state.datasets[key];
    try {
      const res = await fetch(files[key], { cache: "no-cache" });
      if (!res.ok) throw new Error(`${files[key]} -> ${res.status}`);
      const json = await res.json();
      state.datasets[key] = json;
      return json;
    } catch (e) {
      console.warn("load failed:", e.message);
      state.datasets[key] = [];
      return [];
    }
  }

  async function render() {
    mount.innerHTML = "";
    mount.appendChild(header());

    const key = `${state.side}_${state.span}`;
    const arr = await loadOnce(key);

    if (!Array.isArray(arr) || arr.length === 0) {
      mount.appendChild(emptyState("No spotlight data yet — waiting for the first completed game or stats import."));
      return;
    }

    const list = h("div", { class: "hc-list" });
    list.style.display = "grid";
    list.style.gap = "8px";
    list.style.width = "100%";
    list.style.gridTemplateColumns = "1fr";

    arr.slice(0,3).forEach(x => list.appendChild(card(x)));
    mount.appendChild(list);
  }

  render();
})();
