const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../games/kitchencrew');

function start(players, options) {
  const s = game.createState();
  s._options = options || {};
  game.initGame(s, players);
  return s;
}

// Run ticks until the countdown is over.
function go(s) {
  while (s.phase === 'countdown') game.tick(s);
  return s;
}

function ticks(s, seconds) {
  const n = Math.ceil(seconds * 1000 / game.tickMs);
  for (let i = 0; i < n; i++) game.tick(s);
}

// Stand chef i on a floor cell next to tile (tx, ty), facing it.
function standAt(s, i, tx, ty) {
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    if (game.isWalkable(game.tileAt(s, tx + dx, ty + dy))) {
      Object.assign(s.chefs[i], { x: tx + dx + 0.5, y: ty + dy + 0.5, fx: -dx, fy: -dy });
      return;
    }
  }
  throw new Error('no floor next to ' + tx + ',' + ty);
}

function find(s, ch) {
  const out = [];
  s.grid.forEach((row, y) => [...row].forEach((c, x) => { if (c === ch) out.push([x, y]); }));
  return out;
}

function grab(s, i, [tx, ty]) {
  standAt(s, i, tx, ty);
  assert.equal(game.handleMove({ type: 'grab', tx, ty }, s, i), null);
}

function chop(s, i, [tx, ty]) {
  standAt(s, i, tx, ty);
  assert.equal(game.handleMove({ type: 'use', tx, ty }, s, i), null);
  ticks(s, game.constants.CHOP_S + 0.2);
}

function choppedInto(s, crateCh, board, dest) {
  grab(s, 0, find(s, crateCh)[0]);
  grab(s, 0, board);
  chop(s, 0, board);
  grab(s, 0, board);
  grab(s, 0, dest);
}

test('kitchencrew: init builds stations, chefs and opening orders', () => {
  const s = start(3);
  assert.equal(s.chefs.length, 3);
  assert.equal(s.phase, 'countdown');
  assert.equal(s.orders.length, 2);
  assert.equal(s.winner, null);
  for (const [x, y] of find(s, 'S')) assert.equal(s.items[x + ',' + y].k, 'pot');
  const [px, py] = find(s, 'P')[0];
  assert.equal(s.stations[px + ',' + py].n, game.LEVELS[1].plates);
  s.chefs.forEach(c => assert.equal(game.collides(s, c.x, c.y), false));
  assert.ok(s.thresholds[0] < s.thresholds[1] && s.thresholds[1] < s.thresholds[2]);
});

test('kitchencrew: every level is rectangular, enclosed and reachable', () => {
  for (const id of Object.keys(game.LEVELS)) {
    const s = start(4, { level: id });
    assert.ok(s.grid.every(r => r.length === s.w), 'level ' + id + ' rows differ in width');
    // Flood fill from spawn 1 must reach every chef spawn and a cell next to every station.
    const seen = new Set();
    const q = [[Math.floor(s.chefs[0].x), Math.floor(s.chefs[0].y)]];
    while (q.length) {
      const [x, y] = q.pop();
      const k = x + ',' + y;
      if (seen.has(k) || !game.isWalkable(game.tileAt(s, x, y))) continue;
      seen.add(k);
      q.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    s.chefs.forEach(c => assert.ok(seen.has(Math.floor(c.x) + ',' + Math.floor(c.y)), 'level ' + id + ' spawn unreachable'));
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const ch = s.grid[y][x];
      if (game.isWalkable(ch) || ch === 'C' || ch === '#') continue;
      const ok = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has((x + dx) + ',' + (y + dy)));
      assert.ok(ok, 'level ' + id + ' station ' + ch + ' at ' + x + ',' + y + ' unreachable');
    }
    // Every menu recipe can be made from the crates in this kitchen.
    const crates = new Set(s.grid.join('').split('').filter(c => game.CRATES[c]).map(c => game.CRATES[c]));
    for (const r of s.menu) {
      for (const part of game.RECIPES[r].parts) {
        const need = part.startsWith('soup_') ? part.slice(5) : part === 'patty' ? 'meat' : part;
        assert.ok(crates.has(need), 'level ' + id + ' recipe ' + r + ' needs ' + need);
      }
    }
  }
});

test('kitchencrew: interactions wait for the countdown', () => {
  const s = start(1);
  grab(s, 0, find(s, 't')[0]);
  assert.equal(s.chefs[0].h, null);
  go(s);
  grab(s, 0, find(s, 't')[0]);
  assert.deepEqual(s.chefs[0].h, { k: 'tomato', s: 'raw' });
});

