# logos-bot

Slack bot：私訊它要哪個品牌的 logo（格式、顏色、尺寸可用按鈕一步步選），它從 Google
Drive 找出對應檔案，直接上傳回 Slack。跑在 Cloudflare Workers 上，TNL Mediagene
家族已核准的 workspace 可以自助安裝。

## 怎麼用

在 Slack 私訊這個 bot，直接打品牌名稱（例如「TNL」「關鍵評論網」「INSIDE」），依指示
用按鈕選格式／顏色／尺寸，最後答一句用途就會收到檔案。

其他（已核准的）workspace 要安裝，打開：

```
https://logos-bot.thenewslens.workers.dev/slack/install
```

授權一次即可，不需要任何人手動設定 token——所有安裝的 workspace 共用同一份品牌
目錄（這是同一個集團內部自助安裝的設計，不是對外的多租戶產品）。哪些 team id
可以安裝由 `SLACK_ALLOWED_TEAM_IDS` 這個 allowlist 把關（見下方部署章節）——
沒在清單上的 workspace 走完 OAuth 流程也會被拒絕，剛發出的 token 也會立刻撤銷。

## 架構

跑在 **Cloudflare Workers** 上：

| 用途 | 技術 |
|---|---|
| Slack Events / OAuth 安裝 | [`slack-cloudflare-workers`](https://github.com/slack-edge/slack-cloudflare-workers)（`SlackOAuthApp`） |
| 品牌／資產目錄 | **D1**（`src/catalog/d1-catalog-repo.ts`） |
| 多輪對話狀態 | **KV**（`CONVERSATIONS` binding，TTL） |
| 各 workspace 的安裝資訊（bot token） | **KV**（`INSTALLATIONS` binding，`KVInstallationStore`） |
| OAuth 安裝流程的 state 參數（CSRF 防護） | **KV**（`OAUTH_STATES` binding，`KVStateStore`） |
| SVG → PNG 算圖、自訂尺寸 / 底色 | `svg2png-wasm`（純 SVG 合成，不依賴 Cloudflare Images） |
| Google Drive / Vertex 認證 | 純 `fetch` + WebCrypto 自簽 JWT（`src/google-auth.ts`，無 `googleapis` SDK） |

離線的目錄掃描（讀 Google Drive、建立品牌/資產資料）維持跑在 **Node**
（`pnpm scan`），寫本機 SQLite，再用 `pnpm sync:d1:remote` 同步進 D1——Worker
本身完全不碰 Drive 掃描，只在使用者請求時讀 D1 + 下載單一檔案。

完整的遷移過程與設計決策見
[`docs/superpowers/plans/2026-10-01-cloudflare-workers-migration.md`](docs/superpowers/plans/2026-10-01-cloudflare-workers-migration.md)。

### 目錄結構

```
src/
  worker.ts              Worker entrypoint，依路徑分派
  slack-app.ts           SlackOAuthApp 設定、app.message / app.action 註冊
  env.ts                 Worker 的 bindings / vars / secrets 型別
  bot/                   對話流程、品牌比對、算圖後的交付邏輯（Worker 用）
  catalog/               D1 讀取（Worker 用）與 SQLite 讀寫（scan 用）共用的型別/邏輯
  renderer/               svg2png-wasm 算圖（Worker 用）
  scanner/                Drive 掃描、檔案中繼資料推斷（scan 用，Node）
  sync/                   本機 catalog → D1 的資料同步 CLI
  scan.ts                 `pnpm scan` 入口
config/brands.json        品牌別名設定（比對用，隨 Worker 一起部署）
migrations/               D1 schema migrations
```

## 開發

```sh
pnpm install
pnpm dev              # wrangler dev，本機跑 Worker
pnpm test             # vitest
pnpm lint             # eslint
pnpm exec tsc --noEmit        # Node 側 typecheck（scan/sync）
pnpm run typecheck:worker     # Worker 側 typecheck
```

四項（lint、兩個 typecheck、test）都會在每個 PR 上跑 CI
（`.github/workflows/ci.yml`）。

### 跑離線掃描 / 同步到 D1

```sh
cp .env.example .env   # 填 Google service account 路徑 + Drive 資料夾 ID
pnpm scan               # 掃 Drive，寫本機 ./data/catalog.db
pnpm sync:d1:local      # 推進本機 D1（wrangler dev 用）
pnpm sync:d1:remote     # 推進正式 D1
```

細節（為什麼同步是 data-only、冪等、不會動到 `deliveries` 稽核記錄）見
[`migrations/README.md`](migrations/README.md)。

## 部署

```sh
pnpm deploy
```

Worker 需要的 bindings 定義在 `wrangler.jsonc`（D1、三個 KV namespace）。
新 workspace 要能安裝，team id 要先加進 `wrangler.jsonc` 的
`SLACK_ALLOWED_TEAM_IDS`（逗號分隔的非密鑰 var）——留空或沒設等於「全部拒絕」，
不是「全部放行」。Secrets 用 `wrangler secret put <NAME>` 設定，本機開發對照
`.dev.vars.example`：

| Secret | 用途 |
|---|---|
| `SLACK_SIGNING_SECRET` | 驗證 Slack 送來的請求 |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | OAuth 安裝流程（Slack App → Basic Information → App Credentials） |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | 整份 service account JSON，Worker 用它存取 Drive |
| `SLACK_BOT_TOKEN`（選用） | OAuth 安裝後每個 workspace 的 token 存在 `INSTALLATIONS` KV，這個只是手動備援用 |
