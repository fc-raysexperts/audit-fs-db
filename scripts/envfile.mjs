// Tiny .env reader / writer (no dependencies). Secrets are only ever written to the .env file, never printed.
import fs from 'node:fs';

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

/** Set KEY=value in the file (replace the existing line, else append). Creates the file if needed. */
export function setEnvVar(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, () => `${key}=${value}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
  fs.writeFileSync(file, next, { mode: 0o600 });
}
