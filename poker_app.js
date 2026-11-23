/* =====================================================================
   poker_app.js — giao diện + luồng chơi Liar's Poker
   Local: solo (bot) / chuyền máy. Online: host-authoritative qua MQTT relay.
   ===================================================================== */
(function () {
  'use strict';

  var E = window.PokerEngine;
  var Bots = window.PokerBots;

  var BOT_POOL = [
    { name: 'Gấu Bự', avatar: '🐻' },
    { name: 'Thỏ Nhí', avatar: '🐰' },
    { name: 'Cáo Già', avatar: '🦊' }
  ];
  var HUMAN_AVATARS = ['🕵️', '🎩', '🧢', '👒'];
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var COMBOS = [
    { cat: 9, name: 'Thùng phá sảnh hoàng gia', ex: 'A♠ K♠ Q♠ J♠ 10♠' },
    { cat: 8, name: 'Thùng phá sảnh', ex: '9♥ 8♥ 7♥ 6♥ 5♥' },
    { cat: 7, name: 'Tứ quý', ex: '9♠ 9♥ 9♦ 9♣ K♠' },
    { cat: 6, name: 'Cù lũ (Full House)', ex: 'K♥ K♦ K♣ 7♠ 7♥' },
    { cat: 5, name: 'Thùng (Flush)', ex: 'A♥ J♥ 8♥ 5♥ 2♥' },
    { cat: 4, name: 'Sảnh (Straight)', ex: '9♠ 8♦ 7♣ 6♥ 5♠' },
    { cat: 3, name: 'Bộ ba (Three of a Kind)', ex: 'Q♠ Q♦ Q♥ 8♣ 3♦' },
    { cat: 2, name: 'Hai đôi (Two Pair)', ex: 'J♠ J♥ 4♣ 4♦ A♠' },
    { cat: 1, name: 'Một đôi (One Pair)', ex: '10♠ 10♥ A♦ 7♣ 3♠' },
    { cat: 0, name: 'Mậu thầu (High Card)', ex: 'A♠ K♦ 9♣ 5♥ 2♦' }
  ];

  var S = {
    cfg: {
      mode: 'solo',
      count: 4,
      difficulty: 'normal',
      sound: true,
      soloName: 'Bạn',
      onlineName: 'Bạn',
      onlineRole: 'host',
      names: ['Người chơi 1', 'Người chơi 2', 'Người chơi 3', 'Người chơi 4']
    },
    g: null,            // engine khi host/local
    shadow: null,       // state khi client online
    legal: [],
    mySeat: 0,
    isHost: false,
    online: false,
    busy: false,
    passViewed: false,
    passLocked: false,
    seatEls: [],
    pending: new Set(),
    netLog: [],
    roomCode: '',
    lastHand: 0,
    lastRevealed: 0,
    logRevealed: 0,
    logShowdown: 0,
    logHandWinner: 0,
    dealAnim: false,
    flipFrom: 3,
    confirmKind: null,
    swapHole: null,
    swapCard: null,
    swapOffer: null,
    swapSource: null,
    awaitingOffer: false,
    shotTimer: null,
    shotSeen: 0,
    rouletteOpen: false,
    overShown: false,
    tableToken: 0
  };

  /* ------------------------------------------------------------------ */
  /* tiện ích                                                            */
  /* ------------------------------------------------------------------ */
  function $(sel) { return document.querySelector(sel); }
  function show(sel) { var e = $(sel); if (e) e.classList.remove('hidden'); }
  function hide(sel) { var e = $(sel); if (e) e.classList.add('hidden'); }
  function later(fn, ms) {
    var id = setTimeout(function () { S.pending.delete(id); fn(); }, ms);
    S.pending.add(id);
    return id;
  }
  function clearPending() {
    S.pending.forEach(function (id) { clearTimeout(id); });
    S.pending.clear();
    if (S.shotTimer) { clearTimeout(S.shotTimer); S.shotTimer = null; }
  }
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }
  function shake() {
    var el = $('#screen-table');
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(function () { el.classList.remove('shake'); }, 600);
  }
  function pickBot(i) { return BOT_POOL[i % BOT_POOL.length]; }
  function makeRoomCode() {
    var s = '';
    for (var i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }
  function getClientToken() {
    var t = null;
    try { t = sessionStorage.getItem('liarpoker-p-token'); } catch (e) {}
    if (!t) {
      t = 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try { sessionStorage.setItem('liarpoker-p-token', t); } catch (e) {}
    }
    return t;
  }
  function parseMsg(raw) {
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { return null; } }
    return (raw && typeof raw === 'object') ? raw : null;
  }
  function sendTo(conn, obj) {
    try { if (conn && conn.open) conn.send(JSON.stringify(obj)); } catch (e) {}
  }
  function showScreen(which) {
    $('#screen-start').classList.toggle('hidden', which !== 'start');
    $('#screen-table').classList.toggle('hidden', which !== 'table');
    hide('#lobby');
  }
  function showLobby() {
    $('#screen-start').classList.add('hidden');
    $('#screen-table').classList.add('hidden');
    show('#lobby');
  }
  function isClient() { return S.cfg.mode === 'online' && !S.isHost; }
  function onlineHost() { return S.cfg.mode === 'online' && S.isHost; }
  function getState() { return S.shadow || S.g; }

  /* ------------------------------------------------------------------ */
  /* âm thanh                                                            */
  /* ------------------------------------------------------------------ */
  var Sound = {
    ctx: null, on: true,
    init: function () {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
    },
    tone: function (freq, dur, type, gain, slideTo) {
      if (!this.on || !this.ctx) return;
      var ctx = this.ctx, t = ctx.currentTime;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(Math.max(20, freq), t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.1, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.03);
    },
    noise: function (dur, gain, cutoff) {
      if (!this.on || !this.ctx) return;
      var ctx = this.ctx, t = ctx.currentTime;
      var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = ctx.createBufferSource(); src.buffer = buf;
      var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 2000;
      var g = ctx.createGain();
      g.gain.setValueAtTime(gain || 0.1, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(ctx.destination);
      src.start(t);
    },
    play: function (name) {
      if (!this.on) return;
      switch (name) {
        case 'click': this.tone(520, .05, 'square', .035); break;
        case 'tick': this.tone(1100, .03, 'square', .02); break;
        case 'deal': this.noise(.045, .045, 3000); this.tone(300, .04, 'triangle', .025); break;
        case 'flip': this.noise(.06, .08, 2600); this.tone(620, .06, 'square', .03); break;
        case 'chip': this.noise(.05, .06, 1500); this.tone(720, .06, 'triangle', .04); break;
        case 'warn': this.tone(440, .09, 'square', .05); setTimeout(function () { Sound.tone(330, .12, 'square', .05); }, 100); break;
        case 'spin': this.tone(220, .3, 'sawtooth', .05, 520); break;
        case 'shot': this.noise(.5, .38, 700); this.tone(60, .5, 'sine', .28, 28); break;
        case 'blank': this.tone(140, .07, 'square', .06); this.noise(.05, .05, 2200); break;
        case 'jam': this.tone(180, .15, 'square', .08); this.tone(120, .1, 'sawtooth', .06); break;
        case 'turn':
          this.tone(660, .1, 'sine', .05);
          setTimeout(function () { Sound.tone(880, .14, 'sine', .05); }, 110);
          break;
        case 'win':
          [523, 659, 784, 1046].forEach(function (f, i) {
            setTimeout(function () { Sound.tone(f, .26, 'triangle', .09); }, i * 120);
          });
          break;
        case 'lose':
          [392, 330, 262].forEach(function (f, i) {
            setTimeout(function () { Sound.tone(f, .3, 'triangle', .08); }, i * 150);
          });
          break;
      }
    }
  };
  function sfx(name) { if (S.cfg.sound) Sound.play(name); }

  /* ------------------------------------------------------------------ */
  /* lá bài                                                              */
  /* ------------------------------------------------------------------ */
  function faceHTML(card) {
    var r = card.rank, s = card.suit;
    return '<span class="corner tl"><b>' + r + '</b><i>' + s + '</i></span>' +
           '<span class="pip">' + s + '</span>' +
           '<span class="corner br"><b>' + r + '</b><i>' + s + '</i></span>';
  }
  function cardEl(card, extra) {
    var el = document.createElement('div');
    var red = card.suit === '♥' || card.suit === '♦';
    el.className = 'card' + (red ? ' red' : '') + (extra ? ' ' + extra : '');
    el.innerHTML = faceHTML(card);
    return el;
  }
  function backEl(extra) {
    var el = document.createElement('div');
    el.className = 'card back' + (extra ? ' ' + extra : '');
    return el;
  }
  function miniCard(card, up) {
    var d = document.createElement('div');
    var red = !!(up && card) && (card.suit === '♥' || card.suit === '♦');
    d.className = 'hole-mini' + (up ? ' up' + (red ? ' red' : '') : '');
    if (up && card) d.innerHTML = '<small>' + card.rank + '<br>' + card.suit + '</small>';
    return d;
  }

  function playerHand(seat) {
    var st = getState();
    if (!st || !st.players[seat]) return [];
    var p = st.players[seat];
    if (S.g && st === S.g) return p.hand || [];
    return p.hole || [];
  }
  function visibleHole(seat) {
    var st = getState();
    if (!st) return [];
    if (seat === viewSeat()) return playerHand(seat);
    if (st.showdown && st.showdown.seats.indexOf(seat) >= 0) return playerHand(seat);
    return [];
  }
  function communityCards() {
    var st = getState();
    if (!st) return [];
    var out = [];
    for (var i = 0; i < 5; i++) {
      if (i < st.revealed && st.community && st.community[i]) out.push(st.community[i]);
    }
    return out;
  }
  function viewSeat() {
    var st = getState();
    if (!st) return S.mySeat;
    if (S.cfg.mode === 'pass' && (st.phase === 'bet' || st.phase === 'allin')) {
      return st.turn != null ? st.turn : S.mySeat;
    }
    return S.mySeat;
  }
  function viewPlayer() {
    var st = getState();
    if (!st) return null;
    return st.players[viewSeat()] || null;
  }
  function seatConnected(id) {
    if (S.cfg.mode !== 'online') return true;
    if (S.isHost) {
      if (id === 0) return true;
      var e = Net.entryBySeat(id);
      return !!(e && e.connected);
    }
    var p = getState() && getState().players[id];
    return !p || p.connected !== false;
  }
  function actionsFor(seat) {
    if (isClient()) return S.legal || [];
    if (!S.g) return [];
    return E.legalActions(S.g, seat);
  }
  function isViewerTurn() {
    var st = getState();
    if (!st) return false;
    if (st.turn !== viewSeat()) return false;
    if (st.phase !== 'bet' && st.phase !== 'allin') return false;
    var p = st.players[viewSeat()];
    if (!p || !p.alive || !p.inHand) return false;
    if (S.busy) return false;
    if (S.cfg.mode === 'pass' && !S.passViewed) return false;
    return actionsFor(viewSeat()).length > 0;
  }

  /* ------------------------------------------------------------------ */
  /* log                                                                 */
  /* ------------------------------------------------------------------ */
  function addLog(text, cls) {
    var log = $('#log');
    if (log) {
      var d = document.createElement('div');
      d.className = 'log-line' + (cls ? ' ' + cls : '');
      d.textContent = text;
      log.appendChild(d);
      while (log.children.length > 120) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    }
    if (onlineHost()) {
      S.netLog.push({ text: text, cls: cls || '' });
      if (S.netLog.length > 80) S.netLog.shift();
    }
  }
  function renderNetLog(lines) {
    if (!Array.isArray(lines)) return;
    var log = $('#log');
    log.innerHTML = '';
    lines.forEach(function (l) {
      if (!l) return;
      var d = document.createElement('div');
      d.className = 'log-line' + (l.cls ? ' ' + l.cls : '');
      d.textContent = l.text || '';
      log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
  }

  /* ------------------------------------------------------------------ */
  /* combo                                                               */
  /* ------------------------------------------------------------------ */
  var comboRows = {};
  var comboModalBuilt = false;
  function buildCombo() {
    var wrap = $('#combo-list');
    wrap.innerHTML = '';
    comboRows = {};
    COMBOS.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'combo-row';
      row.dataset.cat = c.cat;
      var num = document.createElement('b');
      num.textContent = c.cat;
      var name = document.createElement('span');
      name.className = 'cname';
      name.textContent = c.name;
      var ex = document.createElement('span');
      ex.className = 'cex';
      ex.textContent = c.ex;
      row.appendChild(num); row.appendChild(name); row.appendChild(ex);
      wrap.appendChild(row);
      comboRows[c.cat] = row;
    });
    var modal = $('#combo-modal-list');
    modal.innerHTML = '';
    COMBOS.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'combo-row';
      row.dataset.cat = c.cat;
      var num = document.createElement('b');
      num.textContent = c.cat;
      var name = document.createElement('span');
      name.className = 'cname';
      name.textContent = c.name;
      var ex = document.createElement('span');
      ex.className = 'cex';
      ex.textContent = c.ex;
      row.appendChild(num); row.appendChild(name); row.appendChild(ex);
      modal.appendChild(row);
    });
    comboModalBuilt = true;
  }
  function highlightCombo(cat) {
    Object.keys(comboRows).forEach(function (k) {
      comboRows[k].classList.toggle('on', +k === cat);
    });
  }

  /* ------------------------------------------------------------------ */
  /* vẽ bàn                                                              */
  /* ------------------------------------------------------------------ */
  function positionSeats() {
    var st = getState();
    if (!st) return;
    var n = st.players.length;
    var rot = S.cfg.mode === 'online' ? S.mySeat : 0;
    var land = window.innerHeight <= 520 && window.innerWidth > window.innerHeight;
    if (land) {
      var layouts = {
        2: [[50, 90], [50, 12]],
        3: [[50, 90], [22, 30], [78, 30]],
        4: [[50, 90], [4, 46], [50, 12], [96, 46]]
      };
      var L = layouts[n] || layouts[4];
      S.seatEls.forEach(function (el, i) {
        var pos = L[(i - rot + n) % n] || L[L.length - 1];
        el.style.left = pos[0] + '%';
        el.style.top = pos[1] + '%';
      });
      return;
    }
    var narrow = window.innerWidth < 760;
    var rx = narrow ? 32 : 43.5;
    var ry = narrow ? 40 : 39;
    S.seatEls.forEach(function (el, i) {
      var a = Math.PI / 2 + ((i - rot + n) % n) * (2 * Math.PI / n);
      el.style.left = (50 + rx * Math.cos(a)).toFixed(2) + '%';
      el.style.top = (50 + ry * Math.sin(a)).toFixed(2) + '%';
    });
  }

  function buildSeats() {
    var st = getState();
    if (!st) return;
    var wrap = $('#seats');
    wrap.innerHTML = '';
    S.seatEls = [];
    st.players.forEach(function (p) {
      var el = document.createElement('div');
      el.className = 'seat';

      var av = document.createElement('div');
      av.className = 'seat-av';
      var em = document.createElement('span');
      em.textContent = p.avatar;
      var skull = document.createElement('span');
      skull.className = 'skull';
      skull.textContent = '💀';
      av.appendChild(em); av.appendChild(skull);

      var name = document.createElement('div');
      name.className = 'seat-name';
      name.textContent = p.name;

      var tag = document.createElement('div');
      tag.className = 'seat-tag';

      var bet = document.createElement('div');
      bet.className = 'seat-bet';

      var holes = document.createElement('div');
      holes.className = 'seat-holes';

      el.appendChild(av); el.appendChild(name); el.appendChild(tag);
      el.appendChild(bet); el.appendChild(holes);
      wrap.appendChild(el);
      S.seatEls.push(el);
    });
    positionSeats();
  }

  function renderSeat(p, el, st) {
    var me = viewSeat();
    var active = st.turn === p.id && (st.phase === 'bet' || st.phase === 'allin') && p.alive && p.inHand;
    var winner = st.showdown && st.showdown.winners.indexOf(p.id) >= 0;
    el.classList.toggle('active', active);
    el.classList.toggle('dead', !p.alive);
    el.classList.toggle('folded', p.alive && !p.inHand);
    el.classList.toggle('allin', p.allIn || false);
    el.classList.toggle('winner', !!winner);
    el.classList.toggle('offline', !seatConnected(p.id));

    el.querySelector('.seat-name').textContent = p.name;

    var tagEl = el.querySelector('.seat-tag');
    var tag = '';
    if (S.cfg.mode === 'online') {
      if (!seatConnected(p.id)) tag = 'OFF';
      else if (p.id === me) tag = 'BẠN';
      else if (p.id === 0) tag = 'CHỦ';
    } else if (S.cfg.mode === 'solo' && p.isBot) {
      tag = 'MÁY';
    }
    tagEl.textContent = tag;

    var betEl = el.querySelector('.seat-bet');
    if (!p.alive) betEl.innerHTML = '<b>ĐÃ GỤC</b>';
    else if (!p.inHand) betEl.innerHTML = '<b>ĐÃ BỎ</b>';
    else if (p.allIn) betEl.innerHTML = '<b>ALL-IN · 8 VIÊN</b>';
    else betEl.innerHTML = '<b>' + p.bet + ' VIÊN</b>';
    var hh = st.showdown && st.showdown.hands && st.showdown.hands[p.id];
    if (hh) betEl.innerHTML = '<b>' + E.categoryName(hh.cat) + '</b>';

    var holes = el.querySelector('.seat-holes');
    holes.innerHTML = '';
    if (!p.alive) return;
    if (p.id === me) return; // bài của mình ở dưới
    var vis = visibleHole(p.id);
    if (vis.length) {
      vis.forEach(function (c) { holes.appendChild(miniCard(c, true)); });
    } else if (p.inHand) {
      holes.appendChild(miniCard(null, false));
      holes.appendChild(miniCard(null, false));
    }
  }

  function renderCommunity(st) {
    var wrap = $('#community');
    wrap.innerHTML = '';
    var old = S.flipFrom;
    for (var i = 0; i < 5; i++) {
      var c = st.community ? st.community[i] : null;
      var el;
      if (i < st.revealed && c) {
        el = cardEl(c, 'community-card' + (i >= old ? ' flip' : '') + (S.dealAnim ? ' deal' : ''));
        el.style.setProperty('--i', i);
      } else {
        el = backEl('community-card');
      }
      wrap.appendChild(el);
    }
    S.flipFrom = st.revealed;
  }

  function renderHole(st, vp) {
    var hole = $('#hole');
    hole.innerHTML = '';
    var hidden = !vp || !vp.alive || !vp.inHand || (S.cfg.mode === 'pass' && !S.passViewed);
    var cards = vp ? playerHand(vp.id) : [];
    if (hidden) {
      hole.appendChild(backEl('deal'));
      hole.appendChild(backEl('deal'));
      return;
    }
    if (!cards.length) {
      var m = document.createElement('div');
      m.className = 'hand-empty';
      m.textContent = 'Không có bài.';
      hole.appendChild(m);
      return;
    }
    cards.forEach(function (c, i) {
      var el = cardEl(c, 'deal');
      el.style.setProperty('--i', i);
      el.style.setProperty('--rot', (i === 0 ? '-2deg' : '2deg'));
      hole.appendChild(el);
    });
  }

  function bestInfo() {
    var st = getState();
    var vp = viewPlayer();
    if (!st || !vp) return { label: '—', cat: -1, hole: [] };
    var hole = playerHand(vp.id);
    if (!vp.alive) return { label: 'Bạn đã gục', cat: -1, hole: hole };
    if (!vp.inHand) return { label: 'Bạn đã bỏ bài', cat: -1, hole: hole };
    if (S.cfg.mode === 'pass' && !S.passViewed) return { label: 'Bấm XEM BÀI', cat: -1, hole: hole };
    var comm = communityCards();
    var all = hole.concat(comm);
    if (all.length >= 5) {
      var h = E.bestOf(all);
      return { label: h.label, cat: h.cat, hole: hole, best: h };
    }
    var txt = hole.map(function (c) { return c.rank + c.suit; }).join(' ');
    return { label: 'Bài đầu: ' + (txt || '—'), cat: -1, hole: hole };
  }

  function renderCenter(st) {
    renderCommunity(st);
    var meter = $('#bet-meter');
    meter.innerHTML = '';
    for (var i = 0; i < 8; i++) {
      var d = document.createElement('span');
      d.className = 'bet-dot' + (i < st.level ? ' on' : '');
      meter.appendChild(d);
    }
    $('#bet-label').textContent = 'MỨC CƯỢC · ' + st.level + ' VIÊN';
    var bi = bestInfo();
    $('#best-hand').innerHTML = 'Bài của bạn: <b>' + bi.label + '</b>';
    highlightCombo(bi.cat);
    S.lastBestCat = bi.cat;

    var b = $('#showdown-banner');
    if (st.showdown) {
      var winners = st.showdown.winners.map(function (id) { return st.players[id].name; }).join(', ');
      b.textContent = (st.showdown.winners.indexOf(viewSeat()) >= 0 ? 'BẠN THẮNG VÁN — ' : 'LẬT BÀI — ') + winners + ' thắng';
      b.className = 'showdown-banner' + (st.showdown.winners.indexOf(viewSeat()) >= 0 ? '' : ' lose');
      b.classList.remove('hidden');
    } else if (st.phase === 'handover' && st.handWinner != null) {
      b.textContent = st.players[st.handWinner].name + ' thắng ván';
      b.className = 'showdown-banner';
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }

  function renderButtons(st) {
    var legal = isViewerTurn() ? actionsFor(viewSeat()) : [];
    var call = $('#btn-call');
    var fold = $('#btn-fold');
    var allin = $('#btn-allin');
    var swap = $('#btn-swap');
    var coward = $('#btn-coward');
    var isAllinPhase = st.phase === 'allin';

    call.disabled = legal.indexOf(isAllinPhase ? 'allinCall' : 'call') < 0;
    fold.disabled = legal.indexOf(isAllinPhase ? 'allinFold' : 'fold') < 0;
    allin.disabled = legal.indexOf('allin') < 0;
    swap.disabled = legal.indexOf('swap') < 0;
    coward.disabled = legal.indexOf('coward') < 0;

    call.textContent = isAllinPhase ? 'THEO ALL-IN' : ('THEO +1');
    fold.textContent = isAllinPhase ? 'BỎ (BẮN)' : 'BỎ BÀI';
    swap.classList.toggle('hidden', isAllinPhase);
    coward.classList.toggle('hidden', isAllinPhase);
    allin.classList.toggle('hidden', isAllinPhase);
    call.classList.toggle('ready', !call.disabled && !isAllinPhase);
  }

  function renderTurn(st) {
    var el = $('#turn-text');
    var hint = $('#poker-hint');
    var p = st.turn != null ? st.players[st.turn] : null;
    var txt = '…';
    var h = '';
    if (st.phase === 'bet' && p) {
      var me = p.id === viewSeat();
      if (S.cfg.mode === 'pass') {
        txt = me ? ('Lượt ' + p.name + ' — xem bài rồi chọn') : ('Tới lượt ' + p.name + '…');
      } else if (me) {
        txt = 'Lượt bạn — theo ' + (st.level + 1) + ' viên, hoặc bỏ';
      } else {
        txt = 'Tới lượt ' + p.name + ' — đang chờ…';
      }
      h = 'Mức cược ' + st.level + ' · bỏ bài = bắn ' + st.level + ' viên (' + Math.round(st.level / 8 * 100) + '%)';
    } else if (st.phase === 'allin' && p) {
      txt = 'ALL-IN! ' + p.name + ' chọn theo tất tay hay bỏ';
      h = 'Theo all-in = 8 viên · bỏ = bắn ' + st.level + ' viên hiện có';
    } else if (st.phase === 'shot' && st.shot) {
      txt = st.players[st.shot.seat].name + ' chơi roulette…';
      h = st.shot.bullets + '/8 viên · ' + Math.round(st.shot.bullets / 8 * 100) + '%';
    } else if (st.phase === 'showdown') {
      txt = 'LẬT BÀI!';
    } else if (st.phase === 'handover') {
      txt = (st.handWinner != null ? st.players[st.handWinner].name : '—') + ' thắng ván — ván mới…';
    } else if (st.phase === 'over') {
      txt = 'Kết thúc bàn.';
    }
    el.textContent = txt;
    hint.textContent = h;
  }

  function renderPoker() {
    var st = getState();
    if (!st) return;
    if (S.seatEls.length !== st.players.length) buildSeats();
    $('#hand-no').textContent = st.handNo || 1;
    $('#alive-no').textContent = st.players.filter(function (p) { return p.alive; }).length;
    st.players.forEach(function (p, i) {
      if (S.seatEls[i]) renderSeat(p, S.seatEls[i], st);
    });
    renderCenter(st);
    var vp = viewPlayer();
    renderHole(st, vp);
    var myBet = $('#mybet');
    if (!vp) myBet.textContent = '';
    else if (!vp.alive) myBet.innerHTML = '<b>BẠN ĐÃ GỤC</b>';
    else if (!vp.inHand) myBet.innerHTML = '<b>ĐÃ BỎ BÀI</b>';
    else if (vp.allIn) myBet.innerHTML = '<b>ALL-IN · 8 VIÊN</b>';
    else myBet.innerHTML = '<b>BẠN CƯỢC ' + vp.bet + ' VIÊN</b>';
    renderButtons(st);
    renderTurn(st);
    if (S.online) {
      $('#online-pill').classList.remove('hidden');
      $('#online-code').textContent = S.roomCode;
    } else {
      $('#online-pill').classList.add('hidden');
    }
  }

  /* ------------------------------------------------------------------ */
  /* overlay: roulette / confirm / swap / pass / game over              */
  /* ------------------------------------------------------------------ */
  function showRoulette(seat, bullets, reason, fromNet) {
    var st = getState();
    if (!st || !st.players[seat]) return;
    S.rouletteOpen = true;
    $('#roul-name').textContent = st.players[seat].name;
    var ring = $('#roul-ring');
    var chambers = ring.querySelectorAll('.chamber');
    for (var i = 0; i < chambers.length; i++) {
      chambers[i].classList.toggle('loaded', i < bullets);
    }
    $('#roul-count').textContent = bullets + ' / 8 VIÊN · ' +
      (bullets >= 8 ? '95% chết, 5% kẹt' : Math.round(bullets / 8 * 100) + '% chết');
    var card = $('#roul-card');
    card.className = 'roul-card';
    card.textContent = '?';
    $('#roul-text').textContent = 'Đang quay…';
    ring.classList.remove('spin');
    void ring.offsetWidth;
    ring.classList.add('spin');
    show('#roulette');
    sfx('spin');
    for (var k = 0; k < 8; k++) {
      (function (n) { later(function () { sfx('tick'); }, 200 + n * 140); })(k);
    }
  }

  function showRouletteResult(res, fromNet) {
    var st = getState();
    var card = $('#roul-card');
    var p = st && st.players[res.seat];
    if (res.death) {
      card.classList.add('death');
      card.textContent = '💀';
      $('#roul-text').textContent = 'TRÚNG ĐẠN!';
    } else if (res.jam) {
      card.classList.add('jam');
      card.textContent = 'KẸT ĐẠN';
      $('#roul-text').textContent = 'KẸT ĐẠN — SỐNG SÓT (5%)';
    } else {
      card.classList.add('blank');
      card.textContent = 'TRỐNG';
      $('#roul-text').textContent = 'TRỐNG — SỐNG SÓT';
    }
    sfx(res.death ? 'shot' : res.jam ? 'jam' : 'blank');
    if (res.death) shake();
  }

  function showPokerShot(seat, bullets, reason) {
    var g = S.g;
    if (!g || !g.shot) return;
    if (onlineHost()) {
      Net.broadcastEvent({ t: 'pokerShot', seat: seat, bullets: bullets, reason: reason });
    }
    S.busy = true;
    var token = ++S.tableToken;
    showRoulette(seat, bullets, reason, false);
    addLog(g.players[seat].name + ' chơi roulette ' + bullets + ' viên…', 'warn');
    if (S.shotTimer) clearTimeout(S.shotTimer);
    S.shotTimer = setTimeout(function () {
      if (S.tableToken !== token || !S.g || !S.g.shot) return;
      var res = E.finishShot(S.g);
      renderPoker();
      showRouletteResult({ seat: res.seat, death: res.death, jam: res.jam }, false);
      if (onlineHost()) {
        Net.broadcastEvent({ t: 'pokerShotResult', seat: res.seat, death: res.death, jam: res.jam, bullets: res.bullets });
      }
      if (res.death) addLog(S.g.players[res.seat].name + ' TRÚNG ĐẠN — GỤC.', 'death');
      else if (res.jam) addLog(S.g.players[res.seat].name + ' KẸT ĐẠN — sống sót (5%).', 'dim');
      else addLog(S.g.players[res.seat].name + ' TRỐNG — sống sót.', 'dim');
      S.shotTimer = setTimeout(function () {
        if (S.tableToken !== token) return;
        hide('#roulette');
        S.rouletteOpen = false;
        S.busy = false;
        afterPokerChange();
      }, 1700);
    }, 1800);
  }

  function askConfirm(kind) {
    var st = getState();
    if (!st) return;
    var title = '';
    var text = '';
    if (kind === 'fold') {
      title = 'BỎ BÀI?';
      text = 'Bạn sẽ chơi roulette với <b>' + st.level + ' viên</b> — <b>' +
        Math.round(st.level / 8 * 100) + '%</b> chết. Nếu sống, bạn vẫn chơi ván sau.';
    } else if (kind === 'coward') {
      title = 'BỎ NHÁT?';
      text = 'Bắn với <b>1 viên</b> — <b>12.5%</b> chết. Chỉ dùng được <b>1 lần mỗi bàn</b>.';
    } else if (kind === 'allin') {
      title = 'TẤT TAY (ALL-IN)?';
      text = 'Đặt <b>8 viên</b>. Người khác chọn theo all-in hoặc bỏ. Người thua ở showdown bắn 8 viên — <b>95% chết</b> (5% kẹt đạn).';
    }
    S.confirmKind = kind;
    $('#confirm-title').textContent = title;
    $('#confirm-text').innerHTML = text;
    show('#confirm');
  }

  function confirmOk() {
    var kind = S.confirmKind;
    S.confirmKind = null;
    hide('#confirm');
    if (!kind) return;
    doAction(kind);
  }

  function doAction(kind) {
    var st = getState();
    if (!st) return;
    if (isClient()) {
      var need = kind === 'fold' ? (st.phase === 'allin' ? 'allinFold' : 'fold') : kind;
      if (!S.legal || S.legal.indexOf(need) < 0) return;
      clientSend(need);
      S.passViewed = false;
      return;
    }
    executeAction(actionSeat(), kind);
    S.passViewed = false;
  }

  function doCall() {
    var st = getState();
    if (!st) return;
    var kind = st.phase === 'allin' ? 'allinCall' : 'call';
    if (isClient()) {
      if (!S.legal || S.legal.indexOf(kind) < 0) return;
      clientSend(kind);
      S.passViewed = false;
      return;
    }
    executeAction(actionSeat(), kind);
    S.passViewed = false;
  }

  function actionSeat() {
    if (S.cfg.mode === 'pass' && S.g) return S.g.turn != null ? S.g.turn : S.mySeat;
    return S.mySeat;
  }

  /* ---------- swap ---------- */
  function renderSwap() {
    var st = getState();
    var vp = viewPlayer();
    if (!st || !vp) return;
    var holeWrap = $('#swap-hole');
    var offersWrap = $('#swap-offers');
    holeWrap.innerHTML = '';
    offersWrap.innerHTML = '';
    (playerHand(vp.id) || []).forEach(function (c, i) {
      var el = cardEl(c);
      el.addEventListener('click', function () {
        S.swapHole = i;
        renderSwap();
      });
      if (S.swapHole === i) el.classList.add('pick');
      holeWrap.appendChild(el);
    });
    (S.swapOffer || []).forEach(function (c) {
      var el = cardEl(c);
      el.addEventListener('click', function () {
        S.swapCard = c.id;
        renderSwap();
      });
      if (S.swapCard === c.id) el.classList.add('pick');
      offersWrap.appendChild(el);
    });
    $('#btn-swap-ok').disabled = !(S.swapHole != null && S.swapCard != null);
  }

  function openSwap() {
    S.swapHole = null;
    S.swapCard = null;
    renderSwap();
    show('#swap');
  }

  function startSwap() {
    if (isClient()) {
      if (!S.legal || S.legal.indexOf('swap') < 0) return;
      clientSend('swapOffer');
      S.awaitingOffer = true;
      return;
    }
    var g = S.g;
    if (!g) return;
    var offer = E.offerSwap(g, actionSeat());
    if (!offer) { toast('Không thể đổi bài lúc này.'); return; }
    S.swapOffer = offer.cards;
    S.swapSource = 'local';
    openSwap();
  }

  function confirmSwap() {
    if (S.swapHole == null || S.swapCard == null) return;
    hide('#swap');
    if (isClient()) {
      clientSend('swap', { holeIndex: S.swapHole, cardId: S.swapCard });
      S.swapOffer = null;
      S.swapHole = null;
      S.swapCard = null;
      return;
    }
    var g = S.g;
    if (g) {
      var res = E.applySwap(g, actionSeat(), S.swapHole, S.swapCard);
      if (res) addLog(g.players[actionSeat()].name + ' đổi 1 lá.', 'dim');
    }
    S.swapOffer = null;
    S.swapHole = null;
    S.swapCard = null;
    renderPoker();
    if (onlineHost()) broadcastSnap();
    scheduleTurn();
  }

  function cancelSwap() {
    hide('#swap');
    S.swapHole = null;
    S.swapCard = null;
    if (isClient()) {
      S.swapOffer = null;
      clientSend('swapCancel');
      return;
    }
    var g = S.g;
    if (g) E.cancelSwap(g, actionSeat());
    S.swapOffer = null;
    renderPoker();
  }

  function showPass(p) {
    $('#pass-avatar').textContent = p.avatar;
    $('#pass-name').textContent = p.name;
    show('#pass-overlay');
  }

  function showPokerOver() {
    var st = getState();
    if (!st) return;
    S.busy = true;
    hide('#roulette');
    hide('#swap');
    hide('#confirm');
    hide('#pass-overlay');
    var w = st.winnerId != null ? st.players[st.winnerId] : null;
    var me = viewSeat();
    $('#over-avatar').textContent = w ? w.avatar : '🎲';
    $('#over-name').textContent = w ? w.name : 'Không có người thắng';
    var sub;
    if (!w) sub = 'Bàn kết thúc.';
    else if (S.cfg.mode === 'online') sub = w.id === me ? 'Bạn thắng bàn!' : (w.name + ' thắng bàn.');
    else if (S.cfg.mode === 'pass') sub = w.name + ' thắng bàn.';
    else sub = w.id === me ? 'Bạn thắng bàn!' : (w.name + ' thắng bàn.');
    $('#over-sub').textContent = sub;
    var client = isClient();
    $('#btn-again').classList.toggle('hidden', client);
    $('#over-note').classList.toggle('hidden', !client);
    if (client) $('#over-note').textContent = 'Chờ chủ phòng bắt đầu bàn mới…';
    show('#gameover');
    if (onlineHost()) {
      sfx(w && w.id === S.mySeat ? 'win' : 'lose');
      broadcastSnap();
    } else if (!client) {
      sfx(w && w.id === me ? 'win' : 'lose');
    }
  }

  /* ------------------------------------------------------------------ */
  /* luồng chơi local/host                                              */
  /* ------------------------------------------------------------------ */
  function startLocal() {
    var cfg = S.cfg;
    var players = [];
    if (cfg.mode === 'solo') {
      players.push({ name: (cfg.soloName || '').trim() || 'Bạn', avatar: HUMAN_AVATARS[0], isBot: false });
      for (var i = 0; i < cfg.count - 1; i++) {
        var b = pickBot(i);
        players.push({ name: b.name, avatar: b.avatar, isBot: true });
      }
    } else {
      for (var k = 0; k < cfg.count; k++) {
        players.push({
          name: (cfg.names[k] || '').trim() || ('Người chơi ' + (k + 1)),
          avatar: HUMAN_AVATARS[k % HUMAN_AVATARS.length],
          isBot: false
        });
      }
    }
    startPoker(players, false);
  }

  function startPoker(players, onlineHostFlag) {
    clearPending();
    hide('#gameover'); hide('#roulette'); hide('#confirm'); hide('#swap');
    hide('#pass-overlay'); hide('#lobby');
    S.online = !!onlineHostFlag || S.cfg.mode === 'online';
    S.isHost = !!onlineHostFlag;
    S.mySeat = 0;
    S.g = E.createGame({ players: players, rng: Math.random });
    E.startHand(S.g);
    S.shadow = null;
    S.legal = [];
    S.busy = false;
    S.passViewed = false;
    S.passLocked = false;
    S.overShown = false;
    S.lastHand = S.g.handNo;
    S.lastRevealed = 0;
    S.flipFrom = 0;
    S.logRevealed = 0;
    S.logShowdown = 0;
    S.logHandWinner = 0;
    S.dealAnim = true;
    S.netLog = [];
    S.roomCode = S.online ? Net.code : '';
    S.rouletteOpen = false;
    $('#log').innerHTML = '';
    showScreen('table');
    if (S.online) {
      $('#online-pill').classList.remove('hidden');
      $('#online-code').textContent = S.roomCode;
      $('#btn-leave-online').classList.remove('hidden');
      $('#btn-again').classList.remove('hidden');
    } else {
      $('#online-pill').classList.add('hidden');
      $('#btn-leave-online').classList.add('hidden');
    }
    buildSeats();
    renderPoker();
    addLog('— Bàn poker · ' + players.length + ' người —', 'sys');
    addLog('Ván 1 — chia bài. Mỗi người bắt đầu với 1 viên cược.', 'round');
    later(function () { S.dealAnim = false; renderPoker(); }, 800);
    if (onlineHostFlag) broadcastStart();
    afterPokerChange();
  }

  function afterPokerChange() {
    var g = S.g;
    if (!g) return;
    if (g.revealed > S.logRevealed) {
      var newCards = g.community.slice(S.logRevealed, g.revealed).map(function (c) { return c.rank + c.suit; }).join(' ');
      var added = g.revealed - S.logRevealed;
      var nm = (added > 1 && g.revealed !== 3) ? 'hết bài'
        : g.revealed === 3 ? 'flop' : g.revealed === 4 ? 'turn' : 'river';
      addLog('Lật ' + nm + ': ' + newCards, 'round');
      S.logRevealed = g.revealed;
    }
    if (g.showdown && S.logShowdown !== g.handNo) {
      S.logShowdown = g.handNo;
      var parts = g.showdown.seats.map(function (id) {
        return g.players[id].name + ' (' + g.showdown.hands[id].label + ')';
      });
      addLog('Showdown: ' + parts.join(' · '), 'round');
    }
    if (g.phase === 'handover' && !g.showdown && S.logHandWinner !== g.handNo) {
      S.logHandWinner = g.handNo;
      if (g.handWinner != null) addLog(g.players[g.handWinner].name + ' thắng ván (mọi người bỏ).', 'round');
    }
    renderPoker();
    if (onlineHost()) broadcastSnap();
    if (g.phase === 'showdown') {
      var token = ++S.tableToken;
      S.busy = true;
      later(function () {
        if (S.tableToken !== token) return;
        if (!S.g || S.g.phase !== 'showdown') return;
        E.beginShowdownShots(S.g);
        S.busy = false;
        afterPokerChange();
      }, 2600);
      return;
    }
    if (g.phase === 'shot') {
      showPokerShot(g.shot.seat, g.shot.bullets, g.shot.reason);
      return;
    }
    if (g.phase === 'over') {
      showPokerOver();
      return;
    }
    if (g.phase === 'handover') {
      scheduleNextHand();
      return;
    }
    if (g.phase === 'bet' || g.phase === 'allin') {
      scheduleTurn();
    }
  }

  function scheduleTurn() {
    var g = S.g;
    if (!g) return;
    var p = g.players[g.turn];
    if (!p) return;
    if (S.cfg.mode === 'pass') {
      S.passViewed = false;
      renderPoker();
      showPass(p);
      return;
    }
    if (p.isBot) {
      renderPoker();
      var token = ++S.tableToken;
      later(function () {
        if (S.tableToken !== token) return;
        botTurn(p.id);
      }, 900 + Math.random() * 900);
      return;
    }
    if (p.id === S.mySeat) {
      S.passViewed = true;
      renderPoker();
      return;
    }
    renderPoker();
  }

  function botTurn(seat) {
    var g = S.g;
    if (!g || g.turn !== seat) return;
    if (g.phase !== 'bet' && g.phase !== 'allin') return;
    var p = g.players[seat];
    if (!p || !p.alive) return;

    if (g.phase === 'bet' && Bots.wantsSwap(g, seat)) {
      var offer = E.offerSwap(g, seat);
      if (offer) {
        var pick = Bots.chooseSwap(g, seat, offer, S.cfg.difficulty);
        if (pick) {
          E.applySwap(g, seat, pick.holeIndex, pick.cardId);
          addLog(p.name + ' đổi 1 lá.', 'dim');
        } else {
          E.cancelSwap(g, seat);
        }
      }
    }
    if (g.turn !== seat) return;
    var d = Bots.decide(g, seat, S.cfg.difficulty);
    if (!d) return;
    executeAction(seat, d.action);
  }

  function executeAction(seat, action) {
    var g = S.g;
    if (!g || !g.players[seat]) return;
    var p = g.players[seat];
    var ok = false;
    if (action === 'call') {
      var lv = g.level;
      ok = E.call(g, seat);
      if (ok) addLog(p.name + ' theo — ' + (lv + 1) + ' viên.', p.id === S.mySeat ? 'you' : 'bot');
    } else if (action === 'fold') {
      ok = E.fold(g, seat);
      if (ok) addLog(p.name + ' BỎ BÀI.', 'warn');
    } else if (action === 'coward') {
      ok = E.coward(g, seat);
      if (ok) addLog(p.name + ' BỎ NHÁT.', 'warn');
    } else if (action === 'allin') {
      ok = E.allIn(g, seat);
      if (ok) addLog(p.name + ' ALL-IN 8 VIÊN!', 'liar');
    } else if (action === 'allinCall') {
      ok = E.allInCall(g, seat);
      if (ok) addLog(p.name + ' theo ALL-IN (8 viên).', 'liar');
    } else if (action === 'allinFold') {
      ok = E.allInFold(g, seat);
      if (ok) addLog(p.name + ' bỏ trước ALL-IN.', 'warn');
    }
    if (!ok) {
      if (onlineHost()) broadcastSnap();
      return;
    }
    sfx('chip');
    afterPokerChange();
  }

  function scheduleNextHand() {
    var g = S.g;
    if (!g) return;
    var token = ++S.tableToken;
    later(function () {
      if (S.tableToken !== token) return;
      if (!S.g || S.g.phase !== 'handover') return;
      if (E.alivePlayers(S.g).length < 2) {
        S.g.phase = 'over';
        S.g.winnerId = E.alivePlayers(S.g).length ? E.alivePlayers(S.g)[0].id : null;
        showPokerOver();
        return;
      }
      E.startHand(S.g);
      S.passViewed = false;
      S.dealAnim = true;
      S.flipFrom = 0;
      S.logRevealed = 0;
      S.logShowdown = 0;
      S.logHandWinner = 0;
      addLog('— Ván ' + S.g.handNo + ' — chia bài.', 'round');
      renderPoker();
      later(function () { S.dealAnim = false; renderPoker(); }, 800);
      afterPokerChange();
    }, 2400);
  }

  /* ------------------------------------------------------------------ */
  /* online: snapshot / action / Net                                    */
  /* ------------------------------------------------------------------ */
  function clientSend(action, extra) {
    var msg = { t: 'pokerAction', action: action };
    if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
    if (!Net.send(msg)) { toast('Mất kết nối tới host.'); return; }
    S.busy = true;
    renderPoker();
  }

  function pokerPub() {
    var g = S.g;
    if (!g) return null;
    var showdown = null;
    if (g.showdown) {
      var hands = {};
      g.showdown.seats.forEach(function (id) {
        hands[id] = { label: g.showdown.hands[id].label, cat: g.showdown.hands[id].cat };
      });
      showdown = {
        seats: g.showdown.seats.slice(),
        winners: g.showdown.winners.slice(),
        losers: g.showdown.losers.slice(),
        hands: hands
      };
    }
    return {
      handNo: g.handNo,
      phase: g.phase,
      level: g.level,
      round: g.round,
      revealed: g.revealed,
      turn: g.turn,
      firstSeat: g.firstSeat,
      community: g.community.map(function (c, i) { return i < g.revealed ? c : null; }),
      players: g.players.map(function (p) {
        var shown = !!(g.showdown && g.showdown.seats.indexOf(p.id) >= 0);
        return {
          id: p.id, name: p.name, avatar: p.avatar, alive: p.alive, inHand: p.inHand,
          allIn: p.allIn, bet: p.bet, swapUsed: p.swapUsed, cowardUsed: p.cowardUsed,
          connected: Net.isSeatConnected(p.id),
          hole: shown ? p.hand : null
        };
      }),
      allIn: g.allIn ? { by: g.allIn.by, queue: g.allIn.queue.slice(), responses: g.allIn.responses } : null,
      showdown: showdown,
      shot: g.shot ? { seat: g.shot.seat, bullets: g.shot.bullets, reason: g.shot.reason } : null,
      lastShot: g.lastShot,
      handWinner: g.handWinner,
      winnerId: g.winnerId,
      log: S.netLog.slice(-80)
    };
  }

  function broadcastStart() {
    if (!onlineHost() || !S.g) return;
    var pub = pokerPub();
    Net.lobby.forEach(function (entry) {
      if (entry.seat === 0) return;
      var p = S.g.players[entry.seat];
      Net.sendClient(entry.token, {
        t: 'pokerStart', seat: entry.seat, code: Net.code, pub: pub,
        hand: p ? p.hand : [], legal: p ? E.legalActions(S.g, entry.seat) : []
      });
    });
  }

  function broadcastSnap() {
    if (!onlineHost() || !S.g) return;
    var pub = pokerPub();
    Net.lobby.forEach(function (entry) {
      if (entry.seat === 0) return;
      var p = S.g.players[entry.seat];
      Net.sendClient(entry.token, {
        t: 'pokerSnap', pub: pub,
        hand: p ? p.hand : [], legal: p ? E.legalActions(S.g, entry.seat) : []
      });
    });
  }

  function onPokerAction(seat, msg) {
    var g = S.g;
    if (!g || S.busy) return;
    var act = msg.action;
    if (act === 'swapOffer') {
      if (g.turn !== seat || g.phase !== 'bet') return;
      var offer = E.offerSwap(g, seat);
      if (offer) {
        var entry = Net.entryBySeat(seat);
        if (entry) Net.sendClient(entry.token, { t: 'pokerOffer', cards: offer.cards });
      }
      return;
    }
    if (act === 'swapCancel') {
      E.cancelSwap(g, seat);
      broadcastSnap();
      return;
    }
    if (act === 'swap') {
      if (g.turn !== seat) return;
      var res = E.applySwap(g, seat, msg.holeIndex, msg.cardId);
      if (res) {
        addLog(g.players[seat].name + ' đổi 1 lá.', 'dim');
        broadcastSnap();
      }
      return;
    }
    if (g.turn !== seat) {
      broadcastSnap();
      return;
    }
    if (g.phase !== 'bet' && g.phase !== 'allin') return;
    executeAction(seat, act);
  }

  function applyPokerSnapshot(msg) {
    if (!msg || !msg.pub) return;
    var pub = msg.pub;
    var me = S.mySeat;
    var players = pub.players.map(function (p) {
      return {
        id: p.id, name: p.name, avatar: p.avatar, alive: !!p.alive, inHand: !!p.inHand,
        allIn: !!p.allIn, bet: p.bet, swapUsed: !!p.swapUsed, cowardUsed: !!p.cowardUsed,
        connected: p.connected !== false, isBot: false,
        hole: p.id === me ? (msg.hand || []) : (p.hole || [])
      };
    });
    var newHand = pub.handNo !== S.lastHand;
    S.shadow = {
      handNo: pub.handNo, phase: pub.phase, level: pub.level, round: pub.round,
      revealed: pub.revealed, turn: pub.turn, firstSeat: pub.firstSeat,
      community: pub.community || [], players: players,
      allIn: pub.allIn, showdown: pub.showdown, shot: pub.shot, lastShot: pub.lastShot,
      handWinner: pub.handWinner, winnerId: pub.winnerId
    };
    S.legal = msg.legal || [];
    S.busy = false;
    if (newHand) {
      S.lastHand = pub.handNo;
      S.dealAnim = true;
      S.flipFrom = 0;
      S.logRevealed = 0;
      S.overShown = false;
      hide('#roulette'); S.rouletteOpen = false;
      hide('#gameover'); hide('#confirm'); hide('#swap');
      later(function () { S.dealAnim = false; renderPoker(); }, 800);
      sfx('deal');
    }
    renderPoker();
    renderNetLog(pub.log);
    if (pub.phase !== 'shot' && S.rouletteOpen) {
      hide('#roulette');
      S.rouletteOpen = false;
    }
    if (pub.winnerId != null && !S.overShown) {
      S.overShown = true;
      showPokerOver();
    }
  }

  function startPokerClient(msg) {
    Net.started = true;
    S.cfg.mode = 'online';
    S.online = true;
    S.isHost = false;
    S.mySeat = msg.seat;
    S.roomCode = msg.code || Net.code;
    S.g = null;
    S.shadow = null;
    S.legal = [];
    S.busy = false;
    S.passViewed = true;
    S.overShown = false;
    S.lastHand = 0;
    S.flipFrom = 0;
    clearPending();
    hide('#lobby'); hide('#gameover'); hide('#roulette');
    hide('#confirm'); hide('#swap'); hide('#pass-overlay');
    showScreen('table');
    $('#online-pill').classList.remove('hidden');
    $('#online-code').textContent = S.roomCode;
    $('#btn-leave-online').classList.remove('hidden');
    $('#btn-again').classList.remove('hidden');
    $('#log').innerHTML = '';
    applyPokerSnapshot(msg);
  }

  /* ------------------------------------------------------------------ */
  /* lobby helpers                                                       */
  /* ------------------------------------------------------------------ */
  function setLobbyStatus(text, isErr) {
    var el = $('#lobby-status');
    el.textContent = text || '';
    el.className = 'lobby-status' + (isErr ? ' err' : '');
  }

  function renderLobbyFrom(players, you) {
    if (typeof you === 'number') S.mySeat = you;
    renderLobby(players);
  }

  function renderLobby(players) {
    $('#room-code').textContent = S.roomCode || Net.code || '—';
    var wrap = $('#lobby-players');
    wrap.innerHTML = '';
    var connected = 0;
    (players || []).forEach(function (p) {
      if (p.connected) connected++;
      var row = document.createElement('div');
      row.className = 'lobby-player' + (p.seat === S.mySeat ? ' me' : '') + (p.connected ? '' : ' off');
      var av = document.createElement('div');
      av.className = 'lp-avatar';
      av.textContent = p.avatar || '🎩';
      var nm = document.createElement('div');
      nm.className = 'lp-name';
      nm.textContent = p.name || 'Người chơi';
      var tags = document.createElement('div');
      tags.className = 'lp-tags';
      if (p.host) {
        var th = document.createElement('span');
        th.className = 'lp-tag host';
        th.textContent = 'CHỦ';
        tags.appendChild(th);
      }
      if (p.seat === S.mySeat) {
        var tm = document.createElement('span');
        tm.className = 'lp-tag me';
        tm.textContent = 'BẠN';
        tags.appendChild(tm);
      }
      if (!p.connected) {
        var to = document.createElement('span');
        to.className = 'lp-tag off';
        to.textContent = 'OFF';
        tags.appendChild(to);
      }
      row.appendChild(av); row.appendChild(nm); row.appendChild(tags);
      if (S.isHost && !p.host) {
        var kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'lp-kick';
        kick.title = 'Mời ra';
        kick.textContent = '✕';
        kick.addEventListener('click', function () { Net.kick(p.seat); });
        row.appendChild(kick);
      }
      wrap.appendChild(row);
    });

    var isHost = !!S.isHost;
    var startBtn = $('#btn-lobby-start');
    startBtn.classList.toggle('hidden', !isHost);
    if (isHost) {
      var ready = !!Net.ready;
      startBtn.disabled = connected < 2 || !ready;
      startBtn.textContent = connected < 2 ? 'CẦN THÊM NGƯỜI' : ('BẮT ĐẦU (' + connected + ')');
      $('#lobby-hint').textContent = connected < 2
        ? 'Gửi mã phòng cho bạn bè. Cần ít nhất 2 người.'
        : 'Đủ người rồi! Bấm BẮT ĐẦU khi mọi người đã sẵn sàng.';
    } else {
      $('#lobby-hint').textContent = 'Chờ chủ phòng bắt đầu…';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Online relay qua MQTT công khai (HiveMQ)                            */
  /* Host vẫn giữ luật; broker chỉ chuyển tiếp tin nhắn.                 */
  /* ------------------------------------------------------------------ */
  var Net = {
    mqtt: null,
    ready: false,
    code: '',
    base: '',
    isHost: false,
    started: false,
    closing: false,
    lobby: [],
    myToken: '',
    everConnected: false,
    gotWelcome: false,
    helloTimer: null,
    removeTimers: [],

    close: function (notify) {
      if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
      var client = this.mqtt;
      if (notify !== false && client && client.connected) {
        try {
          if (this.isHost) client.publish(this.base + '/all', JSON.stringify({ t: 'host-left' }), { qos: 0 });
          else client.publish(this.base + '/in', JSON.stringify({ t: 'bye', token: this.myToken }), { qos: 0 });
        } catch (e) {}
      }
      this.mqtt = null;
      this.ready = false;
      this.closing = true;
      setTimeout(function () { try { if (client) client.end(true); } catch (e) {} }, 150);
      this.removeTimers.forEach(function (id) { clearTimeout(id); });
      this.removeTimers = [];
      this.lobby = [];
      this.started = false;
      this.isHost = false;
      this.code = '';
      this.base = '';
      this.myToken = '';
      this.everConnected = false;
      this.gotWelcome = false;
      S.isHost = false;
      S.mySeat = 0;
      S.roomCode = '';
      S.netLog = [];
      this.closing = false;
    },

    leave: function () {
      this.close(true);
      hide('#lobby');
      hide('#gameover');
      hide('#roulette');
      hide('#confirm');
      hide('#swap');
      hide('#pass-overlay');
      $('#online-pill').classList.add('hidden');
      $('#btn-leave-online').classList.add('hidden');
      $('#screen-table').classList.add('hidden');
      $('#screen-start').classList.remove('hidden');
      S.g = null;
      S.shadow = null;
      S.legal = [];
      S.busy = false;
      clearPending();
    },

    hostRoom: function (name) {
      this.close(false);
      this.isHost = true;
      this.started = false;
      this.code = makeRoomCode();
      this.base = 'liarsbar/poker/' + this.code;
      this.myToken = 'host';
      this.lobby = [{ name: name, avatar: HUMAN_AVATARS[0], connected: true, token: 'host', seat: 0 }];
      S.isHost = true;
      S.mySeat = 0;
      S.roomCode = this.code;
      S.netName = name;
      S.cfg.mode = 'online';
      S.netLog = [];
      showLobby();
      $('#room-code').textContent = this.code;
      setLobbyStatus('Đang kết nối tới broker công cộng…');
      renderLobby(this.publicLobby());
      this.connectMqtt(true);
    },

    connectMqtt: function (isHost) {
      var self = this;
      this.ready = false;
      var url = 'wss://broker.hivemq.com:8884/mqtt';
      var cid = 'liarsbar-poker-' + (isHost ? 'h' : 'c') + '-' + Math.random().toString(16).slice(2, 12);
      var will = isHost
        ? { topic: this.base + '/all', payload: JSON.stringify({ t: 'host-left' }), qos: 0, retain: false }
        : { topic: this.base + '/in', payload: JSON.stringify({ t: 'bye', token: this.myToken }), qos: 0, retain: false };
      var client;
      try {
        client = mqtt.connect(url, {
          clientId: cid, clean: true, connectTimeout: 12000,
          reconnectPeriod: 2000, keepalive: 30, will: will
        });
      } catch (e) {
        setLobbyStatus('Không kết nối được broker. Kiểm tra mạng.', true);
        return;
      }
      this.mqtt = client;
      client.on('connect', function () {
        if (self.mqtt !== client) return;
        self.ready = true;
        if (isHost) {
          client.subscribe(self.base + '/in', { qos: 1 }, function (err) {
            if (err) setLobbyStatus('Lỗi đăng ký broker: ' + err.message, true);
          });
          setLobbyStatus(self.everConnected ? 'Đã kết nối lại broker.' : 'Phòng đã mở. Gửi mã cho bạn bè.');
          self.everConnected = true;
          renderLobby(self.publicLobby());
          if (self.started && S.g) broadcastSnap();
        } else {
          client.subscribe([self.base + '/all', self.base + '/c/' + self.myToken], { qos: 1 }, function (err) {
            if (err) { setLobbyStatus('Lỗi đăng ký broker: ' + err.message, true); return; }
            self.hello();
          });
        }
      });
      client.on('reconnect', function () {
        if (self.mqtt === client) setLobbyStatus('Đang kết nối lại broker…');
      });
      client.on('offline', function () {
        if (self.mqtt === client) { self.ready = false; setLobbyStatus('Mất kết nối broker — đang thử lại…', true); }
      });
      client.on('error', function (err) {
        if (self.mqtt === client) setLobbyStatus('Lỗi broker: ' + (err && err.message ? err.message : err), true);
      });
      client.on('close', function () {
        if (self.mqtt === client) self.ready = false;
      });
      client.on('message', function (topic, payload) {
        if (self.mqtt === client) self.onMqttMessage(topic, payload);
      });
    },

    hello: function () {
      var self = this;
      this.gotWelcome = false;
      this.sendRaw({ t: 'hello', name: S.netName || 'Người chơi', token: this.myToken }, true);
      setLobbyStatus('Đã kết nối — chờ chủ phòng…');
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(function () {
        if (self.mqtt && self.mqtt.connected && !self.gotWelcome && !self.started) {
          setLobbyStatus('Không thấy chủ phòng. Kiểm tra mã hoặc bảo host mở phòng.', true);
        }
      }, 6000);
    },

    sendRaw: function (obj, qos) {
      if (!this.mqtt || !this.mqtt.connected) return false;
      try {
        this.mqtt.publish(this.base + '/in', JSON.stringify(obj), { qos: qos ? 1 : 0 });
        return true;
      } catch (e) { return false; }
    },

    send: function (msg) {
      if (!this.mqtt || !this.mqtt.connected) return false;
      var out = { t: msg.t };
      Object.keys(msg).forEach(function (k) { out[k] = msg[k]; });
      out.token = this.myToken;
      try {
        this.mqtt.publish(this.base + '/in', JSON.stringify(out), { qos: 1 });
        return true;
      } catch (e) { return false; }
    },

    sendClient: function (token, obj) {
      if (!this.mqtt || !this.mqtt.connected) return;
      try { this.mqtt.publish(this.base + '/c/' + token, JSON.stringify(obj), { qos: 1 }); } catch (e) {}
    },

    sendAll: function (obj) {
      if (!this.mqtt || !this.mqtt.connected) return;
      try { this.mqtt.publish(this.base + '/all', JSON.stringify(obj), { qos: 0 }); } catch (e) {}
    },

    broadcastEvent: function (obj) {
      this.sendAll(obj);
    },

    onMqttMessage: function (topic, payload) {
      var msg = parseMsg(payload.toString());
      if (!msg) return;
      if (topic === this.base + '/in') {
        if (msg.t === 'hello') this.onHello(msg);
        else if (msg.t === 'bye') this.onBye(msg);
        else if (msg.t === 'pokerAction') {
          var entry = this.entryByToken(msg.token);
          if (entry) this.onAction(entry, msg);
        }
      } else if (topic === this.base + '/all') {
        if (msg.t === 'host-left') {
          toast('Chủ phòng đã rời phòng.');
          this.leave();
        } else if (msg.t === 'pokerShot') {
          showRoulette(msg.seat, msg.bullets, msg.reason, true);
        } else if (msg.t === 'pokerShotResult') {
          showRouletteResult(msg, true);
          later(function () { hide('#roulette'); S.rouletteOpen = false; }, 2000);
        }
      } else if (topic === this.base + '/c/' + this.myToken) {
        this.onClientData(msg);
      }
    },

    onHello: function (msg) {
      var token = String(msg.token || '').slice(0, 40) || ('x' + Math.random().toString(36).slice(2, 10));
      var name = String(msg.name || '').trim().slice(0, 14) || 'Người chơi';
      var existing = this.entryByToken(token);
      if (existing) {
        existing.connected = true;
        existing.name = name;
        this.sendClient(token, { t: 'welcome', seat: existing.seat, code: this.code, players: this.publicLobby() });
        if (this.started && S.g) {
          this.sendClient(token, { t: 'pokerResume', seat: existing.seat, code: this.code });
          var p = S.g.players[existing.seat];
          this.sendClient(token, {
            t: 'pokerSnap', pub: pokerPub(),
            hand: p ? p.hand : [], legal: p ? E.legalActions(S.g, existing.seat) : []
          });
          addLog(name + ' đã kết nối lại.', 'dim');
          broadcastSnap();
        } else {
          this.broadcastLobby();
        }
        return;
      }
      if (this.started) {
        this.sendClient(token, { t: 'error', msg: 'Bàn đã bắt đầu, không thể vào.' });
        return;
      }
      if (this.lobby.length >= 4) {
        this.sendClient(token, { t: 'full', msg: 'Phòng đã đủ 4 người.' });
        return;
      }
      var seat = this.lobby.length;
      this.lobby.push({
        name: name, avatar: HUMAN_AVATARS[seat % HUMAN_AVATARS.length],
        connected: true, token: token, seat: seat
      });
      this.sendClient(token, { t: 'welcome', seat: seat, code: this.code, players: this.publicLobby() });
      this.broadcastLobby();
    },

    onBye: function (msg) {
      var self = this;
      var token = String(msg.token || '');
      var entry = this.entryByToken(token);
      if (!entry) return;
      entry.connected = false;
      if (!this.started) {
        this.broadcastLobby();
        var id = setTimeout(function () {
          if (self.closing || entry.connected) return;
          var idx = self.lobby.indexOf(entry);
          if (idx >= 0) {
            self.lobby.splice(idx, 1);
            self.reindex();
            self.broadcastLobby();
          }
        }, 6000);
        this.removeTimers.push(id);
      } else {
        addLog(entry.name + ' mất kết nối — đang chờ kết nối lại…', 'warn');
        broadcastSnap();
      }
    },

    onAction: function (entry, msg) {
      if (!this.started || !S.g || this.closing) return;
      onPokerAction(entry.seat, msg);
    },

    entryByToken: function (token) {
      for (var i = 0; i < this.lobby.length; i++) {
        if (this.lobby[i].token === token) return this.lobby[i];
      }
      return null;
    },
    entryBySeat: function (seat) {
      for (var i = 0; i < this.lobby.length; i++) {
        if (this.lobby[i].seat === seat) return this.lobby[i];
      }
      return null;
    },
    reindex: function () {
      this.lobby.forEach(function (p, i) { p.seat = i; });
    },
    publicLobby: function () {
      return this.lobby.map(function (p) {
        return {
          name: p.name, avatar: p.avatar, connected: !!p.connected,
          seat: p.seat, host: p.seat === 0
        };
      });
    },
    broadcastLobby: function () {
      var self = this;
      var players = this.publicLobby();
      this.lobby.forEach(function (p) {
        if (p.seat === 0) return;
        self.sendClient(p.token, { t: 'lobby', players: players, you: p.seat });
      });
      if (S.isHost) renderLobby(players);
    },
    playersForGame: function () {
      var list = this.lobby.filter(function (p) { return p.seat === 0 || p.connected; });
      list.sort(function (a, b) { return a.seat - b.seat; });
      list.forEach(function (p, i) { p.seat = i; });
      this.lobby = list;
      return list.map(function (p) {
        return { name: p.name, avatar: p.avatar, isBot: false };
      });
    },
    isSeatConnected: function (seat) {
      if (!S.isHost) {
        var p = S.shadow && S.shadow.players[seat];
        return !p || p.connected !== false;
      }
      if (seat === 0) return true;
      var e = this.entryBySeat(seat);
      return !!(e && e.connected);
    },
    kick: function (seat) {
      if (!this.isHost || this.started) return;
      var entry = this.entryBySeat(seat);
      if (!entry || entry.seat === 0) return;
      this.sendClient(entry.token, { t: 'kicked' });
      var idx = this.lobby.indexOf(entry);
      if (idx >= 0) this.lobby.splice(idx, 1);
      this.reindex();
      this.broadcastLobby();
    },

    startHostGame: function () {
      if (!S.isHost) return;
      var players = this.playersForGame();
      if (players.length < 2) { toast('Cần ít nhất 2 người.'); return; }
      this.started = true;
      hide('#lobby');
      S.cfg.mode = 'online';
      S.isHost = true;
      S.mySeat = 0;
      S.roomCode = this.code;
      startPoker(players, true);
    },

    joinRoom: function (code, name) {
      this.close(false);
      this.isHost = false;
      this.started = false;
      this.code = code;
      this.base = 'liarsbar/poker/' + code;
      this.myToken = getClientToken();
      this.lobby = [];
      S.isHost = false;
      S.mySeat = 0;
      S.roomCode = code;
      S.netName = name;
      S.cfg.mode = 'online';
      showLobby();
      $('#room-code').textContent = code;
      $('#btn-lobby-start').classList.add('hidden');
      setLobbyStatus('Đang kết nối tới broker…');
      renderLobby([]);
      this.connectMqtt(false);
    },

    onClientData: function (msg) {
      if (!msg) return;
      if (msg.t === 'welcome') {
        this.gotWelcome = true;
        if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
        S.mySeat = msg.seat;
        S.roomCode = msg.code || S.roomCode;
        renderLobbyFrom(msg.players || [], msg.seat);
        setLobbyStatus('Đã vào phòng — chờ chủ phòng bắt đầu…');
      } else if (msg.t === 'lobby') {
        if (this.started) return;
        if (typeof msg.you === 'number') S.mySeat = msg.you;
        renderLobbyFrom(msg.players || [], msg.you);
      } else if (msg.t === 'pokerStart') {
        startPokerClient(msg);
      } else if (msg.t === 'pokerSnap') {
        if (!this.started) return;
        applyPokerSnapshot(msg);
      } else if (msg.t === 'pokerOffer') {
        S.swapOffer = msg.cards;
        S.swapSource = 'client';
        openSwap();
      } else if (msg.t === 'pokerResume') {
        this.started = true;
        S.mySeat = msg.seat;
        S.cfg.mode = 'online';
        S.online = true;
        S.isHost = false;
        S.roomCode = msg.code || this.code;
        hide('#lobby');
        showScreen('table');
        $('#online-pill').classList.remove('hidden');
        $('#online-code').textContent = S.roomCode;
        $('#btn-leave-online').classList.remove('hidden');
        toast('Đã kết nối lại.');
      } else if (msg.t === 'host-left') {
        toast('Chủ phòng đã rời phòng.');
        this.leave();
      } else if (msg.t === 'kicked') {
        toast('Bạn đã bị mời ra khỏi phòng.');
        this.leave();
      } else if (msg.t === 'full') {
        toast(msg.msg || 'Phòng đã đủ người.');
        this.leave();
      } else if (msg.t === 'error') {
        toast(msg.msg || 'Có lỗi xảy ra.');
      }
    }
  };

  /* ------------------------------------------------------------------ */
  /* màn hình bắt đầu                                                    */
  /* ------------------------------------------------------------------ */
  function renderNameInputs() {
    var wrap = $('#name-inputs');
    wrap.innerHTML = '';
    var solo = S.cfg.mode === 'solo';
    var online = S.cfg.mode === 'online';
    var n = (solo || online) ? 1 : S.cfg.count;
    wrap.classList.toggle('multi', !solo && !online && n > 2);
    for (var i = 0; i < n; i++) {
      var input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 14;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = (solo || online) ? 'Bạn' : ('Người chơi ' + (i + 1));
      input.value = solo ? S.cfg.soloName : (online ? S.cfg.onlineName : S.cfg.names[i]);
      input.addEventListener('input', (function (idx) {
        return function (e) {
          if (solo) S.cfg.soloName = e.target.value;
          else if (online) S.cfg.onlineName = e.target.value;
          else S.cfg.names[idx] = e.target.value;
        };
      })(i));
      wrap.appendChild(input);
    }
  }

  function updateOnlineRoleUI() {
    var join = S.cfg.onlineRole === 'join';
    $('#join-code-field').classList.toggle('hidden', !join);
    $('#online-note').textContent = join
      ? 'Nhập mã 5 ký tự mà chủ phòng gửi cho bạn.'
      : 'Bạn là host. Gửi mã phòng cho bạn bè để họ vào.';
    if (S.cfg.mode === 'online') {
      $('#btn-start').textContent = join ? 'VÀO PHÒNG' : 'TẠO PHÒNG';
    }
  }

  function updateModeUI() {
    var solo = S.cfg.mode === 'solo';
    var pass = S.cfg.mode === 'pass';
    var online = S.cfg.mode === 'online';
    $('#players-box').style.display = online ? 'none' : '';
    $('#online-box').style.display = online ? '' : 'none';
    $('#diff-box').style.display = solo ? '' : 'none';
    $('#names-label').textContent = pass ? 'Tên người chơi' : 'Tên của bạn';
    $('#mode-note').textContent = solo
      ? "Bạn đấu với 1–3 bot Texas Hold'em."
      : (pass
        ? 'Chuyền máy: tới lượt ai, người đó bấm xem bài.'
        : 'Cần Internet. Một người tạo phòng làm host, bạn bè nhập mã 5 ký tự.');
    $('#btn-start').textContent = online
      ? (S.cfg.onlineRole === 'join' ? 'VÀO PHÒNG' : 'TẠO PHÒNG')
      : 'VÀO BÀN';
    renderNameInputs();
    updateOnlineRoleUI();
  }

  function bindSeg(sel, attr, cb) {
    var wrap = $(sel);
    if (!wrap) return;
    wrap.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        wrap.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        cb(btn.getAttribute(attr));
        sfx('click');
      });
    });
  }

  function setSound(on) {
    S.cfg.sound = on;
    Sound.on = on;
    $('#opt-sound').checked = on;
    $('#btn-sound').textContent = on ? '🔊' : '🔇';
    if (on) { Sound.init(); sfx('click'); }
  }

  function copyText(text) {
    if (!text) return;
    function ok() { toast('Đã copy mã phòng: ' + text); }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        ok();
      } catch (e) { toast('Mã phòng: ' + text); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(fallback);
    } else fallback();
  }

  function goMenu() {
    clearPending();
    S.g = null;
    S.shadow = null;
    S.legal = [];
    S.busy = false;
    S.passViewed = false;
    hide('#gameover'); hide('#roulette'); hide('#confirm');
    hide('#swap'); hide('#pass-overlay');
    $('#screen-table').classList.add('hidden');
    $('#screen-start').classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* sự kiện                                                            */
  /* ------------------------------------------------------------------ */
  bindSeg('#mode-seg', 'data-mode', function (mode) {
    S.cfg.mode = mode;
    updateModeUI();
  });
  bindSeg('#count-seg', 'data-count', function (v) {
    S.cfg.count = parseInt(v, 10) || 4;
    renderNameInputs();
  });
  bindSeg('#diff-seg', 'data-diff', function (v) {
    S.cfg.difficulty = v;
  });
  bindSeg('#online-role-seg', 'data-role', function (role) {
    S.cfg.onlineRole = role;
    updateOnlineRoleUI();
  });

  $('#room-code-input').addEventListener('input', function (e) {
    e.target.value = String(e.target.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });

  $('#opt-sound').addEventListener('change', function (e) { setSound(e.target.checked); });

  $('#btn-start').addEventListener('click', function () {
    Sound.init();
    sfx('click');
    if (S.cfg.mode === 'online') {
      var name = (S.cfg.onlineName || '').trim() || 'Bạn';
      if (S.cfg.onlineRole === 'join') {
        var code = String($('#room-code-input').value || '').trim().toUpperCase();
        if (code.length !== 5) { toast('Nhập đủ 5 ký tự mã phòng.'); return; }
        Net.joinRoom(code, name);
      } else {
        Net.hostRoom(name);
      }
      return;
    }
    startLocal();
  });

  $('#btn-call').addEventListener('click', doCall);
  $('#btn-fold').addEventListener('click', function () { askConfirm('fold'); });
  $('#btn-allin').addEventListener('click', function () { askConfirm('allin'); });
  $('#btn-swap').addEventListener('click', startSwap);
  $('#btn-coward').addEventListener('click', function () { askConfirm('coward'); });

  $('#btn-confirm-ok').addEventListener('click', confirmOk);
  $('#btn-confirm-cancel').addEventListener('click', function () {
    S.confirmKind = null;
    hide('#confirm');
  });
  $('#btn-swap-ok').addEventListener('click', confirmSwap);
  $('#btn-swap-cancel').addEventListener('click', cancelSwap);

  $('#btn-pass-view').addEventListener('click', function () {
    hide('#pass-overlay');
    S.passViewed = true;
    sfx('click');
    renderPoker();
  });

  $('#btn-combo').addEventListener('click', function () {
    var cat = typeof S.lastBestCat === 'number' ? S.lastBestCat : -1;
    document.querySelectorAll('#combo-modal-list .combo-row').forEach(function (r) {
      r.classList.toggle('on', +r.dataset.cat === cat);
    });
    show('#combo-modal');
  });
  $('#btn-combo-close').addEventListener('click', function () { hide('#combo-modal'); });
  $('#combo-modal').addEventListener('click', function (e) {
    if (e.target === $('#combo-modal')) hide('#combo-modal');
  });

  $('#btn-log').addEventListener('click', function () {
    $('.poker-aside').classList.toggle('show');
  });

  $('#btn-sound').addEventListener('click', function () { setSound(!S.cfg.sound); });

  $('#btn-restart').addEventListener('click', function () {
    if (S.cfg.mode === 'online') {
      if (!S.isHost) { toast('Chỉ chủ phòng mới được bắt đầu bàn mới.'); return; }
      var players = Net.playersForGame();
      if (players.length < 2) { toast('Cần ít nhất 2 người đang kết nối.'); return; }
      hide('#gameover');
      startPoker(players, true);
      return;
    }
    startLocal();
  });

  $('#btn-leave-online').addEventListener('click', function () { Net.leave(); });

  $('#btn-again').addEventListener('click', function () {
    if (S.cfg.mode === 'online') {
      if (!S.isHost) { toast('Chờ chủ phòng bắt đầu bàn mới…'); return; }
      var players = Net.playersForGame();
      if (players.length < 2) { toast('Cần ít nhất 2 người đang kết nối.'); return; }
      hide('#gameover');
      startPoker(players, true);
      return;
    }
    hide('#gameover');
    startLocal();
  });

  $('#btn-menu').addEventListener('click', function () {
    hide('#gameover');
    if (S.cfg.mode === 'online') Net.leave();
    else goMenu();
  });

  $('#btn-copy-code').addEventListener('click', function () {
    copyText(S.roomCode || Net.code);
  });

  $('#btn-lobby-start').addEventListener('click', function () {
    Net.startHostGame();
  });

  $('#btn-lobby-leave').addEventListener('click', function () {
    Net.leave();
  });

  function openRules() { show('#rules'); }
  function closeRules() { hide('#rules'); }
  $('#btn-rules-open').addEventListener('click', openRules);
  $('#btn-rules-close').addEventListener('click', closeRules);
  $('#btn-rules-ok').addEventListener('click', closeRules);
  $('#rules').addEventListener('click', function (e) {
    if (e.target === $('#rules')) closeRules();
  });

  window.addEventListener('resize', positionSeats);

  document.addEventListener('pointerdown', function once() {
    Sound.init();
    document.removeEventListener('pointerdown', once);
  }, { once: true });

  /* ------------------------------------------------------------------ */
  /* khởi động                                                          */
  /* ------------------------------------------------------------------ */
  updateModeUI();
  buildCombo();

  (function demo() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return; }
    if (q.get('demo') !== '1' && q.get('autostart') !== '1') return;
    S.cfg.mode = q.get('mode') === 'pass' ? 'pass' : 'solo';
    var n = parseInt(q.get('count') || '4', 10);
    S.cfg.count = Math.min(4, Math.max(2, n || 4));
    var d = q.get('diff');
    if (d === 'easy' || d === 'normal' || d === 'hard') S.cfg.difficulty = d;
    setTimeout(function () {
      Sound.init();
      startLocal();
    }, 250);
  })();

  window.__poker = {
    S: S,
    E: E,
    Bots: Bots,
    Net: Net,
    startLocal: startLocal,
    startPoker: startPoker,
    doCall: doCall,
    doAction: doAction,
    askConfirm: askConfirm,
    confirmOk: confirmOk
  };
})();




