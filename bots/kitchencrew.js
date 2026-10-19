// bots/kitchencrew.js — a helpful bot chef for Kitchen Crew.
// Reactive planner: every tick it looks at the shared kitchen, decides the most useful job for
// whatever it is holding, walks there along a BFS path and interacts. Because it re-plans from the
// live state each tick, it copes with teammates moving things around under its nose.
const game = require('../games/kitchencrew');
const { botName } = require('./lib/bot-name');

exports.name = 'kitchencrew';

const { RECIPES, INGREDIENTS, CRATES } = game;
const key = game.key;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Claims other bots have made this tick, so two bots don't fetch for the same need.
const claims = new WeakMap();
function claimsFor(state) {
  let m = claims.get(state);
  if (!m) { m = new Map(); claims.set(state, m); }
  return m;
}

// Food handed over a counter: tile -> { from: floor cell it was passed from, at: tick }. For a few
// seconds only a chef on another side picks it up (otherwise the passer grabs it straight back).
// After that anyone may: if every chef ended up on the passing side, nobody else ever would.
const PASS_LOCK_TICKS = 60; // ~4 s
const passed = new WeakMap();
function passedFor(state) {
  let m = passed.get(state);
  if (!m) { m = new Map(); passed.set(state, m); }
  for (const [k, v] of m) if (!state.items[k] || state.tick - v.at > PASS_LOCK_TICKS) m.delete(k);
  return m;
}

function tilesOf(state, pred) {
  const out = [];
  for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) if (pred(state.grid[y][x], x, y)) out.push([x, y]);
  return out;
}

function crateFor(state, kind) {
  return tilesOf(state, ch => CRATES[ch] === kind && true).filter(([x, y]) => !state.items[key(x, y)]);
}

function itemsWhere(state, pred) {
  const out = [];
  for (const k of Object.keys(state.items)) {
    const [x, y] = k.split(',').map(Number);
    const it = state.items[k];
    if (it && pred(it, state.grid[y][x], x, y)) out.push([x, y]);
  }
  return out;
}

// ---- pathing ----

function bfs(state, from, blocked) {
  const dist = new Map();
  const prev = new Map();
  const start = key(from[0], from[1]);
  dist.set(start, 0);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    const d = dist.get(key(x, y));
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, nk = key(nx, ny);
      if (dist.has(nk) || !game.isWalkable(game.tileAt(state, nx, ny)) || blocked.has(nk)) continue;
      dist.set(nk, d + 1);
      prev.set(nk, key(x, y));
      q.push([nx, ny]);
    }
  }
  return { dist, prev };
}

// Cheapest floor cell to stand on to use tile (tx, ty), with the path to it.
function routeTo(nav, tx, ty) {
  let best = null;
  for (const [dx, dy] of DIRS) {
    const k = key(tx + dx, ty + dy);
    const d = nav.dist.get(k);
    if (d !== undefined && (!best || d < best.d)) best = { d, k };
  }
  if (!best) return null;
  const path = [best.k];
  while (nav.prev.has(path[0])) path.unshift(nav.prev.get(path[0]));
  return { d: best.d, path: path.map(s => s.split(',').map(Number)) };
}

function nearest(nav, tiles) {
  let best = null;
  for (const t of tiles) {
    const r = routeTo(nav, t[0], t[1]);
    if (r && (!best || r.d < best.r.d)) best = { t, r };
  }
  return best;
}

// ---- world reading ----

function vesselsOnStoves(state, kind) {
  return itemsWhere(state, (it, ch) => it.k === kind && (ch === 'S' || ch === 'F'));
}

function heldBy(state) {
  return state.chefs.map(c => c.h).filter(Boolean);
}

// Count raw/chopped ingredient `kind` not yet inside a vessel or on a plate.
function looseCount(state, kind) {
  let n = 0;
  for (const it of heldBy(state)) if (it.k === kind) n++;
  for (const k of Object.keys(state.items)) if (state.items[k].k === kind) n++;
  for (const k of Object.keys(state.floor || {})) if (state.floor[k].k === kind) n++;
  for (const f of state.flying || []) if (f.item.k === kind) n++;
  return n;
}

