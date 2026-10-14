// Reads the saved Zoho snapshots (git-ignored, under fixtures/) for tests and the reconcile script.
// Not used by the live app - the live app gets the same shapes from the Zoho API.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGL, expandMergedRows } from '../lib/gl.mjs';
import { normalizeVendorGroup } from '../lib/vendors.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
export const exists = (p) => fs.existsSync(path.join(root, p));

export const haveBase = () => exists('fixtures/tb_fy26_nonzero.raw.json') && exists('fixtures/ar_aging_2026-03-31.raw.json');
export const havePartyFixtures = () => exists('fixtures/gl/raw/gl_party_p1.json') && exists('fixtures/gl/journals_merged.json') && exists('fixtures/vendors_imprest_staff.raw.json');

/** The `party` argument of computeFS, built from the saved snapshots (or null when they are absent). */
export function loadParty({ withOverrides = true } = {}) {
  if (!havePartyFixtures()) return null;
  const dir = path.join(root, 'fixtures/gl/raw');
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const norm = normalizeGL(pages);
  const ex = expandMergedRows(norm.rows, readJSON('fixtures/gl/journals_merged.json'));
  const group = normalizeVendorGroup(readJSON('fixtures/vendors_imprest_staff.raw.json'), 'Imprest Staff');
  return {
    gl: { rows: ex.rows, alerts: ex.alerts, meta: norm.meta },
    rules: readJSON('config/party_rules.json'),
    overrides: withOverrides ? readJSON('config/party_overrides.fy26.json') : null,
    staffGroup: group.ids,
    extraNames: group.names,
  };
}
