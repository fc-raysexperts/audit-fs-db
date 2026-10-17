// The little formula language behind the notes, cash flow, ratios and tax workings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, additiveTerms, refsOf, tokenize } from '../lib/expr.mjs';

const vars = { 'l:a': 100, 'l:b': 40, 'c:rate': 0.25 };
const run = (text) => evaluate(parse(text), (k, id) => {
  const v = vars[`${k}:${id}`];
  if (v === undefined) throw new Error(`unknown ${k}:${id}`);
  return v;
});

test('arithmetic follows the usual order and brackets', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('10 - 4 - 3'), 3);
  assert.equal(run('-2 + 5'), 3);
  assert.equal(run('8 / 2 / 2'), 2);
});

test('names are read from the figures handed in, and "-" between two names is a subtraction', () => {
  assert.equal(run('l:a - l:b'), 60);
  assert.equal(run('l:a-l:b'), 60);
  assert.equal(run('(l:a - l:b) * c:rate'), 15);
});

test('max, min and round', () => {
  assert.equal(run('max(0, l:b - l:a)'), 0);
  assert.equal(run('min(l:a, l:b)'), 40);
  assert.equal(run('round(2.6)'), 3);
});

test('nothing is evaluated as code: odd text is refused', () => {
  assert.throws(() => parse('process.exit(1)'), /Unexpected|Unknown/i);
  assert.throws(() => parse('1 + ;'), /Unexpected/);
  assert.throws(() => parse('"a"'), /Unexpected/);
  assert.throws(() => run('l:nope'), /unknown l:nope/);
});

test('dividing by zero is an error, not Infinity', () => {
  assert.throws(() => run('1 / (l:a - l:a)'), /Division by zero/);
});

test('"made up of" terms keep their signs; refsOf lists every name a formula uses', () => {
  const t = parse('l:a + l:b - c:rate - (l:a - l:b)');
  const terms = additiveTerms(t).map((x) => x.sign);
  assert.deepEqual(terms, [1, 1, -1, -1, 1], "a minus in front of a bracket flips the signs inside it");
  assert.deepEqual(refsOf(parse('max(0, l:a) - c:rate')).map((r) => `${r.kind}:${r.id}`), ['l:a', 'c:rate']);
  assert.ok(tokenize('a:2346113000000054793').some((x) => x.t === 'ref' && x.kind === 'a'));
});
