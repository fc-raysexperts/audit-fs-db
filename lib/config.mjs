// Reads the files in config/ and works out the dates of a financial year. (Node only: uses the file system.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config');

const readJSON = (name) => JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
const readOptional = (name) => (fs.existsSync(path.join(configDir, name)) ? readJSON(name) : null);

/**
 * Dates of an Indian financial year ("2025-26" = 1 Apr 2025 to 31 Mar 2026).
 * `to` is the report date: the year end for a finished year, otherwise today (so the year to date).
 * @param {string} fy
 * @param {string} today  "YYYY-MM-DD" (India)
 */
export function fyPeriod(fy, today) {
  const m = /^(\d{4})-(\d{2})$/.exec(fy ?? '');
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new Error(`"${fy}" is not a financial year like 2025-26`);
  const y = Number(m[1]);
  const from = `${y}-04-01`;
  const end = `${y + 1}-03-31`;
  if (today < from) throw new Error(`Financial year ${fy} has not started yet`);
  return { fy, from, end, to: today < end ? today : end };
}

/** Everything the engine needs for one financial year. Year-specific files are looked up by the "fyYY" suffix. */
export function loadConfig(fy) {
  const sfx = `fy${fy.slice(-2)}`;
  const inputs = readOptional(`inputs.${sfx}.json`);
  if (!inputs) {
    throw new Error(`Financial year ${fy} is not set up yet: config/inputs.${sfx}.json is missing (it holds the few year-end figures Zoho does not have)`);
  }
  return {
    mapping: readJSON('mapping.json'),
    settings: readJSON('settings.json'),
    partyRules: readJSON('party_rules.json'),
    inputs,
    overrides: readOptional(`overrides.${sfx}.json`),
    partyOverrides: readOptional(`party_overrides.${sfx}.json`),
    audited: readOptional(`audited.${sfx}.json`),
  };
}
