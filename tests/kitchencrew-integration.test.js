// Kitchen Crew over the real WebSocket protocol: two humans + a bot share one kitchen.
// Checks the realtime broadcast cadence, that position reports are silent (no broadcast storm),
// that both clients see the same authoritative state, that racing grabs resolve to one winner,
// and that a player who drops can resume their seat mid-shift.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const PORT = 3193;
const delay = ms => new Promise(r => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, msgs: [], state: null, index: null, token: null, broadcasts: 0 };
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    c.msgs.push(m);
    if (m.state) c.state = m.state;
    if (m.type === 'game_state') c.broadcasts++;
    if (m.playerIndex !== undefined && (m.type === 'room_created' || m.type === 'room_joined')) c.index = m.playerIndex;
    if (m.resumeToken) c.token = m.resumeToken;
    if (m.roomId) c.roomId = m.roomId;
  });
  c.send = (type, data) => ws.send(JSON.stringify({ type, data }));
  c.open = new Promise(r => ws.on('open', r));
  return c;
}

async function until(fn, ms, what) {
  const end = Date.now() + (ms || 4000);
  while (Date.now() < end) { if (fn()) return; await delay(20); }
  throw new Error('timed out waiting for ' + what);
}

test('kitchencrew: multiplayer sync, silent moves, races and resume', async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  srv.stderr.on('data', d => { err += d; });
  const open = [];
  try {
    await new Promise((res, rej) => {
      const t = setInterval(() => {
        const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
        w.on('open', () => { w.close(); clearInterval(t); res(); });
        w.on('error', () => {});
      }, 150);
      setTimeout(() => rej(new Error('server not listening: ' + err.slice(-200))), 8000);
    });

    const host = client(); open.push(host);
    await host.open;
    host.send('create_room', { game: 'kitchencrew', lang: 'en' });
    await until(() => host.roomId, 3000, 'room');
    host.send('set_option', { key: 'minutes', value: 2 });

    const guest = client(); open.push(guest);
    await guest.open;
    guest.send('join_room', { roomId: host.roomId, lang: 'en' });
    await until(() => guest.index === 1, 3000, 'guest seat');
    host.send('add_bot');
    await delay(100);
    guest.send('player_ready');
    host.send('player_ready');
    await delay(100);
    host.send('start_game');
    await until(() => host.state && host.state.chefs && guest.state && guest.state.chefs, 3000, 'game start');
    assert.equal(host.state.chefs.length, 3);
    assert.equal(host.state.duration, 120000);

    // ~15 Hz broadcasts while ticking.
    const b0 = guest.broadcasts;
    await delay(1000);
    const perSec = guest.broadcasts - b0;
    assert.ok(perSec >= 10 && perSec <= 20, 'expected ~15 broadcasts/s, got ' + perSec);

    // Wait out the countdown, then flood position reports: they must not add broadcasts.
    await until(() => host.state.phase === 'playing', 5000, 'service to start');
    const me = host.state.chefs[0];
    const b1 = guest.broadcasts;
    for (let i = 0; i < 60; i++) {
      host.send('game_move', { type: 'pos', x: me.x, y: me.y + (i % 2 ? 0.01 : 0), fx: 0, fy: 1 });
      await delay(16);
    }
    const flood = guest.broadcasts - b1;
    assert.ok(flood <= 22, 'position reports should ride on ticks, got ' + flood + ' broadcasts for 60 reports in ~1s');

    // Both clients converge on the same authoritative state.
    await delay(200);
    assert.equal(guest.state.chefs[0].x.toFixed(2), me.x.toFixed(2));

    // Race: put both chefs within reach of the tomato crate's neighbour counter and grab together.
    const grid = host.state.grid;
    let crate = null;
    grid.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 't') crate = [x, y]; }));
    const spot = { x: crate[0] + 0.5, y: crate[1] + 1.5 };
    // Walk each chef there in small validated steps.
    for (const c of [host, guest]) {
      const ch = c.state.chefs[c.index];
      let x = ch.x, y = ch.y;
      for (let i = 0; i < 80 && (Math.abs(x - spot.x) > 0.01 || Math.abs(y - spot.y) > 0.01); i++) {
        x += Math.max(-0.25, Math.min(0.25, spot.x - x));
        // stay on row 1/2 (open floor) while sliding sideways
        y += Math.max(-0.25, Math.min(0.25, spot.y - y));
        c.send('game_move', { type: 'pos', x, y, fx: 0, fy: -1 });
        await delay(30);
      }
    }
    await delay(150);
    assert.ok(Math.abs(host.state.chefs[0].x - spot.x) < 0.05, 'host chef reached the crate');
    assert.ok(Math.abs(host.state.chefs[1].x - spot.x) < 0.05, 'guest chef reached the crate');
    // Host grabs a tomato and drops it on the counter at (crate.x+1); then both race for it.
    host.send('game_move', { type: 'grab', tx: crate[0], ty: crate[1] });
    await until(() => host.state.chefs[0].h && host.state.chefs[0].h.k === 'tomato', 2000, 'tomato in hand');
    const counter = [crate[0] + 1, crate[1]];
    assert.equal(grid[counter[1]][counter[0]], 'C');
    host.send('game_move', { type: 'grab', tx: counter[0], ty: counter[1] });
    await until(() => host.state.items[counter.join(',')], 2000, 'tomato on counter');
    guest.send('game_move', { type: 'grab', tx: counter[0], ty: counter[1] });
    host.send('game_move', { type: 'grab', tx: counter[0], ty: counter[1] });
    await delay(300);
    const holders = host.state.chefs.slice(0, 2).filter(c => c.h && c.h.k === 'tomato').length;
    const onCounter = host.state.items[counter.join(',')] ? 1 : 0;
    assert.equal(holders + onCounter, 1, 'exactly one tomato exists after the race');
    assert.deepEqual(JSON.stringify(guest.state.chefs.map(c => c.h)), JSON.stringify(host.state.chefs.map(c => c.h)));

    // The bot chef is moving on its own.
    const bot = host.state.chefs[2];
    const bx = bot.x, by = bot.y;
    await delay(1500);
    const bot2 = host.state.chefs[2];
    assert.ok(Math.hypot(bot2.x - bx, bot2.y - by) > 0.2 || bot2.h, 'bot should be working');

    // Guest drops and resumes its seat mid-shift with the resume token.
    const token = guest.token;
    guest.ws.close();
    await delay(300);
    const back = client(); open.push(back);
    await back.open;
    back.send('join_room', { roomId: host.roomId, resumeToken: token, lang: 'en' });
    await until(() => back.index === 1 && back.state && back.state.chefs, 3000, 'resume');
    assert.equal(back.state.phase, 'playing');
    const b2 = back.broadcasts;
    await delay(400);
    assert.ok(back.broadcasts - b2 >= 3, 'resumed client keeps receiving ticks');
    back.send('game_move', { type: 'pos', x: spot.x, y: spot.y + 0.2, fx: 0, fy: 1 });
    await delay(200);
    assert.ok(Math.abs(host.state.chefs[1].y - (spot.y + 0.2)) < 0.01, 'resumed client controls its chef');
    assert.ok(!host.msgs.some(m => m.type === 'error'), 'no errors: ' + JSON.stringify(host.msgs.filter(m => m.type === 'error')));
  } finally {
    open.forEach(c => { try { c.ws.close(); } catch (e) {} });
    srv.kill();
  }
});
