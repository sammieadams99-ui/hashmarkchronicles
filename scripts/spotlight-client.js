/* Minimal guard so UI doesn’t look broken while data is thin */
(function(){
  const wrap = document.getElementById('miniSpotlight');
  if (!wrap) return;

  function emptyMsg(msg){
    const list = document.getElementById('miniList');
    if (list) list.innerHTML = `<div class="tiny">${msg}</div>`;
  }

  // If the JSON is truly empty, show a friendly note
  window.hcSpotlightEmpty = function(which){
    emptyMsg("No spotlight data yet — updates shortly after the next CFBD refresh.");
  };
})();
