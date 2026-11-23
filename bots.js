/* =====================================================================
   bots.js — AI cho Liar's Poker
   ---------------------------------------------------------------------
   Bot không nhìn trộm bài người khác. Nó chỉ dùng:
     - bài trên tay nó
     - những lá nó đã tự đánh
     - lá đã bị lật (nếu có)
     - số lá trên bàn, số lá người trước còn
   Từ đó ước lượng xác suất người trước thật sự có đủ lá THẬT để đánh,
   rồi quyết định bắt gian hay đánh tiếp.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.Bots = factory(root.Engine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  var FACT = [1];
  for (var i = 1; i <= 22; i++) FACT[i] = FACT[i - 1] * i;

  function comb(n, k) {
    if (k < 0 || k > n || n < 0) return 0;
    return FACT[n] / (FACT[k] * FACT[n - k]);
  }

  function clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  /* Xác suất một tay h lá (rút từ U lá chưa biết, trong đó có T lá THẬT)
     chứa ít nhất n lá THẬT. */
  function pAtLeast(n, h, T, U) {
    if (n <= 0) return 1;
    if (h > U) h = U;
    if (n > h) return 0;
    if (T > U) T = U;
    var total = comb(U, h);
    if (total <= 0) return 0;
    var miss = 0;
    for (var k = 0; k < n; k++) {
      miss += comb(T, k) * comb(U - T, h - k);
    }
    return clamp01(1 - miss / total);
  }

  var LEVELS = {
    easy:   { callAt: 0.30, mix: 0.50, mistake: 0.16, maxTruth: 2, gamble: 0.02 },
    normal: { callAt: 0.47, mix: 0.22, mistake: 0.05, maxTruth: 3, gamble: 0.06 },
    hard:   { callAt: 0.62, mix: 0.12, mistake: 0.00, maxTruth: 3, gamble: 0.10 }
  };

  function pickN(rng, arr, n) {
    var copy = arr.slice();
    var out = [];
    n = Math.min(n, copy.length);
    for (var i = 0; i < n; i++) {
      var j = Math.floor(rng() * copy.length);
      out.push(copy.splice(j, 1)[0]);
    }
    return out;
  }

  /* Trả về { type:'play', cardIds:[...] } hoặc { type:'liar' }. */
  function decide(g, pid, difficulty) {
    var lvl = LEVELS[difficulty] || LEVELS.normal;
    var rng = g.rng;
    var p = g.players[pid];
    var hand = p.hand;
    var last = g.pile.length ? g.pile[g.pile.length - 1] : null;

    if (!hand.length) return { type: 'play', cardIds: [] };

    var truths = hand.filter(function (c) { return Engine.isTruth(c, g.tableType); });
    var lies = hand.filter(function (c) { return !Engine.isTruth(c, g.tableType); });

    // ---- Thông tin công khai mà bot biết ----
    var knownCards = hand.length;
    var knownTruths = truths.length;
    g.pile.forEach(function (grp) {
      if (grp.playerId === pid || grp.revealed) {
        grp.truth.forEach(function (t) {
          knownCards++;
          if (t) knownTruths++;
        });
      }
    });

    var T = Math.max(0, Engine.TRUTHS_PER_ROUND - knownTruths);
    var U = Math.max(1, Engine.TOTAL_CARDS - knownCards);

    // ---- Có nên bắt gian người trước? ----
    if (last && last.playerId !== pid) {
      var n = last.cards.length;
      // Số lá người đó có trước khi đánh (sau khi đánh còn last.player.hand)
      var acc = g.players[last.playerId];
      var h = (acc ? acc.hand.length : 0) + n;
      var pTrue = pAtLeast(n, h, T, U);

      // Chắc chắn xạo vì không đủ lá thật trên toàn bộ bài còn lại
      var certainLie = T < n;

      if (rng() < lvl.mistake) {
        // Bot dễ đôi khi ra quyết định ngẫu nhiên
        if (rng() < 0.5) return { type: 'liar' };
      }

      if (certainLie || pTrue < lvl.callAt) {
        return { type: 'liar' };
      }

      // Thỉnh thoảng bắt liều — để người chơi không thể bluff 1 lá mãi.
      if (rng() < lvl.gamble) {
        return { type: 'liar' };
      }
    }

    // ---- Chọn bài để đánh ----
    if (!truths.length) {
      // Không có lá thật: buộc phải xạo. Đánh 1 lá là ít bị bắt nhất.
      var bluffN = 1;
      if (lies.length >= 2 && hand.length <= 3 && rng() < 0.2) bluffN = 2;
      return { type: 'play', cardIds: pickN(rng, lies, bluffN).map(function (c) { return c.id; }) };
    }

    var maxT = Math.min(3, truths.length, lvl.maxTruth);
    var chosen = [];

    // Thỉnh thoảng trộn 1 lá xạo để tống bớt bài xấu.
    var mix = lies.length > 0 && hand.length >= 3 && rng() < lvl.mix;
    if (mix) {
      chosen.push(pickN(rng, lies, 1)[0]);
      var tN = Math.min(maxT, rng() < 0.5 ? 1 : 2);
      chosen = chosen.concat(pickN(rng, truths, tN));
    } else {
      var nTruth;
      if (maxT === 1) nTruth = 1;
      else if (rng() < 0.58) nTruth = maxT;
      else nTruth = 1 + Math.floor(rng() * maxT);
      chosen = pickN(rng, truths, nTruth);
    }

    chosen = chosen.slice(0, 3);
    if (!chosen.length) chosen = [truths[0]];
    return { type: 'play', cardIds: chosen.map(function (c) { return c.id; }) };
  }

  return { decide: decide, pAtLeast: pAtLeast };
});
