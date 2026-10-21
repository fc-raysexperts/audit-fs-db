// Reads the files in config/ and works out the dates of a financial year. (Node only: uses the file system.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Next to this file when run from the project (scripts, tests, `next dev`); under the working directory when the code has been bundled
// for hosting (Vercel starts the app from the project root and ships config/ with it - see outputFileTracingIncludes in next.config.mjs).
const nextToCode = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config');
export const configDir = process.env.AUDIT_FS_CONFIG_DIR
  || (fs.existsSync(path.join(nextToCode, 'mapping.json')) ? nextToCode : path.join(process.cwd(), 'config'));

const readJSON = (name) => JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
export const readConfigFile = readJSON;
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
    // update-15: accounts that Zoho keeps as one ledger account but the signed workbook lists line by line (fixed deposits per bank ...): see lib/splits.mjs
    splits: readOptional(`splits.${sfx}.json`),
    // update-20: CWIP / IAUD park by park (the CWIP tab): the two accounts, the park names and the words that tell a ledger line's park, see lib/cwip.mjs
    cwip: readOptional(`cwip.${sfx}.json`),
    // update-27: the related parties of Note 28(A) and the RPT Transaction sheet, checked against Zoho (contacts, accounts and the list of checks), see lib/related.mjs
    related: readOptional(`related.${sfx}.json`),
    // update-28: Zoho's fixed asset register against FA Add and Dep.Calc. (lib/register.mjs), and the subsidiaries' own books against Form AOC-1 and the loans of Note 28(A) (lib/subsidiaries.mjs)
    register: readOptional(`register.${sfx}.json`),
    subsidiaries: readOptional(`subsidiaries.${sfx}.json`),
    audited: readOptional(`audited.${sfx}.json`),
    // the rest of the audited booklet (notes, cash flow, fixed assets, ratios, tax): optional, a year without them still shows the statements
    books: {
      notes: readOptional(`notes.${sfx}.json`),
      cashflow: readOptional(`cashflow.${sfx}.json`),
      assets: readOptional(`assets.${sfx}.json`),
      ratios: readOptional(`ratios.${sfx}.json`),
      tax: readOptional(`tax.${sfx}.json`),
    },
    // the sheets of the audited workbook that are shown as they were signed (config/workbook.fyYY/): the list of all sheets, and one file per sheet
    workbook: readOptional(`workbook.${sfx}/index.json`) ? { dir: `workbook.${sfx}`, index: readJSON(`workbook.${sfx}/index.json`) } : null,
  };
}
