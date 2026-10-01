# 出門提醒推送伺服器（Cloudflare Worker）

網頁放在 GitHub Pages，只能放靜態檔案。這個 Worker 負責：

1. 接收網頁設定的出門提醒
2. 每分鐘向九巴查詢實時到站時間，自動調整提醒時間
3. 到出門時間時用 Web Push 推送通知，手機鎖機也會收到

Cloudflare 免費計劃已經足夠個人使用。VAPID 推送金鑰會在第一次使用時自動產生並存在 KV，不需要另外設定密鑰。

---

## 部署步驟（用 Cloudflare 網頁介面，不需要電腦指令）

Cloudflare 介面的名稱有時會改動。如果找不到某個按鈕，找意思相近的選項即可。

### 1. 建立帳號
到 https://dash.cloudflare.com/sign-up 免費註冊。

### 2. 建立 Worker
1. 左邊選單 → **Workers & Pages** → **Create** → 選擇 **Hello World** 範本。
2. 名稱填 `kmb-eta-push`，然後按 **Deploy**。
3. 按 **Edit code**，刪除全部範例程式碼，貼上 [`push-worker.js`](push-worker.js) 的全部內容，再按 **Deploy**。

### 3. 建立 KV 儲存空間
1. 左邊選單 → **Storage & Databases** → **KV** → **Create**。
2. 名稱填 `kmb-eta-reminders`。

### 4. 將 KV 連接到 Worker
1. 回到 `kmb-eta-push` Worker → **Settings** → **Bindings** → **Add** → **KV namespace**。
2. **Variable name** 一定要填 `REMINDERS`（全大楷）。
3. **KV namespace** 選擇 `kmb-eta-reminders`，然後儲存。

### 5. 設定每分鐘執行
1. Worker → **Settings** → **Triggers**（或 **Cron Triggers**）→ **Add**。
2. 填入 `* * * * *`（即每分鐘執行一次），然後儲存。

### 6. 檢查是否成功
用瀏覽器打開：

```
https://kmb-eta-push.<你的子網域>.workers.dev/vapid
```

如果看到 `{"publicKey":"B..."}`，就代表設定成功。
如果看到錯誤，通常是第 4 步的 Variable name 不是 `REMINDERS`。

### 7. 把 Worker 網址告訴 Claude
Claude 會把網址填入 `index.html` 的 `PUSH_API`。

---

## iPhone 使用方法

iPhone 的網頁推送有以下限制：

- 需要 **iOS 16.4 或以上**。
- 必須在 Safari 打開網站 → 按 **分享** → **加入主畫面**，然後**從主畫面的圖示打開**。直接在 Safari 裡使用是收不到推送的。
- 第一次在有「預 X 分鐘出門」的站點選一班車時，iPhone 會詢問是否允許通知，請按 **允許**。

設定成功後，那班車旁邊會顯示「🔔 已設推送提醒」。
如果顯示「🔔 已設提醒(要開住網頁)」，代表推送設定失敗，通常是因為沒有從主畫面打開，或者沒有允許通知。

---

## 改用 Bark 推送（可選，通知不會顯示「from ...」）

網頁 app 的推送通知一定會顯示「from 九巴到站」。改用 Bark app 推送，通知就會像原生 app 一樣。

1. 在 App Store 安裝 **Bark**，打開後複製你的網址，例如 `https://api.day.app/abcdEFGH1234/...`，中間那段 `abcdEFGH1234` 就是你的 Key。
2. Cloudflare → `kmb-eta-push` Worker → **Settings** → **Variables and Secrets** → **Add**：
   - **Type** 選 **Secret**
   - **Variable name** 填 `BARK_KEY`
   - **Value** 貼上你的 Key
3. 儲存後，重新貼上最新的 [`push-worker.js`](push-worker.js)，然後按 **Deploy**。
4. 打開 `https://kmb-eta-push.<你的子網域>.workers.dev/vapid`，應該會看到 `"bark":true`。

⚠️ Key 等於你手機的推送地址，**不要**放入網頁程式碼或 GitHub，也不要公開分享。只存在 Cloudflare 的 Secret 裡。

設定 Bark 後，就不需要「加入主畫面」，直接在 Safari 打開網頁也可以設定推送提醒。

Bark 通知會像鬧鐘一樣：鈴聲連續響 30 秒，並使用「重要提醒」，靜音模式和勿擾模式下也會響。第一次收到時，如果 iPhone 詢問是否允許 Bark 發送「重要提醒」，請按 **允許**。

---

## 用指令部署（可選，需要電腦）

```sh
cd server
npx wrangler login
npx wrangler kv namespace create REMINDERS   # 把輸出的 id 填入 wrangler.toml
npx wrangler deploy
```

## 注意事項
- 每部手機同一時間只會有一個提醒，設定新的提醒會取代舊的。
- 通知發出後，或者班車到站兩分鐘後，提醒會自動刪除。
- 如果刪除並重建 KV，VAPID 金鑰會改變，舊的推送訂閱會失效。網頁下次設定提醒時會自動重新訂閱。
