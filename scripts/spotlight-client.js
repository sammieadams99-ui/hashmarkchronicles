/**
 * Client renderer for the sidebar “Player Spotlight”
 * - Fetches JSON from /data/*.json
 * - Renders featured card + list for Offense/Defense in tabs [Last | Season]
 * - Robust empty-state + safe fallbacks
 *
 * Usage:
 *   <div id="hc-spotlight"></div>
 *   <script src="/scripts/spotlight-client.js" defer></script>
 *
 * CSS: The component ships minimal styles; inherit site fonts.
 */

(function () {
  const ROOT_ID = "hc-spotlight";
  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  const state = {
    side: "offense",   // "offense" | "defense"
    view: "last",      // "last" | "season"
    feeds: {},         // cached JSON
  };

  const css = document.createElement("style");
  css.textContent = `
  .hc-tabs{display:flex;gap:.5rem;margin:.25rem 0 .5rem}
  .hc-tab{padding:.25rem .5rem;border:1px solid #cbd5e1;border-radius:9999px;cursor:pointer;font-size:.85rem;background:#f7fafc}
  .hc-tab.active{background:#003087;color:#fff;border-color:#003087}
  .hc-row{display:flex;align-items:center;gap:.6rem;padding:.5rem;border:1px solid #e6e6e6;border-radius:8px;margin:.4rem 0;background:#fff}
  .hc-row img{width:40px;height:40px;border-radius:50%;object-fit:cover}
  .hc-row .hc-meta{flex:1}
  .hc-name{font-weight:600;font-size:.92rem}
  .hc-sub{font-size:.8rem;color:#475569}
  .hc-grade{margin-left:auto;font-weight:700;font-size:.9rem;min-width:38px;text-align:center;border-radius:14px;padding:.2rem .45rem;border:1px solid #e2e8f0}
  .hc-grade.A{background:#ecfdf5;border-color:#10b981;color:#047857}
  .hc-grade.B{background:#eff6ff;border-color:#60a5fa;color:#1d4ed8}
  .hc-grade.C{background:#fefce8;border-color:#facc15;color:#854d0e}
  .hc-grade.D{background:#fff7ed;border-color:#fb923c;color:#9a3412}
  .hc-grade.F{background:#fef2f2;border-color:#fca5a5;color:#b91c1c}
  .hc-empty{padding:.75rem;border:1px dashed #cbd5e1;border-radius:8px;color:#475569;background:#fff}
  .hc-featured{display:flex;gap:.75rem;align-items:center;border:2px solid #e6e6e6;border-radius:10px;padding:.6rem;background:#fff;margin-bottom:.6rem}
  .hc-featured img{width:54px;height:54px;border-radius:50%;object-fit:cover}
  .hc-featured .hc-title{font-weight:700}
  .hc-chip{display:inline-block;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:9999px;padding:.1rem .5rem;font-size:.75rem;margin-left:.4rem}
  `;
  document.head.appendChild(css);

  root.innerHTML = `
    <div class="hc-tabs">
      <button class="hc-tab" data-side="offense">Offense</button>
      <button class="hc-tab" data-side="defense">Defense</button>
      <span style="flex:1"></span>
      <button class="hc-tab" data-view="last">Last</button>
      <button class="hc-tab" data-view="season">Season</button>
    </div>
    <div id="hc-featured"></div>
    <div id="hc-list"></div>
  `;

  const tabs = root.querySelectorAll(".hc-tab");
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.side) state.side = btn.dataset.side;
      if (btn.dataset.view) state.view = btn.dataset.view;
      render();
    });
  });

  function pickFeed() {
    return `/data/spotlight_${state.side}_${state.view}.json`;
  }

  async function getJSON(url) {
    if (state.feeds[url]) return state.feeds[url];
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      state.feeds[url] = data;
      return data;
    } catch (e) {
      console.warn("spotlight fetch failed", url, e);
      return [];
    }
  }

  function gradePill(g, pct) {
    const letter = (g || "C").slice(0,1);
    const cls = `hc-grade ${letter}`;
    const mod = g.length > 1 ? g.slice(1) : "";
    return `<span class="${cls}" title="${pct ?? ""}%">${letter}${mod}</span>`;
  }

  async function render() {
    // activate tabs
    tabs.forEach(b => {
      const active = (b.dataset.side && b.dataset.side === state.side) ||
                     (b.dataset.view && b.dataset.view === state.view);
      b.classList.toggle("active", active);
    });

    const listEl = root.querySelector("#hc-list");
    const featuredEl = root.querySelector("#hc-featured");

    // FEATURED (only when view=last offense if exists)
    if (state.side === "offense" && state.view === "last") {
      const feature = await getJSON("/data/spotlight_featured.json");
      if (Array.isArray(feature) && feature.length) {
        const p = feature[0];
        featuredEl.innerHTML = `
          <div class="hc-featured">
            <img src="${p.headshot}" alt="${p.name}">
            <div class="hc-meta">
              <div class="hc-title">${p.name}<span class="hc-chip">Featured</span></div>
              <div class="hc-sub">${p.position || ""} ${p.number ? ("• #" + p.number) : ""}</div>
            </div>
            ${gradePill(p.grade, p.percent)}
          </div>`;
      } else {
        featuredEl.innerHTML = "";
      }
    } else {
      featuredEl.innerHTML = "";
    }

    // LIST
    const rows = await getJSON(pickFeed());
    if (!Array.isArray(rows) || rows.length === 0) {
      listEl.innerHTML = `<div class="hc-empty">No spotlight data yet — waiting for the first completed game or stats import.</div>`;
      return;
    }
    listEl.innerHTML = rows.map(p => `
      <div class="hc-row">
        <img src="${p.headshot}" alt="${p.name}">
        <div class="hc-meta">
          <div class="hc-name">${p.name}</div>
          <div class="hc-sub">${p.position || ""} ${p.number ? ("• #" + p.number) : ""}</div>
        </div>
        ${gradePill(p.grade, p.percent)}
      </div>
    `).join("");
  }

  render();
})();
