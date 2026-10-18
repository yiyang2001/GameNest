// games/kitchencrew.js — 厨房小分队 / Kitchen Crew
// Cooperative real-time kitchen: 1-4 chefs chop, cook, plate and serve orders against the clock.
//
// Authority model:
//   - Everything except a human chef's own position is server-authoritative: items, stations,
//     cooking, orders, score and the timer all live here and change only in handleMove / tick.
//   - Each browser moves its own chef locally (instant response on phones) and reports the
//     position with {type:'pos'}. The server rejects positions inside walls or too far from the
//     last accepted one and bumps chef.fix so that client snaps back.
//   - Bots have no client, so they send {type:'input', x, y} and tick() integrates their movement.
//   - Interactions ({type:'grab'|'use', tx, ty}) are validated against the chef's position, so two
//     players reaching for the same tomato resolve in message order: the first one gets it.

exports.name = 'kitchencrew';
exports.maxPlayers = 4;
exports.minPlayers = 1;
exports.realtime = true;
exports.tickMs = 66;
// Position reports arrive ~15x/s per player; the next tick broadcasts them anyway.
exports.silentMove = data => !!data && data.type === 'pos';

const TICK_S = exports.tickMs / 1000;
const SPEED = 4.6;          // tiles per second (client walk speed; bots use the same)
const DASH_SPEED = 11;      // client-side dash, only matters for validation slack
const RADIUS = 0.3;         // chef collision radius in tiles
const REACH = 1.45;         // max chef-centre to tile-centre distance for interactions
const CHOP_S = 1.6;
const WASH_S = 1.5;
const COOK_S = 9;           // full pot -> soup
const FRY_S = 6;            // meat in pan -> patty
const BURN_S = 9;           // seconds after done before it burns
const PLATE_RETURN_MS = 6000;
const COUNTDOWN_MS = 3000;
const RESUME_MS = 3000;
const EXPIRE_PENALTY = 10;
const THROW_SPEED = 12;     // tiles per second
const THROW_RANGE = 5;      // tiles before a thrown ingredient drops to the floor
const CATCH_R = 0.5;        // an empty-handed chef this close to a flying ingredient catches it

// Ingredient behaviour. chop: needs a board before it is usable. pot: chopped form goes in a pot.
// pan: raw form fries in a pan. plate: token used on a plate once prepared.
const INGREDIENTS = {
  tomato: { chop: true, pot: true, plate: 'tomato' },
  onion: { chop: true, pot: true },
  mushroom: { chop: true, pot: true },
  lettuce: { chop: true, plate: 'lettuce' },
  bun: { plate: 'bun' },
  meat: { pan: true },
};

const RECIPES = {
  tomato_soup: { parts: ['soup_tomato'], pts: 20, time: 80 },
  onion_soup: { parts: ['soup_onion'], pts: 20, time: 80 },
  mushroom_soup: { parts: ['soup_mushroom'], pts: 20, time: 80 },
  salad: { parts: ['lettuce', 'tomato'], pts: 16, time: 65 },
  burger: { parts: ['bun', 'patty'], pts: 22, time: 75 },
  deluxe_burger: { parts: ['bun', 'patty', 'lettuce'], pts: 32, time: 90 },
};

// Layout legend:
//   .  floor            1-4 chef spawn (floor)    #  wall / decoration
//   C  counter          B  chopping board          S  stove (starts with a pot)
//   F  stove with pan   P  clean plate rack        R  dirty plate return
//   K  sink             W  serving window          T  trash
//   t o m l b n  crates: tomato onion mushroom lettuce bun meat
const CRATES = { t: 'tomato', o: 'onion', m: 'mushroom', l: 'lettuce', b: 'bun', n: 'meat' };