function platesWithParts(state) {
  const out = [];
  for (const it of heldBy(state)) if (it.k === 'plate') out.push(it);
  for (const k of Object.keys(state.items)) if (state.items[k].k === 'plate') out.push(state.items[k]);
  return out;
}

function openRecipes(state) {
  return state.orders.map(o => o.r);
}

// Tokens still missing across assembly orders (salad / burgers) after crediting plates in play.
function assemblyShortfall(state) {
  const need = {};
  const orders = openRecipes(state).filter(r => !RECIPES[r].parts[0].startsWith('soup_')).slice(0, 2);
  const plates = platesWithParts(state).map(p => p.parts.slice());
  for (const r of orders) {
    const parts = RECIPES[r].parts.slice();
    // credit the best-matching plate
    let bestI = -1, bestHit = -1;
    plates.forEach((pp, i) => {
      if (!pp) return;
      const left = parts.slice();
      let ok = true, hit = 0;
      for (const p of pp) { const j = left.indexOf(p); if (j < 0) { ok = false; break; } left.splice(j, 1); hit++; }
      if (ok && hit > bestHit) { bestHit = hit; bestI = i; }
    });
    if (bestI >= 0) {
      for (const p of plates[bestI]) parts.splice(parts.indexOf(p), 1);
      plates[bestI] = null;
    }
    for (const p of parts) need[p] = (need[p] || 0) + 1;
  }
  return need;
}

// Would a pot of this vegetable (or this finished vessel) feed an open order?
function soupWanted(state, kind) {
  return soupKindsWanted(state).indexOf(kind) >= 0;
}
function vesselWanted(state, v) {
  if (v.k === 'pan') return openRecipes(state).some(r => RECIPES[r].parts.includes('patty'));
  return v.parts.length > 0 && soupWanted(state, v.parts[0]);
}

function soupKindsWanted(state) {
  return openRecipes(state).filter(r => RECIPES[r].parts[0].startsWith('soup_')).map(r => RECIPES[r].parts[0].slice(5));
}

// Which raw ingredient should be fetched next (oldest orders first)?
function nextIngredient(state, myIdx) {
  const pending = {};
  for (const [i, c] of claimsFor(state)) if (i !== myIdx && c && c.fetch) pending[c.fetch] = (pending[c.fetch] || 0) + 1;
  const loose = kind => looseCount(state, kind) + (pending[kind] || 0);

  // Soups: fill pots, matching kinds to orders.
  const pots = vesselsOnStoves(state, 'pot').map(([x, y]) => state.items[key(x, y)]).filter(p => !p.b && p.parts.length < 3)
    .sort((a, b) => b.parts.length - a.parts.length); // finish one soup before starting the next
  const wanted = soupKindsWanted(state);
  const potKinds = vesselsOnStoves(state, 'pot').map(([x, y]) => state.items[key(x, y)]).filter(p => p.parts.length).map(p => p.parts[0]);
  for (const pot of pots) {
    let kind = pot.parts[0];
    if (!kind) {
      // An empty pot takes the oldest soup order no other pot is already making.
      const covered = potKinds.slice();
      kind = wanted.find(w => { const i = covered.indexOf(w); if (i >= 0) { covered.splice(i, 1); return false; } return true; });
      if (!kind) continue;
      potKinds.push(kind);
    }
    if (!soupWanted(state, kind)) continue; // half-filled pot of something no one ordered
    const missing = 3 - pot.parts.length - loose(kind);
    if (missing > 0 && crateFor(state, kind).length) return kind;
  }

  // Burgers: fry a patty for each burger order not already covered.
  const burgers = openRecipes(state).filter(r => RECIPES[r].parts.includes('patty')).slice(0, 2).length;
  if (burgers) {
    const pans = vesselsOnStoves(state, 'pan').map(([x, y]) => state.items[key(x, y)]);
    const frying = pans.filter(p => p.parts.length && !p.b).length;
    const onPlates = platesWithParts(state).filter(p => p.parts.includes('patty')).length;
    if (burgers > frying + onPlates + loose('meat') && pans.some(p => !p.parts.length)) return 'meat';
  }

  // Assembly parts (lettuce, tomato).
  const need = assemblyShortfall(state);
  for (const token of Object.keys(need)) {
    if (token === 'bun' || token === 'patty') continue;
    if (need[token] > loose(token) && crateFor(state, token).length) return token;
  }
  return null;
}

