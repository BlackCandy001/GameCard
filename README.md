# Liar's Bar — 2 game bài

Repo này có **2 chế độ chơi riêng**, cùng phong cách quán bar đêm của *Liar's Bar*:

| Chế độ | Luật | File chơi ngay |
|---|---|---|
| **Liar's Deck — Bài Bịp** | 20 lá A/K/Q/Joker, úp bài, hô BẮT GIAN | `LiarPoker.html` |
| **Liar's Poker — Texas Hold'em + Đạn** | 2 lá riêng + 5 lá chung, sảnh/cù lũ/tứ quý, theo–bỏ–all-in, đổi bài | `PokerMode.html` |

Cả hai đều có: **chơi với bot**, **chuyền máy**, và **online** (host tạo phòng,
không cần server game).

---

## Chơi ngay

**Bản 1 file (dễ gửi bạn bè):**

- `LiarPoker.html` — Liar's Deck.
- `PokerMode.html` — Liar's Poker.

Double-click file là chơi. Không cần cài đặt, không cần server.
Trên điện thoại: gửi file qua Zalo/Telegram/Drive → mở bằng Chrome.
Có thể dùng `play.bat` (Liar's Deck) và `play_poker.bat` (Poker) trên Windows.

Từ màn hình **Liar's Deck** có nút **♠️ CHƠI POKER (TEXAS HOLD'EM)**;
từ Poker có link **← Về Liar's Deck**.

**Bản phát triển (file rời):**

- `index.html` + `style.css` + `engine.js` + `bots.js` + `app.js` — Liar's Deck.
- `poker.html` + `poker.css` + `poker_engine.js` + `poker_bots.js` + `poker_app.js` — Liar's Poker.
- `vendor/mqtt.min.js` — MQTT.js (MIT), relay tin nhắn qua broker công cộng.

---

# LIAR'S POKER — Texas Hold'em + Đạn

## Luật

- Mỗi người **2 lá riêng**. 5 lá chung lật dần:
  **flop** (3 lá), **turn** (1), **river** (1).
- Ghép 2 lá riêng + 5 lá chung, lấy **5 lá mạnh nhất**.
- Mỗi người bắt đầu với **1 viên** (mức 1).
- **Theo (Call)**: đặt thêm 1 viên. Mức cược tăng:
  - mức 2 → lật flop
  - mức 3 → lật turn
  - mức 4 → lật river
  - mức 5 → **showdown**
- **Bỏ bài (Fold)**: chỉ từ flop trở đi; bạn chơi roulette với đúng
  **số viên đang cược**. Sống thì vẫn chơi ván sau.