const LEVELS = {
  1: {
    // Open kitchen, soups only — learn chop -> pot -> plate -> serve.
    grid: [
      'CCtCCoCBCBCSSC',
      'C............W',
      'P..1......2..C',
      'C...CCCCCC...C',
      'C...CCCCCC...T',
      'C..3......4..C',
      'C............C',
      'CCCCCCCCCCCCCC',
    ],
    menu: { tomato_soup: 1, onion_soup: 1 },
    plates: 4,
    dirty: false,
    orderEvery: 22,
    maxOrders: 4,
    stars: [40, 110, 190],
  },
  2: {
    // A counter wall splits prep (left) from cooking/serving (right). Pass food over the
    // divider; solo cooks can still walk around through the gap at the bottom.
    grid: [
      'CCtClCCCCSSCCC',
      'B...1.C..2...W',
      'C.....C......C',
      'B.....C......P',
      'C.....C......C',
      'T..3.......4.C',
      'C............C',
      'CCCCCCCCCCCCCC',
    ],
    menu: { tomato_soup: 2, salad: 2 },
    plates: 4,
    dirty: false,
    orderEvery: 20,
    maxOrders: 4,
    stars: [40, 100, 170],
  },
  3: {
    // Burger bar: fry patties, assemble, and keep the plates washed.
    grid: [
      'CCbCnClCtCCFFCC',
      'C.............W',
      'B..1.......2..C',
      'C....CCCCC....R',
      'B....CCCCC....K',
      'C..3.......4..C',
      'T.............P',
      'CCCCCCCCCCCCCCC',
    ],
    menu: { burger: 2, deluxe_burger: 1, salad: 1 },
    plates: 3,
    dirty: true,
    orderEvery: 21,
    maxOrders: 4,
    stars: [45, 125, 210],
  },
};
exports.LEVELS = LEVELS;
exports.RECIPES = RECIPES;
exports.INGREDIENTS = INGREDIENTS;
exports.CRATES = CRATES;
exports.constants = { SPEED, RADIUS, REACH, CHOP_S, WASH_S, COOK_S, FRY_S, BURN_S, TICK_S, THROW_SPEED, THROW_RANGE };

// Clock is injectable so tests can drive position validation deterministically.
let clock = () => Date.now();
exports._setClock = fn => { clock = fn || (() => Date.now()); };

const key = (x, y) => x + ',' + y;

exports.createState = () => ({
  realtime: true,
  phase: 'countdown',
  level: 1,
  grid: [],
  w: 0,
  h: 0,
  menu: [],
  items: {},
  floor: {},    // floor cell -> ingredient that was thrown and didn't land anywhere
  flying: [],   // thrown ingredients in the air
  flySeq: 0,
  stations: {},
  chefs: [],
  orders: [],
  score: 0,
  delivered: 0,
  failed: 0,
  streak: 0,
  timeLeft: 0,
  duration: 0,
  countdown: COUNTDOWN_MS,
  nextOrder: 0,
  orderSeq: 0,
  returns: [],
  fx: [],
  fxSeq: 0,
  stars: 0,
  thresholds: [0, 0, 0],
  winner: null,
  paused: null, // seat index of whoever paused, or null
  tick: 0,
});

function tileAt(state, x, y) {
  if (y < 0 || y >= state.h || x < 0 || x >= state.w) return '#';
  return state.grid[y][x];
}
exports.tileAt = tileAt;

function isWalkable(ch) {
  return ch === '.' || (ch >= '1' && ch <= '4');
}
exports.isWalkable = isWalkable;

// Surfaces hold one item: counters, boards, stoves, crates.
function isSurface(ch) {
  return ch === 'C' || ch === 'B' || ch === 'S' || ch === 'F' || !!CRATES[ch];
}

// Does a chef-sized circle at (x, y) overlap any solid tile?
function collides(state, x, y, r) {
  const rad = r == null ? RADIUS : r;
  if (x - rad < 0 || y - rad < 0 || x + rad > state.w || y + rad > state.h) return true;
  for (let ty = Math.floor(y - rad); ty <= Math.floor(y + rad); ty++) {
    for (let tx = Math.floor(x - rad); tx <= Math.floor(x + rad); tx++) {
      if (isWalkable(tileAt(state, tx, ty))) continue;
      const cx = Math.max(tx, Math.min(x, tx + 1));
      const cy = Math.max(ty, Math.min(y, ty + 1));
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < rad * rad - 1e-6) return true;
    }
  }
  return false;
}
exports.collides = collides;