// ---- decision ----

// A counter with floor on two opposite sides: food left here can be picked up from the far side.
function sameSide(fromKey, cell, tile) {
  const [fx, fy] = fromKey.split(',').map(Number);
  return Math.sign(fx - tile[0]) === Math.sign(cell[0] - tile[0]) && Math.sign(fy - tile[1]) === Math.sign(cell[1] - tile[1]);
}

function twoSided(state, x, y) {
  const w = (dx, dy) => game.isWalkable(game.tileAt(state, x + dx, y + dy));
  return (w(1, 0) && w(-1, 0)) || (w(0, 1) && w(0, -1));
}

// Carrying something to a far destination with teammates around: hand it over a nearby
// two-sided counter if someone on the other side would get it there much sooner.
function passOrGo(state, idx, nav, dest) {
  const go = { tile: dest.t, act: 'grab' };
  if (state.chefs.length < 2 || dest.r.d < 7) return go;
  const access = dest.r.path[dest.r.path.length - 1];
  const fromDest = bfs(state, access, new Set());
  let best = null;
  for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) {
    if (state.grid[y][x] !== 'C' || state.items[key(x, y)] || !twoSided(state, x, y)) continue;
    const mine = routeTo(nav, x, y);
    const theirs = routeTo(fromDest, x, y);
    if (!mine || !theirs || mine.d > 3) continue;
    // Pass only when the far side of this counter is close to the destination.
    const farSide = DIRS.map(([dx, dy]) => key(x + dx, y + dy)).filter(k => fromDest.dist.has(k) && !nav.dist.has(k) || (fromDest.dist.get(k) || 99) + 3 < (nav.dist.get(k) || 0));
    if (!farSide.length || theirs.d + 4 >= dest.r.d) continue;
    if (!best || mine.d < best.d) best = { d: mine.d, tile: [x, y], from: mine.path[mine.path.length - 1] };
  }
  return best ? { tile: best.tile, act: 'grab', pass: key(best.from[0], best.from[1]) } : go;
}

