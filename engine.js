/* =====================================================================
   engine.js — Luật "Liar's Deck" cơ bản (mode bài của Liar's Bar)
   ---------------------------------------------------------------------
   Bộ bài 20 lá: 6 Già (K), 6 Đầm (Q), 6 Át (A), 2 Joker.
   Mỗi ván mở 1 lá "loại bài". Lá cùng loại + Joker = THẬT, còn lại = XẠO.
   Mỗi lượt đánh úp 1–3 lá. Người sau đánh tiếp hoặc hô BẮT GIAN.
   Lật bài: có lá xạo -> người đánh bị roulette; toàn thật -> người bắt gian
   bị roulette. Roulette: 1 lá Tử + 5 lá Trống, rút trúng Tử là chết.

   File này thuần dữ liệu, không đụng DOM -> chạy được cả trong Node để test.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var RANKS = ['A', 'K', 'Q'];
  var RANK_NAME = { A: 'Át', K: 'Già', Q: 'Đầm', J: 'Joker' };
  var SUITS = ['♠', '♥', '♦', '♣', '♠', '♥'];
  var TOTAL_CARDS = 20;
  var TRUTHS_PER_ROUND = 8; // 6 lá cùng loại + 2 Joker
  var cardSeq = 1;

  function randInt(rng, n) { return Math.floor(rng() * n); }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(rng, i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function makeDeck() {
    var deck = [];
    ['K', 'Q', 'A'].forEach(function (rank) {
      for (var i = 0; i < 6; i++) {
        deck.push({ id: cardSeq++, rank: rank, suit: SUITS[i], joker: false });
      }
    });
    deck.push({ id: cardSeq++, rank: 'J', suit: '★', joker: true });
    deck.push({ id: cardSeq++, rank: 'J', suit: '★', joker: true });
    return deck;
  }

  function isTruth(card, tableType) {
    return !!card.joker || card.rank === tableType;
  }

  function alivePlayers(g) {
    return g.players.filter(function (p) { return p.alive; });
  }

  function createGame(opts) {
    var rng = opts.rng || Math.random;
    var players = opts.players.map(function (p, i) {
      return {
        id: i,
        name: p.name || ('Người chơi ' + (i + 1)),
        avatar: p.avatar || '🎩',
        isBot: !!p.isBot,
        alive: true,
        hand: [],
        // 1 lá Tử + 5 lá Trống, xáo sẵn. Qua các ván chỉ rút bớt, không xáo lại.
        revolver: shuffle([true, false, false, false, false, false], rng),
        shots: 0,
        survived: 0
      };
    });

    return {
      players: players,
      rng: rng,
      difficulty: opts.difficulty || 'normal',
      round: 0,
      tableType: null,
      deck: [],
      pile: [],          // [{ playerId, cards:[], truth:[bool], revealed:bool }]
      turn: 0,
      forcedCall: false,
      phase: 'idle',     // idle | playing | reveal | roulette | dead | alive | over
      challenge: null,
      winnerId: null,
      firstPlayer: randInt(rng, players.length)
    };
  }

  /* Người còn sống kế tiếp tính từ fromId (vòng tròn). */
  function nextAliveAfter(g, fromId) {
    var n = g.players.length;
    var start = (typeof fromId === 'number') ? fromId : n - 1;
    for (var step = 1; step <= n; step++) {
      var p = g.players[(start + step) % n];
      if (p.alive) return p;
    }
    return null;
  }

  function startRound(g, preferredFirstId) {
    g.round++;
    g.tableType = RANKS[randInt(g.rng, RANKS.length)];
    g.deck = shuffle(makeDeck(), g.rng);
    g.pile = [];
    g.challenge = null;
    g.phase = 'playing';
    g.forcedCall = false;

    g.players.forEach(function (p) {
      p.hand = [];
      if (p.alive) p.hand = g.deck.splice(0, 5);
    });

    // Người mở ván: ưu tiên kẻ vừa bị bắt gian; nếu đã chết thì người kế tiếp.
    var first = null;
    if (preferredFirstId != null) {
      var wanted = g.players[preferredFirstId];
      if (wanted && wanted.alive) first = wanted;
    }
    if (!first) first = nextAliveAfter(g, preferredFirstId != null ? preferredFirstId : g.firstPlayer);
    if (!first) first = alivePlayers(g)[0];

    g.turn = first ? first.id : 0;
    g.firstPlayer = g.turn;
    return g;
  }

  /* Chuyển lượt sau khi có người đánh bài.
     Trả về { playerId, forced } — forced = buộc phải hô BẮT GIAN. */
  function advance(g) {
    var alive = alivePlayers(g);
    var withCards = alive.filter(function (p) { return p.hand.length > 0; });
    var last = g.pile.length ? g.pile[g.pile.length - 1] : null;
    var target = null;
    var forced = false;

    if (last) {
      if (withCards.length === 0) {
        // Cả bàn đã hết bài: người kế tiếp phải lật bài người vừa đánh.
        target = nextAliveAfter(g, last.playerId);
        forced = true;
      } else if (withCards.length === 1) {
        // Luật: chỉ còn 1 người có bài -> người đó buộc hô BẮT GIAN.
        if (withCards[0].id !== last.playerId) {
          target = withCards[0];
        } else {
          // Hiếm: người duy nhất còn bài lại vừa đánh -> người kế tiếp lật bài.
          target = nextAliveAfter(g, last.playerId);
        }
        forced = true;
      }
    }

    if (!target) {
      var n = g.players.length;
      for (var step = 1; step <= n; step++) {
        var p = g.players[(g.turn + step) % n];
        if (p.alive && p.hand.length > 0) { target = p; break; }
      }
    }
    if (!target) target = nextAliveAfter(g, g.turn) || alive[0];

    // Không bao giờ để người vừa đánh tự bắt gian chính mình.
    if (target && last && target.id === last.playerId) {
      target = nextAliveAfter(g, last.playerId) || target;
    }

    g.turn = target ? target.id : 0;
    g.forcedCall = forced;
    return { playerId: g.turn, forced: forced };
  }

  function play(g, playerId, cardIds) {
    var p = g.players[playerId];
    if (!p || !p.alive) throw new Error('Người chơi không hợp lệ');
    if (g.turn !== playerId) throw new Error('Chưa tới lượt người này');
    if (g.phase !== 'playing') throw new Error('Không thể đánh bài lúc này');

    var ids = [];
    cardIds.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    if (ids.length < 1 || ids.length > 3) throw new Error('Chỉ được đánh 1–3 lá');

    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    var cards = p.hand.filter(function (c) { return set[c.id]; });
    if (cards.length !== ids.length) throw new Error('Lá bài không có trong tay');

    p.hand = p.hand.filter(function (c) { return !set[c.id]; });

    var group = {
      playerId: playerId,
      cards: cards,
      truth: cards.map(function (c) { return isTruth(c, g.tableType); }),
      revealed: false
    };
    g.pile.push(group);
    return group;
  }

  function challenge(g, callerId) {
    if (!g.pile.length) throw new Error('Chưa có bài để bắt gian');
    var last = g.pile[g.pile.length - 1];
    if (last.playerId === callerId) throw new Error('Không thể tự bắt gian mình');

    last.revealed = true;
    var hasLie = last.truth.some(function (t) { return !t; });
    var shooterId = hasLie ? last.playerId : callerId;

    var info = {
      callerId: callerId,
      accusedId: last.playerId,
      cards: last.cards,
      truth: last.truth,
      hasLie: hasLie,
      shooterId: shooterId
    };
    g.challenge = info;
    g.phase = 'reveal';
    g.forcedCall = false;
    return info;
  }

  /* Rút 1 lá khỏi bộ roulette của người chơi. */
  function shoot(g, playerId) {
    var p = g.players[playerId];
    if (!p || !p.alive) throw new Error('Người chơi không hợp lệ');

    p.shots++;
    // Hết bài mà chưa trúng Tử là chuyện không thể (bộ luôn có đúng 1 Tử),
    // nhưng vẫn phòng hờ.
    var death = p.revolver.length ? !!p.revolver.shift() : true;
    if (death) p.alive = false;
    else p.survived++;

    var alive = alivePlayers(g);
    if (alive.length === 1) g.winnerId = alive[0].id;
    if (alive.length === 0) g.winnerId = null; // hoà — không xảy ra ở bản cơ bản
    g.phase = death ? 'dead' : 'alive';

    return {
      death: death,
      remaining: p.revolver.length,
      eliminated: !p.alive,
      winnerId: g.winnerId,
      aliveCount: alive.length
    };
  }

  /* Chọn người mở ván kế tiếp, đảm bảo còn sống. */
  function pickStarter(g, preferredId) {
    if (preferredId != null) {
      var p = g.players[preferredId];
      if (p && p.alive) return p.id;
    }
    var nxt = nextAliveAfter(g, preferredId != null ? preferredId : g.turn);
    if (nxt) return nxt.id;
    var alive = alivePlayers(g);
    return alive.length ? alive[0].id : 0;
  }

  return {
    RANKS: RANKS,
    RANK_NAME: RANK_NAME,
    TOTAL_CARDS: TOTAL_CARDS,
    TRUTHS_PER_ROUND: TRUTHS_PER_ROUND,
    makeDeck: makeDeck,
    isTruth: isTruth,
    alivePlayers: alivePlayers,
    nextAliveAfter: nextAliveAfter,
    createGame: createGame,
    startRound: startRound,
    advance: advance,
    play: play,
    challenge: challenge,
    shoot: shoot,
    pickStarter: pickStarter
  };
});