// Axis-separated move with wall sliding. Mirrors the client's movement code.
function stepMove(state, chef, vx, vy, dt) {
  const nx = chef.x + vx * dt;
  if (!collides(state, nx, chef.y)) chef.x = nx;
  const ny = chef.y + vy * dt;
  if (!collides(state, chef.x, ny)) chef.y = ny;
}
exports.stepMove = stepMove;

function canReach(chef, tx, ty) {
  const dx = chef.x - (tx + 0.5), dy = chef.y - (ty + 0.5);
  return dx * dx + dy * dy <= REACH * REACH;
}
exports.canReach = canReach;

function pushFx(state, kind, x, y, extra) {
  state.fxSeq++;
  const fx = { id: state.fxSeq, k: kind, x, y, at: state.tick };
  if (extra) Object.assign(fx, extra);
  state.fx.push(fx);
  if (state.fx.length > 24) state.fx.splice(0, state.fx.length - 24);
}

// ---- items ----

function newIngredient(kind) {
  return { k: kind, s: 'raw' };
}

function isIngredient(item) {
  return !!item && !!INGREDIENTS[item.k];
}

// Plate token an item contributes, or null if it can't go on a plate as-is.
function plateToken(item) {
  if (!isIngredient(item)) return null;
  const info = INGREDIENTS[item.k];
  if (!info.plate) return null;
  if (info.chop && item.s !== 'chopped') return null;
  return info.plate;
}

