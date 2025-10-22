import fs from 'fs';
import path from 'path';

export const DRY = process.env.DRY_RUN === 'true';
export const LOG = process.env.LOG_LEVEL || 'info';

export function writeJSON(filePath, data) {
  if (DRY) {
    console.log(`DRY: ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function retry(fn, backoff = [200, 500, 900]) {
  let lastError;
  for (const baseDelay of backoff) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const jitter = Math.random() * 150;
      const waitFor = baseDelay + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitFor));
    }
  }
  throw lastError;
}

export function readJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}
