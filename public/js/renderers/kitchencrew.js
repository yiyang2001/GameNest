// Kitchen Crew renderer — cartoon kitchen on a canvas, local movement for your own chef,
// interpolation for everyone else, on-screen joystick + buttons for phones.
(function () {
  // Must match games/kitchencrew.js
  var TOOLSLOT_W = 40;
  var SPEED = 4.6, DASH_SPEED = 11, DASH_S = 0.15, DASH_CD = 0.65, RADIUS = 0.3, REACH = 1.45;
  var COOK_S = 9, FRY_S = 6, BURN_S = 9;
  var SEND_MS = 66, INTERP_MS = 110;
  var CHEF_COLORS = ['#ff7a6b', '#4fb3ff', '#5fd08e', '#ffc23d'];
  var CHEF_DARK = ['#d9534a', '#2c86cc', '#36a466', '#d99a12'];
  var CRATES = { t: 'tomato', o: 'onion', m: 'mushroom', l: 'lettuce', b: 'bun', n: 'meat' };
  var INGREDIENT_KINDS = Object.keys(CRATES).map(function (c) { return CRATES[c]; });
  var THROW_SPEED = 12, THROW_RANGE = 5;
  var RECIPE_PARTS = {
    tomato_soup: ['soup_tomato'], onion_soup: ['soup_onion'], mushroom_soup: ['soup_mushroom'],
    salad: ['lettuce', 'tomato'], burger: ['bun', 'patty'], deluxe_burger: ['bun', 'patty', 'lettuce'],
  };
  // Ingredients shown on an order ticket (what you need to fetch).
  var RECIPE_INGREDIENTS = {
    tomato_soup: ['tomato', 'tomato', 'tomato'], onion_soup: ['onion', 'onion', 'onion'],
    mushroom_soup: ['mushroom', 'mushroom', 'mushroom'], salad: ['lettuce', 'tomato'],
    burger: ['bun', 'meat'], deluxe_burger: ['bun', 'meat', 'lettuce'],
  };

  var R = null; // all renderer state lives here and is rebuilt on init

  // ---------------------------------------------------------------- key bindings (saved per browser)
  var ACTIONS = ['up', 'down', 'left', 'right', 'grab', 'use', 'dash', 'pause'];
  var DEFAULT_KEYS = {
    up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    grab: ['Space', 'KeyE'], use: ['KeyF', 'ControlLeft'], dash: ['ShiftLeft', 'KeyL'], pause: ['Escape', 'KeyP'],
  };
  function defaultKeys() {
    var k = {};
    ACTIONS.forEach(function (a) { k[a] = DEFAULT_KEYS[a].slice(); });
    return k;
  }
  function loadKeys() {
    var k = defaultKeys();
    try {
      var saved = JSON.parse(localStorage.getItem('kc_keys') || 'null');
      if (saved) ACTIONS.forEach(function (a) {
        if (Array.isArray(saved[a])) k[a] = [0, 1].map(function (i) { return typeof saved[a][i] === 'string' ? saved[a][i] : null; });
      });
    } catch (e) {}
    return k;
  }
  var KEYS = loadKeys();
  function saveKeys() { try { localStorage.setItem('kc_keys', JSON.stringify(KEYS)); } catch (e) {} }
  function actionFor(code) {
    for (var i = 0; i < ACTIONS.length; i++) if (KEYS[ACTIONS[i]].indexOf(code) >= 0) return ACTIONS[i];
    return null;
  }
  function keyName(code) {
    if (!code) return '—';
    var m = /^(Key|Digit)(.)$/.exec(code);
    if (m) return m[2];
    var names = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Escape: 'Esc', Enter: 'Enter',
      ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'Alt', AltRight: 'R-Alt',
      Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
      Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
    if (names[code]) return names[code];
    return code.replace(/^Numpad/, 'Num ');
  }
  function primaryKey(a) { return KEYS[a][0] || KEYS[a][1]; }

  // ---------------------------------------------------------------- sound (tiny WebAudio synth, no assets)
  var Snd = { ctx: null, muted: false };
  try { Snd.muted = localStorage.getItem('kc_muted') === '1'; } catch (e) {}
  function audio() {
    if (Snd.muted) return null;
    if (!Snd.ctx) {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!A) return null;
      try { Snd.ctx = new A(); } catch (e) { return null; }
    }
    if (Snd.ctx.state === 'suspended') Snd.ctx.resume();
    return Snd.ctx;
  }
  function tone(freq, dur, o) {
    var a = audio();
    if (!a) return;
    o = o || {};
    var t0 = a.currentTime + (o.delay || 0), osc = a.createOscillator(), g = a.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.1, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(a.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  var SFX = {
    pop: function () { tone(520, .08, { type: 'triangle', to: 780, vol: .07 }); },
    chop: function () { tone(900, .05, { type: 'square', vol: .035 }); tone(700, .05, { type: 'square', vol: .035, delay: .07 }); },
    ding: function () { tone(1320, .25, { vol: .07 }); tone(1760, .3, { vol: .05, delay: .08 }); },
    serve: function () { [660, 830, 990, 1320].forEach(function (f, i) { tone(f, .16, { type: 'triangle', vol: .09, delay: i * .07 }); }); },
    wrong: function () { tone(180, .22, { type: 'sawtooth', vol: .05, to: 140 }); },
    miss: function () { tone(440, .32, { type: 'triangle', vol: .09, to: 220 }); },
    alarm: function () { tone(880, .09, { type: 'square', vol: .03 }); tone(880, .09, { type: 'square', vol: .03, delay: .14 }); },
    tick: function () { tone(1000, .05, { type: 'square', vol: .03 }); },
    whoosh: function () { tone(300, .18, { type: 'triangle', vol: .05, to: 900 }); },
    thud: function () { tone(160, .1, { type: 'sine', vol: .12, to: 90 }); },
    go: function () { tone(523, .12, { vol: .1 }); tone(659, .12, { vol: .1, delay: .12 }); tone(784, .25, { vol: .1, delay: .24 }); },
    over: function () { [784, 659, 523, 784, 1047].forEach(function (f, i) { tone(f, .18, { type: 'triangle', vol: .09, delay: i * .12 }); }); },
  };
  function setMuted(m) {
    Snd.muted = m;
    try { localStorage.setItem('kc_muted', m ? '1' : '0'); } catch (e) {}
    if (R && R.mute) R.mute.textContent = m ? '\uD83D\uDD07' : '\uD83D\uDD0A';
  }

  function walkable(ch) { return ch === '.' || (ch >= '1' && ch <= '4'); }
  function tileAt(s, x, y) { return (y < 0 || y >= s.h || x < 0 || x >= s.w) ? '#' : s.grid[y][x]; }
  function interactive(ch) { return !walkable(ch) && ch !== '#'; }

  function collides(s, x, y, r) {
    if (x - r < 0 || y - r < 0 || x + r > s.w || y + r > s.h) return true;
    for (var ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
      for (var tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (walkable(tileAt(s, tx, ty))) continue;
        var cx = Math.max(tx, Math.min(x, tx + 1)), cy = Math.max(ty, Math.min(y, ty + 1));
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r * r - 1e-6) return true;
      }
    }
    return false;
  }

  function nowMs() { return performance.now(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function playerName(i) {
    var p = window.gamePlayers && window.gamePlayers.find ? window.gamePlayers.find(function (q) { return q.index === i; }) : null;
    return p && p.name ? p.name : _t('kc_chef') + ' ' + (i + 1);
  }

  // ---------------------------------------------------------------- drawing helpers

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  }
  function circle(ctx, x, y, r, fill) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); }
  function ellipse(ctx, x, y, rx, ry, fill) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); }
  function outline(ctx, w, c) { ctx.lineWidth = w; ctx.strokeStyle = c || 'rgba(60,35,20,.55)'; ctx.stroke(); }

  // Ingredient art. (x, y) centre, s = size in px (about one tile).
  function drawIngredient(ctx, kind, chopped, x, y, s) {
    var u = s / 10;
    ctx.save();
    ctx.lineJoin = 'round';
    if (kind === 'tomato') {
      if (!chopped) {
        circle(ctx, x, y + u * .3, u * 3.3, '#ef4b3c'); outline(ctx, u * .45);
        circle(ctx, x - u * 1.2, y - u * .7, u * .9, 'rgba(255,255,255,.55)');
        leaf(ctx, x, y - u * 2.8, u * 1.6, '#3fae49');
      } else {
        for (var i = 0; i < 3; i++) {
          var ox = x + (i - 1) * u * 2.2, oy = y + (i === 1 ? -u : u * .6);
          circle(ctx, ox, oy, u * 1.8, '#ef4b3c'); outline(ctx, u * .35);
          circle(ctx, ox, oy, u * 1.2, '#ff8a6d');
          circle(ctx, ox - u * .4, oy, u * .25, '#ffe2a8'); circle(ctx, ox + u * .4, oy + u * .3, u * .25, '#ffe2a8');
        }
      }
    } else if (kind === 'onion') {
      if (!chopped) {
        ctx.beginPath(); ctx.moveTo(x, y - u * 4); ctx.bezierCurveTo(x + u * 4.4, y - u * 1, x + u * 3.8, y + u * 3.6, x, y + u * 3.6);
        ctx.bezierCurveTo(x - u * 3.8, y + u * 3.6, x - u * 4.4, y - u * 1, x, y - u * 4); ctx.fillStyle = '#d9a6d6'; ctx.fill(); outline(ctx, u * .45);
        ctx.beginPath(); ctx.moveTo(x, y - u * 3); ctx.quadraticCurveTo(x + u * 1.6, y, x, y + u * 3.4); ctx.strokeStyle = 'rgba(140,70,140,.45)'; ctx.lineWidth = u * .4; ctx.stroke();
        circle(ctx, x - u * 1.4, y - u * .2, u * .8, 'rgba(255,255,255,.45)');
      } else {
        for (var j = 0; j < 3; j++) {
          var px = x + (j - 1) * u * 2.3, py = y + (j === 1 ? -u * .8 : u * .7);
          ctx.beginPath(); ctx.arc(px, py, u * 1.9, 0, Math.PI * 2); ctx.fillStyle = '#f3dbf1'; ctx.fill(); outline(ctx, u * .35, '#a0629c');
          ctx.beginPath(); ctx.arc(px, py, u * 1.05, 0, Math.PI * 2); ctx.strokeStyle = '#c084bb'; ctx.lineWidth = u * .35; ctx.stroke();
        }
      }
    } else if (kind === 'mushroom') {
      if (!chopped) {
        rr(ctx, x - u * 1.2, y - u * .2, u * 2.4, u * 3.6, u); ctx.fillStyle = '#f6ecd8'; ctx.fill(); outline(ctx, u * .4);
        ctx.beginPath(); ctx.ellipse(x, y - u * .4, u * 3.9, u * 2.9, 0, Math.PI, 0); ctx.closePath(); ctx.fillStyle = '#c98b5a'; ctx.fill(); outline(ctx, u * .45);
        circle(ctx, x - u * 1.5, y - u * 1.8, u * .6, '#f4dcc0'); circle(ctx, x + u * 1.2, y - u * 2.2, u * .5, '#f4dcc0');
      } else {
        for (var m = 0; m < 3; m++) {
          var mx = x + (m - 1) * u * 2.3, my = y + (m === 1 ? -u * .8 : u * .6);
          ctx.beginPath(); ctx.ellipse(mx, my - u * .3, u * 1.7, u * 1.2, 0, Math.PI, 0); ctx.lineTo(mx + u * .6, my + u * 1.4); ctx.lineTo(mx - u * .6, my + u * 1.4); ctx.closePath();
          ctx.fillStyle = '#ead2b4'; ctx.fill(); outline(ctx, u * .35, '#a06a3f');
        }
      }
    } else if (kind === 'lettuce') {
      if (!chopped) {
        var leaves = [[-1.8, .6, 2.6], [1.8, .6, 2.6], [0, -1.3, 2.8], [0, 1.2, 2.6]];
        leaves.forEach(function (l, k) { circle(ctx, x + l[0] * u, y + l[1] * u, l[2] * u, k % 2 ? '#7ccf52' : '#5fb83c'); outline(ctx, u * .35, '#3d7d26'); });
        circle(ctx, x - u, y - u * 1.6, u * .8, 'rgba(255,255,255,.35)');
      } else {
        for (var q = 0; q < 6; q++) {
          var a = q * 1.05, lx = x + Math.cos(a) * u * 2, ly = y + Math.sin(a) * u * 1.5;
          ctx.save(); ctx.translate(lx, ly); ctx.rotate(a);
          rr(ctx, -u * 1.5, -u * .6, u * 3, u * 1.2, u * .6); ctx.fillStyle = q % 2 ? '#8fdc62' : '#62bd40'; ctx.fill(); outline(ctx, u * .25, '#3d7d26');
          ctx.restore();
        }
      }
    } else if (kind === 'bun') {
      ctx.beginPath(); ctx.ellipse(x, y + u * .4, u * 3.9, u * 3, 0, Math.PI, 0); ctx.lineTo(x + u * 3.9, y + u * 1.4); ctx.quadraticCurveTo(x, y + u * 2.4, x - u * 3.9, y + u * 1.4); ctx.closePath();
      ctx.fillStyle = '#e9a24f'; ctx.fill(); outline(ctx, u * .45);
      [[-1.6, -1], [0, -1.8], [1.5, -.9], [.6, -.2], [-.7, -.1]].forEach(function (p) { ellipse(ctx, x + p[0] * u, y + p[1] * u, u * .45, u * .28, '#fff3d6'); });
    } else if (kind === 'meat') {
      if (chopped === 'cooked') { drawPatty(ctx, x, y, s); }
      else {
        rr(ctx, x - u * 3.6, y - u * 2.4, u * 7.2, u * 5, u * 2.2); ctx.fillStyle = '#ef8b98'; ctx.fill(); outline(ctx, u * .45, '#9a4655');
        ctx.beginPath(); ctx.moveTo(x - u * 2, y - u); ctx.quadraticCurveTo(x, y + u, x + u * 2.2, y - u * .4); ctx.strokeStyle = '#fbd3d8'; ctx.lineWidth = u * .6; ctx.stroke();
        circle(ctx, x + u * 1.8, y + u * 1.1, u * .7, '#fbd3d8');
      }
    }
    ctx.restore();
  }
  function leaf(ctx, x, y, r, color) {
    ctx.save(); ctx.fillStyle = color;
    for (var i = 0; i < 5; i++) {
      var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * r * .55, y + Math.sin(a) * r * .4, r * .5, r * .22, a, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function drawPatty(ctx, x, y, s) {
    var u = s / 10;
    ellipse(ctx, x, y, u * 3.8, u * 2.6, '#8a4b2a'); outline(ctx, u * .45, '#4e2814');
    ctx.strokeStyle = '#5b2e17'; ctx.lineWidth = u * .5;
    for (var i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(x - u * 2 + i * u * 1.4, y - u * 1.4); ctx.lineTo(x + i * u * 1.4, y + u * 1.4); ctx.stroke(); }
    circle(ctx, x - u * 1.6, y - u * 1, u * .5, 'rgba(255,220,180,.35)');
  }

  var SOUP_COLORS = { tomato: '#f0573d', onion: '#e8b546', mushroom: '#b68457' };

  function drawPlate(ctx, plate, x, y, s) {
    var u = s / 10;
    ellipse(ctx, x, y + u * .6, u * 4.6, u * 3.4, 'rgba(0,0,0,.12)');
    ellipse(ctx, x, y, u * 4.6, u * 3.4, '#ffffff'); outline(ctx, u * .4, '#a9b7c6');
    ellipse(ctx, x, y, u * 3.2, u * 2.3, '#eef3f8');
    drawDish(ctx, plate.parts, x, y, s);
  }

  function drawDish(ctx, parts, x, y, s) {
    var u = s / 10;
    if (!parts || !parts.length) return;
    var soup = parts.length === 1 && parts[0].indexOf('soup_') === 0 ? parts[0].slice(5) : null;
    if (soup) {
      ellipse(ctx, x, y - u * .2, u * 3, u * 2.1, '#fff'); outline(ctx, u * .35, '#a9b7c6');
      ellipse(ctx, x, y - u * .2, u * 2.4, u * 1.6, SOUP_COLORS[soup] || '#e66');
      circle(ctx, x - u * .8, y - u * .6, u * .4, 'rgba(255,255,255,.6)');
      if (soup === 'tomato') leaf(ctx, x + u * .7, y - u * .2, u * .9, '#3fae49');
      if (soup === 'onion') { ctx.beginPath(); ctx.arc(x + u * .6, y, u * .6, 0, Math.PI * 2); ctx.strokeStyle = '#fff2c4'; ctx.lineWidth = u * .3; ctx.stroke(); }
      if (soup === 'mushroom') circle(ctx, x + u * .7, y - u * .1, u * .5, '#e9d2b1');
      return;
    }
    var has = function (p) { return parts.indexOf(p) >= 0; };
    if (has('bun')) {
      // Burger stack (top bun only when it has a patty: looks finished)
      ctx.save();
      ctx.beginPath(); ctx.ellipse(x, y + u * .9, u * 3.1, u * 1.1, 0, 0, Math.PI * 2); ctx.fillStyle = '#e9a24f'; ctx.fill(); outline(ctx, u * .35);
      if (has('patty')) { ellipse(ctx, x, y + u * .1, u * 3.2, u * 1.1, '#7a4024'); outline(ctx, u * .35, '#4e2814'); }
      if (has('lettuce')) {
        ctx.beginPath(); for (var i = 0; i <= 8; i++) { var lx = x - u * 3.3 + i * u * .82; ctx.lineTo(lx, y - u * .4 + (i % 2 ? u * .6 : 0)); }
        ctx.lineTo(x + u * 3.3, y - u * 1); ctx.lineTo(x - u * 3.3, y - u * 1); ctx.closePath(); ctx.fillStyle = '#6fc44a'; ctx.fill();
      }
      if (has('patty')) {
        ctx.beginPath(); ctx.ellipse(x, y - u * .9, u * 3.1, u * 2, 0, Math.PI, 0); ctx.closePath(); ctx.fillStyle = '#eda54f'; ctx.fill(); outline(ctx, u * .35);
        [[-1.3, -1.8], [0, -2.3], [1.2, -1.7]].forEach(function (p) { ellipse(ctx, x + p[0] * u, y + p[1] * u, u * .35, u * .22, '#fff3d6'); });
      }
      ctx.restore();
      return;
    }
    // Salad / loose parts: little pile
    var n = parts.length;
    parts.forEach(function (p, k) {
      var ox = n === 1 ? 0 : (k - (n - 1) / 2) * u * 2.4;
      if (p === 'patty') drawPatty(ctx, x + ox, y, s * .55);
      else drawIngredient(ctx, p, true, x + ox, y, s * .6);
    });
  }

  function drawPot(ctx, pot, x, y, s, t) {
    var u = s / 10;
    ctx.save();
    // handles
    rr(ctx, x - u * 5.2, y - u * .9, u * 1.8, u * 1.6, u * .6); ctx.fillStyle = '#4a5363'; ctx.fill();
    rr(ctx, x + u * 3.4, y - u * .9, u * 1.8, u * 1.6, u * .6); ctx.fill();
    ellipse(ctx, x, y + u * .5, u * 4, u * 3.4, '#7d8798'); outline(ctx, u * .45, '#3c4350');
    ellipse(ctx, x, y - u * .2, u * 3.3, u * 2.6, '#3b4250');
    if (pot.b) {
      ellipse(ctx, x, y - u * .1, u * 3, u * 2.3, '#2a2522');
      circle(ctx, x - u, y - u * .5, u * .6, '#48403b'); circle(ctx, x + u * 1.1, y + u * .2, u * .5, '#48403b');
    } else if (pot.parts.length) {
      var col = SOUP_COLORS[pot.parts[0]] || '#e66';
      var done = pot.parts.length === 3 && pot.p >= COOK_S;
      var fill = pot.parts.length / 3;
      ellipse(ctx, x, y - u * .1, u * 3 * (.55 + fill * .45), u * 2.3 * (.55 + fill * .45), done ? col : shade(col, .35));
      if (!done) for (var i = 0; i < pot.parts.length; i++) drawIngredient(ctx, pot.parts[0], true, x + (i - 1) * u * 1.6, y - u * .2, s * .35);
      if (pot.parts.length === 3) {
        // bubbles
        for (var b = 0; b < 3; b++) {
          var ph = (t / 600 + b * .33) % 1;
          circle(ctx, x + (b - 1) * u * 1.4, y - u * .3 - ph * u, u * (.3 + ph * .3), 'rgba(255,255,255,' + (0.6 - ph * .5) + ')');
        }
      }
    }
    ctx.restore();
  }

  function drawPan(ctx, pan, x, y, s) {
    var u = s / 10;
    ctx.save();
    ctx.save(); ctx.translate(x, y); ctx.rotate(-0.5);
    rr(ctx, u * 3, -u * .7, u * 4, u * 1.4, u * .7); ctx.fillStyle = '#3a2d26'; ctx.fill();
    ctx.restore();
    ellipse(ctx, x, y, u * 3.9, u * 3.3, '#2f3138'); outline(ctx, u * .45, '#15161a');
    ellipse(ctx, x, y - u * .2, u * 3.1, u * 2.6, '#474a54');
    if (pan.parts.length) {
      if (pan.b) { ellipse(ctx, x, y - u * .2, u * 2.6, u * 1.9, '#221a16'); }
      else if (pan.p >= FRY_S) drawPatty(ctx, x, y - u * .2, s * .75);
      else {
        // raw -> brown as it fries
        var f = clamp(pan.p / FRY_S, 0, 1);
        ctx.globalAlpha = 1 - f; drawIngredient(ctx, 'meat', false, x, y - u * .2, s * .7);
        ctx.globalAlpha = f; drawPatty(ctx, x, y - u * .2, s * .75); ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * amt); g = Math.round(g + (255 - g) * amt); b = Math.round(b + (255 - b) * amt);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawItem(ctx, item, x, y, s, t) {
    if (!item) return;
    if (item.k === 'plate') drawPlate(ctx, item, x, y, s);
    else if (item.k === 'pot') drawPot(ctx, item, x, y, s, t);
    else if (item.k === 'pan') drawPan(ctx, item, x, y, s);
    else if (item.k === 'dirty') drawDirtyStack(ctx, item.n, x, y, s);
    else drawIngredient(ctx, item.k, item.s === 'chopped', x, y, s * .9);
  }

  function drawDirtyStack(ctx, n, x, y, s) {
    var u = s / 10;
    for (var i = 0; i < Math.min(n, 4); i++) {
      var yy = y + u - i * u * 1.1;
      ellipse(ctx, x, yy, u * 4, u * 2.6, '#e8e1d4'); outline(ctx, u * .35, '#9d917b');
      circle(ctx, x - u * 1.2, yy - u * .3, u * .6, '#b59a6a'); circle(ctx, x + u, yy + u * .2, u * .5, '#9fbf6a');
    }
    if (n > 1) badge(ctx, x + u * 3.6, y - u * 3, u * 2, String(n), '#8a6d4b');
  }

  function badge(ctx, x, y, r, text, color) {
    circle(ctx, x, y, r, color); outline(ctx, r * .18, '#fff');
    ctx.fillStyle = '#fff'; ctx.font = '800 ' + Math.round(r * 1.25) + 'px Nunito, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + r * .06);
  }

  function progressBar(ctx, x, y, w, frac, color) {
    var h = Math.max(5, w * .16);
    rr(ctx, x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4, h); ctx.fillStyle = 'rgba(40,30,25,.75)'; ctx.fill();
    rr(ctx, x - w / 2, y - h / 2, Math.max(h, w * clamp(frac, 0, 1)), h, h / 2); ctx.fillStyle = color; ctx.fill();
  }

  function bubble(ctx, x, y, r, fill, draw) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r * .3, y + r * .9); ctx.lineTo(x, y + r * 1.45); ctx.lineTo(x + r * .3, y + r * .9);
    ctx.fillStyle = fill; ctx.fill(); outline(ctx, r * .12, 'rgba(60,35,20,.4)');
    draw();
  }

  // ---------------------------------------------------------------- static kitchen layer

  function buildStatic() {
    var s = R.state, T = R.tile;
    var c = document.createElement('canvas');
    c.width = Math.round(s.w * T * R.dpr); c.height = Math.round(s.h * T * R.dpr);
    var g = c.getContext('2d');
    g.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    for (var y = 0; y < s.h; y++) for (var x = 0; x < s.w; x++) {
      var ch = s.grid[y][x], px = x * T, py = y * T;
      if (walkable(ch)) {
        g.fillStyle = (x + y) % 2 ? '#f3e3c8' : '#fbefd9'; g.fillRect(px, py, T, T);
        continue;
      }
      g.fillStyle = '#e7d3b2'; g.fillRect(px, py, T, T); // grout under blocks
    }
    // soft shadow of counters on the floor
    for (var y2 = 0; y2 < s.h; y2++) for (var x2 = 0; x2 < s.w; x2++) {
      if (walkable(s.grid[y2][x2])) continue;
      g.fillStyle = 'rgba(120,80,40,.13)'; g.fillRect(x2 * T + T * .08, y2 * T + T * .9, T * .92, T * .22);
    }
    for (var y3 = 0; y3 < s.h; y3++) for (var x3 = 0; x3 < s.w; x3++) {
      var ch3 = s.grid[y3][x3];
      if (!walkable(ch3)) drawBlock(g, ch3, x3 * T, y3 * T, T, x3, y3);
    }
    R.staticLayer = c;
  }

  function drawBlock(g, ch, px, py, T, tx, ty) {
    var top = T * .8, lip = T - top, pad = T * .03;
    var wood = '#d79a5c', woodDark = '#a8693a', woodTop = '#e8b278';
    if (ch === '#') { rr(g, px, py, T, T, T * .08); g.fillStyle = '#4b6b6b'; g.fill(); return; }
    var topCol = woodTop, faceCol = woodDark;
    if (ch === 'S' || ch === 'F') { topCol = '#6f7787'; faceCol = '#454b57'; }
    if (ch === 'W') { topCol = '#f2f2f2'; faceCol = '#c9c9c9'; }
    if (ch === 'K') { topCol = '#cfe2ee'; faceCol = '#8fa9ba'; }
    if (ch === 'T') { topCol = '#e8b278'; faceCol = woodDark; }
    // front face + top
    rr(g, px + pad, py + pad, T - pad * 2, T - pad * 2, T * .12); g.fillStyle = faceCol; g.fill();
    rr(g, px + pad, py + pad, T - pad * 2, top - pad, T * .12); g.fillStyle = topCol; g.fill();
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(px + T * .12, py + T * .1, T * .76, T * .06);
    if (ch === 'C' || CRATES[ch]) {
      g.strokeStyle = 'rgba(140,85,45,.25)'; g.lineWidth = Math.max(1, T * .025);
      g.beginPath(); g.moveTo(px + T * .1, py + T * .4); g.lineTo(px + T * .9, py + T * .4); g.stroke();
    }
    var cx = px + T / 2, cy = py + top / 2 + pad;
    if (CRATES[ch]) {
      rr(g, px + T * .12, py + T * .12, T * .76, T * .58, T * .08); g.fillStyle = '#b7773f'; g.fill(); outline(g, T * .03, '#7a4a22');
      g.strokeStyle = '#94592c'; g.lineWidth = T * .04;
      g.beginPath(); g.moveTo(px + T * .14, py + T * .32); g.lineTo(px + T * .86, py + T * .32); g.moveTo(px + T * .14, py + T * .52); g.lineTo(px + T * .86, py + T * .52); g.stroke();
      drawIngredient(g, CRATES[ch], false, cx, cy, T * .62);
    } else if (ch === 'B') {
      rr(g, px + T * .16, py + T * .14, T * .68, T * .52, T * .1); g.fillStyle = '#f7e6c4'; g.fill(); outline(g, T * .03, '#b98a52');
      // knife
      g.save(); g.translate(px + T * .8, py + T * .2); g.rotate(.6);
      rr(g, -T * .03, -T * .02, T * .1, T * .26, T * .03); g.fillStyle = '#d8dde4'; g.fill();
      rr(g, -T * .025, T * .22, T * .09, T * .14, T * .03); g.fillStyle = '#5a3a22'; g.fill();
      g.restore();
    } else if (ch === 'S' || ch === 'F') {
      circle(g, cx, cy, T * .32, '#2f343d');
      g.beginPath(); g.arc(cx, cy, T * .24, 0, Math.PI * 2); g.strokeStyle = '#59606d'; g.lineWidth = T * .04; g.stroke();
      circle(g, px + T * .16, py + T * .86, T * .045, '#ffcf5c'); circle(g, px + T * .84, py + T * .86, T * .045, '#ffcf5c');
    } else if (ch === 'P') {
      for (var i = 0; i < 3; i++) { ellipse(g, cx, cy + T * .12 - i * T * .07, T * .3, T * .17, '#fff'); outline(g, T * .02, '#a9b7c6'); }
    } else if (ch === 'W') {
      // awning stripes + bell
      for (var k = 0; k < 4; k++) { g.fillStyle = k % 2 ? '#fff' : '#ef5a4c'; g.fillRect(px + pad + k * (T - pad * 2) / 4, py + pad, (T - pad * 2) / 4, T * .2); }
      g.beginPath(); g.arc(cx, cy + T * .16, T * .16, Math.PI, 0); g.closePath(); g.fillStyle = '#f2b632'; g.fill(); outline(g, T * .025, '#9a6b0e');
      circle(g, cx, cy - T * .02, T * .04, '#9a6b0e');
      g.fillStyle = '#ef5a4c'; g.font = '900 ' + Math.round(T * .2) + 'px Nunito, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    } else if (ch === 'T') {
      rr(g, px + T * .22, py + T * .18, T * .56, T * .52, T * .1); g.fillStyle = '#5fa36a'; g.fill(); outline(g, T * .03, '#2f6a3a');
      rr(g, px + T * .17, py + T * .12, T * .66, T * .12, T * .05); g.fillStyle = '#437f4d'; g.fill();
      g.strokeStyle = '#2f6a3a'; g.lineWidth = T * .03; g.beginPath();
      g.moveTo(px + T * .38, py + T * .32); g.lineTo(px + T * .38, py + T * .62); g.moveTo(px + T * .62, py + T * .32); g.lineTo(px + T * .62, py + T * .62); g.stroke();
    } else if (ch === 'K') {
      rr(g, px + T * .14, py + T * .14, T * .72, T * .52, T * .14); g.fillStyle = '#7fbfe6'; g.fill(); outline(g, T * .03, '#4c86ab');
      ellipse(g, cx - T * .1, cy - T * .06, T * .12, T * .05, 'rgba(255,255,255,.7)');
      rr(g, cx - T * .04, py + T * .04, T * .08, T * .16, T * .03); g.fillStyle = '#9aa7b3'; g.fill();
    } else if (ch === 'R') {
      rr(g, px + T * .12, py + T * .14, T * .76, T * .52, T * .1); g.fillStyle = '#6a5446'; g.fill(); outline(g, T * .03, '#3f2f25');
      g.fillStyle = '#e8d9bf'; g.font = '900 ' + Math.round(T * .26) + 'px Nunito, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('↺', cx, cy);
    }
  }

  // ---------------------------------------------------------------- chefs

  function drawChef(ctx, chef, idx, x, y, T, t, isMe, moving) {
    var u = T / 10;
    var bob = moving ? Math.abs(Math.sin(t / 95 + idx)) * u * .9 : Math.sin(t / 500 + idx) * u * .2;
    var fx = chef.fx || 0, fy = chef.fy == null ? 1 : chef.fy;
    var col = CHEF_COLORS[idx % 4], dark = CHEF_DARK[idx % 4];
    ellipse(ctx, x, y + u * 2.4, u * 3.6, u * 1.3, 'rgba(70,40,20,.22)');
    var by = y - bob;
    var holdBehind = fy < -0.3;
    if (holdBehind) drawHeld(ctx, chef, x, by, T, t);
    // feet
    var step = moving ? Math.sin(t / 95 + idx) * u : 0;
    ellipse(ctx, x - u * 1.4, y + u * 2.1 + step * .3, u * 1.2, u * .8, '#5b3b2a');
    ellipse(ctx, x + u * 1.4, y + u * 2.1 - step * .3, u * 1.2, u * .8, '#5b3b2a');
    // body
    rr(ctx, x - u * 3, by - u * 3.2, u * 6, u * 5.6, u * 2.8); ctx.fillStyle = '#ffffff'; ctx.fill(); outline(ctx, u * .45);
    rr(ctx, x - u * 2.3, by - u * 1.4, u * 4.6, u * 3.6, u * 1.6); ctx.fillStyle = col; ctx.fill();
    ctx.fillStyle = dark; ctx.fillRect(x - u * 2.3, by - u * 1.4, u * 4.6, u * .7);
    // head
    circle(ctx, x, by - u * 4.6, u * 2.9, '#ffd9b8'); ctx.beginPath(); ctx.arc(x, by - u * 4.6, u * 2.9, 0, Math.PI * 2); outline(ctx, u * .45);
    // hat
    ctx.fillStyle = '#ffffff';
    rr(ctx, x - u * 2.3, by - u * 7.4, u * 4.6, u * 1.9, u * .5); ctx.fill(); outline(ctx, u * .35, 'rgba(60,35,20,.45)');
    circle(ctx, x - u * 1.5, by - u * 8, u * 1.6, '#fff'); circle(ctx, x + u * 1.5, by - u * 8, u * 1.6, '#fff'); circle(ctx, x, by - u * 8.8, u * 1.9, '#fff');
    ctx.beginPath(); ctx.arc(x, by - u * 8.8, u * 1.9, Math.PI * 1.05, Math.PI * 1.95); outline(ctx, u * .3, 'rgba(60,35,20,.3)');
    rr(ctx, x - u * 2.3, by - u * 6.1, u * 4.6, u * .6, u * .3); ctx.fillStyle = col; ctx.fill();
    // face looks where you're heading
    var ex = fx * u * 1.1, ey = Math.max(-.6, fy) * u * .7;
    if (fy > -0.75) {
      var blink = (Math.floor(t / 120 + idx * 7) % 34) === 0;
      if (blink) { ctx.fillStyle = '#3b2a20'; ctx.fillRect(x - u * 1.5 + ex, by - u * 4.4 + ey, u * 1, u * .3); ctx.fillRect(x + u * .5 + ex, by - u * 4.4 + ey, u * 1, u * .3); }
      else { circle(ctx, x - u * 1 + ex, by - u * 4.3 + ey, u * .55, '#3b2a20'); circle(ctx, x + u * 1 + ex, by - u * 4.3 + ey, u * .55, '#3b2a20'); }
      circle(ctx, x - u * 1.9 + ex, by - u * 3.4 + ey, u * .55, 'rgba(255,120,120,.45)');
      circle(ctx, x + u * 1.9 + ex, by - u * 3.4 + ey, u * .55, 'rgba(255,120,120,.45)');
      ctx.beginPath(); ctx.arc(x + ex, by - u * 3.6 + ey, u * .7, .15 * Math.PI, .85 * Math.PI); outline(ctx, u * .3, '#3b2a20');
    }
    // hands
    var hx = fx * u * 2.6, hy = fy * u * 1.2;
    circle(ctx, x - u * 2.2 + hx * .5, by - u * .4 + hy, u * .9, '#ffd9b8');
    circle(ctx, x + u * 2.2 + hx * .5, by - u * .4 + hy, u * .9, '#ffd9b8');
    if (!holdBehind) drawHeld(ctx, chef, x, by, T, t);
    // chopping knife animation
    if (chef.w && !chef.h) {
      var sw = Math.sin(t / 55) * .6;
      ctx.save(); ctx.translate(x + fx * u * 3.4, by - u * 1 + fy * u * 2); ctx.rotate(sw - .3);
      rr(ctx, -u * .4, -u * 3.2, u * 1.4, u * 2.8, u * .4); ctx.fillStyle = '#e3e8ee'; ctx.fill(); outline(ctx, u * .25, '#7d8794');
      rr(ctx, -u * .3, -u * .5, u * 1.1, u * 1.6, u * .3); ctx.fillStyle = '#5a3a22'; ctx.fill();
      ctx.restore();
    }
    // name tag
    var name = isMe ? _t('kc_you') : playerName(idx);
    ctx.font = '800 ' + Math.max(10, Math.round(u * 2.6)) + 'px Nunito, system-ui, sans-serif';
    var tw = ctx.measureText(name).width + u * 2.4;
    var tagY = Math.max(by - u * 13.6, 1); // keep the tag inside the canvas for chefs in the top row
    rr(ctx, x - tw / 2, tagY, tw, u * 3.2, u * 1.6); ctx.fillStyle = isMe ? col : 'rgba(255,255,255,.88)'; ctx.fill();
    ctx.fillStyle = isMe ? '#fff' : dark; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, x, tagY + u * 1.6);
  }

  function drawHeld(ctx, chef, x, by, T, t) {
    if (!chef.h) return;
    var u = T / 10;
    var fx = chef.fx || 0, fy = chef.fy == null ? 1 : chef.fy;
    drawItem(ctx, chef.h, x + fx * u * 3.2, by - u * .6 + fy * u * 2.2, T * .78, t);
  }

  // ---------------------------------------------------------------- HUD (orders, timer, score)

  function drawHud() {
    var c = R.hud, g = R.hudCtx, s = R.state;
    var W = R.hudW, H = R.hudH, t = nowMs();
    g.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    var right = Math.min(150, W * .3);
    // orders
    var cardW = Math.min(108, (W - right - 8) / Math.max(4, s.maxOrders || 4) - 6), cardH = H - 6;
    var x = 2;
    (s.orders || []).forEach(function (o, i) {
      var since = R.recvAt && s.phase === 'playing' && !isPaused() ? t - R.recvAt : 0;
      var left = Math.max(0, o.t - since), frac = left / o.T;
      var shake = frac < .2 ? Math.sin(t / 40) * 1.5 : 0;
      var appear = R.orderBorn[o.id] ? clamp((t - R.orderBorn[o.id]) / 260, 0, 1) : 1;
      var oy = 3 + (1 - appear) * -cardH;
      g.save(); g.translate(x + shake, oy);
      rr(g, 0, 0, cardW, cardH, 10); g.fillStyle = '#fffaf0'; g.fill(); outline(g, 2, frac < .2 ? '#e2483d' : '#d9b98a');
      // timer strip
      var stripCol = frac > .5 ? '#5fc46b' : frac > .2 ? '#f2b632' : '#e2483d';
      rr(g, 5, 4, (cardW - 10) * frac, 6, 3); g.fillStyle = stripCol; g.fill();
      // dish
      var dishS = Math.min(cardH * .52, cardW * .5);
      drawPlate(g, { parts: RECIPE_PARTS[o.r] }, cardW / 2, 12 + dishS * .55, dishS);
      // ingredients needed
      var ings = RECIPE_INGREDIENTS[o.r] || [];
      var is = Math.min(cardW / (ings.length + .6), cardH * .26);
      ings.forEach(function (k, j) {
        drawIngredient(g, k, false, cardW / 2 + (j - (ings.length - 1) / 2) * is, cardH - is * .62, is * .9);
      });
      g.restore();
      x += cardW + 6;
    });
    // timer + score
    var secs = Math.ceil(currentTimeLeft() / 1000);
    var mm = Math.floor(secs / 60), ss = secs % 60;
    var tx = W - right;
    rr(g, tx, 3, right - 2, H - 6, 12); g.fillStyle = '#4a3326'; g.fill();
    var low = secs <= 20 && s.phase === 'playing';
    g.fillStyle = low && Math.floor(t / 300) % 2 ? '#ff6b5c' : '#fff3df';
    g.font = '900 ' + Math.round((H - 6) * .36) + 'px Nunito, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('⏱ ' + mm + ':' + (ss < 10 ? '0' : '') + ss, tx + (right - 2) / 2, 3 + (H - 6) * .3);
    var shown = Math.round(R.scoreShown);
    g.fillStyle = '#ffd25c';
    g.fillText('🪙 ' + shown, tx + (right - 2) / 2, 3 + (H - 6) * .72);
  }

  function currentTimeLeft() {
    var s = R.state;
    if (!s) return 0;
    if (s.phase !== 'playing' || isPaused()) return s.phase === 'over' ? 0 : s.timeLeft;
    return Math.max(0, s.timeLeft - (nowMs() - R.recvAt));
  }

  // ---------------------------------------------------------------- local movement & input

  function myChef() { return R.state && R.state.chefs ? R.state.chefs[R.me] : null; }

  function inputVector() {
    var x = 0, y = 0, k = R.keys;
    if (k.left) x -= 1; if (k.right) x += 1; if (k.up) y -= 1; if (k.down) y += 1;
    if (R.joy.active) { x += R.joy.x; y += R.joy.y; }
    if (R.gp) { x += R.gp.x; y += R.gp.y; }
    var l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x: x, y: y };
  }

  function stepLocal(dt) {
    var s = R.state, me = R.local;
    if (!s || !me || s.phase === 'over') return;
    if (isPaused()) { me.vx = me.vy = 0; me.dash = 0; me.moving = false; return; }
    var inp = inputVector();
    var mag = Math.hypot(inp.x, inp.y);
    if (mag > .15) { me.fx = inp.x / mag; me.fy = inp.y / mag; }
    var tvx = inp.x * SPEED, tvy = inp.y * SPEED;
    var a = 1 - Math.exp(-dt * 22);
    me.vx += (tvx - me.vx) * a; me.vy += (tvy - me.vy) * a;
    var vx = me.vx, vy = me.vy;
    if (me.dash > 0) { vx = me.fx * DASH_SPEED; vy = me.fy * DASH_SPEED; me.dash -= dt; }
    me.dashCd = Math.max(0, me.dashCd - dt);
    var steps = Math.ceil(Math.hypot(vx, vy) * dt / .2) || 1;
    for (var i = 0; i < steps; i++) {
      var nx = me.x + vx * dt / steps;
      if (!collides(s, nx, me.y, RADIUS)) me.x = nx;
      var ny = me.y + vy * dt / steps;
      if (!collides(s, me.x, ny, RADIUS)) me.y = ny;
    }
    laneAssist(s, me, vx, vy, dt);
    // Soft push away from other chefs so you can't stand inside each other.
    s.chefs.forEach(function (c, i) {
      if (i === R.me) return;
      var p = R.drawn[i] || c;
      var dx = me.x - p.x, dy = me.y - p.y, d = Math.hypot(dx, dy);
      if (d > 0.001 && d < RADIUS * 2) {
        var push = (RADIUS * 2 - d) * .5;
        var px = me.x + dx / d * push, py = me.y + dy / d * push;
        if (!collides(s, px, me.y, RADIUS)) me.x = px;
        if (!collides(s, me.x, py, RADIUS)) me.y = py;
      }
    });
    me.moving = Math.hypot(me.vx, me.vy) > .5 || me.dash > 0;
  }

  // Lane assist: when moving mostly along one axis, ease the other axis toward the
  // centre of a row/column, so you slide past corners and stop square to stations.
  // The lane is the current one, unless it's blocked ahead and the neighbouring lane
  // (which you're already brushing) is open, in which case you slide into that one.
  var LANE_RATIO = 2.5, LANE_HALF_LIFE = .15, LANE_MAX = SPEED * .6, LANE_SWITCH = .8;
  function laneAssist(s, me, vx, vy, dt) {
    var ax = Math.abs(vx), ay = Math.abs(vy);
    if (Math.max(ax, ay) < .5) return;
    var axis = ax > ay * LANE_RATIO ? 'y' : ay > ax * LANE_RATIO ? 'x' : null;
    if (!axis) return;
    var cur = me[axis], lane = Math.floor(cur) + .5;
    var other = lane + (cur > lane ? 1 : -1);
    if (!laneOpen(s, me, axis, lane, vx, vy) && Math.abs(other - cur) < LANE_SWITCH &&
        laneOpen(s, me, axis, other, vx, vy)) lane = other;
    var d = (lane - cur) * (1 - Math.pow(.5, dt / LANE_HALF_LIFE));
    var cap = LANE_MAX * dt;
    d = Math.max(-cap, Math.min(cap, d));
    if (Math.abs(d) < 1e-4) return;
    var nx = axis === 'x' ? me.x + d : me.x, ny = axis === 'y' ? me.y + d : me.y;
    if (!collides(s, nx, ny, RADIUS)) { me.x = nx; me.y = ny; }
  }
  // Is the next tile ahead (along the travel axis) in this lane walkable?
  function laneOpen(s, me, axis, lane, vx, vy) {
    var tx = axis === 'x' ? Math.floor(lane) : Math.floor(me.x + Math.sign(vx) * (RADIUS + .5));
    var ty = axis === 'y' ? Math.floor(lane) : Math.floor(me.y + Math.sign(vy) * (RADIUS + .5));
    return walkable(tileAt(s, tx, ty));
  }

  // Stickiness: the current target keeps a small bonus so it doesn't flicker between neighbours.
  var TARGET_STICK = .35;
  function findTarget() {
    var s = R.state, me = R.local;
    if (!s || !me) return null;
    var best = null, bestScore = -1e9;
    var x0 = Math.floor(me.x), y0 = Math.floor(me.y);
    var handsFree = !(myChef() && myChef().h);
    for (var ty = y0 - 2; ty <= y0 + 2; ty++) for (var tx = x0 - 2; tx <= x0 + 2; tx++) {
      var dx = tx + .5 - me.x, dy = ty + .5 - me.y, d = Math.hypot(dx, dy);
      if (d > REACH - .08) continue;
      var align = d > .01 ? (dx * me.fx + dy * me.fy) / d : 1;
      // Thrown food lying on the floor: under or beside you comes first, further needs facing.
      if (s.floor && s.floor[tx + ',' + ty]) {
        if (!handsFree) continue;
        var close = Math.abs(tx - x0) + Math.abs(ty - y0) <= 1;
        if (!close && align < .25) continue;
        var fs = (close ? 13 : 0) + align * 2 - d;
        if (fs > bestScore) { bestScore = fs; best = { x: tx, y: ty }; }
        continue;
      }
      if (!interactive(tileAt(s, tx, ty))) continue;
      // Like Overcooked: a counter beside the square you stand on always wins, whichever way
      // you face (facing only breaks ties, e.g. in a corner). Anything further needs facing.
      var adjacent = Math.abs(tx - x0) + Math.abs(ty - y0) === 1;
      if (!adjacent && align < .25) continue;
      var score = (adjacent ? 10 : 0) + align * 2 - d;
      if (R.lastTgt && R.lastTgt.x === tx && R.lastTgt.y === ty) score += TARGET_STICK;
      if (score > bestScore) { bestScore = score; best = { x: tx, y: ty }; }
    }
    R.lastTgt = best;
    return best;
  }

  function sendPos(force) {
    var me = R.local, t = nowMs();
    if (!me || !window.makeGameMove) return;
    var moved = !R.lastSent || Math.abs(me.x - R.lastSent.x) > .005 || Math.abs(me.y - R.lastSent.y) > .005 ||
      Math.abs(me.fx - R.lastSent.fx) > .05 || Math.abs(me.fy - R.lastSent.fy) > .05;
    if (!force && (!moved || t - R.lastSendAt < SEND_MS)) return;
    R.lastSendAt = t;
    R.lastSent = { x: me.x, y: me.y, fx: me.fx, fy: me.fy };
    window.makeGameMove({ type: 'pos', x: round3(me.x), y: round3(me.y), fx: round3(me.fx), fy: round3(me.fy) });
  }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  function vesselReady(v) {
    if (!v || v.b || (v.k !== 'pot' && v.k !== 'pan')) return false;
    return v.k === 'pot' ? v.parts.length === 3 && v.p >= COOK_S : v.parts.length === 1 && v.p >= FRY_S;
  }

  // What the grab button would do on this tile, for the button label / desktop hint.
  function grabAction(tgt) {
    var s = R.state, me = myChef();
    if (!tgt || !me || !s) return null;
    var k = tgt.x + ',' + tgt.y, ch = tileAt(s, tgt.x, tgt.y), item = s.items[k], st = s.stations[k], h = me.h;
    if (s.floor && s.floor[k]) return h ? null : 'take';
    if (!h) return (item || CRATES[ch] || ((ch === 'P' || ch === 'R') && st && st.n > 0)) ? 'take' : null;
    if (ch === 'W') return h.k === 'plate' && h.parts.length ? 'serve' : null;
    if (ch === 'T') return 'bin';
    if (ch === 'P' || ch === 'R' || ch === 'K') return null;
    if ((h.k === 'plate' && vesselReady(item)) || (vesselReady(h) && item && item.k === 'plate')) return 'scoop';
    return 'drop';
  }

  function isIngredient(item) { return !!item && INGREDIENT_KINDS.indexOf(item.k) >= 0; }
  function canThrow() { var c = myChef(); return !!c && isIngredient(c.h); }

  function act(kind) {
    var s = R.state, me = R.local;
    if (!s || !me || s.phase !== 'playing' || isPaused()) return;
    var msg = { x: round3(me.x), y: round3(me.y), fx: round3(me.fx), fy: round3(me.fy) }, pred = null;
    // Use while holding an ingredient throws it the way you face.
    if (kind === 'use' && canThrow()) {
      msg.type = 'throw';
      pred = { at: nowMs(), x: me.x, y: me.y, fx: me.fx, fy: me.fy, fn: predictThrow };
    } else {
      var tgt = findTarget();
      if (!tgt) { pressFlash(kind); return; }
      msg.type = kind; msg.tx = tgt.x; msg.ty = tgt.y;
      if (kind === 'grab') {
        if (grabAction(tgt)) SFX.pop();
        pred = { at: nowMs(), tx: tgt.x, ty: tgt.y, fn: predictGrab };
      }
    }
    pressFlash(kind);
    msg.seq = ++R.seq;
    R.lastSent = { x: me.x, y: me.y, fx: me.fx, fy: me.fy };
    R.lastSendAt = nowMs();
    window.makeGameMove(msg);
    // Show the result now instead of after a round trip (slow over phone Wi-Fi / tunnels); the
    // server's state takes over once it echoes this action's number (see applyPredictions).
    if (pred) { pred.seq = msg.seq; R.preds.push(pred); pred.fn(R.state, R.me, pred); }
    vibrate(12);
  }

  // ---- local prediction of grab / drop / throw ----
  var PREDICT_MS = 1000;
  function applyPredictions(s) {
    var mine = s.chefs && s.chefs[R.me], ack = mine && mine.ack != null ? mine.ack : -1, t = nowMs();
    R.preds = R.preds.filter(function (p) { return p.seq > ack && t - p.at < PREDICT_MS; });
    R.preds.forEach(function (p) { p.fn(s, R.me, p); });
  }
  // Mirrors the simple, certain cases of the server's interact(); merging items and serving wait for it.
  function predictGrab(s, i, p) {
    var c = s.chefs && s.chefs[i];
    if (!c) return;
    var k = p.tx + ',' + p.ty, ch = tileAt(s, p.tx, p.ty), h = c.h, item = s.items[k], st = s.stations && s.stations[k];
    if (walkable(ch)) { if (!h && s.floor && s.floor[k]) { c.h = s.floor[k]; delete s.floor[k]; } return; }
    if (ch === 'P') {
      if (!h && st && st.n > 0) { st.n--; c.h = { k: 'plate', parts: [] }; }
      else if (h && h.k === 'plate' && !h.parts.length && st) { st.n++; c.h = null; }
      return;
    }
    if (ch === 'R') {
      if (!h && st && st.n > 0) { c.h = { k: 'dirty', n: st.n }; st.n = 0; }
      else if (h && h.k === 'dirty' && st) { st.n += h.n; c.h = null; }
      return;
    }
    if (ch === 'K') { if (h && h.k === 'dirty' && st) { st.n += h.n; c.h = null; } return; }
    if (ch === 'T') {
      if (!h) return;
      if (isIngredient(h)) c.h = null;
      else if (h.k === 'plate') h.parts = [];
      else if (h.k === 'pot' || h.k === 'pan') { h.parts = []; h.p = 0; h.b = false; }
      return;
    }
    if (!(ch === 'C' || ch === 'B' || ch === 'S' || ch === 'F' || CRATES[ch])) return;
    if (!h) {
      if (item) { c.h = item; delete s.items[k]; }
      else if (CRATES[ch]) c.h = { k: CRATES[ch], s: 'raw' };
      return;
    }
    if (item || (CRATES[ch] && h.k === 'plate')) return;
    var fits = ch === 'S' || ch === 'F' ? h.k === 'pot' || h.k === 'pan' : ch === 'B' ? isIngredient(h) : true;
    if (fits) { s.items[k] = h; c.h = null; }
  }
  function predictThrow(s, i, p) {
    var c = s.chefs && s.chefs[i];
    if (!c || !isIngredient(c.h)) return;
    var l = Math.hypot(p.fx, p.fy) || 1, f = { item: c.h, x: p.x, y: p.y, dx: p.fx / l, dy: p.fy / l, d: 0 };
    // carry it as far as it has flown since the press, stopping at the first counter
    var want = Math.min(THROW_RANGE, THROW_SPEED * (nowMs() - p.at) / 1000);
    while (f.d < want) {
      var st = Math.min(.1, want - f.d), nx = f.x + f.dx * st, ny = f.y + f.dy * st;
      if (!walkable(tileAt(s, Math.floor(nx), Math.floor(ny)))) break;
      f.x = nx; f.y = ny; f.d += st;
    }
    c.h = null;
    s.flying = (s.flying || []).concat([f]);
  }

  function dash() {
    var me = R.local;
    if (!me || !R.state || R.state.phase === 'over' || me.dashCd > 0) return;
    me.dash = DASH_S; me.dashCd = DASH_CD;
    pressFlash('dash');
    addPuff(me.x - me.fx * .3, me.y - me.fy * .3);
  }

  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

  function pressFlash(kind) {
    var b = R.root && R.root.querySelector('[data-kc="' + kind + '"]');
    if (!b) return;
    b.classList.add('kc-hit'); setTimeout(function () { b.classList.remove('kc-hit'); }, 120);
  }

  // ---------------------------------------------------------------- effects

  function addPuff(x, y) { R.particles.push({ k: 'puff', x: x, y: y, born: nowMs(), life: 420 }); }

  function handleFx(list) {
    list.forEach(function (f) {
      if (f.id <= R.fxSeen) return;
      R.fxSeen = f.id;
      if (R.skipFx) return;
      var t = nowMs();
      var snd = { pause: 'pop', resume: 'pop', serve: 'serve', wrong: 'wrong', expire: 'miss', burnt: 'wrong', chop: 'chop', cooked: 'ding', go: 'go', over: 'over', washed: 'pop', trash: 'pop',
        'throw': 'whoosh', 'catch': 'pop', land: 'thud', splat: 'thud' }[f.k];
      if (snd) SFX[snd]();
      if (f.k === 'serve') { R.particles.push({ k: 'text', x: f.x + .5, y: f.y, text: '+' + f.pts, color: '#2e9e4a', born: t, life: 1100 }); confetti(f.x + .5, f.y + .5); vibrate(25); }
      else if (f.k === 'wrong') R.particles.push({ k: 'text', x: f.x + .5, y: f.y, text: _t('kc_not_ordered'), color: '#e2483d', born: t, life: 1100, small: true });
      else if (f.k === 'expire') { R.banner = { text: _t('kc_order_missed') + ' ' + f.pts, color: '#e2483d', born: t }; vibrate(40); }
      else if (f.k === 'burnt') { R.particles.push({ k: 'text', x: f.x + .5, y: f.y, text: _t('kc_burnt'), color: '#3a2a22', born: t, life: 1400, small: true }); }
      else if (f.k === 'chop') { for (var i = 0; i < 5; i++) R.particles.push({ k: 'bit', x: f.x + .5, y: f.y + .45, vx: (Math.random() - .5) * 3, vy: -Math.random() * 3 - 1, born: t, life: 500, color: '#ffffff' }); }
      else if (f.k === 'cooked') R.particles.push({ k: 'text', x: f.x + .5, y: f.y, text: '✓', color: '#2e9e4a', born: t, life: 900 });
      else if (f.k === 'go') R.banner = { text: _t('kc_go'), color: '#2e9e4a', born: t, big: true };
      else if (f.k === 'over') R.banner = { text: _t('kc_times_up'), color: '#4a3326', born: t, big: true, hold: true };
      else if (f.k === 'order') R.orderBorn[f.oid] = t;
      else if (f.k === 'trash') addPuff(f.x + .5, f.y + .4);
      else if (f.k === 'splash' || f.k === 'washed') { for (var j = 0; j < 4; j++) R.particles.push({ k: 'bit', x: f.x + .5, y: f.y + .4, vx: (Math.random() - .5) * 2.4, vy: -Math.random() * 2.5 - .5, born: t, life: 450, color: '#bfe6ff' }); }
    });
  }

  function confetti(x, y) {
    var cols = ['#ff7a6b', '#4fb3ff', '#5fd08e', '#ffc23d', '#c88bff'];
    for (var i = 0; i < 14; i++) R.particles.push({ k: 'bit', x: x, y: y, vx: (Math.random() - .5) * 6, vy: -Math.random() * 5 - 2, born: nowMs(), life: 900, color: cols[i % cols.length], square: true });
  }

  function drawParticles(ctx, T, t) {
    R.particles = R.particles.filter(function (p) { return t - p.born < p.life; });
    R.particles.forEach(function (p) {
      var a = (t - p.born) / p.life;
      ctx.save(); ctx.globalAlpha = 1 - a;
      if (p.k === 'text') {
        ctx.font = '900 ' + Math.round(T * (p.small ? .34 : .55)) + 'px Nunito, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var yy = (p.y - a * 1.1) * T;
        ctx.lineWidth = T * .09; ctx.strokeStyle = '#fff'; ctx.strokeText(p.text, p.x * T, yy);
        ctx.fillStyle = p.color; ctx.fillText(p.text, p.x * T, yy);
      } else if (p.k === 'puff') {
        circle(ctx, p.x * T, p.y * T - a * T * .3, T * (.15 + a * .25), 'rgba(255,255,255,.8)');
      } else if (p.k === 'bit') {
        var tt = (t - p.born) / 1000;
        var bx = (p.x + p.vx * tt) * T, by = (p.y + p.vy * tt + 6 * tt * tt) * T;
        ctx.fillStyle = p.color;
        if (p.square) { ctx.translate(bx, by); ctx.rotate(tt * 8); ctx.fillRect(-T * .05, -T * .05, T * .1, T * .1); }
        else { ctx.beginPath(); ctx.arc(bx, by, T * .05, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
    });
  }

  // ---------------------------------------------------------------- main frame

  function interpolatedChef(i) {
    var buf = R.snaps, t = nowMs() - INTERP_MS;
    if (!buf.length) return null;
    var a = null, b = null;
    for (var k = buf.length - 1; k >= 0; k--) { if (buf[k].at <= t) { a = buf[k]; b = buf[k + 1] || null; break; } }
    if (!a) return buf[0].chefs[i];
    var ca = a.chefs[i];
    if (!b || !ca) return ca;
    var cb = b.chefs[i];
    if (!cb) return ca;
    var f = clamp((t - a.at) / Math.max(1, b.at - a.at), 0, 1);
    return { x: ca.x + (cb.x - ca.x) * f, y: ca.y + (cb.y - ca.y) * f, fx: cb.fx, fy: cb.fy };
  }

  function frame() {
    if (!R || !R.canvas || !document.body.contains(R.canvas)) { teardown(); return; }
    R.raf = requestAnimationFrame(frame);
    var t = nowMs();
    // Real elapsed time (capped for tab switches) so slow phones walk as fast as PCs; stepLocal sub-steps.
    var dt = Math.min(.1, (t - (R.lastFrame || t)) / 1000);
    R.lastFrame = t;
    var s = R.state;
    if (!s || !s.grid || !s.grid.length) return;
    if (!R.staticLayer) buildStatic();

    var pausedBy = isPaused() ? s.paused : null;
    if (pausedBy !== R.pausedShown) {
      R.pausedShown = pausedBy;
      R.root.classList.toggle('kc-paused', pausedBy !== null);
      if (pausedBy !== null) R.pauseText.textContent = '⏸ ' + _tf('kc_paused_by', pausedBy === R.me ? _t('kc_you') : playerName(pausedBy));
      R.pauseBtn.textContent = pausedBy !== null ? '▶' : '⏸';
    }

    pollPad();
    stepLocal(dt);
    if (pausedBy === null) sendPos(false);
    R.scoreShown += (s.score - R.scoreShown) * Math.min(1, dt * 8);

    var ctx = R.ctx, T = R.tile;
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.clearRect(0, 0, R.cw, R.ch);
    ctx.drawImage(R.staticLayer, 0, 0, s.w * T, s.h * T);

    // target highlight
    var tgt = s.phase !== 'over' ? findTarget() : null;
    var ga = grabAction(tgt);
    var lbl = _t('kc_btn_' + (ga || 'grab'));
    if (lbl !== R.grabLbl && R.grabSpan) { R.grabLbl = lbl; R.grabSpan.textContent = lbl; }
    var ulbl = _t(canThrow() ? 'kc_btn_throw' : 'kc_btn_use');
    if (ulbl !== R.useLbl && R.useSpan) { R.useLbl = ulbl; R.useSpan.textContent = ulbl; R.useIcon.textContent = canThrow() ? '🎯' : '🔪'; }
    if (tgt) {
      var pulse = .55 + Math.sin(t / 160) * .2;
      rr(ctx, tgt.x * T + T * .04, tgt.y * T + T * .04, T * .92, T * .76, T * .14);
      ctx.lineWidth = Math.max(2, T * .07); ctx.strokeStyle = 'rgba(255,255,255,' + pulse + ')'; ctx.stroke();
      ctx.lineWidth = Math.max(1, T * .03); ctx.strokeStyle = CHEF_COLORS[R.me % 4]; ctx.stroke();
    }

    // station overlays: counts, sink water, stove glow
    Object.keys(s.stations || {}).forEach(function (k) {
      var p = k.split(','), x = +p[0], y = +p[1], st = s.stations[k], ch = tileAt(s, x, y);
      var cx = (x + .5) * T, cy = (y + .4) * T;
      if (ch === 'P') { if (st.n > 0) badge(ctx, cx + T * .3, cy - T * .22, T * .16, String(st.n), '#5a7fa8'); else crossOut(ctx, cx, cy, T); }
      if (ch === 'R' && st.n > 0) drawDirtyStack(ctx, st.n, cx, cy, T * .6);
      if (ch === 'K' && st.n > 0) {
        drawDirtyStack(ctx, st.n, cx, cy + T * .05, T * .55);
      }
    });

    // items on surfaces
    Object.keys(s.items || {}).forEach(function (k) {
      var p = k.split(','), x = +p[0], y = +p[1], item = s.items[k], ch = tileAt(s, x, y);
      var cx = (x + .5) * T, cy = (y + .42) * T;
      var cooking = (ch === 'S' || ch === 'F') && item && (item.k === 'pot' || item.k === 'pan') && !item.b &&
        item.parts.length === (item.k === 'pot' ? 3 : 1);
      if (cooking) circle(ctx, cx, cy + T * .02, T * (.36 + Math.sin(t / 90) * .015), 'rgba(255,120,40,.55)');
      drawItem(ctx, item, cx, cy, T * .82, t);
      if (vesselReady(item) && (ch === 'S' || ch === 'F') && item.p - (item.k === 'pot' ? COOK_S : FRY_S) > BURN_S * .35 && t - (R.alarmAt[k] || 0) > 1000) {
        R.alarmAt[k] = t; SFX.alarm();
      }
    });

    // thrown food lying on the floor
    Object.keys(s.floor || {}).forEach(function (k) {
      var p = k.split(','), cx = (+p[0] + .5) * T, cy = (+p[1] + .5) * T;
      ellipse(ctx, cx, cy + T * .16, T * .24, T * .08, 'rgba(60,35,20,.18)');
      drawItem(ctx, s.floor[k], cx, cy, T * .62, t);
    });

    // chefs, back to front
    var order = s.chefs.map(function (c, i) {
      var pos;
      if (i === R.me && R.local) pos = { x: R.local.x, y: R.local.y, fx: R.local.fx, fy: R.local.fy, moving: R.local.moving };
      else {
        var ip = interpolatedChef(i) || c;
        var prev = R.drawn[i];
        pos = { x: ip.x, y: ip.y, fx: ip.fx, fy: ip.fy, moving: prev ? Math.hypot(ip.x - prev.x, ip.y - prev.y) > dt * .6 : false };
      }
      R.drawn[i] = pos;
      return { i: i, c: c, pos: pos };
    }).sort(function (a, b) { return a.pos.y - b.pos.y; });
    order.forEach(function (o) {
      var view = { fx: o.pos.fx, fy: o.pos.fy, h: o.c.h, w: o.c.w };
      drawChef(ctx, view, o.i, o.pos.x * T, o.pos.y * T, T, t, o.i === R.me, o.pos.moving);
    });

    drawFlying(ctx, s, T, t);

    // Status indicators on top of everything (chefs standing at a stove used to hide them).
    Object.keys(s.items || {}).forEach(function (k) {
      var p = k.split(','), x = +p[0], y = +p[1];
      overhead(ctx, s.items[k], tileAt(s, x, y), (x + .5) * T, y, T, t);
    });
    Object.keys(s.stations || {}).forEach(function (k) {
      var p = k.split(','), x = +p[0], y = +p[1], st = s.stations[k];
      if (tileAt(s, x, y) === 'K' && st.n > 0 && st.p > 0) progressBar(ctx, (x + .5) * T, indicatorY(y, T), T * .7, st.p, '#4fb3ff');
    });

    drawParticles(ctx, T, t);
    drawBanner(ctx, t);
    drawHud();
  }

  // Thrown ingredients: the server sends a position each tick; carry it forward between ticks
  // (stopping at the first counter) and lift it on an arc over its shadow.
  function drawFlying(ctx, s, T, t) {
    (s.flying || []).forEach(function (f) {
      var since = isPaused() ? 0 : Math.min(.1, (t - R.recvAt) / 1000);
      var ahead = Math.min(THROW_SPEED * since, THROW_RANGE - f.d), x = f.x, y = f.y, gone = 0;
      while (gone < ahead) {
        var st = Math.min(.1, ahead - gone), nx = x + f.dx * st, ny = y + f.dy * st;
        if (!walkable(tileAt(s, Math.floor(nx), Math.floor(ny)))) break;
        x = nx; y = ny; gone += st;
      }
      var p = clamp((f.d + gone) / THROW_RANGE, 0, 1);
      var lift = (.22 + Math.sin(p * Math.PI) * .38) * T;
      ellipse(ctx, x * T, y * T + T * .2, T * .2, T * .07, 'rgba(60,35,20,.22)');
      ctx.save(); ctx.translate(x * T, y * T - lift); ctx.rotate(t / 90 % (Math.PI * 2));
      drawItem(ctx, f.item, 0, 0, T * .6, t);
      ctx.restore();
    });
  }

  function crossOut(ctx, cx, cy, T) {
    ctx.save(); ctx.globalAlpha = .55 + Math.sin(nowMs() / 200) * .2;
    ctx.strokeStyle = '#e2483d'; ctx.lineWidth = T * .07; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - T * .18, cy - T * .18); ctx.lineTo(cx + T * .18, cy + T * .18); ctx.moveTo(cx + T * .18, cy - T * .18); ctx.lineTo(cx - T * .18, cy + T * .18); ctx.stroke();
    ctx.restore();
  }

  // Where a tile's progress bar / bubble goes. Normally just above the tile; for the top row that
  // would be off the board (it looked hidden behind the timer), so those go just below the counter.
  function indicatorY(y, T) {
    return y === 0 ? (y + 1.14) * T : (y - .14) * T;
  }

  // Progress / done / burning indicators for a tile (drawn after the chefs so nobody covers them).
  function overhead(ctx, item, ch, cx, y, T, t) {
    if (!item) return;
    var topY = (y - .02) * T;
    var by = indicatorY(y, T);
    var bubbleY = y === 0 ? by + T * .1 : by - T * .2;
    if ((item.k === 'pot' || item.k === 'pan') && item.parts.length) {
      var need = item.k === 'pot' ? 3 : 1, doneAt = item.k === 'pot' ? COOK_S : FRY_S;
      if (item.b) {
        bubble(ctx, cx, bubbleY, T * .2, '#3a2a22', function () { textIn(ctx, '✕', cx, bubbleY, T * .24, '#fff'); });
        smoke(ctx, cx, topY + T * .2, T, t);
      } else if (item.parts.length < need) {
        if (item.k === 'pot') pips(ctx, cx, by, T, item.parts.length, need);
      } else if (item.p < doneAt) {
        progressBar(ctx, cx, by, T * .7, item.p / doneAt, '#5fc46b');
      } else {
        var burnFrac = (item.p - doneAt) / BURN_S;
        if (burnFrac > .35) {
          var flash = Math.floor(t / (burnFrac > .7 ? 110 : 220)) % 2;
          bubble(ctx, cx, bubbleY, T * .2, flash ? '#e2483d' : '#ffb03a', function () { textIn(ctx, '!', cx, bubbleY, T * .3, '#fff'); });
        } else {
          bubble(ctx, cx, bubbleY, T * .2, '#5fc46b', function () { textIn(ctx, '✓', cx, bubbleY, T * .26, '#fff'); });
        }
        steam(ctx, cx, topY + T * .2, T, t);
      }
    } else if (ch === 'B' && item.c > 0 && item.s === 'raw') {
      progressBar(ctx, cx, by, T * .7, item.c, '#4fb3ff');
    }
  }
  function pips(ctx, cx, y, T, have, need) {
    for (var i = 0; i < need; i++) {
      circle(ctx, cx + (i - (need - 1) / 2) * T * .2, y, T * .07, i < have ? '#5fc46b' : 'rgba(40,30,25,.45)');
    }
  }
  function textIn(ctx, txt, x, y, size, color) {
    ctx.fillStyle = color; ctx.font = '900 ' + Math.round(size) + 'px Nunito, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, x, y + size * .05);
  }
  function steam(ctx, x, y, T, t) {
    for (var i = 0; i < 3; i++) {
      var ph = (t / 900 + i / 3) % 1;
      circle(ctx, x + Math.sin(ph * 6 + i) * T * .08 + (i - 1) * T * .1, y - ph * T * .55, T * (.05 + ph * .07), 'rgba(255,255,255,' + (.55 * (1 - ph)) + ')');
    }
  }
  function smoke(ctx, x, y, T, t) {
    for (var i = 0; i < 4; i++) {
      var ph = (t / 1100 + i / 4) % 1;
      circle(ctx, x + Math.sin(ph * 5 + i) * T * .12, y - ph * T * .8, T * (.07 + ph * .12), 'rgba(60,55,55,' + (.5 * (1 - ph)) + ')');
    }
  }

  function drawBanner(ctx, t) {
    var s = R.state, W = R.cw, H = R.ch;
    if (s.phase === 'countdown') {
      var n = Math.ceil(s.countdown / 1000 - (nowMs() - R.recvAt) / 1000);
      n = clamp(n, 1, 3);
      if (n !== R.lastCount) { R.lastCount = n; SFX.tick(); }
      ctx.save(); ctx.fillStyle = 'rgba(60,35,20,.28)'; ctx.fillRect(0, 0, W, H);
      textBig(ctx, String(n), W / 2, H * .45, H * .3, '#fff', '#ef5a4c');
      textBig(ctx, _t('kc_get_ready'), W / 2, H * .7, H * .08, '#fff', '#4a3326');
      ctx.restore();
      return;
    }
    var b = R.banner;
    if (!b) return;
    var age = t - b.born, life = b.hold ? 1e9 : (b.big ? 900 : 1600);
    if (age > life) { R.banner = null; return; }
    var a = b.hold ? 1 : 1 - Math.max(0, (age - life * .6) / (life * .4));
    var sc = b.big ? 1 + Math.max(0, .4 - age / 400) : 1;
    ctx.save(); ctx.globalAlpha = a;
    if (b.big) textBig(ctx, b.text, W / 2, H * .45, H * .16 * sc, '#fff', b.color);
    else {
      ctx.font = '900 ' + Math.round(H * .06) + 'px Nunito, system-ui, sans-serif';
      var tw = ctx.measureText(b.text).width + 28;
      rr(ctx, W / 2 - tw / 2, H * .06, tw, H * .1, 14); ctx.fillStyle = b.color; ctx.fill();
      textIn(ctx, b.text, W / 2, H * .11, H * .06, '#fff');
    }
    ctx.restore();
  }
  function textBig(ctx, txt, x, y, size, fill, stroke) {
    ctx.font = '900 ' + Math.round(size) + 'px Nunito, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = size * .16; ctx.strokeStyle = stroke; ctx.strokeText(txt, x, y);
    ctx.fillStyle = fill; ctx.fillText(txt, x, y);
  }

  // ---------------------------------------------------------------- layout

  function isTouch() {
    return R.touchSeen || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  }

  function layout() {
    if (!R || !R.state || !R.state.grid || !R.state.grid.length) return;
    var s = R.state, root = R.root;
    var touch = isTouch();
    var vw = window.innerWidth, vh = window.innerHeight;
    var landscape = vw > vh * 1.15;
    root.classList.toggle('kc-touch', touch);
    root.classList.toggle('kc-land', touch && landscape);
    var fit = window.boardFit ? window.boardFit(root) : { w: vw - 24, h: vh - 200 };
    var availW = Math.min(fit.w, vw - 12);
    var sideW = touch && landscape ? Math.min(170, Math.max(120, vw * .17)) : 0;
    var padH = touch && !landscape ? 150 : 0;
    var hudH = clamp(Math.round(Math.min(availW, 720) * .12), 56, 78);
    var top = R.wrap.getBoundingClientRect().top;
    var actions = document.getElementById('gameActions');
    var actionsH = actions && actions.offsetParent ? actions.offsetHeight + 10 : 0;
    var availH = vh - Math.max(0, top) - padH - hudH - actionsH - 14;
    // Landscape phones: give the kitchen the whole screen height and scroll the page header away.
    if (touch && landscape) availH = vh - hudH - 18;
    // ⏸ ⚙ 🔊 never sit on the order strip: a pad column on phones, the key-hint bar on desktop.
    var home = touch ? R.toolSlot : R.toolBar;
    if (R.tools.parentNode !== home) home.appendChild(R.tools);
    var boardW = availW - sideW * 2 - (touch && landscape ? TOOLSLOT_W + 8 : 0);
    var tile = Math.floor(Math.min(boardW / s.w, availH / s.h, 72));
    tile = Math.max(touch ? 20 : 26, tile);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var changed = tile !== R.tile || dpr !== R.dpr || R.builtLevel !== s.level + ':' + s.w;
    R.dpr = dpr;
    R.tile = tile;
    R.cw = s.w * tile; R.ch = s.h * tile;
    R.hudW = Math.max(R.cw, Math.min(availW, 520)); R.hudH = hudH;
    // room-client fires a synthetic resize on every state update (~15/s here). Assigning a canvas
    // width/height — even the same value — clears it, which phones show as the board blinking,
    // so only touch sizes that really changed.
    sizeCanvas(R.canvas, R.cw, R.ch, dpr);
    sizeCanvas(R.hud, R.hudW, hudH, dpr);
    if (R.sideW !== sideW) { R.sideW = sideW; R.root.style.setProperty('--kc-side', sideW + 'px'); }
    if (changed) { R.staticLayer = null; R.builtLevel = s.level + ':' + s.w; }
    // Portrait phones are width-bound: hand leftover height to the controls (bigger thumb area).
    if (touch && !landscape) {
      var spare = availH - s.h * tile;
      setStyle(R.pad, 'height', clamp(150 + spare - 8, 150, 200) + 'px');
    }
    // Scroll the board into view only when the layout actually changed (not on every update).
    var layoutKey = [touch, landscape, vw, vh, tile].join(':');
    if (layoutKey === R.layoutKey) return;
    R.layoutKey = layoutKey;
    if (touch && landscape) {
      requestAnimationFrame(function () {
        if (!R || !R.root) return;
        var y = R.root.getBoundingClientRect().top + (window.scrollY || 0) - 6;
        if (Math.abs((window.scrollY || 0) - y) > 4) window.scrollTo(0, y);
      });
    }
  }

  function sizeCanvas(c, w, h, dpr) {
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (c.width !== pw) c.width = pw;
    if (c.height !== ph) c.height = ph;
    setStyle(c, 'width', w + 'px');
    setStyle(c, 'height', h + 'px');
  }
  function setStyle(el, prop, value) {
    if (el.style[prop] !== value) el.style[prop] = value;
  }

  // ---------------------------------------------------------------- input wiring

  function onKey(e, down) {
    if (!R || !R.root || !document.body.contains(R.root)) return;
    if (R.capture) { if (down) captureKey(e); return; }
    if (R.settingsOpen) {
      if (down && e.code === 'Escape') { e.preventDefault(); closeSettings(); }
      return;
    }
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var a = actionFor(e.code);
    if (!a) return;
    e.preventDefault();
    if (a === 'up' || a === 'down' || a === 'left' || a === 'right') { R.keys[a] = down; return; }
    if (!down || e.repeat) return;
    if (a === 'grab' || a === 'use') act(a);
    else if (a === 'dash') dash();
    else if (a === 'pause') togglePause();
  }

  // Game controllers (standard mapping: Xbox / PlayStation / Switch Pro, USB or Bluetooth).
  // Browsers only list a pad after a button is pressed on the page, and Chrome only exposes
  // the Gamepad API on secure pages (https or localhost).
  var PAD_BUTTONS = { grab: [0], use: [2], dash: [1, 5, 7], pause: [9] };
  function pollPad() {
    var gp = null;
    try {
      var pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
    } catch (e) {}
    if (!gp) {
      if (R.gp) { R.gp = null; R.gpPrev = {}; if (R.settingsOpen) renderSettings(); }
      return;
    }
    if (!R.gp) {
      R.gpPrev = {};
      R.banner = { text: '🎮 ' + _t('kc_pad_on'), color: '#4a3326', born: nowMs() };
      if (R.settingsOpen) renderSettings();
    }
    var pressed = function (b) { var x = gp.buttons[b]; return !!x && (x.pressed || x.value > .5); };
    var x = gp.axes[0] || 0, y = gp.axes[1] || 0, m = Math.hypot(x, y);
    var mag = m < .2 ? 0 : Math.min(1, (m - .2) / .6);
    x = m ? x / m * mag : 0; y = m ? y / m * mag : 0;
    if (pressed(12)) y -= 1; if (pressed(13)) y += 1; if (pressed(14)) x -= 1; if (pressed(15)) x += 1;
    R.gp = { x: R.settingsOpen ? 0 : x, y: R.settingsOpen ? 0 : y };
    Object.keys(PAD_BUTTONS).forEach(function (a) {
      var down = PAD_BUTTONS[a].some(pressed), was = R.gpPrev[a];
      R.gpPrev[a] = down;
      if (!down || was) return;
      if (R.settingsOpen) { if (a === 'pause') closeSettings(); return; }
      if (a === 'grab' || a === 'use') act(a);
      else if (a === 'dash') dash();
      else togglePause();
    });
  }

  function isPaused() { return !!R && !!R.state && R.state.paused !== null && R.state.paused !== undefined; }

  function togglePause() {
    if (!R || !R.state || R.state.phase === 'over' || !window.makeGameMove) return;
    window.makeGameMove({ type: 'pause', on: !isPaused() });
    SFX.pop();
  }

  // ---------------------------------------------------------------- settings panel

  function openSettings() {
    R.settingsOpen = true;
    R.keys = {};
    renderSettings();
    R.settings.classList.add('kc-open');
  }
  function closeSettings() {
    R.settingsOpen = false;
    R.capture = null;
    R.settings.classList.remove('kc-open');
  }
  function renderSettings() {
    var box = R.settings;
    box.querySelector('.kc-soundtoggle').textContent = Snd.muted ? '🔇 ' + _t('kc_off') : '🔊 ' + _t('kc_on');
    box.querySelector('.kc-padstate').textContent = R.gp ? '✅ ' + _t('kc_pad_on') : _t('kc_pad_none');
    box.querySelector('.kc-keyrows').innerHTML = ACTIONS.map(function (a) {
      var label = _t('kc_act_' + a);
      label = label.charAt(0).toUpperCase() + label.slice(1); // the hint line uses these lowercase
      return '<div class="kc-keyrow"><span>' + label + '</span>' + [0, 1].map(function (i) {
        var capturing = R.capture && R.capture.a === a && R.capture.i === i;
        return '<button class="kc-chip' + (capturing ? ' kc-capturing' : '') + '" data-a="' + a + '" data-i="' + i + '">' +
          (capturing ? _t('kc_press_key') : keyName(KEYS[a][i])) + '</button>';
      }).join('') + '</div>';
    }).join('');
  }
  function captureKey(e) {
    e.preventDefault();
    e.stopPropagation();
    var c = R.capture;
    R.capture = null;
    if (e.code === 'Escape') { renderSettings(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') KEYS[c.a][c.i] = null;
    else {
      // A key does one thing: take it off whatever action had it.
      ACTIONS.forEach(function (a) { KEYS[a] = KEYS[a].map(function (k) { return k === e.code ? null : k; }); });
      KEYS[c.a][c.i] = e.code;
    }
    saveKeys();
    renderSettings();
    updateKeyHint();
  }
  function updateKeyHint() {
    var kbd = function (a) { return '<kbd>' + keyName(primaryKey(a)) + '</kbd>'; };
    R.root.querySelector('.kc-keys').innerHTML =
      kbd('up') + kbd('left') + kbd('down') + kbd('right') + ' ' + _t('kc_act_move') + ' · ' +
      kbd('grab') + ' ' + _t('kc_act_grab') + ' · ' + kbd('use') + ' ' + _t('kc_act_use') + ' · ' +
      kbd('dash') + ' ' + _t('kc_act_dash') + ' · ' + kbd('pause') + ' ' + _t('kc_act_pause') + ' · ⚙ ' + _t('kc_settings');
  }

  function wireJoystick(zone, knob, base) {
    var id = null, ox = 0, oy = 0, RAD = 46;
    function setKnob(dx, dy) { knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; }
    zone.addEventListener('pointerdown', function (e) {
      if (id !== null) return;
      e.preventDefault(); R.touchSeen = true;
      id = e.pointerId; try { zone.setPointerCapture(id); } catch (er) {}
      var r = zone.getBoundingClientRect();
      // Floating stick: centre where the thumb lands (clamped inside the zone).
      ox = clamp(e.clientX, r.left + RAD, r.right - RAD); oy = clamp(e.clientY, r.top + RAD, r.bottom - RAD);
      base.style.left = (ox - r.left) + 'px'; base.style.top = (oy - r.top) + 'px';
      base.classList.add('kc-on');
      R.root.classList.add('kc-used');
      move(e);
    });
    function move(e) {
      if (e.pointerId !== id) return;
      var dx = e.clientX - ox, dy = e.clientY - oy, d = Math.hypot(dx, dy);
      // The knob stops at the rim, but the direction must come from the real (unclamped) offset:
      // dividing a clamped offset by the unclamped distance made dragging past the rim *slower*.
      var k = d > RAD ? RAD / d : 1;
      setKnob(dx * k, dy * k);
      var m = Math.min(1, d / RAD);
      // small dead zone, then full speed quickly: phones feel sluggish with a linear stick
      var mag = m < .15 ? 0 : Math.min(1, (m - .15) / .45);
      R.joy.active = true;
      R.joy.x = d > 0 ? dx / d * mag : 0;
      R.joy.y = d > 0 ? dy / d * mag : 0;
    }
    function end(e) {
      if (e.pointerId !== id) return;
      id = null; R.joy.active = false; R.joy.x = R.joy.y = 0; setKnob(0, 0); base.classList.remove('kc-on');
    }
    zone.addEventListener('pointermove', move);
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
  }

  function wireButtons(root) {
    root.querySelectorAll('[data-kc]').forEach(function (b) {
      b.addEventListener('pointerdown', function (e) {
        e.preventDefault(); R.touchSeen = true;
        var k = b.getAttribute('data-kc');
        if (k === 'dash') dash(); else act(k);
      });
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
  }

  function teardown() {
    if (!R) return;
    if (R.raf) cancelAnimationFrame(R.raf);
    window.removeEventListener('keydown', R.kd); window.removeEventListener('keyup', R.ku);
    window.removeEventListener('resize', R.rs); window.removeEventListener('blur', R.bl);
    R.canvas = null;
  }

  function installStyles() {
    injectStylesOnce('kc-styles',
      '.kc-root{--kc-side:0px;width:100%;display:flex;flex-direction:column;align-items:center;gap:6px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '.kc-hud{display:block}' +
      '.board-wrap.stage-board:has(.kc-root){align-items:flex-start}' +
      '.kc-hudwrap{position:relative}' +
      '.kc-tools{display:flex;gap:6px;flex:none}' +
      '.kc-toolbar{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap}' +
      // phones: the tools leave the order strip for a column in the control pad
      '.kc-toolslot{display:none;flex-direction:column;justify-content:center}' +
      '.kc-touch .kc-toolslot{display:flex}' +
      '.kc-toolslot .kc-tools{flex-direction:column;gap:8px}' +
      '.kc-land .kc-toolslot{order:3;width:' + TOOLSLOT_W + 'px;flex:none}' +
      '.kc-padmap{font-size:13px;font-weight:700;line-height:1.6}' +
      '.kc-tool{width:32px;height:32px;border-radius:50%;border:0;background:rgba(255,255,255,.9);box-shadow:0 2px 6px rgba(0,0,0,.15);font-size:15px;line-height:32px;padding:0;cursor:pointer;color:#4a3326;font-family:inherit}' +
      '.kc-board{position:relative}' +
      '.kc-pausebox{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(60,35,20,.5);border-radius:16px;color:#fff;font-weight:900;font-size:18px;text-align:center;padding:10px}' +
      '.kc-paused .kc-pausebox{display:flex}' +
      '.kc-resume{border:0;border-radius:999px;background:#5fc46b;color:#fff;font:900 16px Nunito,system-ui,sans-serif;padding:10px 22px;box-shadow:0 4px 0 rgba(0,0,0,.2);cursor:pointer}' +
      '.kc-settings{position:fixed;inset:0;z-index:70;display:none;align-items:center;justify-content:center;background:rgba(30,20,12,.4);padding:16px}' +
      '.kc-settings.kc-open{display:flex}' +
      '.kc-card{background:#fffaf0;border-radius:20px;padding:18px;width:min(380px,100%);max-height:90vh;overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,.25);display:grid;gap:8px;color:#4a3326}' +
      '.kc-card-title{font-size:18px;font-weight:900}' +
      '.kc-card-sub{font-size:13px;font-weight:800;margin-top:6px;color:#7a6a5a}' +
      '.kc-keyrows{display:grid;gap:6px}' +
      '.kc-keyrow{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;font-size:14px;font-weight:700}' +
      '.kc-chip{min-width:74px;border:1px solid #e3d4bd;border-bottom-width:3px;border-radius:8px;background:#fff;padding:5px 8px;font:800 13px Nunito,system-ui,sans-serif;color:#4a3326;cursor:pointer}' +
      '.kc-chip.kc-capturing{background:#ffe9a8;border-color:#e2b23c}' +
      '.kc-soundtoggle{grid-column:2/span 2}' +
      '.kc-keyhelp{font-size:12px;color:#8a7a6a}' +
      '.kc-resetkeys{justify-self:start}' +
      '.kc-close{border:0;border-radius:999px;background:#ef5a4c;color:#fff;font:900 15px Nunito,system-ui,sans-serif;padding:10px;margin-top:6px;cursor:pointer}' +
      '.kc-touch .kc-keyset{display:none}' +
      '.kc-row{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%}' +
      '.kc-canvas{display:block;border-radius:16px;box-shadow:0 10px 28px rgba(90,50,20,.25);touch-action:none;background:#f3e3c8}' +
      '.kc-pad{display:none;width:100%;max-width:640px;height:150px;justify-content:space-between;align-items:stretch;gap:10px;touch-action:none}' +
      '.kc-touch .kc-pad{display:flex}' +
      '.kc-stick{position:relative;flex:1;max-width:240px;border-radius:22px;background:rgba(255,255,255,.35);touch-action:none}' +
      '.kc-stick-hint{position:absolute;left:0;right:0;bottom:6px;font-size:11px;font-weight:800;color:rgba(90,60,40,.5);pointer-events:none;text-align:center;padding:0 6px;transition:opacity .4s}' +
      '.kc-used .kc-stick-hint{opacity:0}' +
      '.kc-base{position:absolute;left:50%;top:50%;width:92px;height:92px;margin:-46px 0 0 -46px;border-radius:50%;background:rgba(74,51,38,.12);border:3px solid rgba(74,51,38,.18);pointer-events:none;transition:opacity .15s}' +
      '.kc-base.kc-on{background:rgba(74,51,38,.18)}' +
      '.kc-knob{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:#fff;box-shadow:0 3px 10px rgba(0,0,0,.2);border:3px solid #e8d2b0}' +
      '.kc-btns{display:grid;grid-template-columns:auto auto;grid-template-rows:1fr 1fr;gap:8px;align-items:center;justify-items:center;touch-action:none}' +
      '.kc-btn{border:0;border-radius:50%;font-weight:900;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.05;touch-action:none;box-shadow:0 5px 0 rgba(0,0,0,.18),0 6px 14px rgba(0,0,0,.15);-webkit-tap-highlight-color:transparent;font-family:inherit}' +
      '.kc-btn span{font-size:11px;font-weight:800;opacity:.95}' +
      '.kc-btn b{font-size:22px}' +
      '.kc-grab{width:84px;height:84px;background:#ef5a4c;grid-row:1/span 2;grid-column:2}' +
      '.kc-use{width:62px;height:62px;background:#4fa3e0;grid-column:1;grid-row:1}' +
      '.kc-dash{width:54px;height:54px;background:#8f7bd6;grid-column:1;grid-row:2}' +
      '.kc-btn.kc-hit,.kc-btn:active{transform:translateY(3px) scale(.95);box-shadow:0 2px 0 rgba(0,0,0,.18)}' +
      '.kc-keys{font-size:12px;color:#7a6a5a;font-weight:700;text-align:center;line-height:1.6}' +
      '.kc-keys kbd{display:inline-block;background:#fff;border:1px solid #e3d4bd;border-bottom-width:3px;border-radius:6px;padding:0 6px;margin:0 2px;font:800 11px/18px Nunito,system-ui,sans-serif;color:#4a3326}' +
      '.kc-touch .kc-keys{display:none}' +
      // landscape phones: stick left, buttons right, board in the middle
      '.kc-land .kc-pad{display:contents}' +
      '.kc-land .kc-stick{order:0;width:var(--kc-side);flex:none;align-self:stretch;max-width:none}' +
      '.kc-land .kc-board{order:1}' +
      '.kc-land .kc-btns{order:2;width:var(--kc-side)}' +
      '.kc-land .kc-row{flex-direction:row;align-items:stretch}');
  }

  window.gameRenderers = window.gameRenderers || new Map();
  window.gameRenderers.set('kitchencrew', {
    init: function (container) {
      teardown();
      installStyles();
      container.innerHTML =
        '<div class="kc-root">' +
          '<div class="kc-hudwrap"><canvas class="kc-hud"></canvas>' +
            '<div class="kc-tools">' +
              '<button class="kc-tool kc-pausebtn" aria-label="' + _t('kc_pause') + '">⏸</button>' +
              '<button class="kc-tool kc-gear" aria-label="' + _t('kc_settings') + '">⚙</button>' +
              '<button class="kc-tool kc-mute" aria-label="' + _t('kc_sound') + '"></button>' +
            '</div></div>' +
          '<div class="kc-row">' +
            '<div class="kc-board"><canvas class="kc-canvas"></canvas>' +
              '<div class="kc-pausebox"><div class="kc-pausetxt"></div><button class="kc-resume">▶ ' + _t('kc_resume') + '</button></div>' +
            '</div>' +
            '<div class="kc-pad">' +
              '<div class="kc-stick"><div class="kc-stick-hint">' + _t('kc_stick_hint') + '</div><div class="kc-base"><div class="kc-knob"></div></div></div>' +
              '<div class="kc-toolslot"></div>' +
              '<div class="kc-btns">' +
                '<button class="kc-btn kc-use" data-kc="use"><b>🔪</b><span>' + _t('kc_btn_use') + '</span></button>' +
                '<button class="kc-btn kc-dash" data-kc="dash"><b>💨</b></button>' +
                '<button class="kc-btn kc-grab" data-kc="grab"><b>✋</b><span>' + _t('kc_btn_grab') + '</span></button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="kc-toolbar"><div class="kc-keys"></div></div>' +
          '<div class="kc-settings"><div class="kc-card">' +
            '<div class="kc-card-title">⚙ ' + _t('kc_settings') + '</div>' +
            '<div class="kc-keyrow"><span>' + _t('kc_sound') + '</span><button class="kc-chip kc-soundtoggle"></button></div>' +
            '<div class="kc-keyset">' +
              '<div class="kc-card-sub">' + _t('kc_keys_title') + '</div>' +
              '<div class="kc-keyrows"></div>' +
              '<div class="kc-keyhelp">' + _t('kc_key_help') + '</div>' +
              '<button class="kc-chip kc-resetkeys">' + _t('kc_reset_keys') + '</button>' +
            '</div>' +
            '<div class="kc-card-sub">🎮 ' + _t('kc_pad_title') + '</div>' +
            '<div class="kc-keyhelp kc-padstate"></div>' +
            '<div class="kc-padmap">' + _t('kc_pad_help') + '</div>' +
            '<button class="kc-close">' + _t('kc_close') + '</button>' +
          '</div></div>' +
        '</div>';
      var root = container.querySelector('.kc-root');
      R = {
        root: root, wrap: root.querySelector('.kc-row'),
        canvas: root.querySelector('.kc-canvas'), hud: root.querySelector('.kc-hud'),
        keys: {}, joy: { active: false, x: 0, y: 0 },
        snaps: [], drawn: {}, particles: [], orderBorn: {}, fxSeen: 0, skipFx: true,
        scoreShown: 0, tile: 0, dpr: 1, local: null, lastFix: null, lastTick: -1,
        lastSendAt: 0, lastSent: null, banner: null, recvAt: nowMs(), touchSeen: false, seq: 0, preds: [],
      };
      R.ctx = R.canvas.getContext('2d');
      R.grabSpan = root.querySelector('.kc-grab span');
      R.useSpan = root.querySelector('.kc-use span');
      R.useIcon = root.querySelector('.kc-use b');
      R.pad = root.querySelector('.kc-pad');
      R.mute = root.querySelector('.kc-mute');
      R.tools = root.querySelector('.kc-tools');
      R.toolBar = root.querySelector('.kc-toolbar');
      R.toolSlot = root.querySelector('.kc-toolslot');
      R.pauseBtn = root.querySelector('.kc-pausebtn');
      R.pauseText = root.querySelector('.kc-pausetxt');
      R.settings = root.querySelector('.kc-settings');
      R.pausedShown = null;
      R.pauseBtn.addEventListener('click', togglePause);
      root.querySelector('.kc-resume').addEventListener('click', togglePause);
      root.querySelector('.kc-gear').addEventListener('click', openSettings);
      root.querySelector('.kc-close').addEventListener('click', closeSettings);
      R.settings.addEventListener('click', function (e) {
        if (e.target === R.settings) { closeSettings(); return; }
        var chip = e.target.closest('[data-a]');
        if (chip) { R.capture = { a: chip.getAttribute('data-a'), i: Number(chip.getAttribute('data-i')) }; renderSettings(); return; }
        if (e.target.closest('.kc-soundtoggle')) { setMuted(!Snd.muted); if (!Snd.muted) SFX.pop(); renderSettings(); return; }
        if (e.target.closest('.kc-resetkeys')) { KEYS = defaultKeys(); saveKeys(); renderSettings(); updateKeyHint(); }
      });
      updateKeyHint();
      R.alarmAt = {};
      setMuted(Snd.muted);
      R.mute.addEventListener('click', function () { setMuted(!Snd.muted); if (!Snd.muted) SFX.pop(); });
      // Browsers only allow audio after a gesture: warm the context up on the first one.
      var unlock = function () { audio(); };
      root.addEventListener('pointerdown', unlock, { once: true });
      window.addEventListener('keydown', unlock, { once: true });
      R.hudCtx = R.hud.getContext('2d');
      wireJoystick(root.querySelector('.kc-stick'), root.querySelector('.kc-knob'), root.querySelector('.kc-base'));
      wireButtons(root);
      R.canvas.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') { R.touchSeen = true; layout(); } });
      R.kd = function (e) { onKey(e, true); };
      R.ku = function (e) { onKey(e, false); };
      R.rs = function () { layout(); };
      R.bl = function () { R.keys = {}; };
      window.addEventListener('keydown', R.kd); window.addEventListener('keyup', R.ku);
      window.addEventListener('resize', R.rs); window.addEventListener('blur', R.bl);
      R.raf = requestAnimationFrame(frame);
    },
    render: function (state, container, playerIndex) {
      if (!R || !R.canvas) this.init(container);
      var first = !R.state;
      var restarted = R.state && (state.tick < R.lastTick || state.level !== R.state.level);
      R.state = state;
      R.me = playerIndex;
      R.recvAt = nowMs();
      if (first || restarted) {
        R.preds = [];
        // after a reload / rejoin, keep numbering above what the server last acknowledged
        var me0 = state.chefs && state.chefs[playerIndex];
        if (me0 && me0.ack != null) R.seq = Math.max(R.seq, me0.ack);
      }
      applyPredictions(state);
      R.snaps.push({ at: R.recvAt, chefs: state.chefs.map(function (c) { return { x: c.x, y: c.y, fx: c.fx, fy: c.fy }; }) });
      if (R.snaps.length > 12) R.snaps.shift();
      var mine = state.chefs[playerIndex];
      if (mine && (first || restarted || !R.local || mine.fix !== R.lastFix)) {
        // (Re)join, restart or server correction: take the server's position.
        R.local = { x: mine.x, y: mine.y, fx: mine.fx, fy: mine.fy, vx: 0, vy: 0, dash: 0, dashCd: 0, moving: false };
        R.lastFix = mine.fix;
        R.lastSent = null;
      }
      if (first || restarted) {
        R.fxSeen = state.fxSeq; R.particles = []; R.banner = null; R.scoreShown = state.score;
        R.staticLayer = null;
        layout();
      }
      R.skipFx = false;
      handleFx(state.fx || []);
      R.lastTick = state.tick;
      if (!R.tile) layout();
    },
  });
})();