test('kitchencrew: tomato soup from crate to serving window scores', () => {
  const s = go(start(2));
  s.orders = [{ id: 99, r: 'tomato_soup', t: 60000, T: 60000 }];
  const board = find(s, 'B')[0];
  const stove = find(s, 'S')[0];
  for (let i = 0; i < 3; i++) choppedInto(s, 't', board, stove);
  const pot = s.items[stove.join(',')];
  assert.deepEqual(pot.parts, ['tomato', 'tomato', 'tomato']);
  // Raw tomatoes are refused by the pot.
  grab(s, 0, find(s, 't')[0]);
  grab(s, 0, stove);
  assert.equal(s.chefs[0].h.k, 'tomato');
  grab(s, 0, find(s, 'T')[0]);
  assert.equal(s.chefs[0].h, null);

  ticks(s, game.constants.COOK_S + 0.2);
  assert.ok(game.vesselDone(pot));
  grab(s, 0, find(s, 'P')[0]);
  assert.equal(s.chefs[0].h.k, 'plate');
  grab(s, 0, stove);
  assert.deepEqual(s.chefs[0].h.parts, ['soup_tomato']);
  assert.equal(pot.parts.length, 0);
  const before = s.score;
  grab(s, 0, find(s, 'W')[0]);
  assert.equal(s.chefs[0].h, null);
  assert.ok(!s.orders.some(o => o.id === 99), 'the soup order is fulfilled');
  assert.equal(s.delivered, 1);
  assert.ok(s.score > before + 20, 'base points plus a tip for a fresh order');
  assert.ok(s.fx.some(f => f.k === 'serve'));
  // The plate comes back to the rack.
  const rack = find(s, 'P')[0].join(',');
  const plates = s.stations[rack].n;
  ticks(s, 7);
  assert.equal(s.stations[rack].n, plates + 1);
});

test('kitchencrew: a dish nobody ordered is refused at the window', () => {
  const s = go(start(1));
  s.orders = [{ id: 1, r: 'onion_soup', t: 60000, T: 60000 }];
  s.chefs[0].h = { k: 'plate', parts: ['soup_tomato'] };
  grab(s, 0, find(s, 'W')[0]);
  assert.deepEqual(s.chefs[0].h, { k: 'plate', parts: ['soup_tomato'] });
  assert.equal(s.score, 0);
  assert.ok(s.fx.some(f => f.k === 'wrong'));
});

test('kitchencrew: pots only take one kind of chopped vegetable', () => {
  const s = go(start(1));
  const stove = find(s, 'S')[0];
  s.items[stove.join(',')].parts = ['tomato'];
  s.chefs[0].h = { k: 'onion', s: 'chopped' };
  grab(s, 0, stove);
  assert.equal(s.chefs[0].h.k, 'onion');
  s.chefs[0].h = { k: 'tomato', s: 'chopped' };
  grab(s, 0, stove);
  assert.equal(s.chefs[0].h, null);
});

test('kitchencrew: soup burns if left on the stove and must be binned', () => {
  const s = go(start(1));
  const stove = find(s, 'S')[0];
  const pot = s.items[stove.join(',')];
  pot.parts = ['onion', 'onion', 'onion'];
  ticks(s, game.constants.COOK_S + game.constants.BURN_S + 0.3);
  assert.equal(pot.b, true);
  assert.ok(s.fx.some(f => f.k === 'burnt'));
  grab(s, 0, find(s, 'P')[0]);
  grab(s, 0, stove);
  assert.deepEqual(s.chefs[0].h.parts, [], 'burnt soup cannot be plated');
  grab(s, 0, find(s, 'P')[0]); // put the plate back
  grab(s, 0, stove);           // pick up the pot
  assert.equal(s.chefs[0].h.k, 'pot');
  grab(s, 0, find(s, 'T')[0]);
  assert.equal(s.chefs[0].h.parts.length, 0);
  assert.equal(s.chefs[0].h.b, false);
  grab(s, 0, stove);
  assert.equal(s.items[stove.join(',')].k, 'pot');
});

test('kitchencrew: lifting the pot pauses cooking', () => {
  const s = go(start(1));
  const stove = find(s, 'S')[0];
  const pot = s.items[stove.join(',')];
  pot.parts = ['tomato', 'tomato', 'tomato'];
  ticks(s, 2);
  grab(s, 0, stove);
  const p = s.chefs[0].h.p;
  ticks(s, 3);
  assert.equal(s.chefs[0].h.p, p);
});

