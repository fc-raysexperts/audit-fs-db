// One-time step, run on YOUR computer:  npm run zoho:token
//
// Turns the one-time "grant code" from the Zoho API Console (Self Client -> Generate Code) into a REFRESH TOKEN and saves it
// in .env as ZOHO_REFRESH_TOKEN. Nothing secret is printed. Needs ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env first.
//   npm run zoho:token                 (asks for the code)
//   npm run zoho:token -- 1000.abc...  (code on the command line)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadEnv, setEnvVar } from './envfile.mjs';
import { exchangeGrantCode, DATA_CENTERS } from '../lib/zoho.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (!fs.existsSync(envFile)) {
  fs.copyFileSync(path.join(root, '.env.example'), envFile);
  fs.chmodSync(envFile, 0o600);
  console.log('Created .env from .env.example');
}
const env = loadEnv(envFile);
const missing = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Please put ${missing.join(' and ')} into the .env file first (Zoho API Console -> your Self Client -> "Client Secret" tab), then run this again.`);
  process.exit(1);
}
const dc = env.ZOHO_DC || 'in';
if (!DATA_CENTERS[dc]) { console.error(`ZOHO_DC "${dc}" is not valid`); process.exit(1); }

let code = process.argv[2];
if (!code) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  code = (await rl.question('Paste the grant code (it expires in a few minutes): ')).trim();
  rl.close();
}
if (!code) { console.error('No code given.'); process.exit(1); }

try {
  const r = await exchangeGrantCode({ clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, code, dc });
  setEnvVar(envFile, 'ZOHO_REFRESH_TOKEN', r.refreshToken);
  console.log('OK - refresh token saved in .env (not shown here).');
  if (r.scope) console.log('Scopes granted:', r.scope);
  if (r.apiDomain) console.log('API domain:', r.apiDomain, r.apiDomain.endsWith(`.${dc}`) || r.apiDomain.includes(`zohoapis.${dc}`) ? '(matches ZOHO_DC)' : `(CHECK: does not look like data centre "${dc}")`);
  console.log('Next: npm run zoho:check');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