- **Bỏ nhát (Coward's Fold)**: **1 lần mỗi bàn**, chỉ vòng đầu, bắn với
  **1 viên** (12.5%).
- **All-in**: đặt **8 viên**. Người khác chọn **theo all-in (8)** hoặc
  **bỏ** (bắn với số viên hiện có). Nếu ≥2 người theo, lật hết bài và
  showdown; người thua bắn **8 viên** (95% chết, **5% kẹt đạn**).
- **Đổi bài (Swap)**: **1 lần mỗi ván tay**, trước khi lật hết 5 lá chung.
  Xem 3 lá được chọn, thay cho 1 trong 2 lá riêng. Không mất lượt —
  vẫn theo/bỏ sau đó.
- **Showdown**: bài mạnh nhất thắng ván và an toàn. **Tất cả những người
  còn lại ở showdown** bắn roulette với mức cược cuối (5 hoặc 8).
- **8 viên** vẫn có 5% kẹt đạn. Trúng đạn là chết. Sống cuối cùng thắng bàn.

## Bảng combo (mạnh → yếu)

| # | Combo | Ví dụ |
|---|---|---|
| 9 | Thùng phá sảnh hoàng gia | A♠ K♠ Q♠ J♠ 10♠ |
| 8 | Thùng phá sảnh | 9♥ 8♥ 7♥ 6♥ 5♥ |
| 7 | Tứ quý | 9♠ 9♥ 9♦ 9♣ K♠ |
| 6 | Cù lũ (Full House) | K♥ K♦ K♣ 7♠ 7♥ |
| 5 | Thùng (Flush) | A♥ J♥ 8♥ 5♥ 2♥ |
| 4 | Sảnh (Straight) | 9♠ 8♦ 7♣ 6♥ 5♠ |
| 3 | Bộ ba (Three of a Kind) | Q♠ Q♦ Q♥ 8♣ 3♦ |
| 2 | Hai đôi (Two Pair) | J♠ J♥ 4♣ 4♦ A♠ |
| 1 | Một đôi (One Pair) | 10♠ 10♥ A♦ 7♣ 3♠ |
| 0 | Mậu thầu (High Card) | A♠ K♦ 9♣ 5♥ 2♦ |

A được tính là **1** trong sảnh A-2-3-4-5.
Panel bên phải hiện bảng này và **highlight combo hiện tại của bạn**;
trên mobile bấm nút **♠**.

## Bot

Bot Texas Hold'em ước lượng sức bài từ 2 lá riêng + lá chung đã lật,
tính mức cược/rủi ro, biết:
- theo / bỏ / bỏ nhát;
- all-in khi bài rất mạnh (và bluff hiếm);
- đổi 1 lá nếu lá mới làm bài mạnh hơn;
- theo all-in hay bỏ khi bị all-in.

3 độ khó: Dễ / Vừa / Khó.

---

# LIAR'S DECK — Bài Bịp (bản gốc)

- 20 lá: 6 Già (K), 6 Đầm (Q), 6 Át (A), 2 Joker.
- Mỗi ván mở 1 **loại bài**. Lá cùng loại + Joker = **THẬT**, còn lại = **XẠO**.
- Đánh úp 1–3 lá; người sau đánh tiếp hoặc hô **BẮT GIAN**.
- Lật bài: có lá xạo → người đánh bắn roulette; toàn thật → người bắt gian bắn.
- Roulette: 6 lá (1 Tử, 5 Trống), rút trúng Tử là chết.
- Sống sót cuối cùng thắng.

Chi tiết trong nút **LUẬT CHƠI** của game.

---

## Chơi online (cả 2 game)

Một người làm **host**, bạn bè nhập **mã phòng 5 ký tự**.
Tin nhắn bàn chơi đi qua **broker MQTT công khai** (HiveMQ, WSS) — host vẫn
giữ luật, không cần server game, không dùng WebRTC nên **chơi khác mạng ổn định hơn**.

1. **Host:** chọn **🌐 Online** → **👑 Tạo phòng** → nhập tên → **TẠO PHÒNG**.
   Copy mã gửi bạn bè.
2. **Bạn bè:** mở cùng file game → **🌐 Online** → **🔑 Vào phòng** →
   nhập tên + mã → **VÀO PHÒNG**.
3. Đủ **2–4 người**, host bấm **BẮT ĐẦU**.

**Riêng tư:** host giữ luật và chỉ gửi cho mỗi máy đúng bài của người đó.
Với Poker, lá đổi bài chỉ gửi riêng cho người đổi; showdown mới lật bài
của những người vào showdown.

**Phòng của 2 game độc lập:** Liar's Deck dùng topic `liarsbar/deck/<mã>`,
Liar's Poker dùng `liarsbar/poker/<mã>`, nên cùng một mã 5 ký tự vẫn không đụng nhau.

**Mất kết nối:** MQTT tự nối lại broker; client tự gửi lại hello và nhận lại
trạng thái ván. Nếu host đóng tab, broker báo `host-left` và phòng đóng.
Nếu ai thoát giữa ván, host bấm **↺** (Bàn mới) để chơi tiếp với người còn kết nối.

Cần Internet lúc kết nối. Broker là WSS (port 8884) nên qua được hầu hết
wifi/4G; nếu mạng chặn cả WSS 8884 thì thử mạng khác. Tin nhắn đi qua broker
công cộng — đừng dùng cho nội dung nhạy cảm.

---

## Cấu trúc file

| File | Nội dung |
|---|---|
| `LiarPoker.html` | **Bản 1 file** Liar's Deck |
| `PokerMode.html` | **Bản 1 file** Liar's Poker |
| `index.html` / `app.js` / `engine.js` / `bots.js` | Liar's Deck (bản phát triển) |
| `poker.html` / `poker_app.js` / `poker_engine.js` / `poker_bots.js` | Liar's Poker (bản phát triển) |
| `style.css` / `poker.css` | Giao diện quán bar + bàn poker |
| `vendor/mqtt.min.js` | MQTT.js (MIT) — relay tin nhắn qua broker công khai |
| `server.js` | Web server Node.js thuần (cho Wispbyte / Docker / Pterodactyl) |
| `package.json` | Cấu hình khởi động npm / Node |
| `test_engine.js` | Test 3.600 ván Liar's Deck |
| `poker_test.js` | Test evaluator + 1.080 bàn Poker |
| `build_single.py` / `build_poker.py` | Gộp thành file 1 file |

## Chạy Web Server (Local hoặc Wispbyte)

Dự án có sẵn `server.js` (không cần `npm install`, tự động nhận `PORT` từ Wispbyte / Pterodactyl):

```powershell
npm start
# hoặc
node server.js
```

Các route khả dụng:
- `/` hoặc `/deck`: Mở Liar's Deck (`index.html`)
- `/poker`: Mở Liar's Poker (`poker.html`)
- `/health`: Endpoint kiểm tra trạng thái máy chủ (healthcheck)

## Kiểm thử

```powershell
node liars_poker/test_engine.js
node liars_poker/poker_test.js
```

Kết quả mong đợi:
`===== OK: 3600 ván ... =====` và `===== OK: 1080 bàn ... =====`.

## Build lại bản 1 file

```powershell
python liars_poker/build_single.py
python liars_poker/build_poker.py
```

---

## Ghi chú

- Hai game nằm ngoài project Godot **AETHERFALL** (`godot_project/`).
- Chỉ dùng HTML/CSS/JS thuần; dependency ngoài duy nhất là MQTT.js (MIT).
- Online dùng broker MQTT công cộng (HiveMQ) làm relay; host là trọng tài.
  Broker chỉ thấy topic/tin nhắn, không phải server game của bạn.
- Nếu broker công cộng gặp sự cố, chế độ offline vẫn chơi bình thường.