test('kitchencrew: salad is assembled on a plate across the split kitchen', () => {
  const s = go(start(2, { level: 2 }));
  s.orders = [{ id: 1, r: 'salad', t: 60000, T: 60000 }];
  const board = find(s, 'B')[0];
  const counter = [6, 2]; // the divider
  assert.equal(game.tileAt(s, 6, 2), 'C');
  // Chef 0 preps lettuce and leaves it on the divider; chef 1 brings a plate from the other side.
  choppedInto(s, 'l', board, counter);
  assert.equal(s.items['6,2'].s, 'chopped');
  s.chefs[1].x = 7.5; s.chefs[1].y = 2.5;
  game.handleMove({ type: 'grab', tx: 13, ty: 3 }, s, 1); // out of reach: ignored
  assert.equal(s.chefs[1].h, null);
  grab(s, 1, find(s, 'P')[0]);
  s.chefs[1].x = 7.5; s.chefs[1].y = 2.5;
  assert.equal(game.handleMove({ type: 'grab', tx: 6, ty: 2 }, s, 1), null);
  assert.deepEqual(s.chefs[1].h.parts, ['lettuce']);
  // Raw tomato does not go on a plate; a chopped one does.
  s.chefs[1].h.parts.push('tomato');
  assert.equal(game.matchRecipe(s.chefs[1].h.parts), 'salad');
  assert.equal(game.plateAccepts(s, s.chefs[1].h, 'lettuce'), false, 'no third part on a finished salad');
  grab(s, 1, find(s, 'W')[0]);
  assert.equal(s.delivered, 1);
});

test('kitchencrew: burgers fry in a pan and plates come back dirty', () => {
  const s = go(start(2, { level: 3 }));
  s.orders = [{ id: 1, r: 'burger', t: 60000, T: 60000 }];
  const pan = find(s, 'F')[0];
  grab(s, 0, find(s, 'n')[0]);
  assert.equal(s.chefs[0].h.k, 'meat');
  grab(s, 0, pan);
  assert.deepEqual(s.items[pan.join(',')].parts, ['meat']);
  ticks(s, game.constants.FRY_S + 0.2);
  grab(s, 1, find(s, 'P')[0]);
  grab(s, 1, find(s, 'b')[0]); // bun straight onto the plate
  assert.deepEqual(s.chefs[1].h.parts, ['bun']);
  grab(s, 1, pan);
  assert.deepEqual(s.chefs[1].h.parts.slice().sort(), ['bun', 'patty']);
  grab(s, 1, find(s, 'W')[0]);
  assert.equal(s.delivered, 1);

  const ret = find(s, 'R')[0].join(',');
  const sink = find(s, 'K')[0];
  const rack = find(s, 'P')[0].join(',');
  const clean = s.stations[rack].n;
  ticks(s, 7);
  assert.equal(s.stations[ret].n, 1, 'served plate returns dirty');
  assert.equal(s.stations[rack].n, clean);
  grab(s, 0, find(s, 'R')[0]);
  assert.deepEqual(s.chefs[0].h, { k: 'dirty', n: 1 });
  grab(s, 0, sink);
  assert.equal(s.stations[sink.join(',')].n, 1);
  standAt(s, 0, sink[0], sink[1]);
  game.handleMove({ type: 'use', tx: sink[0], ty: sink[1] }, s, 0);
  ticks(s, game.constants.WASH_S + 0.2);
  assert.equal(s.stations[sink.join(',')].n, 0);
  assert.equal(s.stations[rack].n, clean + 1);
});

test('kitchencrew: walking away stops chopping but keeps progress', () => {
  const s = go(start(1));
  const board = find(s, 'B')[0];
  grab(s, 0, find(s, 't')[0]);
  grab(s, 0, board);
  standAt(s, 0, board[0], board[1]);
  game.handleMove({ type: 'use', tx: board[0], ty: board[1] }, s, 0);
  ticks(s, 0.6);
  s.chefs[0].y += 2.5; // wander off
  ticks(s, 0.5);
  const item = s.items[board.join(',')];
  assert.equal(s.chefs[0].w, null);
  assert.equal(item.s, 'raw');
  assert.ok(item.c > 0.2 && item.c < 0.6);
});