function decide(state, idx, nav, avoid) {
  const me = state.chefs[idx];
  const h = me.h;
  const handed = passedFor(state);
  // Skip food that was passed from the side I'd be standing on.
  const near = tiles => nearest(nav, tiles.filter(t => {
    if (!h && avoid && avoid.has(key(t[0], t[1]))) return false;
    const lock = handed.get(key(t[0], t[1]));
    if (!lock) return true;
    const from = lock.from;
    const r = routeTo(nav, t[0], t[1]);
    return r && key(r.path[r.path.length - 1][0], r.path[r.path.length - 1][1]) !== from &&
      !sameSide(from, r.path[r.path.length - 1], t);
  }));
  const freeCounters = () => tilesOf(state, (ch, x, y) => ch === 'C' && !state.items[key(x, y)]);
  const plateSources = () => tilesOf(state, (ch, x, y) => ch === 'P' && state.stations[key(x, y)].n > 0)
    .concat(itemsWhere(state, (it, ch) => it.k === 'plate' && !it.parts.length && ch === 'C'));
  const doneVessels = () => itemsWhere(state, it => game.vesselDone(it));
  const anyOrderTakes = parts => openRecipes(state).some(r => {
    const left = RECIPES[r].parts.slice();
    return parts.every(p => { const i = left.indexOf(p); if (i < 0) return false; left.splice(i, 1); return true; });
  });

  if (!h) {
    if (me.w) return { wait: true };
    const burnt = itemsWhere(state, it => (it.k === 'pot' || it.k === 'pan') && it.b);
    if (burnt.length) { const b = near(burnt); if (b) return { tile: b.t, act: 'grab' }; }
    // Food a teammate threw that landed on the floor: tidy it up (the held-item rules take it on).
    const dropped = Object.keys(state.floor || {}).map(k => k.split(',').map(Number));
    if (dropped.length) { const f = near(dropped); if (f) return { tile: f.t, act: 'grab' }; }
    // A finished dish sitting on a counter: serve it.
    const ready = itemsWhere(state, it => it.k === 'plate' && it.parts.length && game.matchRecipe(it.parts) && openRecipes(state).includes(game.matchRecipe(it.parts)));
    if (ready.length) { const r = near(ready); if (r) return { tile: r.t, act: 'grab' }; }
    // Cooked food someone ordered is waiting: fetch a plate.
    if (doneVessels().some(([x, y]) => vesselWanted(state, state.items[key(x, y)]))) {
      const p = near(plateSources());
      if (p) return { tile: p.t, act: 'grab' };
    }
    // Keep the boards moving.
    const others = new Set(state.chefs.filter((c, i) => i !== idx && c.w).map(c => key(c.w[0], c.w[1])));
    const toChop = tilesOf(state, (ch, x, y) => ch === 'B' && game.workTarget(state, x, y) && !others.has(key(x, y)));
    if (toChop.length) { const c = near(toChop); if (c) return { tile: c.t, act: 'use' }; }
    // Prepared ingredients lying around that a pot or plate can use.
    // Only pick up food that has somewhere to go right now (else we'd just park it again).
    const usable = itemsWhere(state, it => it.s === 'chopped' && (
      (soupWanted(state, it.k) && vesselsOnStoves(state, 'pot').some(([x, y]) => game.potAccepts(state.items[key(x, y)], it))) ||
      itemsWhere(state, p => p.k === 'plate' && game.plateAccepts(state, p, game.plateToken(it))).length));
    if (usable.length) { const u = near(usable); if (u) return { tile: u.t, act: 'grab' }; }
    // Raw food someone parked on a counter while the boards/pans were busy: pick it back up
    // once there's somewhere to take it (it's counted as in-progress, so nobody else fetches more).
    const freeBoard = tilesOf(state, (ch, x, y) => ch === 'B' && !state.items[key(x, y)]).length > 0;
    const freePan = itemsWhere(state, (it, ch) => ch === 'F' && it.k === 'pan' && !it.parts.length && !it.b).length > 0;
    const parkedRaw = itemsWhere(state, (it, ch) => it.s === 'raw' && (ch === 'C' || CRATES[ch]) && INGREDIENTS[it.k] &&
      ((INGREDIENTS[it.k].chop && freeBoard) || (INGREDIENTS[it.k].pan && freePan)));
    if (parkedRaw.length) { const r = near(parkedRaw); if (r) return { tile: r.t, act: 'grab' }; }
    // A salad/burger part is ready but no plate is out: bring one.
    const short = assemblyShortfall(state);
    const waiting = itemsWhere(state, it => it.s === 'chopped' && short[game.plateToken(it)] > 0);
    if (waiting.length && !platesWithParts(state).some(p => waiting.some(([x, y]) => game.plateAccepts(state, p, game.plateToken(state.items[key(x, y)]))))) {
      const p = near(plateSources());
      if (p) return { tile: p.t, act: 'grab' };
    }
    // Partly built burger/salad on a counter that a bun completes.
    const wantsBun = itemsWhere(state, it => it.k === 'plate' && it.parts.length && game.plateAccepts(state, it, 'bun') && anyOrderTakes(it.parts.concat(['bun'])));
    if (wantsBun.length) { const w = near(wantsBun); if (w) return { tile: w.t, act: 'grab' }; }
    // Dishes: wash when clean plates run low.
    const rack = tilesOf(state, ch => ch === 'P').map(([x, y]) => state.stations[key(x, y)].n).reduce((a, b) => a + b, 0);
    const sinks = tilesOf(state, (ch, x, y) => ch === 'K' && state.stations[key(x, y)].n > 0 && !others.has(key(x, y)));
    if (sinks.length && rack < 2) { const s = near(sinks); if (s) return { tile: s.t, act: 'use' }; }
    const returns = tilesOf(state, (ch, x, y) => ch === 'R' && state.stations[key(x, y)].n > 0);
    if (returns.length && rack < 2) { const r = near(returns); if (r) return { tile: r.t, act: 'grab' }; }
    const kind = nextIngredient(state, idx);
    if (kind) {
      const c = near(crateFor(state, kind));
      if (c) return { tile: c.t, act: 'grab', fetch: kind };
    }
    // Burger orders with a patty ready but no plate yet are handled above; otherwise prep a bun plate.
    if (sinks.length) { const s = near(sinks); if (s) return { tile: s.t, act: 'use' }; }
    if (returns.length) { const r = near(returns); if (r) return { tile: r.t, act: 'grab' }; }
    return null;
  }

  if (h.k === 'dirty') {
    const s = near(tilesOf(state, ch => ch === 'K'));
    return s ? { tile: s.t, act: 'grab' } : null;
  }

  if (h.k === 'pot' || h.k === 'pan') {
    if (h.b || (h.parts.length && !game.vesselDone(h))) {
      if (h.b) { const t = near(tilesOf(state, ch => ch === 'T')); return t ? { tile: t.t, act: 'grab' } : null; }
    }
    if (game.vesselDone(h)) {
      const plates = itemsWhere(state, it => it.k === 'plate' && !it.parts.length);
      const p = near(plates.length ? plates : freeCounters());
      if (p && plates.length) return { tile: p.t, act: 'grab' };
    }
    const stove = h.k === 'pot' ? 'S' : 'F';
    const s = near(tilesOf(state, (ch, x, y) => ch === stove && !state.items[key(x, y)]));
    if (s) return { tile: s.t, act: 'grab' };
    const c = near(freeCounters());
    return c ? { tile: c.t, act: 'grab' } : null;
  }

  if (h.k === 'plate') {
    const recipe = h.parts.length ? game.matchRecipe(h.parts) : null;
    if (recipe && openRecipes(state).includes(recipe)) {
      const w = near(tilesOf(state, ch => ch === 'W'));
      if (w) return { tile: w.t, act: 'grab' };
    }
    if (h.parts.length && !anyOrderTakes(h.parts)) {
      const t = near(tilesOf(state, ch => ch === 'T'));
      if (t) return { tile: t.t, act: 'grab' };
    }
    const vessels = doneVessels().filter(([x, y]) => {
      const v = state.items[key(x, y)];
      const tok = v.k === 'pot' ? 'soup_' + v.parts[0] : 'patty';
      return game.plateAccepts(state, h, tok) && anyOrderTakes(h.parts.concat([tok]));
    });
    if (vessels.length) { const v = near(vessels); if (v) return { tile: v.t, act: 'grab' }; }
    const parts = itemsWhere(state, it => {
      const tok = game.plateToken(it);
      return tok && game.plateAccepts(state, h, tok) && anyOrderTakes(h.parts.concat([tok]));
    });
    if (parts.length) { const p = near(parts); if (p) return { tile: p.t, act: 'grab' }; }
    if (game.plateAccepts(state, h, 'bun') && anyOrderTakes(h.parts.concat(['bun'])) && (h.parts.length || assemblyShortfall(state).patty === undefined || doneVessels().length || vesselsOnStoves(state, 'pan').some(([x, y]) => state.items[key(x, y)].parts.length))) {
      const b = near(crateFor(state, 'bun'));
      if (b) return { tile: b.t, act: 'grab' };
    }
    if (!h.parts.length && !doneVessels().some(([x, y]) => vesselWanted(state, state.items[key(x, y)]))) {
      // Nothing to put on it right now: give it back so someone else can use it.
      const rackT = near(tilesOf(state, ch => ch === 'P'));
      if (rackT) return { tile: rackT.t, act: 'grab' };
    }
    const c = near(freeCounters());
    return c ? { tile: c.t, act: 'grab' } : null;
  }

  // Ingredients.
  const info = INGREDIENTS[h.k] || {};
  if (info.chop && h.s === 'raw') {
    const b = near(tilesOf(state, (ch, x, y) => ch === 'B' && !state.items[key(x, y)]));
    if (b) return { tile: b.t, act: 'grab' };
  }
  if (info.pan && h.s === 'raw') {
    const p = near(itemsWhere(state, (it, ch) => ch === 'F' && game.panAccepts(it, h)));
    if (p) return { tile: p.t, act: 'grab' };
  }
  if (h.s === 'chopped' || !info.chop) {
    const pots = soupWanted(state, h.k) ? itemsWhere(state, (it, ch) => ch === 'S' && game.potAccepts(it, h)) : [];
    if (pots.length) {
      const most = Math.max(...pots.map(([x, y]) => state.items[key(x, y)].parts.length));
      const p = near(pots.filter(([x, y]) => state.items[key(x, y)].parts.length === most));
      if (p) return passOrGo(state, idx, nav, p);
    }
    const tok = game.plateToken(h);
    const plates = itemsWhere(state, it => it.k === 'plate' && game.plateAccepts(state, it, tok) && anyOrderTakes(it.parts.concat([tok])));
    if (tok && plates.length) { const p = near(plates); if (p) return { tile: p.t, act: 'grab' }; }
  }
  // Nobody needs it right now — bin it if no order uses it, otherwise park it on a counter.
  const useful = openRecipes(state).some(r => RECIPES[r].parts.some(p => p === game.plateToken(h) || p === 'soup_' + h.k || (p === 'patty' && h.k === 'meat')));
  if (!useful) { const t = near(tilesOf(state, ch => ch === 'T')); if (t) return { tile: t.t, act: 'grab' }; }
  const c = near(tilesOf(state, (ch, x, y) => ch === 'C' && !state.items[key(x, y)]));
  return c ? { tile: c.t, act: 'grab' } : null;
}

