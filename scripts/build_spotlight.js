import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const TEAM = process.env.TEAM || 'Kentucky';
const yearEnv = Number.parseInt(process.env.YEAR || '', 10);
const YEAR = Number.isFinite(yearEnv) ? yearEnv : new Date().getUTCFullYear();

const REQUIRED_OUTPUTS = [
  path.join(ROOT, 'data', 'spotlight_offense_last.json'),
  path.join(ROOT, 'data', 'spotlight_defense_last.json')
];

const OPTIONAL_OUTPUTS = [
  path.join(ROOT, 'data', 'spotlight_featured.json'),
  path.join(ROOT, 'data', 'spotlight_offense_season.json'),
  path.join(ROOT, 'data', 'spotlight_defense_season.json'),
  path.join(ROOT, 'data', 'team', 'roster_plus.json')
];

async function hasJsonContent(file){
  try {
    const text = await fs.readFile(file, 'utf8');
    const trimmed = text.trim();
    if (!trimmed) return false;
    try {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json)) return json.length > 0;
      if (json && typeof json === 'object') return Object.keys(json).length > 0;
    } catch {
      return trimmed.length > 0;
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyOutputs(){
  const checks = await Promise.all(REQUIRED_OUTPUTS.map(hasJsonContent));
  if (!checks.every(Boolean)) return false;
  const optionalChecks = await Promise.all(OPTIONAL_OUTPUTS.map(async (file) => ({
    file,
    ok: await hasJsonContent(file)
  })));
  for (const entry of optionalChecks){
    if (!entry.ok) {
      console.log(`[spotlight] optional output missing or empty: ${path.relative(ROOT, entry.file)}`);
    }
  }
  return true;
}

function runNodeScript(scriptPath){
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env }
    });
    child.on('error', (err) => {
      console.error(`[spotlight] Failed to start ${path.basename(scriptPath)}:`, err?.message || err);
      resolve(false);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        console.warn(`[spotlight] ${path.basename(scriptPath)} exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

async function runCfbdPipeline(){
  console.log('[spotlight] Running CFBD spotlight pipeline');
  const scriptPath = path.join(__dirname, 'build-spotlight.js');
  const success = await runNodeScript(scriptPath);
  if (!success) return false;
  const ok = await verifyOutputs();
  if (!ok) console.warn('[spotlight] CFBD pipeline completed but required spotlight files are missing');
  return ok;
}

async function runEspnFallback(){
  try {
    const mod = await import('./fallback_espn.js');
    if (typeof mod.buildSpotlightFromESPN !== 'function') {
      console.warn('[spotlight] ESPN fallback module missing buildSpotlightFromESPN export');
      return false;
    }
    console.log('[spotlight] Using ESPN fallback');
    await mod.buildSpotlightFromESPN(TEAM, YEAR);
    return await verifyOutputs();
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.log('[spotlight] ESPN fallback module not found; skipping');
      return false;
    }
    console.error('[spotlight] ESPN fallback failed:', err?.message || err);
    return false;
  }
}

async function runCfbfastRFallback(){
  try {
    console.log('[spotlight] Using cfbfastR fallback');
    const { buildSpotlightFromCFBfastR } = await import('./fallback_cfbfastr.js');
    await buildSpotlightFromCFBfastR(TEAM, YEAR);
    return await verifyOutputs();
  } catch (err) {
    console.error('[spotlight] cfbfastR fallback failed:', err?.message || err);
    return false;
  }
}

async function main(){
  let ok = await runCfbdPipeline();
  let source = ok ? 'cfbd' : null;

  if (!ok) {
    ok = await runEspnFallback();
    if (ok) source = 'espn';
  }

  if (!ok) {
    ok = await runCfbfastRFallback();
    if (ok) source = 'cfbfastR';
  }

  if (!ok) {
    console.log('[spotlight] Spotlight fallbacks exhausted — retaining existing cached data');
    return;
  }

  console.log(`[spotlight] Spotlight build succeeded via ${source}`);
}

main().catch(err => {
  console.error('[spotlight] Unexpected build error:', err?.message || err);
  process.exit(1);
});