function multisetWithin(parts, recipeParts) {
  const left = recipeParts.slice();
  for (const p of parts) {
    const i = left.indexOf(p);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

function plateAccepts(state, plate, token) {
  if (!plate || plate.k !== 'plate' || !token) return false;
  const next = plate.parts.concat([token]);
  return state.menu.some(id => multisetWithin(next, RECIPES[id].parts));
}
exports.plateAccepts = plateAccepts;

function matchRecipe(parts) {
  for (const id of Object.keys(RECIPES)) {
    const r = RECIPES[id].parts;
    if (r.length === parts.length && multisetWithin(parts, r)) return id;
  }
  return null;
}
exports.matchRecipe = matchRecipe;

function vesselDone(v) {
  if (!v || v.b) return false;
  if (v.k === 'pot') return v.parts.length === 3 && v.p >= COOK_S;
  if (v.k === 'pan') return v.parts.length === 1 && v.p >= FRY_S;
  return false;
}
exports.vesselDone = vesselDone;

function vesselToken(v) {
  if (!vesselDone(v)) return null;
  return v.k === 'pot' ? 'soup_' + v.parts[0] : 'patty';
}

function emptyVessel(v) {
  v.parts = [];
  v.p = 0;
  v.b = false;
}

function potAccepts(pot, item) {
  if (!pot || pot.k !== 'pot' || pot.b || pot.parts.length >= 3) return false;
  if (!isIngredient(item) || !INGREDIENTS[item.k].pot || item.s !== 'chopped') return false;
  return pot.parts.length === 0 || pot.parts[0] === item.k;
}

function panAccepts(pan, item) {
  return !!pan && pan.k === 'pan' && !pan.b && pan.parts.length === 0 &&
    isIngredient(item) && INGREDIENTS[item.k].pan && item.s === 'raw';
}

// Try to merge the held item `a` with the surface item `b`.
// Returns { held, surface } describing what remains in hand / on the tile, or null.
function combine(state, a, b) {
  // ingredient into a vessel (either direction)
  if (potAccepts(b, a)) { b.parts.push(a.k); b.p = 0; return { held: null, surface: b }; }
  if (potAccepts(a, b)) { a.parts.push(b.k); a.p = 0; return { held: a, surface: null }; }
  if (panAccepts(b, a)) { b.parts.push(a.k); b.p = 0; return { held: null, surface: b }; }
  if (panAccepts(a, b)) { a.parts.push(b.k); a.p = 0; return { held: a, surface: null }; }
  // finished vessel onto a plate (either direction)
  if (a && a.k === 'plate' && plateAccepts(state, a, vesselToken(b))) {
    a.parts.push(vesselToken(b)); emptyVessel(b); return { held: a, surface: b };
  }
  if (b && b.k === 'plate' && plateAccepts(state, b, vesselToken(a))) {
    b.parts.push(vesselToken(a)); emptyVessel(a); return { held: a, surface: b };
  }
  // prepared ingredient onto a plate (either direction)
  if (a && a.k === 'plate' && plateAccepts(state, a, plateToken(b))) {
    a.parts.push(plateToken(b)); return { held: a, surface: null };
  }
  if (b && b.k === 'plate' && plateAccepts(state, b, plateToken(a))) {
    b.parts.push(plateToken(a)); return { held: null, surface: b };
  }
  // two plates: pour a plate's food onto an empty plate
  if (a && b && a.k === 'plate' && b.k === 'plate') {
    if (!a.parts.length && b.parts.length) { a.parts = b.parts; b.parts = []; return { held: a, surface: b }; }
    if (a.parts.length && !b.parts.length) { b.parts = a.parts; a.parts = []; return { held: a, surface: b }; }
  }
  return null;
}
exports.combine = combine;

function canPlace(ch, item) {
  if (ch === 'S' || ch === 'F') return item.k === 'pot' || item.k === 'pan';
  if (ch === 'B') return isIngredient(item);
  return ch === 'C' || !!CRATES[ch];
}

// ---- interaction ----

function serve(state, chef, tx, ty) {
  const plate = chef.h;
  if (!plate || plate.k !== 'plate' || !plate.parts.length) return;
  const recipe = matchRecipe(plate.parts);
  // Most urgent order of that recipe.
  let best = -1;
  state.orders.forEach((o, i) => {
    if (o.r === recipe && (best < 0 || o.t < state.orders[best].t)) best = i;
  });
  if (best < 0) {
    pushFx(state, 'wrong', tx, ty);
    return;
  }
  const order = state.orders[best];
  // Serving the oldest ticket keeps a tip streak going, like a real pass.
  state.streak = best === 0 ? Math.min(state.streak + 1, 4) : 1;
  const base = RECIPES[recipe].pts;
  const tip = Math.round(base * 0.4 * (order.t / order.T)) * state.streak;
  const pts = base + tip;
  state.score += pts;
  state.delivered++;
  state.orders.splice(best, 1);
  chef.h = null;
  state.returns.push({ t: PLATE_RETURN_MS });
  pushFx(state, 'serve', tx, ty, { pts, tip, r: recipe });
  if (!state.orders.length) state.nextOrder = Math.min(state.nextOrder, 1500);
}

function interact(state, chef, tx, ty) {
  const ch = tileAt(state, tx, ty);
  const k = key(tx, ty);
  const held = chef.h;
  const onTile = state.items[k] || null;

  if (ch === 'W') return serve(state, chef, tx, ty);

  // Food that was thrown and fell on the floor: pick it up (you can't put things down there).
  if (isWalkable(ch)) {
    const dropped = state.floor[k];
    if (dropped && !held) { delete state.floor[k]; chef.h = dropped; }
    return;
  }

  if (ch === 'T') {
    if (!held) return;
    if (held.k === 'pot' || held.k === 'pan') { if (held.parts.length) { emptyVessel(held); pushFx(state, 'trash', tx, ty); } return; }
    if (held.k === 'plate') { if (held.parts.length) { held.parts = []; pushFx(state, 'trash', tx, ty); } return; }
    if (isIngredient(held)) { chef.h = null; pushFx(state, 'trash', tx, ty); }
    return;
  }

  if (ch === 'P') {
    const st = state.stations[k];
    if (!held && st.n > 0) { st.n--; chef.h = { k: 'plate', parts: [] }; return; }
    if (held && held.k === 'plate' && !held.parts.length) { st.n++; chef.h = null; }
    return;
  }

  if (ch === 'R') {
    const st = state.stations[k];
    if (!held && st.n > 0) { chef.h = { k: 'dirty', n: st.n }; st.n = 0; return; }
    if (held && held.k === 'dirty') { st.n += held.n; chef.h = null; }
    return;
  }

  if (ch === 'K') {
    const st = state.stations[k];
    if (held && held.k === 'dirty') { st.n += held.n; chef.h = null; pushFx(state, 'splash', tx, ty); }
    return;
  }

  if (!isSurface(ch)) return;

  if (!held) {
    if (onTile) {
      delete state.items[k];
      chef.h = onTile;
      return;
    }
    if (CRATES[ch]) chef.h = newIngredient(CRATES[ch]);
    return;
  }

  if (!onTile) {
    // Holding a plate at a bun crate: drop a bun straight on it.
    if (CRATES[ch] && held.k === 'plate') {
      const token = plateToken(newIngredient(CRATES[ch]));
      if (plateAccepts(state, held, token)) held.parts.push(token);
      return;
    }
    if (canPlace(ch, held)) {
      state.items[k] = held;
      chef.h = null;
    }
    return;
  }

  const res = combine(state, held, onTile);
  if (!res) return;
  chef.h = res.held;
  if (res.surface) state.items[k] = res.surface;
  else delete state.items[k];
}

// ---- throwing ----

// Advance one thrown ingredient. Returns true once it has been caught or has come to rest.
function stepFlight(state, f, dt) {
  const total = Math.min(THROW_SPEED * dt, THROW_RANGE - f.d);
  const n = Math.max(1, Math.ceil(total / 0.2));
  for (let s = 0; s < n; s++) {
    const step = total / n;
    const nx = f.x + f.dx * step, ny = f.y + f.dy * step;
    const tx = Math.floor(nx), ty = Math.floor(ny);
    // Hitting a counter comes first: nobody catches across one.
    if (!isWalkable(tileAt(state, tx, ty))) {
      landFlight(state, f, tx, ty);
      return true;
    }
    // An empty-handed teammate in the way catches it (the thrower can't catch their own throw).
    for (let i = 0; i < state.chefs.length; i++) {
      const c = state.chefs[i];
      if (i === f.by || c.h || Math.hypot(c.x - nx, c.y - ny) > CATCH_R) continue;
      c.h = f.item;
      c.w = null;
      pushFx(state, 'catch', tx, ty, { by: i });
      return true;
    }
    f.x = nx; f.y = ny; f.d += step;
  }
  if (f.d >= THROW_RANGE - 1e-6) {
    dropToFloor(state, f.item, Math.floor(f.x), Math.floor(f.y));
    return true;
  }
  return false;
}

// It hit tile (tx, ty): land there if that tile can take it, otherwise bounce onto the floor.
function landFlight(state, f, tx, ty) {
  const ch = tileAt(state, tx, ty), k = key(tx, ty), it = f.item, on = state.items[k];
  if (ch === 'T') { pushFx(state, 'trash', tx, ty); return; }
  if (isSurface(ch)) {
    if (!on && canPlace(ch, it)) { state.items[k] = it; pushFx(state, 'land', tx, ty); return; }
    if (on && (potAccepts(on, it) || panAccepts(on, it))) { on.parts.push(it.k); on.p = 0; pushFx(state, 'land', tx, ty); return; }
    if (on && on.k === 'plate' && plateAccepts(state, on, plateToken(it))) { on.parts.push(plateToken(it)); pushFx(state, 'land', tx, ty); return; }
  }
  dropToFloor(state, it, Math.floor(f.x), Math.floor(f.y));
}

// Put an ingredient on the nearest free floor cell around (x, y). Lost if the area is packed.
function dropToFloor(state, item, x, y) {
  for (let r = 0; r <= 2; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cx = x + dx, cy = y + dy, k = key(cx, cy);
      if (!isWalkable(tileAt(state, cx, cy)) || state.floor[k]) continue;
      state.floor[k] = item;
      pushFx(state, 'splat', cx, cy);
      return;
    }
  }
  pushFx(state, 'trash', x, y);
}

function workTarget(state, tx, ty) {
  const ch = tileAt(state, tx, ty);
  if (ch === 'B') {
    const item = state.items[key(tx, ty)];
    return !!item && isIngredient(item) && INGREDIENTS[item.k].chop && item.s === 'raw';
  }
  if (ch === 'K') return state.stations[key(tx, ty)].n > 0;
  return false;
}

// ---- lifecycle ----

function chooseLevel(options) {
  const lv = options && options.level;
  return LEVELS[lv] ? Number(lv) : 1;
}

function scaleFor(count) {
  // Throughput grows sub-linearly with more cooks in the same kitchen.
  return { 1: 0.6, 2: 1, 3: 1.25, 4: 1.45 }[count] || 1;
}

function pickRecipe(state) {
  const entries = Object.keys(state.menuWeights);
  let total = 0;
  entries.forEach(id => { total += state.menuWeights[id]; });
  let roll = Math.random() * total;
  for (const id of entries) {
    roll -= state.menuWeights[id];
    if (roll <= 0) return id;
  }
  return entries[0];
}

function spawnOrder(state) {
  const r = pickRecipe(state);
  const T = Math.round(RECIPES[r].time * state.orderTimeScale * 1000);
  state.orderSeq++;
  state.orders.push({ id: state.orderSeq, r, t: T, T });
  pushFx(state, 'order', 0, 0, { r, oid: state.orderSeq });
}

exports.initGame = (state, playerCount) => {
  const opts = state._options || {};
  const levelId = chooseLevel(opts);
  const L = LEVELS[levelId];
  const count = Math.max(1, Math.min(4, playerCount || 1));
  state.level = levelId;
  state.grid = L.grid.slice();
  state.h = L.grid.length;
  state.w = L.grid[0].length;
  state.menuWeights = Object.assign({}, L.menu);
  state.menu = Object.keys(L.menu);
  state.dirtyPlates = !!L.dirty;
  state.items = {};
  state.floor = {};
  state.flying = [];
  state.flySeq = 0;
  state.stations = {};
  const spawns = [];
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      const ch = state.grid[y][x];
      if (ch === 'S') state.items[key(x, y)] = { k: 'pot', parts: [], p: 0, b: false };
      if (ch === 'F') state.items[key(x, y)] = { k: 'pan', parts: [], p: 0, b: false };
      if (ch === 'P') state.stations[key(x, y)] = { n: L.plates };
      if (ch === 'R') state.stations[key(x, y)] = { n: 0 };
      if (ch === 'K') state.stations[key(x, y)] = { n: 0, p: 0 };
      if (ch >= '1' && ch <= '4') spawns[Number(ch) - 1] = { x: x + 0.5, y: y + 0.5 };
    }
  }
  const now = clock();
  state.chefs = [];
  for (let i = 0; i < count; i++) {
    const sp = spawns[i] || spawns[0];
    state.chefs.push({ x: sp.x, y: sp.y, fx: 0, fy: 1, h: null, w: null, fix: 0, last: now, in: null });
  }
  const minutes = [1, 2, 3, 4].indexOf(Number(opts.minutes)) >= 0 ? Number(opts.minutes) : 3;
  state.duration = minutes * 60000;
  state.timeLeft = state.duration;
  state.countdown = COUNTDOWN_MS;
  state.phase = 'countdown';
  state.orders = [];
  state.orderSeq = 0;
  state.orderTimeScale = count === 1 ? 1.35 : 1;
  state.orderEvery = L.orderEvery * 1000 * (count === 1 ? 1.4 : count >= 3 ? 0.85 : 1);
  state.maxOrders = L.maxOrders + (count >= 4 ? 1 : 0);
  state.score = 0;
  state.delivered = 0;
  state.failed = 0;
  state.streak = 0;
  state.returns = [];
  state.fx = [];
  state.fxSeq = 0;
  state.tick = 0;
  state.stars = 0;
  const scale = scaleFor(count) * (minutes / 3);
  state.thresholds = L.stars.map(s => Math.round(s * scale / 5) * 5);
  state.winner = null;
  state.realtime = true;
  state.paused = null;
  spawnOrder(state);
  spawnOrder(state);
  state.nextOrder = state.orderEvery * 0.6;
};