test('kitchencrew: two chefs grabbing the same item resolve in order', () => {
  const s = go(start(2));
  s.items['4,3'] = { k: 'onion', s: 'chopped' };
  s.chefs[0].x = 4.5; s.chefs[0].y = 2.5;
  s.chefs[1].x = 3.5; s.chefs[1].y = 3.5;
  game.handleMove({ type: 'grab', tx: 4, ty: 3 }, s, 1);
  game.handleMove({ type: 'grab', tx: 4, ty: 3 }, s, 0);
  assert.equal(s.chefs[1].h.k, 'onion');
  assert.equal(s.chefs[0].h, null, 'second grab finds the counter empty and does nothing');
  assert.equal(s.items['4,3'], undefined);
});

test('kitchencrew: position reports are validated', () => {
  let now = 1000;
  game._setClock(() => now);
  try {
    const s = go(start(1));
    const c = s.chefs[0];
    c.last = now;
    const x0 = c.x, y0 = c.y;
    now += 100;
    game.handleMove({ type: 'pos', x: x0 + 0.4, y: y0, fx: 1, fy: 0 }, s, 0);
    assert.equal(c.x, x0 + 0.4);
    assert.equal(c.fx, 1);
    now += 50;
    game.handleMove({ type: 'pos', x: x0 + 9, y: y0 }, s, 0); // teleport
    assert.equal(c.x, x0 + 0.4);
    assert.equal(c.fix, 1);
    now += 100;
    game.handleMove({ type: 'pos', x: 0.2, y: 0.2 }, s, 0); // inside a wall
    assert.equal(c.fix, 2);
    game.handleMove({ type: 'pos', x: NaN, y: 1 }, s, 0);
    assert.equal(c.fix, 3);
    // Two reports arriving together (Wi-Fi burst during a dash) are both accepted.
    const bx = c.x;
    now += 2;
    game.handleMove({ type: 'pos', x: bx + 0.7, y: c.y }, s, 0);
    now += 2;
    game.handleMove({ type: 'pos', x: bx + 1.4, y: c.y }, s, 0);
    assert.equal(c.x, bx + 1.4);
    assert.equal(c.fix, 3);
    // But a short hop across a counter is not: the island is between rows 2 and 5.
    Object.assign(c, { x: 5.5, y: 2.5, last: now });
    now += 300;
    game.handleMove({ type: 'pos', x: 5.5, y: 5.5 }, s, 0);
    assert.equal(c.y, 2.5);
    assert.equal(c.fix, 4);
  } finally {
    game._setClock(null);
  }
});

test('kitchencrew: bot input moves the chef through tick with wall sliding', () => {
  const s = go(start(1));
  const c = s.chefs[0];
  const y0 = c.y;
  game.handleMove({ type: 'input', x: 0, y: -1 }, s, 0);
  ticks(s, 2);
  assert.ok(c.y < y0);
  assert.equal(game.collides(s, c.x, c.y), false);
  assert.ok(c.y >= 1 + game.constants.RADIUS - 1e-9, 'stopped at the counter');
  game.handleMove({ type: 'input', x: 0, y: 0 }, s, 0);
  assert.equal(c.in, null);
});

test('kitchencrew: expired orders cost points and the timer ends the shift', () => {
  const s = go(start(2, { minutes: 2 }));
  assert.equal(s.duration, 120000);
  s.score = 25;
  s.orders = [{ id: 1, r: 'onion_soup', t: 100, T: 60000 }];
  ticks(s, 0.2);
  assert.equal(s.failed, 1);
  assert.equal(s.score, 15);
  s.score = s.thresholds[1];
  s.timeLeft = 50;
  ticks(s, 0.1);
  assert.equal(s.phase, 'over');
  assert.equal(s.stars, 2);
  assert.equal(s.winner, -2);
  assert.equal(game.tick(s), false);

  const f = go(start(1));
  f.timeLeft = 10;
  game.tick(f);
  assert.equal(f.winner, -3, 'no stars is a team loss');
});

test('kitchencrew: bad payloads are rejected, late packets ignored', () => {
  const s = go(start(1));
  assert.equal(game.handleMove(null, s, 0), 'kc_bad_move');
  assert.equal(game.handleMove({ type: 'teleport' }, s, 0), 'kc_bad_move');
  assert.equal(game.handleMove({ type: 'grab', tx: 'a', ty: 1 }, s, 0), 'kc_bad_move');
  assert.equal(game.handleMove({ type: 'pos', x: 1, y: 1 }, s, 3), 'kc_no_chef');
  s.phase = 'over';
  assert.equal(game.handleMove({ type: 'grab', tx: 1, ty: 1 }, s, 0), null);
  assert.equal(game.silentMove({ type: 'pos' }), true);
  assert.equal(game.silentMove({ type: 'grab' }), false);
});

