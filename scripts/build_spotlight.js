const KEY = process.env.CFBD_KEY;
if (!KEY) { console.log('Missing CFBD_KEY — skipping spotlight'); process.exit(0); }

function inGameWindow(tz = 'America/New_York') {
  const now = new Date();
  const dow = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz })
    .formatToParts(now).find(p => p.type === 'weekday').value;
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(now));
  if (dow === 'Thu' && hour >= 18) return true;
  if (dow === 'Fri' && hour >= 18) return true;
  if (dow === 'Sat') return true;
  if (dow === 'Sun' && hour <= 15) return true;
  return false;
}

if (!inGameWindow()) {
  console.log('No game window — skipping spotlight build.');
  process.exit(0);
}

console.log('Game window detected — spotlight builder not yet implemented (OK).');
process.exit(0);