exports.handleMove = (data, state, playerIndex) => {
  if (!data || typeof data !== 'object') return 'kc_bad_move';
  const chef = state.chefs && state.chefs[playerIndex];
  if (!chef) return 'kc_no_chef';
  if (state.phase === 'over') return null; // late packets after the whistle are harmless

  const type = data.type;

  // Pause is shared: the kitchen clock stops for everyone. Any chef may pause or resume (it's a
  // co-op party game); resuming runs a short countdown so nobody is caught mid-step.
  if (type === 'pause') {
    if (data.on) {
      if (state.paused === null) {
        state.paused = playerIndex;
        pushFx(state, 'pause', 0, 0, { by: playerIndex });
      }
    } else if (state.paused !== null) {
      state.paused = null;
      if (state.phase === 'playing') { state.phase = 'countdown'; state.countdown = RESUME_MS; }
      pushFx(state, 'resume', 0, 0, { by: playerIndex });
    }
    return null;
  }
  if (state.paused !== null && (type === 'pos' || type === 'grab' || type === 'use' || type === 'input' || type === 'throw')) return null;

  // Throw the held ingredient the way the chef faces; the server flies it (see stepFlight).
  if (type === 'throw') {
    if (data.x !== undefined) acceptPosition(state, chef, data);
    if (state.phase !== 'playing' || !isIngredient(chef.h)) return null;
    const l = Math.hypot(chef.fx, chef.fy) || 1;
    state.flySeq++;
    state.flying.push({ id: state.flySeq, item: chef.h, x: chef.x, y: chef.y, dx: chef.fx / l, dy: chef.fy / l, d: 0, by: playerIndex });
    chef.h = null;
    chef.w = null;
    pushFx(state, 'throw', Math.floor(chef.x), Math.floor(chef.y), { by: playerIndex });
    return null;
  }

  if (type === 'pos' || type === 'grab' || type === 'use') {
    if (data.x !== undefined) acceptPosition(state, chef, data);
    if (type === 'pos') return null;
    if (state.phase !== 'playing') return null;
    const tx = data.tx, ty = data.ty;
    if (!Number.isInteger(tx) || !Number.isInteger(ty)) return 'kc_bad_move';
    if (!canReach(chef, tx, ty)) return null; // out of reach after correction — just a miss
    if (type === 'grab') {
      chef.w = null;
      interact(state, chef, tx, ty);
    } else if (!chef.h && workTarget(state, tx, ty)) {
      chef.w = [tx, ty];
    }
    return null;
  }

  if (type === 'input') {
    const x = Number(data.x) || 0, y = Number(data.y) || 0;
    const len = Math.hypot(x, y);
    chef.in = len > 0.01 ? { x: x / Math.max(1, len), y: y / Math.max(1, len) } : null;
    return null;
  }

  return 'kc_bad_move';
};

