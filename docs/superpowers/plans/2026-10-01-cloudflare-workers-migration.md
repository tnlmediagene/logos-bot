# logos-bot → Cloudflare Workers 遷移規劃（檔案級）

> 狀態：**規劃中，尚未動任何 code**。
> 日期：2026-10-01
> 參考骨架：`../honyakukonnyaku`（`slack-cloudflare-workers` + KV + `export default { fetch }`）

## 0. 選型結論（已上網查證，無功能犧牲）

| 現況（Node 常駐） | Workers 替代 | 套件 / 綁定 |
|---|---|---|
| `@slack/bolt` Socket Mode | HTTP Events API | `slack-cloudflare-workers` |
| `better-sqlite3` + `fs` schema | Cloudflare **D1**（SQLite） | `wrangler d1` |
| 記憶體 `ConversationStore` (Map) | **KV**（帶 TTL） | KV namespace binding |
| `sharp`（resize + composite 底色） | **Cloudflare Images binding** | `env.IMAGES`（付費） |
| `@resvg/resvg-js`（SVG→PNG 光柵化） | **`svg2png-wasm`**（純 WASM resvg） | npm `svg2png-wasm` |
| `googleapis` service-account auth | **`@sagi.io/workers-jwt`** + `fetch` | WebCrypto JWT → OAuth token |
| Google Drive SDK | 直接 `fetch` Drive REST v3 | — |
| Vertex AI（token 交換用 SDK） | 只換 token provider，REST 主體不動 | — |
| scan CLI（`tsx src/scan.ts`） | **維持離線 script（Node）寫進遠端 D1** | `wrangler d1 execute` / HTTP seed |

### 已知地雷（查證得到，選型已規避）
- **Workers 禁止動態 WASM 編譯**：`WebAssembly.instantiate(bytes)` 會被 runtime 擋。WASM 必須以「模組 import」方式綁定。`svg2png-wasm` 與 CF Images binding 皆已處理，照它們的官方用法即可。
- **Worker 記憶體上限 ~128MB**：大圖光柵化前要有尺寸/大小檢查（現有 `validateDimensions` + `MAX_OUTPUT_SIZE` 已擋）。
- **Worker CPU 時限**：整包 Drive 全量掃描 + 每檔案處理不適合塞進單一 request。→ scan 維持離線。
- **D1 是 async**：`better-sqlite3` 是同步 API，`CatalogRepo` 全數 method 要改 `async`，連帶 `AssetResolver`、`ConversationManager.getNextQuestion`（讀 assets 處）都要 `await` 化。這是最大的機械性改動面。

---

## 1. 分層評估：哪些檔案「幾乎不動」

這些是純邏輯、無 I/O，直接搬到 Workers 專案即可（可能只改 import 副檔名）：

- `src/bot/rule-parser.ts` — 純字串解析，零依賴。**不動。**
- `src/bot/brand-matcher.ts` — 純比對。**不動。**
- `src/bot/request-parser.ts` — 組合上兩者，**不動**（重要：request 時已無 AI 呼叫）。
- `src/bot/labels.ts`、`src/bot/response-builder.ts`、`src/bot/no-match.ts` — 純訊息組裝。**不動**（`no-match.ts` 讀 repo 的部分需 async 化，見下）。
- `src/config/brands-config.ts` 的 `loadBrandConfig` — 改成 build 時把 `config/brands.json` 用 `import brands from "../../config/brands.json"` 直接打包進 bundle（Workers 無 `fs`）。`syncBrandConfig`（寫檔）**只在離線 scan 用**，不進 Worker。

## 2. 需要 async 化的檔案（D1 連鎖反應）

D1 的 `prepare().bind().all()/first()/run()` 全是 Promise，所以：

- `src/catalog/catalog-repo.ts` — **全部 method 改 async**，SQL 字串幾乎原封不動：
  - `better-sqlite3` 的 `@named` 參數 → D1 用 `?` 位置參數 + `.bind(...)`。這是逐句要改的點（named → positional）。
  - `.get()` → `.first()`；`.all()` → `.all()`（回 `{ results }`，取 `.results`）；`.run()` → `.run()`。
  - `db.transaction(...)`（同步）→ D1 的 `env.DB.batch([...])`。用在 `run-scan.ts` 的 `removeAll` 與刪除偵測 → 但那是離線 scan，見第 6 節。
