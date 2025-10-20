/**
 * build-spotlight.js
 * - Reads spotlight JSON files in ./data
 * - Ensures player objects contain .headshot (ESPN CDN if possible)
 * - Ensures .last_game and .season contain minimal stat objects (so frontend shows categories)
 *
 * Works with Node v18+ where global fetch is available (GitHub Actions node:20 has it).
 */

import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const FILES = [
  "spotlight_offense_last.json",
  "spotlight_defense_last.json",
  "spotlight_featured.json",
  "spotlight_offense_season.json",
  "spotlight_defense_season.json"
];

function espnIdFromUrl(url) {
  if (!url) return null;
  // match "/player/_/id/<digits>/"
  const m = url.match(/\/id\/(\d+)\//);
  return m ? m[1] : null;
}

function buildEspnHeadshotUrl(id) {
  if (!id) return "";
  // ESPN CDN pattern used on many sites
  return `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`;
}

/**
 * scorePlayers: minimal scoring filler so front-end has stat keys to render
 * If there are real stats available in the player object (season/last_game), prefer them.
 * Otherwise add a small object with the expected keys so labels render.
 */
function scorePlayers(players = []) {
  return players.map((p) => {
    const out = { ...p };

    // ensure last_game object exists
    if (!out.last_game || Object.keys(out.last_game || {}).length === 0) {
      // a safe minimal structure — front-end can read these keys and show nothing else
      out.last_game = {
        tckl: 0,
        tfl: 0,
        yds: 0,
        ypc: 0,
        ypg: 0,
        td: 0,
        rec: 0,
        rush: 0,
      };
    }

    if (!out.season || Object.keys(out.season || {}).length === 0) {
      out.season = {
        games: 0,
        yds: 0,
        td: 0,
        rec: 0,
        rush: 0,
        tfl: 0,
      };
    }

    return out;
  });
}

async function loadJson(fn) {
  try {
    const txt = await fs.readFile(path.join(DATA_DIR, fn), "utf8");
    return JSON.parse(txt || "[]");
  } catch (err) {
    // file may not exist — return empty array
    return [];
  }
}
async function writeJson(fn, data) {
  await fs.writeFile(path.join(DATA_DIR, fn), JSON.stringify(data, null, 2), "utf8");
}

async function run() {
  for (const file of FILES) {
    const arr = await loadJson(file);

    // if the file contains an object with players (some of your files may be top-level object)
    let players = Array.isArray(arr) ? arr : arr.players || arr.items || [];

    // if there are no players, leave minimal content (so front-end doesn't break)
    if (!players || players.length === 0) {
      // keep file as empty array (we still write fallback later)
      await writeJson(file, []);
      console.log(`[build-spotlight] ${file} empty -> wrote []`);
      continue;
    }

    // ensure headshot if espn contains id in url
    players = players.map((p) => {
      const player = { ...p };
      if ((!player.headshot || player.headshot === "") && player.espn) {
        const id = espnIdFromUrl(player.espn);
        if (id) {
          player.headshot = buildEspnHeadshotUrl(id);
        }
      }
      return player;
    });

    // ensure players have usable stat objects
    const scored = scorePlayers(players);

    // write back same shape as read:
    if (Array.isArray(arr)) {
      await writeJson(file, scored);
    } else if (arr.players) {
      arr.players = scored;
      await writeJson(file, arr);
    } else {
      // fallback: write array
      await writeJson(file, scored);
    }

    console.log(`[build-spotlight] ${file} -> wrote ${scored.length} players (headshots + stats normalized)`);
  }

  console.log("[build-spotlight] done");
}

run().catch((err) => {
  console.error("[build-spotlight] error:", err);
  process.exitCode = 1;
});
