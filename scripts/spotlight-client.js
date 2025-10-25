/* Hashmark Spotlight Client (idempotent renderer)
 * - Reads /data JSONs and populates the sidebar.
 * - Guarantees graceful empty-state messages.
 * - Renders letter grades with +/-, color, and 0–100 hover score.
 * - Accepts ?debug=1 to show a tiny telemetry line.
 */
(function(){
  const elWrap = document.getElementById('miniSpotlight');
  if(!elWrap) return;

  const elList = document.getElementById('miniList');
  const elFeat = document.getElementById('miniFeatured');
  const debugOn = /(?:\?|&)debug=1\b/.test(location.search);
  const TEAM = (new URLSearchParams(location.search).get('team') || 'Kentucky').trim();
  const YEAR = new Date().getFullYear(); // client display only

  const FILES = {
    featured: '/data/spotlight_featured.json',
    off_last: '/data/spotlight_offense_last.json',
    off_season: '/data/spotlight_offense_season.json',
    def_last: '/data/spotlight_defense_last.json',
    def_season: '/data/spotlight_defense_season.json'
  };

  // ui state
  let side = 'offense', span = 'last';
  const btns = elWrap.querySelectorAll('.chip');
  btns.forEach(b => b.addEventListener('click', () => {
    if(b.dataset.side) side = b.dataset.side;
    if(b.dataset.span) span = b.dataset.span;
    btns.forEach(x => x.classList.remove('active'));
    elWrap.querySelectorAll(`.chip[data-side="${side}"]`).forEach(x => x.classList.add('active'));
    elWrap.querySelectorAll(`.chip[data-span="${span}"]`).forEach(x => x.classList.add('active'));
    drawList();
  }));
  elWrap.querySelector(`.chip[data-side="${side}"]`)?.classList.add('active');
  elWrap.querySelector(`.chip[data-span="${span}"]`)?.classList.add('active');

  function gradeColor(letter){
    const L = letter.replace(/[+\-]/g,'');
    if(L==='A') return '#16a34a';
    if(L==='B') return '#22c55e';
    if(L==='C') return '#f59e0b';
    if(L==='D') return '#ef4444';
    return '#94a3b8';
  }
  function gradeHTML(g){
    if(!g) return '';
    const clr = gradeColor(g.letter||'');
    const mod = (g.mod||'').replace('plus','+').replace('minus','-');
    const label = `${g.letter || ''}${mod ? (mod==='+'?'+':'−'):''}`;
    return `<span class="grade" title="Score ${g.score??'—'}" style="background:${clr}">${label}</span>`;
  }

  function tileOrImg(p, size){
    const initials = (p.name||'').split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase() || 'UK';
    const s = size||48;
    const head = (p.headshot||'').trim();
    if(!head) return `<div class="tile" style="width:${s}px;height:${s}px">${initials}</div>`;
    const esc = head.replace(/"/g,'&quot;');
    return `<img src="${esc}" alt="${p.name} headshot" width="${s}" height="${s}" loading="lazy"
             onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=&quot;tile&quot; style=&quot;width:${s}px;height:${s}px&quot;>${initials}</div>')">`;
  }

  function statLine(p){
    // Show the compact stat line if present
    const s = p.last_game || p.season || {};
    const keys = ['cmp_att','yds','td','int','rush','rush_yds','rec','rec_yds','tkl','tfl','sck'];
    const map = {cmp_att:'CMP-ATT', yds:'YDS', td:'TD', int:'INT', rush:'RUSH', rush_yds:'RUSH YDS',
                 rec:'REC', rec_yds:'REC YDS', tkl:'TKL', tfl:'TFL', sck:'SACK'};
    const out = [];
    for(const k of keys){
      if(s[k]!=null && s[k]!==''){
        out.push(`${map[k]} ${s[k]}`);
      }
      if(out.length>=3) break;
    }
    return out.join(' • ');
  }

  async function getJSON(path){
    const tryPaths = [path, path.replace(/^\//,'')];
    for(const p of tryPaths){
      try{
        const r = await fetch(p,{cache:'no-store'});
        if(r.ok) return await r.json();
      }catch(e){}
    }
    return null;
  }

  async function drawFeatured(){
    const data = await getJSON(FILES.featured);
    if(!data || !data.name){
      elFeat.style.display='none';
      return;
    }
    elFeat.innerHTML = rowHTML(data, true);
    elFeat.style.display='flex';
  }

  function rowHTML(p, featured){
    const stat = statLine(p);
    const grade = p.grade ? gradeHTML(p.grade) : '';
    const trend = (typeof p.rank_delta==='number' ?
      `<span class="trend ${p.rank_delta>0?'up':(p.rank_delta<0?'down':'flat')}"
             title="Spot movement">${p.rank_delta>0?'▲':p.rank_delta<0?'▼':'–'}</span>` : '');
    return `
      <div class="row">
        ${tileOrImg(p, featured?56:48)}
        <div>
          <div class="who">${p.name} <span class="tiny">• ${p.pos||''}</span>${grade}${trend}</div>
          <div class="stat">${stat} ${p.espn?`<a href="${p.espn}" target="_blank" class="tiny">ESPN ↗</a>`:''}</div>
        </div>
      </div>`;
  }

  async function drawList(){
    const key = (side==='offense'?'off':'def') + '_' + (span==='season'?'season':'last');
    const data = await getJSON(FILES[key]);
    if(!Array.isArray(data) || data.length===0){
      elList.innerHTML = `<div class="tiny">No spotlight data available (${side}/${span}).</div>`;
      return;
    }
    elList.innerHTML = data.slice(0,3).map(p => rowHTML(p)).join('');
  }

  // Kick
  drawFeatured(); 
  drawList();

  // debug telemetry chip
  if(debugOn){
    const hint = document.createElement('div');
    hint.className='tiny';
    hint.style.cssText='margin-top:8px;opacity:.75';
    (async ()=>{
      const r = await getJSON('/data/roster.json');
      const ids = (Array.isArray(r)?r.length:0);
      hint.textContent = `data-mode: live • roster:${ids} (ids:${ids}) • spotlight:3/3 • filter=${span}`;
    })();
    elWrap.appendChild(hint);
  }
})();

/* minimal CSS helpers expected by index.html
   .grade { display:inline-flex; align-items:center; justify-content:center;
     margin-left:8px; border-radius:999px; padding:2px 8px; font:800 12px/1 system-ui;
     background:#111; color:#fff; }
   .trend { margin-left:6px; font:700 12px/1 system-ui; color:#94a3b8 }
   .trend.up { color:#16a34a } .trend.down { color:#dc2626 }
   .tile { display:grid; place-items:center; border-radius:8px; background:#0033a0; color:#fff;
           font:800 14px/1 system-ui; border:1px solid #e5e7eb }
*/
