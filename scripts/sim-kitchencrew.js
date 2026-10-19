// Bot-only Kitchen Crew shifts, run the way server.js runs a realtime game:
// each tick every bot submits one move, then the game ticks.
// usage: node scripts/sim-kitchencrew.js [runs]
const assert = require('assert');
const game = require('../games/kitchencrew');
const bots = require('../bots/kitchencrew');

function shift(level, players, minutes) {
  const s = game.createState();
  s._options = { level: String(level), minutes };
  game.initGame(s, players);
  const crew = [...Array(players).keys()].map(i => bots.createBot(i));
  let guard = 0;
  while (s.winner === null && guard++ < 10000) {
    crew.forEach((b, i) => {
      const mv = b.getMove(s);
      const err = game.handleMove(mv, s, i);
      assert.strictEqual(err, null, 'bot move rejected: ' + JSON.stringify(mv) + ' -> ' + err);
    });
    game.tick(s);
  }
  assert.notStrictEqual(s.winner, null, 'shift never ended');
  return s;
}

const runs = Number(process.argv[2]) || 3;
for (const level of Object.keys(game.LEVELS)) {
  for (const players of [1, 2, 3, 4]) {
    const results = [];
    for (let r = 0; r < runs; r++) results.push(shift(level, players, 3));
    const avg = k => (results.reduce((a, s) => a + s[k], 0) / runs).toFixed(1);
    console.log(`level ${level} · ${players} bot(s): score ${avg('score')}  served ${avg('delivered')}  missed ${avg('failed')}  stars ${avg('stars')}  thresholds ${results[0].thresholds.join('/')}`);
  }
}