- `src/bot/asset-resolver.ts` — `resolve()` 讀 `repo.findAssets()` → 改 `async resolve()`，內部 `await`。
- `src/bot/conversation.ts` — `getNextQuestion()` 目前同步，但呼叫端已先把 `assets`/`brands` 查好傳入，**本身不碰 DB**，可維持同步。只有呼叫端（handler）要 `await` 查 assets。✅ 影響小。
- `src/bot/no-match.ts` — 若內部呼叫 `repo`，同樣 async 化（需讀檔確認呼叫點）。

## 3. 需要重寫的檔案（平台相依）

### 3.1 `src/db/connection.ts` → 移除
- Workers 不用檔案 DB。D1 binding 由 `env.DB` 提供，schema 用 `wrangler d1 migrations`。
- `initDb`/`migrate` 邏輯 → 轉成 `migrations/0001_init.sql`（複製現有 `schema.sql`）+ `0002_add_source_modified_time.sql`（把 `migrate()` 的 `ALTER TABLE` 落成一條 migration）。

### 3.2 `src/scanner/drive-client.ts` → 重寫為 `fetch` 版
- 拿掉 `googleapis`。改：
  - `listFolder`：`GET https://www.googleapis.com/drive/v3/files?q=...&supportsAllDrives=true&includeItemsFromAllDrives=true`，帶 `Authorization: Bearer <token>`，分頁 `pageToken`。
  - `downloadFile`：`GET .../files/{id}?alt=media&supportsAllDrives=true` → `await res.arrayBuffer()`（Workers 無 `Buffer`，用 `Uint8Array`/`ArrayBuffer`）。
  - token 由新的 `GoogleAuth`（見 3.4）提供，建構子收 `getAccessToken` 而非 service account 字串。
- ⚠️ 全 code base 的 `Buffer` 要換成 `Uint8Array`/`ArrayBuffer`（Workers 無 Node `Buffer`；`nodejs_compat` flag 可部分補，但影像路徑建議用標準型別）。影響 `delivery.ts`、`renderer.ts`、`drive-client.ts`、`file-metadata.ts`。

### 3.3 `src/renderer/renderer.ts` → 重寫算圖後端
- `renderSvgNatural` / `renderCustomSize` 的內部實作換掉：
  - **SVG → PNG**：`svg2png-wasm`（`createSvg2png` 初始化一次，模組 import WASM）。取代 `Resvg`。
  - **resize + 置中 + 底色 canvas**：改用 **CF Images binding** `env.IMAGES.input(bytes).transform({width,height,background,fit}).output()`；或若不啟用 Images，用 `@cf-wasm/photon` 做 resize/composite。
  - `validateDimensions` 純邏輯，**不動**。
  - `paddingRatio` 置中留白邏輯：用 Images 的 `fit: "contain"` + `background` + `gravity` 對應，或先 svg2png 到目標尺寸再 Images pad。細節在實作階段定。
- 決策：**主線用 CF Images binding**（原生、少一個 WASM），SVG 光柵化用 `svg2png-wasm`。備案 `@cf-wasm/photon`（若不想開 Images 付費）。

### 3.4 新增 `src/google-auth.ts`（取代 `googleapis` 的 token 交換）
- 用 `@sagi.io/workers-jwt` 的 GCP service account helper：讀 `env.GOOGLE_SERVICE_ACCOUNT_KEY`（JSON 字串，存 Worker secret）→ 產生 JWT → `POST https://oauth2.googleapis.com/token` 換 access token。
- 兩個 scope 各發一顆 token：`drive.readonly`（Drive）與 `cloud-platform`（Vertex）。可快取到 KV（TTL ~3000s）避免每 request 重簽。
- `src/ai/vertex-provider.ts`：把 `createServiceAccountTokenProvider`（用 `google.auth`）換成注入本檔的 `getAccessToken`。**REST 主體、function-calling 結構完全不動。**

### 3.5 `src/config.ts` → `src/env.ts`
- 拿掉 `dotenv`/`fs`。改成從 `env`（Worker bindings）讀：`SLACK_*`、`GOOGLE_SERVICE_ACCOUNT_KEY`、`DRIVE_ROOT_FOLDER_ID`、`VERTEX_*`、`GEMINI_MODEL`、`MAX_OUTPUT_SIZE`、`AUDIT_NOTIFY_CHANNELS`。
- `resolveServiceAccountKey` 的「檔案路徑 vs 內容」分層 → Workers 只有 secret 字串一種，簡化為直接讀 `env.GOOGLE_SERVICE_ACCOUNT_KEY`。
- secrets 用 `wrangler secret put`；非敏感的用 `wrangler.toml [vars]`。