function routeToCell(nav, target) {
  const k = key(target[0], target[1]);
  if (!nav.dist.has(k)) return null;
  const path = [k];
  while (nav.prev.has(path[0])) path.unshift(nav.prev.get(path[0]));
  return { d: nav.dist.get(k), path: path.map(p => p.split(',').map(Number)) };
}

// Cells next to a station (anything but a plain counter) are where people need to stand.
function busyCell(state, x, y) {
  return DIRS.some(([dx, dy]) => {
    const ch = game.tileAt(state, x + dx, y + dy);
    return !game.isWalkable(ch) && ch !== 'C' && ch !== '#';
  });
}

// Nothing to do: get out of the way of the stations and other chefs.
function stepAside(state, cell, nav, idx) {
  const others = new Set(state.chefs.filter((c, i) => i !== idx).map(c => key(Math.floor(c.x), Math.floor(c.y))));
  if (!busyCell(state, cell[0], cell[1]) && !others.has(key(cell[0], cell[1]))) return null;
  let best = null;
  for (const [k, d] of nav.dist) {
    const [x, y] = k.split(',').map(Number);
    if (busyCell(state, x, y) || others.has(k)) continue;
    if (!best || d < best.d) best = { d, cell: [x, y] };
  }
  return best ? { cell: best.cell } : null;
}

