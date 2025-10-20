/**
 * build-ticker.js
 * - Ensure data/ticker.json exists and has at least one item
 * - If CFBD key is present and you want to fetch real team stats, you can extend this file to call CFBD endpoints.
 *
 * For now this script guarantees the banner has something to show so your UI doesn't say `undefined`.
 */

import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const TICKER_FILE = path.join(DATA_DIR, "ticker.json");

async function readTicker() {
  try {
    const t = await fs.readFile(TICKER_FILE, "utf8");
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function writeTicker(obj) {
  await fs.writeFile(TICKER_FILE, JSON.stringify(obj, null, 2), "utf8");
}

async function run() {
  const current = await readTicker();

  if (current && Array.isArray(current.items) && current.items.length > 0) {
    console.log("[build-ticker] existing ticker found; leaving intact");
    return;
  }

  // Fallback ticker so the banner shows something
  const fallback = {
    year: process.env.YEAR || "2025",
    team: process.env.TEAM || "Kentucky",
    lastWeek: process.env.LASTWEEK ? Number(process.env.LASTWEEK) : 8,
    items: [
      {
        label: "Yards/Play (UK)",
        value: 5.7,
        context: "offense"
      },
      {
        label: "EPA/Play last 3",
        value: "+0.08",
        context: "offense"
      },
      {
        label: "Havoc Allowed",
        value: "42%",
        context: "defense"
      }
    ]
  };

  await writeTicker(fallback);
  console.log("[build-ticker] wrote fallback ticker.json with 3 items");
}

run().catch((err) => {
  console.error("[build-ticker] error:", err);
  process.exitCode = 1;
});