test('kitchencrew: bot crews finish every kitchen without rejected moves and serve food', () => {
  const bots = require('../bots/kitchencrew');
  for (const level of Object.keys(game.LEVELS)) {
    for (const players of [1, 3]) {
      const s = game.createState();
      s._options = { level, minutes: 2 };
      game.initGame(s, players);
      const crew = [...Array(players).keys()].map(i => bots.createBot(i));
      for (let guard = 0; s.winner === null && guard < 5000; guard++) {
        crew.forEach((b, i) => {
          const mv = b.getMove(s);
          assert.equal(game.handleMove(mv, s, i), null, 'rejected ' + JSON.stringify(mv));
        });
        game.tick(s);
      }
      assert.notEqual(s.winner, null, 'level ' + level + ' never ended');
      assert.ok(s.delivered >= 1, 'level ' + level + ' with ' + players + ' bot(s) served nothing');
      s.chefs.forEach(c => assert.equal(game.collides(s, c.x, c.y), false));
    }
  }
});

test('kitchencrew: pause freezes the whole kitchen for everyone and resumes through a countdown', () => {
  let now = 5000;
  game._setClock(() => now);
  try {
    const s = go(start(2));
    const stove = find(s, 'S')[0];
    const pot = s.items[stove.join(',')];
    pot.parts = ['onion', 'onion', 'onion'];
    ticks(s, 1);
    const snap = { time: s.timeLeft, p: pot.p, order: s.orders[0].t, x: s.chefs[0].x };
    assert.equal(game.handleMove({ type: 'pause', on: true }, s, 1), null);
    assert.equal(s.paused, 1);
    ticks(s, 5);
    assert.equal(s.timeLeft, snap.time, 'shift clock stops');
    assert.equal(pot.p, snap.p, 'cooking stops');
    assert.equal(s.orders[0].t, snap.order, 'order timers stop');
    now += 200;
    game.handleMove({ type: 'pos', x: s.chefs[0].x + 0.3, y: s.chefs[0].y }, s, 0);
    assert.equal(s.chefs[0].x, snap.x, 'nobody moves while paused');
    grab(s, 0, find(s, 't')[0]);
    assert.equal(s.chefs[0].h, null, 'nobody interacts while paused');
    // A second pause press doesn't change who paused; any chef can resume.
    game.handleMove({ type: 'pause', on: true }, s, 0);
    assert.equal(s.paused, 1);
    game.handleMove({ type: 'pause', on: false }, s, 0);
    assert.equal(s.paused, null);
    assert.equal(s.phase, 'countdown');
    ticks(s, 1);
    assert.equal(s.timeLeft, snap.time, 'clock still frozen during the resume countdown');
    ticks(s, 2.5);
    assert.equal(s.phase, 'playing');
    ticks(s, 1);
    assert.ok(s.timeLeft < snap.time && pot.p > snap.p, 'kitchen runs again');
    assert.ok(s.fx.some(f => f.k === 'pause' && f.by === 1) && s.fx.some(f => f.k === 'resume'));
  } finally {
    game._setClock(null);
  }
});

// Hand chef i an item, stand them at (x, y) facing (fx, fy) and throw.
function throwFrom(s, i, item, x, y, fx, fy) {
  Object.assign(s.chefs[i], { h: item, x, y, fx, fy });
  assert.equal(game.handleMove({ type: 'throw' }, s, i), null);
}

test('kitchencrew: thrown food lands on a counter, in a pot, or is caught', () => {
  const s = go(start(2, { level: '1' }));
  // park chef 1 out of every flight path
  Object.assign(s.chefs[1], { x: 12.5, y: 6.5 });
  throwFrom(s, 0, { k: 'tomato', s: 'raw' }, 3.5, 1.5, 0, -1);
  assert.equal(s.chefs[0].h, null, 'the item leaves your hands');
  assert.equal(s.flying.length, 1);
  ticks(s, 0.5);
  assert.deepEqual(s.items['3,0'], { k: 'tomato', s: 'raw' }, 'lands on the empty counter');
  assert.equal(s.flying.length, 0);

  // chopped tomato thrown three tiles straight into the pot
  throwFrom(s, 0, { k: 'tomato', s: 'chopped' }, 11.5, 3.5, 0, -1);
  ticks(s, 0.5);
  assert.deepEqual(s.items['11,0'].parts, ['tomato']);

  // an empty-handed teammate in the path catches it; the thrower never catches their own
  Object.assign(s.chefs[1], { x: 6.5, y: 1.5, h: null });
  throwFrom(s, 0, { k: 'onion', s: 'raw' }, 2.5, 1.5, 1, 0);
  ticks(s, 0.5);
  assert.deepEqual(s.chefs[1].h, { k: 'onion', s: 'raw' });
  assert.ok(s.fx.some(f => f.k === 'catch' && f.by === 1));
});