### 3.6 `src/renderer/cache.ts`（`OutputCache`）→ 選擇性保留
- 現在就沒接上 delivery（見 SETUP_TODO）。Workers 版若要快取算好的 PNG，改存 **R2**（bytes）+ D1/KV（key→R2 path）。**建議先不接**，維持現狀（即時算），跟現在一樣。

## 4. Slack 層重寫

### 4.1 `src/bot/app.ts` → 移除 Bolt
- 不再 `new App({ socketMode })`。改由 `slack-cloudflare-workers` 的 `SlackApp`（bot-token 模式即可，不必像 honyakukonnyaku 走完整 OAuth，除非要多工作區安裝）。

### 4.2 `src/index.ts` → `export default { fetch }`
- 新的進入點：
  1. 每個 request 建立 `SlackApp`，註冊 `message`（DM）事件 + `action`（按鈕）+ `command`（`/logos`）handler。
  2. handler 內用 `env` 建 `CatalogRepo(env.DB)`、`ConversationStore(env.KV_CONVERSATIONS)`、`DriveClient(getAccessToken)`、renderer、`RequestParser`（用打包進來的 brands.json + D1 讀出的 brands 建 `BrandMatcher`）。
  3. `return await app.run(request, ctx)`。
- ⚠️ 開機時「一次載入所有 brands 建 matcher」的模式（現 `index.ts` 註解）在 Workers 每 request 都要重建。可接受（brands 數十筆），或把 matcher 結果快取到 KV。

### 4.3 `src/bot/dm-handler.ts` / `commands.ts` → 改寫成 slack-cloudflare-workers 的 handler 形狀
- 業務邏輯（parse → question → resolve → deliver）幾乎照搬，改動點：
  - `say` / `respond` / `client.files.uploadV2` 換成 `slack-cloudflare-workers` 的對應 API（`context.client`、`context.say`）。檔案上傳走 `files.uploadV2`（純 HTTP，Workers OK）。
  - 所有 `repo.*`、`resolver.resolve` 前面加 `await`。
  - `postProcessing`（先貼「處理中」再刪）保留；Workers 單 request 內 `await` 序列即可，必要時用 `ctx.waitUntil` 讓稽核通知在回應後背景送。

### 4.4 `src/bot/conversation-store.ts` → KV 版
- `get/set/delete` 改 `async`，底層 `env.KV.get(userId, "json")` / `put(userId, JSON, { expirationTtl })` / `delete`。
- TTL 建議 30–60 分鐘（對話逾時自然清掉，取代現在的記憶體易失性）。

### 4.5 `src/bot/audit.ts` / `delivery.ts` → 幾乎不動
- `delivery.ts` 已是 ports 注入設計，**核心邏輯不動**；只需：ports 的 `downloadSource`/`uploadFile` 換 fetch 版、`Buffer` → `Uint8Array`。
- `audit.ts`：`repo.recordDelivery` 加 `await`；Slack 通知用 `ctx.waitUntil` 背景送。

## 5. AI 供應商層

- `src/ai/provider.ts`、`factory.ts` — 介面不動；`factory` 從 `env` 讀而非 `process.env`。
- `src/ai/vertex-provider.ts` — 只換 token provider（見 3.4），REST 不動。
- `src/ai/gemini-provider.ts` / `anthropic-provider.ts` — 純 `fetch`/SDK；request 時**其實用不到**（parser 已 rule-based），只有離線 scan 的 `ai-builder` 會用。→ **AI 供應商整層主要服務離線 scan**，Worker bot 路徑幾乎不呼叫 AI。可考慮 Worker bundle 不打包 AI 層，減小體積。

## 6. scan 的處置（維持離線）

- `src/scan.ts` + `src/scanner/run-scan.ts` + `catalog/*builder*` + `catalog/review-export.ts` + `coverage-report.ts` + `override-repo.ts` **維持 Node 離線執行**（你的機器或 CI）。
- 差別：離線 scan 的輸出目標從本機 `catalog.db` 改成 **遠端 D1**。兩條路擇一：
  - **(a)** 離線仍寫本機 SQLite，然後 `wrangler d1 execute --file dump.sql` / `d1 import` 灌進遠端 D1（最簡單，批次同步）。
  - **(b)** scan 直接透過 D1 HTTP API 寫遠端（較即時，較多改動）。
  - **建議 (a)**：scan 完 dump → import，週期性跑即可。scan 程式幾乎不改。
