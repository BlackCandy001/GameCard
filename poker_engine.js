/* =====================================================================
   poker_engine.js — Liar's Poker (Texas Hold'em + đạn) kiểu Liar's Bar
   ---------------------------------------------------------------------
   - 2 lá riêng + 5 lá chung.
   - Mức cược (đạn) 1 → 2 (flop) → 3 (turn) → 4 (river) → 5 (showdown).
   - Theo (call): đặt thêm 1 viên. Bỏ (fold): chơi roulette với số đạn
     đang cược. Bỏ nhát (coward's fold): 1 lần/ván, chỉ vòng đầu, 1 viên.
   - All-in: 8 viên; người khác theo (8) hoặc bỏ (bắn với số đạn hiện có).
   - Đổi bài: 1 lần/ván tay, trước khi lật hết 5 lá chung.
   - Showdown: bài mạnh nhất thắng; những người thua bắn với mức cược
     cuối (5 hoặc 8). Trúng đạn là chết; 8 viên có 5% kẹt đạn.
   - Sống sót cuối cùng thắng bàn.

   File thuần dữ liệu, không DOM. Chạy được trong Node để test.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  var SUITS = ['♠', '♥', '♦', '♣'];
  var VAL = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  var RANK_NAME = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  var CAT = {
    HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
    FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8, ROYAL: 9
  };
  var CAT_NAMES = [
    'Mậu thầu', 'Một đôi', 'Hai đôi', 'Bộ ba', 'Sảnh',
    'Thùng', 'Cù lũ', 'Tứ quý', 'Thùng phá sảnh', 'Thùng phá sảnh hoàng gia'
  ];

  var cardSeq = 1;

  function makeDeck() {
    var deck = [];
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = 0; r < RANKS.length; r++) {
        deck.push({ id: cardSeq++, rank: RANKS[r], suit: SUITS[s], value: VAL[RANKS[r]] });
      }
    }
    return deck;
  }

  function shuffle(a, rng) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function rankName(v) { return RANK_NAME[v] || String(v); }

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
        bet: 1,
        inHand: false,
        allIn: false,
        swapUsed: false,
        cowardUsed: false,
        folded: false
      };
    });
    var alive = players.filter(function (p) { return p.alive; });
    return {
      players: players,
      rng: rng,
      handNo: 0,
      phase: 'idle',        // idle | bet | allin | shot | showdown | handover | over
      level: 1,
      round: 0,             // 0 preflop, 1 flop, 2 turn, 3 river
      revealed: 0,
      community: [],
      deck: [],
      turn: 0,
      firstSeat: alive.length ? Math.floor(rng() * alive.length) : 0,
      acted: {},
      allIn: null,          // { by, queue:[], levelBefore, responses:{} }
      swapOffer: null,      // { seat, cards:[3] }
      shot: null,           // { seat, bullets, reason }
      lastShot: null,
      showdown: null,       // { seats, hands:{}, winners:[], losers:[] }
      handWinner: null,
      winnerId: null
    };
  }

  function alivePlayers(g) {
    return g.players.filter(function (p) { return p.alive; });
  }

  function inHandPlayers(g) {
    return g.players.filter(function (p) { return p.alive && p.inHand; });
  }

  function nextAliveAfter(g, fromId) {
    var n = g.players.length;
    var start = typeof fromId === 'number' ? fromId : n - 1;
    for (var step = 1; step <= n; step++) {
      var p = g.players[(start + step) % n];
      if (p.alive) return p.id;
    }
    return null;
  }

  function firstInHandFrom(g, fromId) {
    var n = g.players.length;
    var start = typeof fromId === 'number' ? fromId : n - 1;
    for (var step = 0; step < n; step++) {
      var p = g.players[(start + step) % n];
      if (p.alive && p.inHand) return p.id;
    }
    return null;
  }

  function nextActorFrom(g, fromId) {
    var n = g.players.length;
    for (var step = 1; step <= n; step++) {
      var p = g.players[(fromId + step) % n];
      if (p.alive && p.inHand && !p.allIn && !g.acted[p.id]) return p.id;
    }
    return null;
  }

  function startHand(g) {
    if (alivePlayers(g).length < 2) {
      g.phase = 'over';
      g.winnerId = alivePlayers(g).length ? alivePlayers(g)[0].id : null;
      return g;
    }
    g.handNo++;
    if (g.handNo > 1) {
      var nx = nextAliveAfter(g, g.firstSeat);
      if (nx != null) g.firstSeat = nx;
    }

    g.phase = 'bet';
    g.level = 1;
    g.round = 0;
    g.revealed = 0;
    g.acted = {};
    g.allIn = null;
    g.swapOffer = null;
    g.shot = null;
    g.lastShot = null;
    g.showdown = null;
    g.handWinner = null;

    g.players.forEach(function (p) {
      p.hand = [];
      p.bet = 1;
      p.allIn = false;
      p.swapUsed = false;
      p.inHand = p.alive;
      p.folded = !p.alive;
    });

    g.deck = shuffle(makeDeck(), g.rng);
    g.players.forEach(function (p) {
      if (p.inHand) p.hand = [g.deck.pop(), g.deck.pop()];
    });
    g.community = g.deck.splice(0, 5);

    g.turn = firstInHandFrom(g, g.firstSeat);
    return g;
  }

  function legalActions(g, seat) {
    var p = g.players[seat];
    if (!p || !p.alive) return [];
    if (g.phase === 'bet' && g.turn === seat) {
      if (!p.inHand || p.allIn) return [];
      var out = ['call'];
      if (g.round > 0) out.push('fold');
      if (g.round === 0 && !p.cowardUsed) out.push('coward');
      if (g.level < 8) out.push('allin');
      if (!p.swapUsed && g.revealed < 5) out.push('swap');
      return out;
    }
    if (g.phase === 'allin' && g.turn === seat) {
      if (!p.inHand || p.allIn) return [];
      return ['allinCall', 'allinFold'];
    }
    return [];
  }

  function call(g, seat) {
    if (legalActions(g, seat).indexOf('call') < 0) return false;
    var p = g.players[seat];
    p.bet = g.level + 1;
    g.acted[seat] = true;
    afterRoundAction(g, seat);
    return true;
  }

  function afterRoundAction(g, fromSeat) {
    if (inHandPlayers(g).length <= 1) {
      endHand(g, inHandPlayers(g)[0] ? inHandPlayers(g)[0].id : null);
      return;
    }
    var nxt = nextActorFrom(g, fromSeat);
    if (nxt != null) {
      g.turn = nxt;
      return;
    }
    completeRound(g);
  }

  function completeRound(g) {
    if (inHandPlayers(g).length <= 1) {
      endHand(g, inHandPlayers(g)[0] ? inHandPlayers(g)[0].id : null);
      return;
    }
    g.level++;
    if (g.level === 2) {
      g.revealed = 3;
      g.round = 1;
    } else if (g.level === 3) {
      g.revealed = 4;
      g.round = 2;
    } else if (g.level === 4) {
      g.revealed = 5;
      g.round = 3;
    } else if (g.level >= 5) {
      g.revealed = 5;
      startShowdown(g);
      return;
    }
    g.acted = {};
    g.turn = nextRoundStarter(g);
    g.phase = 'bet';
  }

  function nextRoundStarter(g) {
    var n = g.players.length;
    for (var step = 0; step < n; step++) {
      var p = g.players[(g.firstSeat + step) % n];
      if (p.alive && p.inHand && !p.allIn) return p.id;
    }
    return null;
  }

  function fold(g, seat) {
    if (legalActions(g, seat).indexOf('fold') < 0) return false;
    var p = g.players[seat];
    p.inHand = false;
    p.folded = true;
    beginShot(g, seat, g.level, 'fold');
    return true;
  }

  function coward(g, seat) {
    if (legalActions(g, seat).indexOf('coward') < 0) return false;
    var p = g.players[seat];
    p.cowardUsed = true;
    p.inHand = false;
    p.folded = true;
    beginShot(g, seat, 1, 'coward');
    return true;
  }

  function allIn(g, seat) {
    if (legalActions(g, seat).indexOf('allin') < 0) return false;
    var p = g.players[seat];
    g.allIn = {
      by: seat,
      levelBefore: g.level,
      queue: [],
      responses: {}
    };
    g.players.forEach(function (q) {
      if (q.alive && q.inHand && !q.allIn && q.id !== seat) g.allIn.queue.push(q.id);
    });
    p.bet = 8;
    p.allIn = true;
    if (!g.allIn.queue.length) {
      resolveAllIn(g);
      return true;
    }
    g.phase = 'allin';
    g.turn = g.allIn.queue[0];
    return true;
  }

  function allInCall(g, seat) {
    if (legalActions(g, seat).indexOf('allinCall') < 0) return false;
    var p = g.players[seat];
    p.bet = 8;
    p.allIn = true;
    if (g.allIn) {
      g.allIn.responses[seat] = 'call';
      g.allIn.queue.shift();
      if (!g.allIn.queue.length) resolveAllIn(g);
      else g.turn = g.allIn.queue[0];
    }
    return true;
  }

  function allInFold(g, seat) {
    if (legalActions(g, seat).indexOf('allinFold') < 0) return false;
    var p = g.players[seat];
    p.inHand = false;
    p.folded = true;
    if (g.allIn) {
      g.allIn.responses[seat] = 'fold';
      g.allIn.queue.shift();
    }
    beginShot(g, seat, p.bet, 'allinFold');
    return true;
  }

  function resolveAllIn(g) {
    g.allIn = null;
    g.phase = 'bet';
    if (inHandPlayers(g).length <= 1) {
      endHand(g, inHandPlayers(g)[0] ? inHandPlayers(g)[0].id : null);
      return;
    }
    g.level = 8;
    g.revealed = 5;
    g.round = 3;
    startShowdown(g);
  }

  function offerSwap(g, seat) {
    var p = g.players[seat];
    if (!p || !p.alive || !p.inHand) return null;
    if (p.swapUsed || g.revealed >= 5) return null;
    if (g.swapOffer) return g.swapOffer;
    var cards = [];
    for (var i = 0; i < 3 && g.deck.length; i++) cards.push(g.deck.pop());
    if (cards.length < 3) return null;
    g.swapOffer = { seat: seat, cards: cards };
    return g.swapOffer;
  }

  function applySwap(g, seat, holeIndex, cardId) {
    var p = g.players[seat];
    if (!g.swapOffer || g.swapOffer.seat !== seat) return null;
    if (!p || !p.alive || !p.inHand || p.swapUsed) return null;
    if (holeIndex !== 0 && holeIndex !== 1) return null;
    var idx = -1;
    for (var i = 0; i < g.swapOffer.cards.length; i++) {
      if (g.swapOffer.cards[i].id === cardId) { idx = i; break; }
    }
    if (idx < 0) return null;
    var picked = g.swapOffer.cards[idx];
    var old = p.hand[holeIndex];
    p.hand[holeIndex] = picked;
    p.swapUsed = true;
    g.swapOffer = null;
    // 2 lá còn lại của offer bị bỏ; lá cũ bỏ.
    return { oldCard: old, newCard: picked };
  }

  function cancelSwap(g, seat) {
    if (!g.swapOffer || g.swapOffer.seat !== seat) return false;
    g.swapOffer.cards.forEach(function (c) { g.deck.push(c); });
    g.swapOffer = null;
    return true;
  }

  function beginShot(g, seat, bullets, reason) {
    var n = Math.max(1, Math.min(8, Math.floor(bullets || 1)));
    g.shot = { seat: seat, bullets: n, reason: reason };
    g.phase = 'shot';
    return g.shot;
  }

  function shootRoll(g, bullets) {
    var n = Math.max(1, Math.min(8, Math.floor(bullets)));
    var jam = n >= 8 && g.rng() < 0.05;
    var death = !jam && g.rng() < (n / 8);
    return { death: death, jam: jam, bullets: n, chance: jam ? 0 : n / 8 };
  }

  function finishShot(g) {
    if (!g.shot) return null;
    var shot = g.shot;
    var roll = shootRoll(g, shot.bullets);
    var p = g.players[shot.seat];
    if (roll.death) p.alive = false;
    g.lastShot = {
      seat: shot.seat,
      bullets: shot.bullets,
      reason: shot.reason,
      death: roll.death,
      jam: roll.jam,
      chance: roll.chance
    };
    g.shot = null;
    continueAfterShot(g, shot);
    return g.lastShot;
  }

  function continueAfterShot(g, shot) {
    var reason = shot.reason;

    if (reason === 'showdown') {
      if (g.showdown && g.showdown.losers.length) {
        beginShowdownShot(g);
      } else {
        endHand(g, g.showdown && g.showdown.winners.length ? g.showdown.winners[0] : null);
      }
      return;
    }

    if (reason === 'allinFold') {
      if (g.allIn && g.allIn.queue.length) {
        g.phase = 'allin';
        g.turn = g.allIn.queue[0];
      } else {
        resolveAllIn(g);
      }
      return;
    }

    // fold / coward
    if (inHandPlayers(g).length <= 1) {
      endHand(g, inHandPlayers(g)[0] ? inHandPlayers(g)[0].id : null);
      return;
    }
    g.phase = 'bet';
    var nxt = nextActorFrom(g, shot.seat);
    if (nxt != null) {
      g.turn = nxt;
    } else {
      completeRound(g);
    }
  }

  function startShowdown(g) {
    if (inHandPlayers(g).length <= 1) {
      endHand(g, inHandPlayers(g)[0] ? inHandPlayers(g)[0].id : null);
      return;
    }
    g.revealed = 5;
    var seats = inHandPlayers(g).map(function (p) { return p.id; });
    var hands = {};
    seats.forEach(function (id) {
      var p = g.players[id];
      hands[id] = bestOf(p.hand.concat(g.community));
    });
    var best = null;
    seats.forEach(function (id) {
      if (!best || compare(hands[id], best) > 0) best = hands[id];
    });
    var winners = seats.filter(function (id) { return compare(hands[id], best) === 0; });
    var losers = seats.filter(function (id) { return winners.indexOf(id) < 0; });
    g.showdown = {
      seats: seats,
      hands: hands,
      winners: winners,
      losers: losers
    };
    g.phase = 'showdown';
    if (!losers.length) {
      endHand(g, winners[0]);
    }
  }

  function beginShowdownShots(g) {
    if (!g.showdown) return;
    if (!g.showdown.losers.length) {
      endHand(g, g.showdown.winners.length ? g.showdown.winners[0] : null);
      return;
    }
    beginShowdownShot(g);
  }

  function beginShowdownShot(g) {
    if (!g.showdown || !g.showdown.losers.length) {
      endHand(g, g.showdown && g.showdown.winners.length ? g.showdown.winners[0] : null);
      return;
    }
    var seat = g.showdown.losers.shift();
    beginShot(g, seat, g.level, 'showdown');
  }

  function endHand(g, winnerId) {
    g.handWinner = winnerId;
    var alive = alivePlayers(g);
    if (alive.length <= 1) {
      g.phase = 'over';
      g.winnerId = alive.length ? alive[0].id : null;
      return;
    }
    g.phase = 'handover';
  }

  /* ------------------------------------------------------------------ */
  /* đánh giá bài                                                       */
  /* ------------------------------------------------------------------ */
  function evaluate5(cards) {
    var vals = cards.map(function (c) { return c.value; }).sort(function (a, b) { return b - a; });
    var suits = {};
    cards.forEach(function (c) { suits[c.suit] = (suits[c.suit] || 0) + 1; });
    var flush = Object.keys(suits).some(function (s) { return suits[s] === 5; });

    var counts = {};
    vals.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
    var groups = Object.keys(counts).map(function (v) {
      return { v: +v, c: counts[v] };
    }).sort(function (a, b) { return b.c - a.c || b.v - a.v; });

    var uniq = [];
    vals.forEach(function (v) { if (uniq.indexOf(v) < 0) uniq.push(v); });
    var straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
    }

    if (straightHigh && flush) {
      return { cat: straightHigh === 14 ? CAT.ROYAL : CAT.STRAIGHT_FLUSH, tie: [straightHigh], cards: cards };
    }
    if (groups[0].c === 4) {
      return { cat: CAT.QUADS, tie: [groups[0].v, groups[1].v], cards: cards };
    }
    if (groups[0].c === 3 && groups[1].c === 2) {
      return { cat: CAT.FULL_HOUSE, tie: [groups[0].v, groups[1].v], cards: cards };
    }
    if (flush) {
      return { cat: CAT.FLUSH, tie: vals.slice(), cards: cards };
    }
    if (straightHigh) {
      return { cat: CAT.STRAIGHT, tie: [straightHigh], cards: cards };
    }
    if (groups[0].c === 3) {
      return { cat: CAT.TRIPS, tie: [groups[0].v, groups[1].v, groups[2].v], cards: cards };
    }
    if (groups[0].c === 2 && groups[1].c === 2) {
      return { cat: CAT.TWO_PAIR, tie: [groups[0].v, groups[1].v, groups[2].v], cards: cards };
    }
    if (groups[0].c === 2) {
      return { cat: CAT.PAIR, tie: [groups[0].v, groups[1].v, groups[2].v, groups[3].v], cards: cards };
    }
    return { cat: CAT.HIGH, tie: vals.slice(), cards: cards };
  }

  function combinations(arr, k) {
    var out = [];
    var n = arr.length;
    function rec(start, cur) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (var i = start; i < n; i++) {
        cur.push(arr[i]);
        rec(i + 1, cur);
        cur.pop();
      }
    }
    rec(0, []);
    return out;
  }

  function bestOf(cards) {
    if (!cards || cards.length < 5) {
      return { cat: -1, tie: [], cards: cards ? cards.slice() : [], label: 'Chưa đủ 5 lá' };
    }
    var best = null;
    if (cards.length === 5) {
      best = evaluate5(cards.slice());
    } else {
      var combos = combinations(cards, 5);
      combos.forEach(function (c) {
        var h = evaluate5(c);
        if (!best || compare(h, best) > 0) best = h;
      });
    }
    best.label = handLabel(best);
    return best;
  }

  function compare(a, b) {
    if (!a || !b) return 0;
    if (a.cat !== b.cat) return a.cat - b.cat;
    var n = Math.max(a.tie.length, b.tie.length);
    for (var i = 0; i < n; i++) {
      var av = a.tie[i] || 0;
      var bv = b.tie[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  function handLabel(h) {
    if (!h || h.cat < 0) return 'Chưa đủ 5 lá';
    var t = h.tie;
    switch (h.cat) {
      case CAT.ROYAL: return 'Thùng phá sảnh hoàng gia';
      case CAT.STRAIGHT_FLUSH: return 'Thùng phá sảnh ' + rankName(t[0]) + '-high';
      case CAT.QUADS: return 'Tứ quý ' + rankName(t[0]);
      case CAT.FULL_HOUSE: return 'Cù lũ ' + rankName(t[0]) + ' / ' + rankName(t[1]);
      case CAT.FLUSH: return 'Thùng ' + rankName(t[0]) + '-high';
      case CAT.STRAIGHT: return 'Sảnh ' + rankName(t[0]) + '-high';
      case CAT.TRIPS: return 'Bộ ba ' + rankName(t[0]);
      case CAT.TWO_PAIR: return 'Hai đôi ' + rankName(t[0]) + ' / ' + rankName(t[1]);
      case CAT.PAIR: return 'Một đôi ' + rankName(t[0]);
      default: return 'Mậu thầu ' + rankName(t[0]);
    }
  }

  function categoryName(cat) {
    return CAT_NAMES[cat] || '—';
  }

  return {
    RANKS: RANKS,
    SUITS: SUITS,
    CAT: CAT,
    CAT_NAMES: CAT_NAMES,
    makeDeck: makeDeck,
    createGame: createGame,
    startHand: startHand,
    legalActions: legalActions,
    call: call,
    fold: fold,
    coward: coward,
    allIn: allIn,
    allInCall: allInCall,
    allInFold: allInFold,
    offerSwap: offerSwap,
    applySwap: applySwap,
    cancelSwap: cancelSwap,
    finishShot: finishShot,
    beginShot: beginShot,
    shootRoll: shootRoll,
    beginShowdownShots: beginShowdownShots,
    alivePlayers: alivePlayers,
    inHandPlayers: inHandPlayers,
    bestOf: bestOf,
    evaluate5: evaluate5,
    compare: compare,
    handLabel: handLabel,
    categoryName: categoryName,
    rankName: rankName,
    nextAliveAfter: nextAliveAfter
  };
});