function acceptPosition(state, chef, data) {
  const x = Number(data.x), y = Number(data.y);
  const now = clock();
  const elapsed = Math.max(0, (now - (chef.last || now)) / 1000);
  // Generous speed slack: phone Wi-Fi often delivers reports in bursts, and a rejected report
  // snaps the player back (rubber-banding). Walls are enforced along the whole path instead.
  const maxDist = Math.min(elapsed, 1) * DASH_SPEED * 1.3 + 1.2;
  const ok = Number.isFinite(x) && Number.isFinite(y) &&
    Math.hypot(x - chef.x, y - chef.y) <= maxDist &&
    clearPath(state, chef.x, chef.y, x, y);
  if (!ok) {
    chef.fix++;
    chef.last = now;
    return;
  }
  chef.x = x;
  chef.y = y;
  chef.last = now;
  const fx = Number(data.fx), fy = Number(data.fy);
  if (Number.isFinite(fx) && Number.isFinite(fy) && (fx || fy)) {
    const l = Math.hypot(fx, fy);
    chef.fx = fx / l;
    chef.fy = fy / l;
  }
  if (chef.w && !canReach(chef, chef.w[0], chef.w[1])) chef.w = null;
}

// No wall between two positions (sampled every 0.15 tiles, slightly smaller radius for float slack).
function clearPath(state, x0, y0, x1, y1) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.15));
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    if (collides(state, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, RADIUS - 0.04)) return false;
  }
  return true;
}