- 這樣 `run-scan.ts` 的 `db.transaction`、`better-sqlite3` 都留在離線端，**不需 async 化那條路**。

## 7. 新增 / 設定檔

- `wrangler.toml`：
  - `main = "src/index.ts"`、`compatibility_date`、`compatibility_flags = ["nodejs_compat"]`（視 svg2png-wasm/photon 需求）。
  - `[[d1_databases]]` binding `DB`。
  - `[[kv_namespaces]]` binding `KV_CONVERSATIONS`（+ 若做 OAuth 再加 installations/states）。
  - `[images]` binding `IMAGES`（若用 CF Images）。
  - 選用 `[[r2_buckets]]`（若接算圖快取）。
  - `[vars]`：`DRIVE_ROOT_FOLDER_ID`、`AI_PROVIDER`、`VERTEX_*`、`GEMINI_MODEL`、`MAX_OUTPUT_SIZE`、`AUDIT_NOTIFY_CHANNELS`。
- `wrangler secret put`：`SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`、`SLACK_CLIENT_ID/SECRET`（若 OAuth）、`GOOGLE_SERVICE_ACCOUNT_KEY`。
- `migrations/0001_init.sql`、`0002_*.sql`（自 `schema.sql` + `migrate()`）。
- `.dev.vars.sample`（本機 `wrangler dev` 用）。
- `package.json`：移除 `@slack/bolt`、`better-sqlite3`、`sharp`、`@resvg/resvg-js`、`googleapis`、`dotenv`；加 `slack-cloudflare-workers`、`svg2png-wasm`、`@sagi.io/workers-jwt`、`wrangler`（+ 視情況 `@cf-wasm/photon`）。scripts：`dev`→`wrangler dev`、`deploy`→`wrangler deploy`、`scan` 維持 `tsx`（離線）。

## 8. 測試

- 純邏輯測試（`rule-parser`、`brand-matcher`、`conversation`、`asset-resolver`、`response-builder`、`no-match`、`labels`）**大多可留**，只改被 async 化 method 的斷言為 `await`。
- `catalog-repo.test.ts`：從 `better-sqlite3` in-memory 換成 **`vitest` + `@cloudflare/vitest-pool-workers`** 的 D1 測試環境，或抽一個 repo 介面用 fake 實作。
- `renderer.test.ts`：算圖後端換掉，測試改對 `svg2png-wasm` / Images 的行為（或在 Workers pool 內跑）。
- `drive-client.test.ts`、`vertex-provider.test.ts`：mock `fetch`（已是這個方向）。

## 9. 建議實作順序（分階段，每階段可獨立驗證）

1. **鷹架**：新 `wrangler.toml` + D1 migrations + KV binding + `export default { fetch }` 空殼，`wrangler dev` 能起。
2. **DB 層**：`CatalogRepo` async 化 + D1；用 seed 資料在 `wrangler dev` 驗證查詢。
3. **Google auth + Drive fetch**：`google-auth.ts` + `drive-client.ts` 重寫，驗證能列檔/下載。
4. **Slack 骨架**：`slack-cloudflare-workers` 接 `message.im`，先只回 echo，驗證 Events + 簽章。
5. **接上業務邏輯**：parser → conversation(KV) → resolver → 直接下載交付（先不含算圖）。
6. **算圖**：接 `svg2png-wasm` + CF Images，補回自訂尺寸 PNG。
7. **稽核 + 通知**：`audit.ts` 寫 D1 + `ctx.waitUntil` 通知。
8. **scan 同步**：離線 scan → dump → `d1 import` 流程跑通。
9. **測試遷移** + 端到端實測。

## 10. 尚待你定調（不阻塞規劃，但影響實作分支）

1. **算圖後端**：CF Images binding（付費、原生、省事）＝主線建議；或純 `@cf-wasm/photon`（免額外付費、多一個 WASM）。
2. **Slack 安裝模式**：單一工作區 bot token（簡單）＝建議；或多工作區 OAuth（像 honyakukonnyaku，需 installations/states KV）。
3. **scan 同步方式**：(a) dump + `d1 import`（建議）或 (b) scan 直寫遠端 D1。
4. **算圖快取**：先不接（維持即時算）＝建議；或接 R2。
