// A tiny, safe formula language for the notes ("what is this line made of?").
//
//   1 + 2 * (3 - 4)   max(0, x)   min(a, b)   round(x)   -x
//   a:<accountId>      one Zoho account, as the Trial Balance holds it (debit +, credit -)
//   n:<bucket>         a group of accounts (mapping.json bucket) in natural sign: assets and expenses as they are, the rest flipped to positive
//   r:<bucket>         the same group with debit +, credit -
//   l:<line>           a statement line of the snapshot (e.g. l:pat)
//   i:<key>            a year-end input (config/inputs.fyYY.json)
//   c:<key>            a constant of the notes file (config/notes.fyYY.json)
//   row:<key>          another row of the notes (its computed value)
//
// There is no eval: the text is parsed into a small tree and walked. Unknown names raise an error that says exactly what is missing.

const NAME = /[A-Za-z0-9_.]/; // no "-": "l:pat-l:tax" must read as a subtraction

export function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('+-*/(),'.includes(ch)) { out.push({ t: ch }); i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      const n = Number(text.slice(i, j));
      if (!Number.isFinite(n)) throw new Error(`Bad number "${text.slice(i, j)}" in formula: ${text}`);
      out.push({ t: 'num', v: n }); i = j; continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < text.length && (NAME.test(text[j]) || text[j] === ':')) j++;
      const word = text.slice(i, j);
      const colon = word.indexOf(':');
      if (colon > 0) out.push({ t: 'ref', kind: word.slice(0, colon), id: word.slice(colon + 1) });
      else out.push({ t: 'fn', name: word });
      i = j; continue;
    }
    throw new Error(`Unexpected "${ch}" in formula: ${text}`);
  }
  return out;
}

export function parse(text) {
  const tk = tokenize(text);
  let p = 0;
  const peek = () => tk[p];
  const take = (t) => {
    const x = tk[p];
    if (!x || (t && x.t !== t)) throw new Error(`Formula is incomplete or malformed near "${x?.t ?? 'end'}": ${text}`);
    p++; return x;
  };
  function expr() {
    let left = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = take().t; left = { op, a: left, b: term() };
    }
    return left;
  }
  function term() {
    let left = factor();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = take().t; left = { op, a: left, b: factor() };
    }
    return left;
  }
  function factor() {
    const x = peek();
    if (!x) throw new Error(`Formula ends too early: ${text}`);
    if (x.t === '-') { take(); return { op: 'neg', a: factor() }; }
    if (x.t === '+') { take(); return factor(); }
    if (x.t === 'num') { take(); return { num: x.v }; }
    if (x.t === 'ref') { take(); return { ref: x.kind, id: x.id }; }
    if (x.t === '(') { take(); const e = expr(); take(')'); return e; }
    if (x.t === 'fn') {
      take(); take('(');
      const args = [expr()];
      while (peek() && peek().t === ',') { take(); args.push(expr()); }
      take(')');
      if (!['max', 'min', 'round'].includes(x.name)) throw new Error(`Unknown function "${x.name}" in formula: ${text}`);
      return { fn: x.name, args };
    }
    throw new Error(`Unexpected "${x.t}" in formula: ${text}`);
  }
  const tree = expr();
  if (p !== tk.length) throw new Error(`Unexpected "${tk[p].t}" at the end of formula: ${text}`);
  return tree;
}

/** @param {object} tree  @param {(kind:string,id:string)=>number} lookup */
export function evaluate(tree, lookup) {
  const go = (n) => {
    if ('num' in n) return n.num;
    if ('ref' in n) {
      const v = lookup(n.ref, n.id);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${n.ref}:${n.id}" has no number`);
      return v;
    }
    if ('fn' in n) {
      const a = n.args.map(go);
      if (n.fn === 'max') return Math.max(...a);
      if (n.fn === 'min') return Math.min(...a);
      return Math.round(a[0]);
    }
    switch (n.op) {
      case 'neg': return -go(n.a);
      case '+': return go(n.a) + go(n.b);
      case '-': return go(n.a) - go(n.b);
      case '*': return go(n.a) * go(n.b);
      case '/': { const d = go(n.b); if (d === 0) throw new Error('Division by zero in a formula'); return go(n.a) / d; }
      default: throw new Error('Bad formula tree');
    }
  };
  return go(tree);
}

/**
 * The top-level additive terms of a formula, each as its own tree with its sign: used to show "made up of ...".
 * "a + b - c" -> [{sign:+1, tree:a}, {sign:+1, tree:b}, {sign:-1, tree:c}]
 */
export function additiveTerms(tree) {
  const out = [];
  const go = (n, s) => {
    if (n.op === '+') { go(n.a, s); go(n.b, s); } else if (n.op === '-') { go(n.a, s); go(n.b, -s); } else if (n.op === 'neg') go(n.a, -s);
    else out.push({ sign: s, tree: n });
  };
  go(tree, 1);
  return out;
}

/** Names of everything a formula refers to - to check config files without a snapshot. */
export function refsOf(tree, acc = []) {
  if ('ref' in tree) acc.push({ kind: tree.ref, id: tree.id });
  if ('a' in tree) refsOf(tree.a, acc);
  if ('b' in tree) refsOf(tree.b, acc);
  if ('args' in tree) tree.args.forEach((x) => refsOf(x, acc));
  return acc;
}