function finish(state) {
  state.phase = 'over';
  state.timeLeft = 0;
  state.stars = state.thresholds.filter(t => state.score >= t).length;
  state.winner = state.stars > 0 ? -2 : -3;
  pushFx(state, 'over', 0, 0, { stars: state.stars });
}

exports.tick = state => {
  if (state.phase === 'over' || state.winner !== null) return false;
  if (state.paused !== null && state.paused !== undefined) return true; // everything frozen
  const ms = exports.tickMs;
  const dt = TICK_S;

  // Bot movement (humans report positions themselves).
  for (const chef of state.chefs) {
    if (!chef.in) continue;
    stepMove(state, chef, chef.in.x * SPEED, chef.in.y * SPEED, dt);
    chef.fx = chef.in.x; chef.fy = chef.in.y;
    chef.last = clock();
    if (chef.w && !canReach(chef, chef.w[0], chef.w[1])) chef.w = null;
  }

  if (state.phase === 'countdown') {
    state.countdown -= ms;
    if (state.countdown <= 0) { state.countdown = 0; state.phase = 'playing'; pushFx(state, 'go', 0, 0); }
    state.tick++;
    return true;
  }

  state.timeLeft -= ms;

  // Thrown ingredients.
  for (let i = state.flying.length - 1; i >= 0; i--) {
    if (stepFlight(state, state.flying[i], dt)) state.flying.splice(i, 1);
  }

  // Chopping and washing.
  for (const chef of state.chefs) {
    if (!chef.w) continue;
    const [tx, ty] = chef.w;
    if (chef.h || !canReach(chef, tx, ty) || !workTarget(state, tx, ty)) { chef.w = null; continue; }
    const k = key(tx, ty);
    if (tileAt(state, tx, ty) === 'B') {
      const item = state.items[k];
      item.c = (item.c || 0) + dt / CHOP_S;
      if (item.c >= 1) {
        item.s = 'chopped';
        delete item.c;
        chef.w = null;
        pushFx(state, 'chop', tx, ty);
      }
    } else {
      const st = state.stations[k];
      st.p += dt / WASH_S;
      if (st.p >= 1) {
        st.p = 0;
        st.n--;
        const rack = Object.keys(state.stations).find(sk => {
          const [sx, sy] = sk.split(',').map(Number);
          return tileAt(state, sx, sy) === 'P';
        });
        if (rack) state.stations[rack].n++;
        pushFx(state, 'washed', tx, ty);
        if (st.n <= 0) chef.w = null;
      }
    }
  }

  // Cooking on stoves.
  for (const k of Object.keys(state.items)) {
    const [x, y] = k.split(',').map(Number);
    const ch = tileAt(state, x, y);
    if (ch !== 'S' && ch !== 'F') continue;
    const v = state.items[k];
    if (!v || v.b) continue;
    const need = v.k === 'pot' ? 3 : v.k === 'pan' ? 1 : 0;
    if (!need || v.parts.length < need) continue;
    const doneAt = v.k === 'pot' ? COOK_S : FRY_S;
    const before = v.p;
    v.p += dt;
    if (before < doneAt && v.p >= doneAt) pushFx(state, 'cooked', x, y);
    if (v.p >= doneAt + BURN_S) {
      v.b = true;
      pushFx(state, 'burnt', x, y);
    }
  }

  // Orders.
  for (let i = state.orders.length - 1; i >= 0; i--) {
    const o = state.orders[i];
    o.t -= ms;
    if (o.t <= 0) {
      state.orders.splice(i, 1);
      state.failed++;
      state.streak = 0;
      state.score = Math.max(0, state.score - EXPIRE_PENALTY);
      pushFx(state, 'expire', 0, 0, { r: o.r, pts: -EXPIRE_PENALTY });
    }
  }
  state.nextOrder -= ms;
  if (state.nextOrder <= 0) {
    if (state.orders.length < state.maxOrders) spawnOrder(state);
    state.nextOrder = state.orderEvery;
  }
  if (!state.orders.length && state.nextOrder > 2000) state.nextOrder = 2000;

  // Served plates come back after a while.
  for (let i = state.returns.length - 1; i >= 0; i--) {
    state.returns[i].t -= ms;
    if (state.returns[i].t > 0) continue;
    state.returns.splice(i, 1);
    const want = state.dirtyPlates ? 'R' : 'P';
    const sk = Object.keys(state.stations).find(s => {
      const [sx, sy] = s.split(',').map(Number);
      return tileAt(state, sx, sy) === want;
    });
    if (sk) state.stations[sk].n++;
  }

  state.tick++;
  if (state.timeLeft <= 0) finish(state);
  return true;
};

// Used by bots and tests.
exports.key = key;
exports.workTarget = workTarget;
exports.plateToken = plateToken;
exports.potAccepts = potAccepts;
exports.panAccepts = panAccepts;
exports.isSurface = isSurface;
