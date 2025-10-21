#!/usr/bin/env node
/**
 * Deterministically derive a secret token from the provided CFBD API key.
 * The script also prints a fresh random 32-byte secret in case you prefer
 * to rotate the GitHub secret with a random value instead.
 */

import { createHash, randomBytes } from 'node:crypto';

function usage() {
  console.error(
    [
      'Usage: node scripts/generate-cfbd-secret.js [options] [api-key]',
      '   or: CFBD_KEY=... npm run secret [options]',
      '',
      'Options:',
      '  --json          Emit a JSON payload for scripting.',
      '  --no-random     Skip generating the random rotation candidate.',
      '  --gh            Print a helper command for gh secret set.',
      '  --repo=<slug>   Owner/repo override for --gh helpers.',
      '  -h, --help      Show this message.'
    ].join('\n')
  );
}

function parseArgs(rawArgs) {
  const options = {
    includeRandom: true,
    error: false
  };
  const positionals = [];

  for (const arg of rawArgs) {
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-random') {
      options.includeRandom = false;
    } else if (arg === '--gh') {
      options.gh = true;
    } else if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length);
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      options.help = true;
      options.error = true;
    } else {
      positionals.push(arg);
    }
  }

  options.value = positionals[0];
  return options;
}

async function readFromStdin() {
  if (process.stdin.isTTY) {
    return '';
  }

  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

function deriveSecret(source) {
  const hex = createHash('sha256').update(source, 'utf8').digest('hex');
  return {
    hex,
    base64: Buffer.from(hex, 'hex').toString('base64url')
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    process.exit(args.error ? 1 : 0);
  }

  let input = (args.value || process.env.CFBD_KEY || '').trim();

  if (!input) {
    input = await readFromStdin();
  }

  if (!input) {
    usage();
    process.exit(1);
  }

  const derived = deriveSecret(input);
  const randomSecret = args.includeRandom
    ? randomBytes(32).toString('base64url')
    : null;

  if (args.json) {
    const payload = {
      derived: {
        hex: derived.hex,
        base64url: derived.base64
      }
    };

    if (randomSecret) {
      payload.random = randomSecret;
    }

    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('Derived secret (hex):', derived.hex);
    console.log('Derived secret (base64url):', derived.base64);

    if (randomSecret) {
      console.log('Fresh random 32-byte secret:', randomSecret);
    }
  }

  if (args.gh) {
    const repo = args.repo || process.env.GITHUB_REPOSITORY;
    const repoSuffix = repo ? ` --repo ${repo}` : '';
    const command = `printf '%s' '${derived.base64}' | gh secret set CFBD_SECRET${repoSuffix} --app actions --body -`;

    if (!args.json) {
      console.log('');
      console.log('To update your GitHub secret:');
    }

    console.log(args.json ? command : `  ${command}`);
  }
}

await main();
