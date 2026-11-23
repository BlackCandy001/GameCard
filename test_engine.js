/* Test engine + bot bằng Node (không cần trình duyệt).
   Chạy: node liars_poker/test_engine.js
   Mô phỏng hàng nghìn ván để bắt lỗi luật, kẹt lượt, rò rỉ bài. */
'use strict';

const Engine = require('./engine.js');
const Bots = require('./bots.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOT_NAMES = ['Gấu Bự', 'Thỏ Nhí', 'Cáo Già', 'Sói Xám'];

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function simulate(seed, playerCount, difficulty) {
  const rng = mulberry32(seed);
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({ name: BOT_NAMES[i % BOT_NAMES.length] + (i >= 4 ? i : ''), isBot: true });
  }
  const g = Engine.createGame({ players, rng, difficulty });
  let preferred = g.firstPlayer;
  let rounds = 0;
  let actions = 0;

  while (g.winnerId == null) {
    if (++rounds > 400) throw new Error('Quá nhiều ván, có thể bị kẹt');
    Engine.startRound(g, preferred);
    assert(g.pile.length === 0, 'pile phải rỗng đầu ván');
    assert(!g.forcedCall, 'đầu ván không được forcedCall');
    assert(g.players[g.turn].alive, 'người mở ván phải còn sống');

    let turnGuard = 0;
    let resolved = null;

    while (!resolved) {
      if (++turnGuard > 300) throw new Error('Ván không kết thúc');
      if (++actions > 100000) throw new Error('Quá nhiều hành động');

      const p = g.players[g.turn];
      assert(p.alive, 'lượt của người đã chết');
      assert(g.turn >= 0 && g.turn < g.players.length, 'turn ngoài phạm vi');

      // Kiểm tra bảo toàn bài: tay + bài trên bàn + bài chưa chia = 20
      const inHands = g.players.reduce((s, q) => s + q.hand.length, 0);
      const onTable = g.pile.reduce((s, grp) => s + grp.cards.length, 0);
      assert(inHands + onTable + g.deck.length === 20, 'mất hoặc thừa bài');

      // Mọi lá trên bàn phải là lá thật sự rời khỏi tay
      const seen = new Set();
      g.players.forEach(q => q.hand.forEach(c => {
        assert(!seen.has(c.id), 'một lá nằm ở 2 tay');
        seen.add(c.id);
      }));

      if (g.forcedCall) {
        assert(g.pile.length > 0, 'forcedCall mà chưa có bài');
        assert(lastIsNotMe(g), 'forcedCall nhưng lại tự bắt gian mình');
        resolved = Engine.challenge(g, g.turn);
        continue;
      }

      if (p.hand.length === 0) {
        throw new Error('Đến lượt người hết bài mà không bị forcedCall');
      }

      const d = Bots.decide(g, p.id, difficulty);
      if (d.type === 'liar') {
        assert(g.pile.length > 0, 'bot bắt gian khi chưa có bài');
        assert(lastIsNotMe(g), 'bot tự bắt gian mình');
        resolved = Engine.challenge(g, p.id);
      } else {
        assert(d.cardIds.length >= 1 && d.cardIds.length <= 3, 'số lá đánh sai');
        Engine.play(g, p.id, d.cardIds);
        Engine.advance(g);
      }
    }

    // Xử lý roulette
    const shot = Engine.shoot(g, resolved.shooterId);
    assert(typeof shot.death === 'boolean', 'roulette trả về sai');
    assert(g.players[resolved.shooterId].shots >= 1, 'không ghi nhận lượt bắn');

    if (g.winnerId != null) break;

    // Người mở ván sau: kẻ bị bắt gian, nếu chết thì người kế tiếp.
    preferred = Engine.pickStarter(g, resolved.accusedId);
    assert(g.players[preferred].alive, 'người mở ván sau đã chết');
  }

  const alive = Engine.alivePlayers(g);
  assert(alive.length === 1, 'kết thúc mà không còn đúng 1 người');
  assert(g.winnerId === alive[0].id, 'winnerId không khớp');

  return { rounds, actions };
}

function lastIsNotMe(g) {
  const last = g.pile[g.pile.length - 1];
  return last.playerId !== g.turn;
}

let totalRounds = 0;
let totalGames = 0;
let maxRounds = 0;

for (const diff of ['easy', 'normal', 'hard']) {
  for (const n of [2, 3, 4]) {
    const games = 400;
    for (let s = 0; s < games; s++) {
      const r = simulate(1000 + s * 7 + n * 131, n, diff);
      totalRounds += r.rounds;
      totalGames++;
      if (r.rounds > maxRounds) maxRounds = r.rounds;
    }
    console.log(`ok  ${n} người · ${diff} · ${games} ván`);
  }
}

console.log(`\n===== OK: ${totalGames} ván, TB ${(totalRounds / totalGames).toFixed(2)} ván/bàn, max ${maxRounds} ván =====`);
