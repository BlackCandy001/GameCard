/* =====================================================================
   app.js — điều khiển giao diện + luồng chơi
   ===================================================================== */
(function () {
  'use strict';

  var E = window.Engine;
  var Bots = window.Bots;

  var BOT_POOL = [
    { name: 'Gấu Bự', avatar: '🐻' },
    { name: 'Thỏ Nhí', avatar: '🐰' },
    { name: 'Cáo Già', avatar: '🦊' }
  ];
  var HUMAN_AVATARS = ['🕵️', '🎩', '🧢', '👒'];
  var TIMER_SECONDS = 30;

  var S = {
    cfg: {
      mode: 'solo',
      count: 4,
      difficulty: 'normal',
      timer: true,
      sound: true,
      soloName: 'Bạn',
      onlineName: 'Bạn',
      onlineRole: 'host',
      names: ['Người chơi 1', 'Người chơi 2', 'Người chơi 3', 'Người chơi 4']
    },
    g: null,
    gameId: 0,
    seatEls: [],
    selected: new Set(),
    busy: false,
    passLocked: false,
    revealed: false,
    timerId: null,
    timerEnd: 0,
    pending: new Set(),
    reveal: null,
    verdict: null,
    justPlayed: null,
    dealAnim: false,
    tableAnim: false,
    isHost: false,
    mySeat: 0,
    roomCode: '',
    netName: '',
    netLog: [],
    lastRound: 0,
    lastPileGroups: 0,
    gameOverShown: false
  };

  /* ------------------------------------------------------------------ */
  /* tiện ích                                                            */
  /* ------------------------------------------------------------------ */
  function $(sel) { return document.querySelector(sel); }
  function show(sel) { var e = $(sel); if (e) e.classList.remove('hidden'); }
  function hide(sel) { var e = $(sel); if (e) e.classList.add('hidden'); }

  function later(fn, ms) {
    var id = setTimeout(function () {
      S.pending.delete(id);
      fn();
    }, ms);
    S.pending.add(id);
    return id;
  }

  function clearPending() {
    S.pending.forEach(function (id) { clearTimeout(id); });
    S.pending.clear();
    stopTimer();
  }

  function pickBot(i) { return BOT_POOL[i % BOT_POOL.length]; }

  function buildPlayers() {
    var cfg = S.cfg;
    if (cfg.mode === 'solo') {
      var out = [{
        name: (cfg.soloName || '').trim() || 'Bạn',
        avatar: HUMAN_AVATARS[0],
        isBot: false
      }];
      for (var i = 0; i < cfg.count - 1; i++) {
        var b = pickBot(i);
        out.push({ name: b.name, avatar: b.avatar, isBot: true });
      }
      return out;
    }
    var list = [];
    for (var k = 0; k < cfg.count; k++) {
      list.push({
        name: (cfg.names[k] || '').trim() || ('Người chơi ' + (k + 1)),
        avatar: HUMAN_AVATARS[k % HUMAN_AVATARS.length],
        isBot: false
      });
    }
    return list;
  }

  function handOwner() {
    if (!S.g) return null;
    if (S.cfg.mode === 'online') return S.g.players[S.mySeat] || null;
    if (S.cfg.mode === 'solo') return S.g.players[0] || null;
    if (!S.revealed) return null;
    if (S.g.phase !== 'playing') return null;
    var p = S.g.players[S.g.turn];
    return (p && !p.isBot) ? p : null;
  }

  function canHumanAct() {
    var g = S.g;
    if (!g) return false;
    if (g.phase !== 'playing' || g.winnerId != null) return false;
    var p = g.players[g.turn];
    if (!p || p.isBot || !p.alive) return false;
    if (S.cfg.mode === 'online' && p.id !== S.mySeat) return false;
    if (S.busy || S.passLocked || g.forcedCall) return false;
    if (S.cfg.mode === 'pass' && !S.revealed) return false;
    return true;
  }

  function showScreen(which) {
    $('#screen-start').classList.toggle('hidden', which !== 'start');
    $('#screen-game').classList.toggle('hidden', which !== 'game');
    hide('#lobby');
  }

  function showLobby() {
    $('#screen-start').classList.add('hidden');
    $('#screen-game').classList.add('hidden');
    show('#lobby');
  }

  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function isOnline() { return S.cfg.mode === 'online'; }
  function onlineHost() { return S.cfg.mode === 'online' && S.isHost; }

  function makeRoomCode() {
    var s = '';
    for (var i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function getClientToken() {
    var t = null;
    try { t = sessionStorage.getItem('liarpoker-token'); } catch (e) {}
    if (!t) {
      t = 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try { sessionStorage.setItem('liarpoker-token', t); } catch (e) {}
    }
    return t;
  }

  function parseMsg(raw) {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return (raw && typeof raw === 'object') ? raw : null;
  }

  function dummyCards(n, base) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({ id: base + i, rank: '?', suit: '♠', joker: false });
    }
    return out;
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
      hide('#verdict');
      $('#online-pill').classList.add('hidden');
      $('#btn-leave-online').classList.add('hidden');
      $('#screen-game').classList.add('hidden');
      $('#screen-start').classList.remove('hidden');
      S.g = null;
      S.shadow = null;
      S.legal = [];
      S.busy = false;
      clearPending();
    },

    /* ---------- host ---------- */
    hostRoom: function (name) {
      this.close(false);
      this.isHost = true;
      this.started = false;
      this.code = makeRoomCode();
      this.base = 'liarsbar/deck/' + this.code;
      this.myToken = 'host';
      this.lobby = [{ name: name, avatar: HUMAN_AVATARS[0], connected: true, token: 'host', seat: 0 }];
      S.isHost = true;
      S.mySeat = 0;
      S.roomCode = this.code;
      S.netName = name;
      S.cfg.mode = 'online';
      S.cfg.timer = false;
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
      var cid = 'liarsbar-deck-' + (isHost ? 'h' : 'c') + '-' + Math.random().toString(16).slice(2, 12);
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
          if (self.started && S.g) self.broadcastState();
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

    onMqttMessage: function (topic, payload) {
      var msg = parseMsg(payload.toString());
      if (!msg) return;
      if (topic === this.base + '/in') {
        if (msg.t === 'hello') this.onHello(msg);
        else if (msg.t === 'bye') this.onBye(msg);
        else if (msg.t === 'action') {
          var entry = this.entryByToken(msg.token);
          if (entry) this.onAction(entry, msg);
        }
      } else if (topic === this.base + '/all') {
        if (msg.t === 'host-left') {
          toast('Chủ phòng đã rời phòng.');
          this.leave();
        } else if (msg.t === 'rouletteStart') {
          clientRouletteStart(msg);
        } else if (msg.t === 'rouletteResult') {
          clientRouletteResult(msg);
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
          this.sendClient(token, { t: 'resume', seat: existing.seat, code: this.code });
          this.sendSnapshotTo(existing);
          addLog(name + ' đã kết nối lại.', 'dim');
          this.broadcastState();
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
        this.broadcastState();
      }
    },

    onAction: function (entry, msg) {
      if (!this.started || !S.g || this.closing) return;
      var seat = entry.seat;
      var g = S.g;
      if (g.phase !== 'playing' || g.turn !== seat || S.busy || g.forcedCall || g.winnerId != null) {
        this.sendSnapshotTo(entry);
        return;
      }
      if (msg.action === 'liar') {
        if (!g.pile.length) { this.sendSnapshotTo(entry); return; }
        doChallenge(seat);
        return;
      }
      if (msg.action === 'play') {
        var ids = Array.isArray(msg.ids) ? msg.ids : [];
        var p = g.players[seat];
        var ok = !!p && ids.length >= 1 && ids.length <= 3;
        if (ok) {
          ok = ids.every(function (id) {
            return p.hand.some(function (c) { return c.id === id; });
          });
        }
        if (!ok) { this.sendSnapshotTo(entry); return; }
        doPlay(seat, ids);
      }
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
      this.lobby.forEach(function (p, i) {
        p.seat = i;
      });
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
    sendSnapshotTo: function (entry) {
      if (!entry || !S.g) return;
      var p = S.g.players[entry.seat];
      this.sendClient(entry.token, { t: 'snap', pub: pubState(), hand: p ? p.hand : [] });
    },
    broadcastState: function () {
      if (!onlineHost() || !S.g) return;
      var self = this;
      var pub = pubState();
      this.lobby.forEach(function (entry) {
        if (entry.seat === 0) return;
        var p = S.g.players[entry.seat];
        self.sendClient(entry.token, { t: 'snap', pub: pub, hand: p ? p.hand : [] });
      });
    },
    broadcastStart: function () {
      if (!onlineHost() || !S.g) return;
      var self = this;
      var pub = pubState();
      this.lobby.forEach(function (entry) {
        if (entry.seat === 0) return;
        var p = S.g.players[entry.seat];
        self.sendClient(entry.token, {
          t: 'start', seat: entry.seat, code: Net.code, pub: pub, hand: p ? p.hand : []
        });
      });
    },
    broadcastEvent: function (obj) {
      this.sendAll(obj);
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
        var p = S.g && S.g.players[seat];
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

    /* ---------- client ---------- */
    joinRoom: function (code, name) {
      this.close(false);
      this.isHost = false;
      this.started = false;
      this.code = code;
      this.base = 'liarsbar/deck/' + code;
      this.myToken = getClientToken();
      this.lobby = [];
      S.isHost = false;
      S.mySeat = 0;
      S.roomCode = code;
      S.netName = name;
      S.cfg.mode = 'online';
      S.cfg.timer = false;
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
      } else if (msg.t === 'start') {
        startClientGame(msg);
      } else if (msg.t === 'snap') {
        if (!this.started) return;
        applySnapshot(msg);
      } else if (msg.t === 'resume') {
        this.started = true;
        S.cfg.mode = 'online';
        S.isHost = false;
        S.cfg.timer = false;
        S.mySeat = msg.seat;
        S.roomCode = msg.code || this.code;
        hide('#lobby');
        $('#screen-start').classList.add('hidden');
        $('#screen-game').classList.remove('hidden');
        $('#online-pill').classList.remove('hidden');
        $('#online-code').textContent = S.roomCode;
        $('#btn-leave-online').classList.remove('hidden');
        toast('Đã kết nối lại.');
      } else if (msg.t === 'rouletteStart') {
        clientRouletteStart(msg);
      } else if (msg.t === 'rouletteResult') {
        clientRouletteResult(msg);
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
  /* âm thanh tổng hợp bằng WebAudio                                     */
  /* ------------------------------------------------------------------ */
  var Sound = {
    ctx: null,
    on: true,
    init: function () {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
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
        case 'play': this.noise(.08, .11, 1100); this.tone(150, .1, 'triangle', .09, 80); break;
        case 'liar':
          this.tone(233, .16, 'sawtooth', .1, 175);
          setTimeout(function () { Sound.tone(175, .32, 'sawtooth', .12, 110); }, 140);
          break;
        case 'warn':
          this.tone(440, .09, 'square', .05);
          setTimeout(function () { Sound.tone(330, .12, 'square', .05); }, 100);
          break;
        case 'spin': this.tone(220, .3, 'sawtooth', .05, 520); break;
        case 'shot': this.noise(.5, .38, 700); this.tone(60, .5, 'sine', .28, 28); break;
        case 'blank': this.tone(140, .07, 'square', .06); this.noise(.05, .05, 2200); break;
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

  function sfx(name) {
    if (S.cfg.sound) Sound.play(name);
  }

  /* ------------------------------------------------------------------ */
  /* vẽ                                                                  */
  /* ------------------------------------------------------------------ */
  function faceHTML(card) {
    if (card.joker) {
      return '<div class="jk"><span class="jk-star">★</span><span class="jk-word">JOKER</span></div>';
    }
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

  function addLog(text, cls) {
    var log = $('#log');
    if (log) {
      var d = document.createElement('div');
      d.className = 'log-line' + (cls ? ' ' + cls : '');
      d.textContent = text;
      log.appendChild(d);
      while (log.children.length > 90) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    }
    if (onlineHost()) {
      S.netLog.push({ text: text, cls: cls || '' });
      if (S.netLog.length > 70) S.netLog.shift();
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1700);
  }

  function shake() {
    var el = $('#screen-game');
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(function () { el.classList.remove('shake'); }, 650);
  }

  function positionSeats() {
    var g = S.g;
    if (!g) return;
    var n = g.players.length;
    var rot = (S.cfg.mode === 'online') ? S.mySeat : 0;
    var land = window.innerHeight <= 520 && window.innerWidth > window.innerHeight;
    if (land) {
      // Màn hình ngang thấp: xếp ghế ở 4 phía, bàn bài nằm giữa.
      var layouts = {
        2: [[50, 96], [50, 7]],
        3: [[50, 96], [22, 32], [78, 32]],
        4: [[50, 96], [4, 48], [50, 7], [96, 48]]
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
    var ry = narrow ? 41 : 40;
    S.seatEls.forEach(function (el, i) {
      var a = Math.PI / 2 + ((i - rot + n) % n) * (2 * Math.PI / n);
      el.style.left = (50 + rx * Math.cos(a)).toFixed(2) + '%';
      el.style.top = (50 + ry * Math.sin(a)).toFixed(2) + '%';
    });
  }

  function buildSeats() {
    var wrap = $('#seats');
    wrap.innerHTML = '';
    S.seatEls = [];
    if (!S.g) return;
    S.g.players.forEach(function (p) {
      var el = document.createElement('div');
      el.className = 'seat';

      var av = document.createElement('div');
      av.className = 'seat-av';
      var em = document.createElement('span');
      em.textContent = p.avatar;
      var skull = document.createElement('span');
      skull.className = 'skull';
      skull.textContent = '💀';
      av.appendChild(em);
      av.appendChild(skull);

      var name = document.createElement('div');
      name.className = 'seat-name';
      name.textContent = p.name;

      var tag = document.createElement('div');
      tag.className = 'seat-tag';

      var cards = document.createElement('div');
      cards.className = 'seat-cards';

      el.appendChild(av);
      el.appendChild(name);
      el.appendChild(tag);
      el.appendChild(cards);
      wrap.appendChild(el);
      S.seatEls.push(el);
    });
    positionSeats();
  }

  function renderSeats() {
    var g = S.g;
    if (!g) return;
    g.players.forEach(function (p, i) {
      var el = S.seatEls[i];
      if (!el) return;
      var active = g.turn === p.id && g.phase === 'playing' && g.winnerId == null && p.alive;
      el.classList.toggle('active', active);
      el.classList.toggle('dead', !p.alive);

      var nameEl = el.querySelector('.seat-name');
      if (nameEl.textContent !== p.name) nameEl.textContent = p.name;

      var connected = true;
      if (S.cfg.mode === 'online') connected = Net.isSeatConnected(p.id);
      el.classList.toggle('offline', !connected);

      var tagEl = el.querySelector('.seat-tag');
      if (S.cfg.mode === 'online') {
        var tag = '';
        if (!connected) tag = 'OFF';
        else if (p.id === S.mySeat) tag = 'BẠN';
        else if (p.id === 0) tag = 'CHỦ';
        tagEl.textContent = tag;
      } else {
        tagEl.textContent = (S.cfg.mode === 'solo' && p.isBot) ? 'MÁY' : '';
      }

      var cards = el.querySelector('.seat-cards');
      cards.innerHTML = '';
      if (!p.alive) {
        cards.innerHTML = '<span class="none">đã gục</span>';
      } else if (p.hand.length === 0) {
        cards.innerHTML = '<span class="none">hết bài</span>';
      } else {
        var shown = Math.min(p.hand.length, 5);
        for (var k = 0; k < shown; k++) {
          var m = document.createElement('i');
          m.className = 'mini';
          cards.appendChild(m);
        }
        var b = document.createElement('b');
        b.textContent = '×' + p.hand.length;
        cards.appendChild(b);
      }
    });
  }

  function renderTableCard(animate) {
    var tc = $('#table-card');
    var g = S.g;
    if (!g || !g.tableType) {
      tc.className = 'card big empty';
      tc.innerHTML = '';
      return;
    }
    tc.className = 'card big' + (animate ? ' flip' : '');
    tc.innerHTML = faceHTML({ rank: g.tableType, suit: '♠', joker: false });
  }

  function renderPile() {
    var pile = $('#pile');
    var g = S.g;
    pile.innerHTML = '';
    if (!g) { $('#pile-label').textContent = ''; return; }

    if (S.reveal) {
      S.reveal.cards.forEach(function (c, i) {
        var ok = S.reveal.truth[i];
        var el = cardEl(c, 'reveal-card ' + (ok ? 'truth' : 'lie'));
        el.style.setProperty('--i', i);
        var b = document.createElement('span');
        b.className = 'rb ' + (ok ? 'ok' : 'bad');
        b.textContent = ok ? 'THẬT' : 'XẠO';
        el.appendChild(b);
        pile.appendChild(el);
      });
      $('#pile-label').textContent = 'Lật bài của ' + g.players[S.reveal.accusedId].name;
      return;
    }

    var total = 0;
    g.pile.forEach(function (grp) {
      grp.cards.forEach(function (c) {
        total++;
        var el = cardEl(c, 'back');
        var rot = ((c.id * 37) % 19) - 9;
        var dx = ((c.id * 13) % 15) - 7;
        var dy = -Math.min(total, 14) * 0.7;
        el.style.setProperty('--rot', rot + 'deg');
        el.style.setProperty('--dx', dx + 'px');
        el.style.setProperty('--dy', dy + 'px');
        el.style.transform = 'translate(-50%, -50%) translate(' + dx + 'px,' + dy + 'px) rotate(' + rot + 'deg)';
        if (S.justPlayed && S.justPlayed.indexOf(c.id) >= 0) el.classList.add('pop');
        pile.appendChild(el);
      });
    });
    $('#pile-label').textContent = total ? total + ' lá trên bàn' : '';
  }

  function renderVerdict() {
    var v = $('#verdict');
    if (!S.verdict) {
      v.className = 'verdict hidden';
      v.textContent = '';
      return;
    }
    v.className = 'verdict ' + S.verdict.cls;
    v.textContent = S.verdict.text;
  }

  function updateHint() {
    var hint = $('#hand-hint');
    if (!S.g) { hint.textContent = ''; return; }
    if (S.cfg.mode === 'pass' && !S.revealed) {
      hint.textContent = 'Bài đang úp';
      return;
    }
    if (S.cfg.mode === 'online' && S.g && S.g.phase === 'playing') {
      var tp = S.g.players[S.g.turn];
      if (tp && tp.id !== S.mySeat) {
        hint.textContent = 'Đang chờ ' + tp.name + '…';
        return;
      }
    }
    if (!S.selected.size) {
      hint.textContent = 'Chọn 1–3 lá rồi bấm ĐÁNH BÀI';
    } else {
      hint.textContent = 'Đã chọn ' + S.selected.size + ' lá' + (S.selected.size >= 3 ? ' (tối đa)' : '');
    }
  }

  function renderHand() {
    var hand = $('#hand');
    hand.innerHTML = '';
    var g = S.g;
    if (!g) return;

    var owner = handOwner();
    if (!owner) {
      var m = document.createElement('div');
      m.className = 'hand-empty';
      m.textContent = 'Bài đang úp — chuyền máy cho người tới lượt.';
      hand.appendChild(m);
      updateHint();
      return;
    }
    if (!owner.alive) {
      var d = document.createElement('div');
      d.className = 'hand-empty';
      d.textContent = 'Bạn đã gục ngã. Ngồi xem phần còn lại nhé…';
      hand.appendChild(d);
      updateHint();
      return;
    }
    if (!owner.hand.length) {
      var e = document.createElement('div');
      e.className = 'hand-empty';
      e.innerHTML = '<b>Hết bài.</b> Bạn chờ mọi người lật bài.';
      hand.appendChild(e);
      updateHint();
      return;
    }

    var interactive = canHumanAct();
    var tableRank = g.tableType;
    var weight = function (c) {
      if (c.joker) return 0;
      if (c.rank === tableRank) return 1;
      return 2 + ['A', 'K', 'Q'].indexOf(c.rank);
    };
    var sorted = owner.hand.slice().sort(function (a, b) {
      var d = weight(a) - weight(b);
      if (d) return d;
      return a.suit < b.suit ? -1 : a.suit > b.suit ? 1 : 0;
    });
    var n = sorted.length;
    sorted.forEach(function (c, i) {
      var el = cardEl(c, 'hand-card');
      el.dataset.id = c.id;
      el.style.setProperty('--i', i);
      el.style.setProperty('--rot', ((i - (n - 1) / 2) * 3.4).toFixed(2) + 'deg');
      el.style.zIndex = String(i + 1);
      if (S.dealAnim) el.classList.add('deal');
      if (S.selected.has(c.id)) el.classList.add('sel');
      if (interactive) {
        el.addEventListener('click', function () { onCardClick(c.id, el); });
      } else {
        el.style.cursor = 'default';
      }
      hand.appendChild(el);
    });
    updateHint();
  }

  function onCardClick(id, el) {
    if (!canHumanAct()) return;
    if (S.selected.has(id)) {
      S.selected.delete(id);
    } else {
      if (S.selected.size >= 3) { toast('Tối đa 3 lá mỗi lượt'); return; }
      S.selected.add(id);
    }
    el.classList.toggle('sel');
    sfx('tick');
    updateHint();
    renderButtons();
  }

  function renderButtons() {
    var act = canHumanAct();
    var play = $('#btn-play');
    var liar = $('#btn-liar');
    play.disabled = !act || S.selected.size === 0;
    liar.disabled = !act || !S.g || S.g.pile.length === 0;
    play.classList.toggle('ready', act && S.selected.size > 0);
  }

  function renderTurn() {
    var g = S.g;
    var el = $('#turn-text');
    if (!g) { el.textContent = '…'; return; }
    var p = g.players[g.turn];
    var txt;
    if (g.winnerId != null) {
      txt = 'Kết thúc — ' + g.players[g.winnerId].name + ' thắng bàn.';
    } else if (g.phase === 'reveal') {
      txt = 'Lật bài…';
    } else if (g.phase === 'roulette' || g.phase === 'dead') {
      txt = 'Roulette…';
    } else if (S.cfg.mode === 'pass' && S.passLocked) {
      txt = 'Chuyền máy cho ' + (p ? p.name : '') + '…';
    } else if (g.forcedCall) {
      txt = 'Chỉ còn 1 người có bài — buộc phải BẮT GIAN!';
    } else if (S.cfg.mode === 'online' && p) {
      if (p.id !== S.mySeat && !Net.isSeatConnected(p.id)) {
        txt = p.name + ' mất kết nối — đang chờ…';
      } else if (p.id === S.mySeat) {
        txt = 'Tới lượt bạn — chọn 1–3 lá';
      } else {
        txt = 'Tới lượt ' + p.name + ' — đang chờ…';
      }
    } else if (p && p.isBot) {
      txt = p.name + ' đang suy nghĩ…';
    } else if (p) {
      txt = S.cfg.mode === 'solo' ? 'Tới lượt bạn — chọn 1–3 lá' : ('Tới lượt ' + p.name + ' — chọn 1–3 lá');
    } else {
      txt = '…';
    }
    el.textContent = txt;
  }

  function renderTop() {
    var g = S.g;
    if (!g) return;
    $('#round-no').textContent = g.round || 1;
    $('#alive-no').textContent = E.alivePlayers(g).length;
  }

  function renderAll() {
    renderTop();
    renderSeats();
    renderTableCard(S.tableAnim);
    renderPile();
    renderVerdict();
    renderHand();
    renderButtons();
    renderTurn();
  }

  /* ------------------------------------------------------------------ */
  /* đồng bộ trạng thái online                                           */
  /* ------------------------------------------------------------------ */
  function pubState() {
    var g = S.g;
    if (!g) return null;
    return {
      round: g.round,
      tableType: g.tableType,
      turn: g.turn,
      phase: g.phase,
      forcedCall: !!g.forcedCall,
      winnerId: g.winnerId,
      busy: !!S.busy,
      players: g.players.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          alive: !!p.alive,
          handCount: p.hand.length,
          revolverLeft: p.revolver.length,
          connected: Net.isSeatConnected(p.id)
        };
      }),
      pile: g.pile.map(function (gr) {
        return {
          playerId: gr.playerId,
          count: gr.cards.length,
          revealed: !!gr.revealed,
          cards: gr.revealed ? gr.cards : null,
          truth: gr.revealed ? gr.truth : null
        };
      }),
      reveal: S.reveal ? {
        cards: S.reveal.cards,
        truth: S.reveal.truth,
        accusedId: S.reveal.accusedId,
        callerId: S.reveal.callerId
      } : null,
      verdict: S.verdict || null,
      log: S.netLog.slice(-70)
    };
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

  function applySnapshot(msg) {
    if (!msg || !msg.pub) return;
    var pub = msg.pub;
    var wasMyTurn = !!(S.g && S.g.phase === 'playing' && S.g.turn === S.mySeat);
    var prevPile = S.g ? S.g.pile.length : 0;
    var prevReveal = !!S.reveal;

    var players = (pub.players || []).map(function (p) {
      var own = p.id === S.mySeat;
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        alive: !!p.alive,
        isBot: false,
        hand: own ? (msg.hand || []) : dummyCards(p.handCount || 0, 100000 + p.id * 10),
        handCount: p.handCount || 0,
        revolverLeft: p.revolverLeft || 0,
        connected: p.connected !== false
      };
    });

    var pile = (pub.pile || []).map(function (gr, gi) {
      return {
        playerId: gr.playerId,
        cards: (gr.revealed && gr.cards) ? gr.cards : dummyCards(gr.count || 0, 200000 + gi * 10),
        truth: gr.truth || [],
        revealed: !!gr.revealed
      };
    });

    S.g = {
      round: pub.round,
      tableType: pub.tableType,
      turn: pub.turn,
      phase: pub.winnerId != null ? 'over' : pub.phase,
      forcedCall: !!pub.forcedCall,
      players: players,
      pile: pile,
      winnerId: pub.winnerId,
      challenge: null,
      online: true
    };

    S.reveal = pub.reveal ? {
      cards: pub.reveal.cards,
      truth: pub.reveal.truth,
      accusedId: pub.reveal.accusedId,
      callerId: pub.reveal.callerId
    } : null;
    S.verdict = pub.verdict || null;
    S.busy = !!pub.busy;
    S.selected.clear();

    if (S.seatEls.length !== players.length) buildSeats();

    var newRound = pub.round !== S.lastRound;
    if (newRound) {
      S.lastRound = pub.round;
      S.dealAnim = true;
      S.tableAnim = true;
      hide('#roulette');
      sfx('flip');
      later(function () {
        if (!S.g) return;
        S.dealAnim = false;
        S.tableAnim = false;
        renderTableCard(false);
        renderHand();
      }, 820);
    }

    if (!S.g.winnerId) S.gameOverShown = false;

    renderAll();
    renderNetLog(pub.log);

    if (S.g.pile.length > prevPile) sfx('play');
    if (S.reveal && !prevReveal) sfx('liar');

    var isMyTurn = S.g.phase === 'playing' && S.g.turn === S.mySeat;
    if (isMyTurn && !wasMyTurn) sfx('turn');

    if (S.g.winnerId != null && !S.gameOverShown) {
      S.gameOverShown = true;
      hide('#roulette');
      showGameOver();
    }
  }

  function startClientGame(msg) {
    Net.started = true;
    Net.closing = false;
    S.cfg.mode = 'online';
    S.isHost = false;
    S.cfg.timer = false;
    S.mySeat = msg.seat;
    S.roomCode = msg.code || Net.code;
    S.g = null;
    S.gameId++;
    clearPending();
    hide('#lobby');
    hide('#gameover');
    hide('#roulette');
    hide('#pass-overlay');
    $('#screen-start').classList.add('hidden');
    $('#screen-game').classList.remove('hidden');
    $('#online-pill').classList.remove('hidden');
    $('#online-code').textContent = S.roomCode;
    $('#btn-leave-online').classList.remove('hidden');
    $('#btn-again').classList.remove('hidden');
    $('#over-note').classList.add('hidden');
    S.selected.clear();
    S.busy = false;
    S.passLocked = false;
    S.revealed = true;
    S.reveal = null;
    S.verdict = null;
    S.justPlayed = null;
    S.dealAnim = true;
    S.tableAnim = true;
    S.lastRound = 0;
    S.lastPileGroups = 0;
    S.gameOverShown = false;
    S.netLog = [];
    $('#log').innerHTML = '';
    $('#hand-hint').textContent = '';
    applySnapshot(msg);
    positionSeats();
  }

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
        var tHost = document.createElement('span');
        tHost.className = 'lp-tag host';
        tHost.textContent = 'CHỦ';
        tags.appendChild(tHost);
      }
      if (p.seat === S.mySeat) {
        var tMe = document.createElement('span');
        tMe.className = 'lp-tag me';
        tMe.textContent = 'BẠN';
        tags.appendChild(tMe);
      }
      if (!p.connected) {
        var tOff = document.createElement('span');
        tOff.className = 'lp-tag off';
        tOff.textContent = 'OFF';
        tags.appendChild(tOff);
      }

      row.appendChild(av);
      row.appendChild(nm);
      row.appendChild(tags);

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

  function clientRouletteStart(msg) {
    var p = S.g && S.g.players[msg.seat];
    showClientRoulette(p ? p.name : 'Người chơi');
  }

  function showClientRoulette(name) {
    S.busy = true;
    $('#roul-name').textContent = name;
    var card = $('#roul-card');
    card.className = 'roul-card';
    card.textContent = '?';
    $('#roul-text').textContent = 'Đang quay…';
    var ring = $('#roul-ring');
    ring.classList.remove('spin');
    void ring.offsetWidth;
    ring.classList.add('spin');
    show('#roulette');
    sfx('spin');
    for (var i = 0; i < 7; i++) {
      (function (k) { later(function () { sfx('tick'); }, 220 + k * 150); })(i);
    }
  }

  function clientRouletteResult(msg) {
    var card = $('#roul-card');
    card.classList.add(msg.death ? 'death' : 'blank');
    card.textContent = msg.death ? '💀' : 'TRỐNG';
    $('#roul-text').textContent = msg.death ? 'TRÚNG ĐẠN!' : 'TRỐNG — sống sót!';
    sfx(msg.death ? 'shot' : 'blank');
    if (msg.death) shake();
  }

  /* ------------------------------------------------------------------ */
  /* đồng hồ 30 giây                                                     */
  /* ------------------------------------------------------------------ */
  function startTimer() {
    stopTimer();
    if (!S.cfg.timer) return;
    if (!canHumanAct()) return;
    var fill = $('#timer-fill');
    var wrap = $('#timer-wrap');
    S.timerEnd = Date.now() + TIMER_SECONDS * 1000;
    wrap.classList.add('on');
    fill.style.width = '100%';
    fill.classList.remove('low');
    S.timerId = setInterval(function () {
      var left = S.timerEnd - Date.now();
      var pct = Math.max(0, left / (TIMER_SECONDS * 1000));
      fill.style.width = (pct * 100).toFixed(1) + '%';
      fill.classList.toggle('low', pct < 0.25);
      if (left <= 0) {
        stopTimer();
        autoPlayHuman();
      }
    }, 100);
  }

  function stopTimer() {
    if (S.timerId) {
      clearInterval(S.timerId);
      S.timerId = null;
    }
    var wrap = $('#timer-wrap');
    if (wrap) wrap.classList.remove('on');
  }

  function autoPlayHuman() {
    var g = S.g;
    if (!g || !canHumanAct()) return;
    var p = g.players[g.turn];
    if (!p.hand.length) {
      if (g.pile.length) doChallenge(g.turn, true);
      return;
    }
    var truth = p.hand.filter(function (c) { return E.isTruth(c, g.tableType); })[0];
    var card = truth || p.hand[0];
    addLog('Hết giờ — ' + p.name + ' tự động đánh 1 lá.', 'warn');
    doPlay(g.turn, [card.id]);
  }

  /* ------------------------------------------------------------------ */
  /* luồng chơi                                                          */
  /* ------------------------------------------------------------------ */
  function beginGame(playersOverride) {
    clearPending();
    hide('#gameover'); hide('#roulette'); hide('#pass-overlay'); hide('#verdict'); hide('#rules'); hide('#lobby');

    var players = playersOverride || buildPlayers();
    var online = S.cfg.mode === 'online';
    S.gameId++;
    S.g = E.createGame({
      players: players,
      rng: Math.random,
      difficulty: S.cfg.difficulty
    });
    S.selected.clear();
    S.busy = true;
    S.passLocked = false;
    S.revealed = S.cfg.mode === 'solo' || online;
    S.reveal = null;
    S.verdict = null;
    S.justPlayed = null;
    S.dealAnim = false;
    S.tableAnim = false;
    S.lastRound = 0;
    S.lastPileGroups = 0;
    S.gameOverShown = false;
    S.netLog = [];
    if (!online) {
      S.isHost = false;
      S.mySeat = 0;
    }
    if (online) {
      S.cfg.timer = false;
      $('#online-pill').classList.remove('hidden');
      $('#online-code').textContent = S.roomCode;
      $('#btn-leave-online').classList.remove('hidden');
    } else {
      $('#online-pill').classList.add('hidden');
      $('#btn-leave-online').classList.add('hidden');
    }
    $('#btn-again').classList.remove('hidden');
    $('#over-note').classList.add('hidden');
    $('#log').innerHTML = '';
    $('#hand-hint').textContent = '';

    $('#screen-start').classList.add('hidden');
    $('#screen-game').classList.remove('hidden');
    buildSeats();
    renderAll();
    addLog('— Bàn mới · ' + players.length + ' người —', 'sys');

    var gid = S.gameId;
    later(function () {
      if (S.gameId !== gid) return;
      startRound(S.g.firstPlayer);
    }, 480);
  }

  function startRound(preferred) {
    var g = S.g;
    if (!g) return;
    E.startRound(g, preferred);
    var gid = S.gameId;

    S.selected.clear();
    S.busy = true;
    S.passLocked = false;
    S.revealed = S.cfg.mode === 'solo' || S.cfg.mode === 'online';
    S.reveal = null;
    S.verdict = null;
    S.justPlayed = null;
    S.dealAnim = true;
    S.tableAnim = true;
    S.lastRound = g.round;

    renderAll();
    addLog('Ván ' + g.round + ' — loại bài: ' + E.RANK_NAME[g.tableType] + ' (' + g.tableType + ')', 'round');
    sfx('flip');

    if (onlineHost()) {
      if (g.round === 1) Net.broadcastStart();
      else Net.broadcastState();
    }

    later(function () {
      if (S.gameId !== gid) return;
      S.dealAnim = false;
      S.tableAnim = false;
      renderTableCard(false);
      renderHand();
      beginTurn();
    }, 820);
  }

  function beginTurn() {
    var g = S.g;
    if (!g || g.winnerId != null) return;
    if (g.phase !== 'playing') return;
    stopTimer();
    S.selected.clear();
    if (S.cfg.mode === 'pass') S.revealed = false;

    var p = g.players[g.turn];
    if (!p || !p.alive) return;

    if (g.forcedCall) {
      S.busy = true;
      renderAll();
      addLog(p.name + ' buộc phải bắt gian (chỉ còn 1 người có bài).', 'warn');
      sfx('warn');
      if (onlineHost()) Net.broadcastState();
      later(function () { doChallenge(p.id, true); }, 1250);
      return;
    }

    S.busy = false;

    if (S.cfg.mode === 'online') {
      renderAll();
      if (onlineHost()) Net.broadcastState();
      if (p.id === S.mySeat) startHumanTurn();
      return;
    }

    if (p.isBot) {
      renderAll();
      var wait = 760 + Math.random() * 1050;
      later(function () {
        if (S.g !== g) return;
        botAct(p.id);
      }, wait);
      return;
    }

    if (S.cfg.mode === 'pass') {
      S.passLocked = true;
      renderAll();
      showPass(p);
      return;
    }

    startHumanTurn();
  }

  function startHumanTurn() {
    var g = S.g;
    if (!g || g.phase !== 'playing' || g.winnerId != null) return;
    S.passLocked = false;
    S.busy = false;
    renderAll();
    startTimer();
    sfx('turn');
  }

  function showPass(p) {
    $('#pass-avatar').textContent = p.avatar;
    $('#pass-name').textContent = p.name;
    show('#pass-overlay');
  }

  function botAct(pid) {
    var g = S.g;
    if (!g || g.turn !== pid || g.phase !== 'playing' || S.busy) return;
    var d = Bots.decide(g, pid, S.cfg.difficulty);
    if (d.type === 'liar') doChallenge(pid, false);
    else doPlay(pid, d.cardIds);
  }

  function doPlay(pid, ids) {
    var g = S.g;
    if (!g || g.phase !== 'playing' || g.turn !== pid) return;
    if (S.busy) return;
    var p = g.players[pid];

    if (S.cfg.mode === 'online' && !S.isHost) {
      if (!canHumanAct()) return;
      if (!Net.send({ t: 'action', action: 'play', ids: ids })) { toast('Mất kết nối tới host.'); return; }
      S.busy = true;
      S.selected.clear();
      renderAll();
      return;
    }

    var group;
    try {
      group = E.play(g, pid, ids);
    } catch (err) {
      toast(err.message);
      return;
    }

    var gid = S.gameId;
    stopTimer();
    S.selected.clear();
    if (S.cfg.mode === 'pass' && !p.isBot) S.revealed = false;
    S.justPlayed = group.cards.map(function (c) { return c.id; });
    S.busy = true;

    sfx('play');
    var logCls = (S.cfg.mode === 'online') ? (p.id === S.mySeat ? 'you' : 'bot') : (p.isBot ? 'bot' : 'you');
    addLog(p.name + ' đánh ' + group.cards.length + ' lá.', logCls);
    E.advance(g);
    renderAll();

    later(function () {
      if (S.gameId !== gid) return;
      S.justPlayed = null;
      beginTurn();
    }, 440);
  }

  function doChallenge(pid, forced) {
    var g = S.g;
    if (!g || g.phase !== 'playing' || g.turn !== pid || !g.pile.length) return;

    if (S.cfg.mode === 'online' && !S.isHost) {
      if (!canHumanAct()) return;
      if (!Net.send({ t: 'action', action: 'liar' })) { toast('Mất kết nối tới host.'); return; }
      S.busy = true;
      S.selected.clear();
      renderAll();
      return;
    }

    var res;
    try {
      res = E.challenge(g, pid);
    } catch (err) {
      toast(err.message);
      return;
    }
    var gid = S.gameId;
    stopTimer();
    S.busy = true;
    S.selected.clear();
    S.revealed = false;
    S.passLocked = true;

    sfx('liar');
    addLog(g.players[pid].name + ' hô BẮT GIAN!', 'liar');
    S.reveal = { cards: res.cards, truth: res.truth, accusedId: res.accusedId, callerId: res.callerId };
    if (res.hasLie) {
      var lies = res.truth.filter(function (t) { return !t; }).length;
      S.verdict = { cls: 'bad', text: 'CÓ LÁ XẠO → ' + g.players[res.accusedId].name + ' phải chơi roulette' };
      addLog('Lật ra: ' + lies + ' lá XẠO.', 'liar');
    } else {
      S.verdict = { cls: 'ok', text: 'TOÀN LÁ THẬT → ' + g.players[res.callerId].name + ' bắt gian sai, phải chơi roulette' };
      addLog('Lật ra: toàn lá THẬT.', 'dim');
    }
    renderAll();
    if (onlineHost()) Net.broadcastState();

    later(function () {
      if (S.gameId !== gid) return;
      roulette(res);
    }, 2400);
  }

  function roulette(res) {
    var g = S.g;
    if (!g) return;
    var shooter = g.players[res.shooterId];
    var gid = S.gameId;

    S.busy = true;
    S.revealed = false;
    $('#roul-name').textContent = shooter.name;
    var card = $('#roul-card');
    card.className = 'roul-card';
    card.textContent = '?';
    $('#roul-text').textContent = 'Đang quay…';
    var ring = $('#roul-ring');
    ring.classList.remove('spin');
    void ring.offsetWidth;
    ring.classList.add('spin');
    show('#roulette');
    if (onlineHost()) Net.broadcastEvent({ t: 'rouletteStart', seat: res.shooterId });

    sfx('spin');
    for (var i = 0; i < 7; i++) {
      (function (k) { later(function () { sfx('tick'); }, 220 + k * 150); })(i);
    }

    later(function () {
      if (S.gameId !== gid) return;
      var shot;
      try { shot = E.shoot(g, res.shooterId); }
      catch (err) { hide('#roulette'); return; }

      card.classList.add(shot.death ? 'death' : 'blank');
      card.textContent = shot.death ? '💀' : 'TRỐNG';
      $('#roul-text').textContent = shot.death ? 'TRÚNG ĐẠN!' : 'TRỐNG — sống sót!';
      sfx(shot.death ? 'shot' : 'blank');
      if (onlineHost()) {
        Net.broadcastEvent({ t: 'rouletteResult', seat: res.shooterId, death: shot.death, remaining: shot.remaining });
      }

      if (shot.death) {
        addLog(shooter.name + ' chơi roulette: TRÚNG ĐẠN 💀', 'death');
        addLog(shooter.name + ' đã gục ngã.', 'death');
        shake();
      } else {
        addLog(shooter.name + ' chơi roulette: TRỐNG — còn ' + shot.remaining + ' lá.', 'dim');
      }
      renderAll();

      if (shot.winnerId != null) {
        later(function () {
          if (S.gameId !== gid) return;
          hide('#roulette');
          showGameOver();
        }, 1700);
      } else {
        later(function () {
          if (S.gameId !== gid) return;
          hide('#roulette');
          S.reveal = null;
          S.verdict = null;
          S.busy = false;
          var preferred = res.hasLie
            ? res.accusedId
            : (E.nextAliveAfter(g, res.accusedId) || {}).id;
          startRound(E.pickStarter(g, preferred));
        }, 1500);
      }
    }, 1600);
  }

  function showGameOver() {
    var g = S.g;
    if (!g) return;
    S.busy = true;
    hide('#roulette');
    var online = S.cfg.mode === 'online';
    var w = g.winnerId != null ? g.players[g.winnerId] : null;
    $('#over-avatar').textContent = w ? w.avatar : '🎲';
    $('#over-name').textContent = w ? w.name : 'Không có người thắng';
    var sub;
    if (!w) {
      sub = 'Bàn chơi kết thúc.';
    } else if (online) {
      sub = (w.id === S.mySeat) ? 'Bạn thắng bàn!' : (w.name + ' thắng bàn.');
    } else if (S.cfg.mode === 'solo') {
      sub = w.isBot ? 'Bạn đã gục ngã. Thử lại nhé!' : 'Bạn là người sống sót cuối cùng!';
    } else {
      sub = w.name + ' là người sống sót cuối cùng.';
    }
    $('#over-sub').textContent = sub;

    var isOnlineClient = online && !S.isHost;
    $('#btn-again').classList.toggle('hidden', isOnlineClient);
    $('#over-note').classList.toggle('hidden', !isOnlineClient);
    if (isOnlineClient) {
      $('#over-note').textContent = 'Chờ chủ phòng bắt đầu bàn mới…';
    }

    show('#gameover');
    if (online) {
      sfx(w && w.id === S.mySeat ? 'win' : 'lose');
    } else {
      sfx(S.cfg.mode === 'solo' && w && w.isBot ? 'lose' : 'win');
    }
    if (!isOnlineClient) {
      addLog('— ' + (w ? w.name : 'Không ai') + ' thắng bàn —', 'round');
    }
    if (onlineHost()) Net.broadcastState();
  }

  function goMenu() {
    if (S.cfg.mode === 'online') {
      Net.leave();
      return;
    }
    clearPending();
    S.g = null;
    S.busy = false;
    S.passLocked = false;
    S.selected.clear();
    hide('#gameover'); hide('#roulette'); hide('#pass-overlay'); hide('#rules');
    $('#screen-game').classList.add('hidden');
    $('#screen-start').classList.remove('hidden');
    $('#log').innerHTML = '';
  }

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
    $('#timer-chk').style.display = online ? 'none' : '';
    $('#names-label').textContent = pass ? 'Tên người chơi' : 'Tên của bạn';

    $('#mode-note').textContent = solo
      ? 'Bạn đấu với 1–3 nhân vật do máy điều khiển.'
      : (pass
        ? 'Cả bàn dùng chung một máy. Tới lượt ai, người đó bấm xem bài.'
        : 'Cần Internet. Một người tạo phòng làm host, bạn bè nhập mã 5 ký tự.');

    S.cfg.timer = online ? false : solo;
    $('#opt-timer').checked = S.cfg.timer;
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

  /* ------------------------------------------------------------------ */
  /* gắn sự kiện                                                         */
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

  $('#opt-timer').addEventListener('change', function (e) {
    S.cfg.timer = e.target.checked;
  });
  $('#opt-sound').addEventListener('change', function (e) {
    setSound(e.target.checked);
  });

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
    beginGame();
  });

  function openRules() { show('#rules'); }
  function closeRules() { hide('#rules'); }
  $('#btn-rules-open').addEventListener('click', openRules);
  $('#btn-rules-close').addEventListener('click', closeRules);
  $('#btn-rules-ok').addEventListener('click', closeRules);
  $('#rules').addEventListener('click', function (e) {
    if (e.target === $('#rules')) closeRules();
  });

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
      } catch (e) {
        toast('Mã phòng: ' + text);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(fallback);
    } else {
      fallback();
    }
  }

  $('#btn-copy-code').addEventListener('click', function () {
    copyText(S.roomCode || Net.code);
  });

  $('#btn-lobby-start').addEventListener('click', function () {
    if (!S.isHost) return;
    var players = Net.playersForGame();
    if (players.length < 2) { toast('Cần ít nhất 2 người.'); return; }
    Net.started = true;
    hide('#lobby');
    hide('#gameover');
    S.isHost = true;
    S.mySeat = 0;
    beginGame(players);
  });

  $('#btn-lobby-leave').addEventListener('click', function () {
    Net.leave();
  });

  $('#btn-leave-online').addEventListener('click', function () {
    Net.leave();
  });

  $('#btn-play').addEventListener('click', function () {
    if (!canHumanAct() || !S.selected.size) return;
    doPlay(S.g.turn, Array.from(S.selected));
  });

  $('#btn-liar').addEventListener('click', function () {
    if (!canHumanAct() || !S.g.pile.length) return;
    doChallenge(S.g.turn, false);
  });

  $('#btn-pass-view').addEventListener('click', function () {
    hide('#pass-overlay');
    S.revealed = true;
    S.passLocked = false;
    sfx('click');
    startHumanTurn();
  });

  $('#btn-sound').addEventListener('click', function () {
    setSound(!S.cfg.sound);
  });

  $('#btn-restart').addEventListener('click', function () {
    if (S.cfg.mode === 'online') {
      if (!S.isHost) { toast('Chỉ chủ phòng mới được bắt đầu bàn mới.'); return; }
      if (!S.g) return;
      var players = Net.playersForGame();
      if (players.length < 2) { toast('Cần ít nhất 2 người đang kết nối.'); return; }
      hide('#gameover');
      beginGame(players);
      return;
    }
    if (!S.g) return;
    beginGame();
  });

  $('#btn-log').addEventListener('click', function () {
    $('#logpanel').classList.toggle('open');
  });

  $('#btn-again').addEventListener('click', function () {
    if (S.cfg.mode === 'online') {
      if (!S.isHost) { toast('Chờ chủ phòng bắt đầu bàn mới…'); return; }
      var players = Net.playersForGame();
      if (players.length < 2) { toast('Cần ít nhất 2 người đang kết nối.'); return; }
      hide('#gameover');
      beginGame(players);
      return;
    }
    hide('#gameover');
    beginGame();
  });

  $('#btn-menu').addEventListener('click', function () {
    hide('#gameover');
    goMenu();
  });

  window.addEventListener('resize', positionSeats);

  /* mở khoá âm thanh ở lần chạm đầu tiên */
  document.addEventListener('pointerdown', function once() {
    Sound.init();
    document.removeEventListener('pointerdown', once);
  }, { once: true });

  /* ------------------------------------------------------------------ */
  /* khởi động                                                           */
  /* ------------------------------------------------------------------ */
  updateModeUI();
  renderAll();

  /* tự chạy khi mở bằng ?demo=1 (dùng để chụp màn hình / thử nhanh) */
  (function demo() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return; }
    if (q.get('demo') !== '1' && q.get('autostart') !== '1') return;
    S.cfg.mode = q.get('mode') === 'pass' ? 'pass' : 'solo';
    var nc = parseInt(q.get('count') || '4', 10);
    S.cfg.count = Math.min(4, Math.max(2, nc || 4));
    var d = q.get('diff');
    if (d === 'easy' || d === 'normal' || d === 'hard') S.cfg.difficulty = d;
    setTimeout(function () {
      Sound.init();
      beginGame();
    }, 250);
  })();

  /* hook nhỏ để test tự động */
  window.__liar = {
    S: S,
    Engine: E,
    Bots: Bots,
    Net: Net,
    beginGame: beginGame,
    doPlay: doPlay,
    doChallenge: doChallenge
  };
})();
