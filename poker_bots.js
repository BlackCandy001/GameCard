/* =====================================================================
   poker_bots.js — AI cho Liar's Poker
   ---------------------------------------------------------------------
   Bot chỉ dùng bài của mình + lá chung đã lật. Không nhìn trộm.
   Quyết định: theo / bỏ / all-in / bỏ nhát / đổi bài.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./poker_engine.js'));
  else root.PokerBots = factory(root.PokerEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  var LEVELS = {
    easy: { foldAdd: -0.08, bluff: 0.07, mistake: 0.12, aggr: 0.18 },
    normal: { foldAdd: 0.00, bluff: 0.04, mistake: 0.03, aggr: 0.12 },
    hard: { foldAdd: 0.08, bluff: 0.02, mistake: 0.00, aggr: 0.08 }
  };

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  function preflopScore(hand) {
    if (!hand || hand.length < 2) return 0;
    var a = hand[0].value, b = hand[1].value;
    var hi = Math.max(a, b), lo = Math.min(a, b);
    var s;
    if (a === b) {
      s = 0.55 + ((hi - 2) / 12) * 0.4;
    } else {
      s = ((hi - 2) / 12) * 0.34 + ((lo - 2) / 12) * 0.14;
      if (hand[0].suit === hand[1].suit) s += 0.07;
      if (hi - lo <= 2) s += 0.05;
      if (hi === 14) s += 0.10;
      if (hi >= 12 && lo >= 10) s += 0.07;
      if (hi === 14 && lo === 13) s += 0.05;
    }
    return clamp(s, 0, 1);
  }

  var CAT_STRENGTH = [0.18, 0.34, 0.50, 0.64, 0.74, 0.83, 0.92, 0.97, 0.99, 1.0];

  function strength(g, seat) {
    var p = g.players[seat];
    var known = p.hand.concat(g.community.slice(0, g.revealed));
    if (known.length < 5) return preflopScore(p.hand);
    var h = P.bestOf(known);
    var s = CAT_STRENGTH[h.cat] || 0.2;
    if (h.cat === P.CAT.PAIR && h.tie.length) s += (h.tie[0] - 2) / 12 * 0.10;
    if (h.cat === P.CAT.TWO_PAIR && h.tie.length >= 2) s += (h.tie[0] - 2) / 12 * 0.06;
    if (h.cat === P.CAT.TRIPS && h.tie.length) s += (h.tie[0] - 2) / 12 * 0.05;
    if (h.cat === P.CAT.HIGH && h.tie.length) s += (h.tie[0] - 2) / 12 * 0.08;
    return clamp(s, 0, 1);
  }

  function opponents(g, seat) {
    return P.inHandPlayers(g).filter(function (p) { return p.id !== seat; }).length;
  }

  function foldThreshold(g, diff, s) {
    var lvl = LEVELS[diff] || LEVELS.normal;
    var base;
    if (g.level <= 2) base = 0.30;
    else if (g.level === 3) base = 0.44;
    else base = 0.56;
    // càng nhiều đối thủ, cần bài mạnh hơn
    base += Math.max(0, opponents(g, -1) - 1) * 0.03;
    return clamp(base + lvl.foldAdd, 0.1, 0.9);
  }

  function randomLegal(g, seat, legal) {
    var pool = legal.filter(function (a) { return a !== 'swap'; });
    if (!pool.length) return 'call';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function decide(g, seat, difficulty) {
    var legal = P.legalActions(g, seat);
    if (!legal.length) return null;
    var lvl = LEVELS[difficulty] || LEVELS.normal;
    var p = g.players[seat];

    if (legal.indexOf('allinCall') >= 0) {
      var sAll = strength(g, seat);
      var call = sAll >= (difficulty === 'easy' ? 0.42 : difficulty === 'hard' ? 0.58 : 0.50);
      return { action: call ? 'allinCall' : 'allinFold' };
    }

    if (legal.indexOf('allinFold') >= 0) return { action: 'allinFold' };

    if (legal.indexOf('call') < 0) return null;

    if (lvl.mistake && g.rng() < lvl.mistake) {
      return { action: randomLegal(g, seat, legal) };
    }

    var s = strength(g, seat);
    var canFold = legal.indexOf('fold') >= 0;
    var canCoward = legal.indexOf('coward') >= 0;
    var canAllIn = legal.indexOf('allin') >= 0;

    if (g.round === 0) {
      // pre-flop: không được bỏ thường, chỉ coward's fold
      if (canCoward && s < 0.20 && g.rng() < 0.65) {
        return { action: 'coward' };
      }
      if (canAllIn && s > 0.90 && g.rng() < lvl.aggr) {
        return { action: 'allin' };
      }
      return { action: 'call' };
    }

    var thr = foldThreshold(g, difficulty, s);
    var strong = s >= 0.86;
    var veryStrong = s >= 0.93;

    if (canAllIn && ((veryStrong && g.level >= 3 && g.rng() < 0.28 + lvl.aggr) ||
                     (strong && g.level >= 4 && g.rng() < 0.18))) {
      return { action: 'allin' };
    }
    if (canAllIn && g.rng() < lvl.bluff) {
      return { action: 'allin' };
    }

    if (s < thr && canFold) return { action: 'fold' };
    return { action: 'call' };
  }

  function chooseSwap(g, seat, offer, difficulty) {
    if (!offer || !offer.cards || !offer.cards.length) return null;
    var p = g.players[seat];
    var known = p.hand.concat(g.community.slice(0, g.revealed));
    var current;
    var currentScore;
    if (known.length >= 5) {
      current = P.bestOf(known);
      currentScore = null;
    } else {
      current = null;
      currentScore = preflopScore(p.hand);
    }

    var best = null;
    for (var h = 0; h < 2; h++) {
      for (var o = 0; o < offer.cards.length; o++) {
        var newHand = p.hand.slice();
        newHand[h] = offer.cards[o];
        var score;
        var hand;
        if (known.length >= 5) {
          hand = P.bestOf(newHand.concat(g.community.slice(0, g.revealed)));
          score = null;
          if (!best || P.compare(hand, best.hand) > 0) {
            best = { holeIndex: h, cardId: offer.cards[o].id, hand: hand };
          }
        } else {
          score = preflopScore(newHand);
          if (!best || score > best.score) {
            best = { holeIndex: h, cardId: offer.cards[o].id, score: score };
          }
        }
      }
    }

    if (!best) return null;
    if (known.length >= 5) {
      return P.compare(best.hand, current) > 0 ? { holeIndex: best.holeIndex, cardId: best.cardId } : null;
    }
    return (best.score > currentScore + 0.035) ? { holeIndex: best.holeIndex, cardId: best.cardId } : null;
  }

  function wantsSwap(g, seat) {
    var legal = P.legalActions(g, seat);
    return legal.indexOf('swap') >= 0;
  }

  return {
    decide: decide,
    chooseSwap: chooseSwap,
    wantsSwap: wantsSwap,
    strength: strength,
    preflopScore: preflopScore
  };
});