test('kitchencrew: food that cannot land drops to the floor and can be picked up', () => {
  const s = go(start(2, { level: '1' }));
  Object.assign(s.chefs[1], { x: 12.5, y: 6.5, h: { k: 'plate', parts: [] } }); // busy hands: no catching
  // raw tomato at the pot: pots only take chopped food, so it bounces onto the floor
  throwFrom(s, 0, { k: 'tomato', s: 'raw' }, 11.5, 1.5, 0, -1);
  ticks(s, 0.3);
  assert.deepEqual(s.floor['11,1'], { k: 'tomato', s: 'raw' });
  assert.deepEqual(s.items['11,0'].parts, []);
  // out of range over open floor: lands about 5 tiles away
  throwFrom(s, 0, { k: 'lettuce', s: 'raw' }, 1.5, 5.5, 1, 0);
  ticks(s, 1);
  assert.deepEqual(s.floor['6,5'], { k: 'lettuce', s: 'raw' });
  // pick it up from the next cell; you can't put things down on the floor
  Object.assign(s.chefs[0], { x: 5.5, y: 5.5, h: null });
  assert.equal(game.handleMove({ type: 'grab', tx: 6, ty: 5 }, s, 0), null);
  assert.deepEqual(s.chefs[0].h, { k: 'lettuce', s: 'raw' });
  assert.equal(s.floor['6,5'], undefined);
  assert.equal(game.handleMove({ type: 'grab', tx: 6, ty: 5 }, s, 0), null);
  assert.equal(s.floor['6,5'], undefined, 'no dropping on the floor');
  assert.ok(s.chefs[0].h);
});

test('kitchencrew: only ingredients fly, and never during countdown or pause', () => {
  const s = start(1, { level: '1' });
  throwFrom(s, 0, { k: 'tomato', s: 'raw' }, 3.5, 1.5, 0, -1);
  assert.equal(s.flying.length, 0, 'countdown');
  go(s);
  throwFrom(s, 0, { k: 'plate', parts: [] }, 3.5, 1.5, 0, -1);
  assert.equal(s.flying.length, 0, 'plates stay in hand');
  assert.equal(s.chefs[0].h.k, 'plate');
  game.handleMove({ type: 'pause', on: true }, s, 0);
  throwFrom(s, 0, { k: 'tomato', s: 'raw' }, 3.5, 1.5, 0, -1);
  assert.equal(s.flying.length, 0, 'paused');
  game.handleMove({ type: 'pause', on: false }, s, 0);
  go(s);
  throwFrom(s, 0, { k: 'tomato', s: 'raw' }, 3.5, 1.5, 0, -1);
  game.handleMove({ type: 'pause', on: true }, s, 0);
  const before = JSON.stringify(s.flying);
  ticks(s, 1);
  assert.equal(JSON.stringify(s.flying), before, 'mid-air food freezes while paused');
});

test('kitchencrew: bots tidy up food lying on the floor', () => {
  const bots = require('../bots/kitchencrew');
  const s = go(start(1, { level: '1' }));
  s.floor['6,5'] = { k: 'tomato', s: 'raw' };
  const bot = bots.createBot(0);
  for (let i = 0; i < 150 && s.floor['6,5']; i++) {
    assert.equal(game.handleMove(bot.getMove(s), s, 0), null);
    game.tick(s);
  }
  assert.equal(s.floor['6,5'], undefined);
});

test('kitchencrew: actions echo their number so clients can drop predictions', () => {
  const s = go(start(1, { level: '1' }));
  grab(s, 0, find(s, 't')[0]);
  assert.equal(s.chefs[0].ack, undefined, 'no number, no echo');
  standAt(s, 0, 3, 0);
  game.handleMove({ type: 'grab', tx: 3, ty: 0, seq: 7 }, s, 0);
  assert.equal(s.chefs[0].ack, 7);
  game.handleMove({ type: 'throw', seq: 8 }, s, 0);
  assert.equal(s.chefs[0].ack, 8, 'echoed even when nothing happens (hands are empty)');
});
