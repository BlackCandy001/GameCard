/* Test engine Liar's Poker: evaluator + mô phỏng bot.
   Chạy: node liars_poker/poker_test.js */
'use strict';
const P = require('./poker_engine.js');
const B = require('./poker_bots.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
function c(s) {
  const suit = s.slice(-1);
  const rank = s.slice(0, -1);
  return { id: Math.random(), rank, suit, value: RANK_VAL[rank] };
}
function hand(str) { return str.trim().split(/\s+/).map(c); }

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

// ---------- evaluator ----------
const cases = [
  ['A♠ K♠ Q♠ J♠ 10♠', 9, 'royal'],
  ['9♥ 8♥ 7♥ 6♥ 5♥', 8, 'straight flush'],
  ['A♥ 5♥ 4♥ 3♥ 2♥', 8, 'steel wheel'],
  ['9♠ 9♥ 9♦ 9♣ K♠', 7, 'quads'],
  ['K♥ K♦ K♣ 7♠ 7♥', 6, 'full house'],
  ['A♥ J♥ 8♥ 5♥ 2♥', 5, 'flush'],
  ['9♠ 8♦ 7♣ 6♥ 5♠', 4, 'straight'],
  ['A♠ 5♦ 4♣ 3♥ 2♠', 4, 'wheel'],
  ['Q♠ Q♦ Q♥ 8♣ 3♦', 3, 'trips'],
  ['J♠ J♥ 4♣ 4♦ A♠', 2, 'two pair'],
  ['10♠ 10♥ A♦ 7♣ 3♠', 1, 'pair'],
  ['A♠ K♦ 9♣ 5♥ 2♦', 0, 'high']
];
for (const [str, cat, name] of cases) {
  const h = P.evaluate5(hand(str));
  assert(h.cat === cat, name + ' cat=' + h.cat + ' expected ' + cat);
  console.log('ok', name, '->', P.handLabel(h));
}

// best of 7
let h7 = P.bestOf(hand('A♠ K♠ Q♠ J♠ 10♠ 2♥ 3♦'));
assert(h7.cat === 9, 'royal of 7');
console.log('ok best of 7 royal:', h7.label);

// so sánh
let a = P.evaluate5(hand('A♠ A♥ K♦ K♣ 2♠'));
let b = P.evaluate5(hand('A♦ A♣ Q♥ Q♦ 3♠'));
assert(P.compare(a, b) > 0, 'AAKK > AAQQ');
let w1 = P.evaluate5(hand('A♠ 2♦ 3♣ 4♥ 5♠'));
let w2 = P.evaluate5(hand('2♠ 3♦ 4♣ 5♥ 6♠'));
assert(P.compare(w2, w1) > 0, '6-high straight > wheel');
console.log('ok compare tiebreak');

// ---------- simulate bot games ----------
function simulate(seed, n, diff) {
  const rng = mulberry32(seed);
  const names = ['Gấu', 'Thỏ', 'Cáo', 'Sói'];
  const players = [];
  for (let i = 0; i < n; i++) players.push({ name: names[i], isBot: true });
  const g = P.createGame({ players, rng });
  let guard = 0;
  let hands = 0;
  let shots = 0;
  let allins = 0;

  P.startHand(g);
  while (g.phase !== 'over') {
    if (++guard > 20000) throw new Error('guard');
    if (g.phase === 'shot') {
      shots++;
      P.finishShot(g);
      continue;
    }
    if (g.phase === 'showdown') {
      P.beginShowdownShots(g);
      continue;
    }
    if (g.phase === 'handover') {
      hands++;
      if (hands > 300) throw new Error('quá nhiều ván');
      if (P.alivePlayers(g).length < 2) break;
      P.startHand(g);
      continue;
    }
    if (g.phase === 'bet' || g.phase === 'allin') {
      const seat = g.turn;
      if (seat == null) throw new Error('turn null ở ' + g.phase);
      const p = g.players[seat];
      if (!p || !p.alive) throw new Error('turn người chết');

      if (g.phase === 'bet' && B.wantsSwap(g, seat)) {
        const offer = P.offerSwap(g, seat);
        if (offer) {
          const pick = B.chooseSwap(g, seat, offer, diff);
          if (pick) P.applySwap(g, seat, pick.holeIndex, pick.cardId);
          else P.cancelSwap(g, seat);
        }
      }
      const d = B.decide(g, seat, diff);
      if (!d) throw new Error('bot không quyết định');
      if (d.action === 'allin') allins++;
      switch (d.action) {
        case 'call': assert(P.call(g, seat), 'call false'); break;
        case 'fold': assert(P.fold(g, seat), 'fold false'); break;
        case 'coward': assert(P.coward(g, seat), 'coward false'); break;
        case 'allin': assert(P.allIn(g, seat), 'allin false'); break;
        case 'allinCall': assert(P.allInCall(g, seat), 'allinCall false'); break;
        case 'allinFold': assert(P.allInFold(g, seat), 'allinFold false'); break;
        default: throw new Error('action lạ ' + d.action);
      }
      continue;
    }
    throw new Error('phase lạ ' + g.phase);
  }

  const alive = P.alivePlayers(g);
  assert(alive.length === 1, 'kết thúc không còn 1 người');
  assert(g.winnerId === alive[0].id, 'winnerId sai');
  return { hands, shots, allins };
}

let total = { games: 0, hands: 0, shots: 0, allins: 0 };
for (const diff of ['easy', 'normal', 'hard']) {
  for (const n of [2, 3, 4]) {
    for (let s = 0; s < 120; s++) {
      const r = simulate(2000 + s * 17 + n * 101, n, diff);
      total.games++;
      total.hands += r.hands;
      total.shots += r.shots;
      total.allins += r.allins;
    }
    console.log(`ok ${n} người · ${diff}`);
  }
}
console.log(`\n===== OK: ${total.games} bàn, TB ${(total.hands / total.games).toFixed(2)} ván/bàn, ${total.shots} phát súng, ${total.allins} all-in =====`);