exports.createBot = playerIndex => {
  const mem = { stuck: 0, lastX: 0, lastY: 0, wiggle: 0, parked: [] };
  return {
    name: botName(playerIndex, 'zh'),
    playerIndex,
    getMove(state) {
      const me = state.chefs && state.chefs[playerIndex];
      if (!me || state.phase === 'over') return { type: 'input', x: 0, y: 0 };
      if (state.phase !== 'playing') return { type: 'input', x: 0, y: 0 };
      const cell = [Math.floor(me.x), Math.floor(me.y)];
      const open = bfs(state, cell, new Set());
      const avoid = new Set(mem.parked.filter(p => p.until > state.tick).map(p => p.k));
      let plan = decide(state, playerIndex, open, avoid);
      claimsFor(state).set(playerIndex, plan);
      if (plan && plan.wait) return { type: 'input', x: 0, y: 0 };
      if (!plan || !plan.tile) plan = stepAside(state, cell, open, playerIndex);
      if (!plan) return { type: 'input', x: 0, y: 0 };
      // Bots don't route around other chefs: two chefs dodging each other in a corridor pick the
      // same detour forever. Chefs don't collide on the server, so they just squeeze past.
      const route = plan.cell ? routeToCell(open, plan.cell) : routeTo(open, plan.tile[0], plan.tile[1]);
      if (!route) return { type: 'input', x: 0, y: 0 };

      // Unstick: if we have barely moved for a while, sidestep randomly for a few ticks.
      const moved = Math.hypot(me.x - mem.lastX, me.y - mem.lastY);
      mem.lastX = me.x; mem.lastY = me.y;
      if (mem.wiggle > 0) {
        mem.wiggle--;
        return { type: 'input', x: mem.wx, y: mem.wy };
      }

      const goal = route.path[route.path.length - 1];
      let wp = route.path.length > 1 ? route.path[1] : goal;
      // Commit to the waypoint we were heading for until we reach it: re-routing every tick
      // around a teammate who is also re-routing makes both of them dither in place.
      const goalKey = key(goal[0], goal[1]);
      if (mem.wp && mem.goal === goalKey && Math.abs(mem.wp[0] - cell[0]) + Math.abs(mem.wp[1] - cell[1]) <= 1 &&
          Math.hypot(mem.wp[0] + 0.5 - me.x, mem.wp[1] + 0.5 - me.y) > 0.15) {
        wp = mem.wp;
      }
      mem.wp = wp; mem.goal = goalKey;
      const tx = wp[0] + 0.5, ty = wp[1] + 0.5;
      const dx = tx - me.x, dy = ty - me.y, d = Math.hypot(dx, dy);
      const atGoal = route.path.length === 1 && d < 0.2;
      if (atGoal) {
        mem.stuck = 0;
        if (plan.cell) return { type: 'input', x: 0, y: 0 };
        if (me.in) return { type: 'input', x: 0, y: 0 };
        if (plan.pass) passedFor(state).set(key(plan.tile[0], plan.tile[1]), { from: plan.pass, at: state.tick });
        // Remember where we put things down on plain counters so we don't instantly take them back.
        if (me.h && plan.act === 'grab' && game.tileAt(state, plan.tile[0], plan.tile[1]) === 'C' && !state.items[key(plan.tile[0], plan.tile[1])]) {
          mem.parked = mem.parked.filter(p => p.until > state.tick).concat([{ k: key(plan.tile[0], plan.tile[1]), until: state.tick + 45 }]);
        }
        return { type: plan.act, tx: plan.tile[0], ty: plan.tile[1] };
      }
      if (moved < 0.02) mem.stuck++; else mem.stuck = 0;
      if (mem.stuck > 12) {
        mem.stuck = 0;
        mem.wiggle = 4;
        const a = Math.random() * Math.PI * 2;
        mem.wx = Math.cos(a); mem.wy = Math.sin(a);
      }
      const step = game.constants.SPEED * game.constants.TICK_S;
      const mag = d < step ? d / step : 1;
      return { type: 'input', x: dx / d * mag, y: dy / d * mag };
    },
  };
};
