# TZG 商品上架跟進

內部團隊用的上架協作系統。一批約 20 件商品，從原圖、上架、首次審查、指定優化、優化到最終審查，一張全覽表就能看清楚誰領先、誰落後、卡在誰手上、誰被退件幾次。

規格見 [docs/spec-v2.md](docs/spec-v2.md)。

## 技術

- Cloudflare Workers：API 和前端靜態檔
- D1：資料庫，資料表在第一次打開網頁時自動建立，並自動建立預設成員（管理員 1 位，每種身分各 3 位）
- R2：存放原圖和優化截圖
- 前端：純 HTML／CSS／JS，沒有建置步驟
- 時間與責任歸屬的計算放在 `src/worktime.js`、`src/analytics.js`，是純函式，有單元測試

## 部署到 Cloudflare

D1 資料庫 `product-listing-db` 和 R2 儲存空間 `product-listing-photos` 已經建好，`wrangler.toml` 裡的 D1 ID 也已經填好，只剩下面兩步：

1. **連接 GitHub**：Cloudflare 後台 → Workers & Pages → Create → Import a repository → 選這個 repo 的 `main` 分支。Build command 留空，Deploy command 填 `npx wrangler deploy`。
2. **第一次登入**：部署完成後，請**你本人先打開網頁，選「管理員」**，綁定到你的電腦。接著到「設定」把預設名字改成員工的真名，再勾選每個人的身分。

之後每次推送到 `main`，Cloudflare 都會自動重新部署。

## 本機開發

```bash
npm install
npm test      # 時間計算與責任歸屬的單元測試
npm run dev   # http://localhost:8787
```

## 安全性

- 裝置綁定使用隨機 token，存在 HttpOnly cookie 裡，資料庫只存它的雜湊值。
- 還沒綁定的名字，任何拿到網址的人都能點，所以部署後請盡快讓每個人完成第一次登入。
- 一個名字只能綁一台裝置。換裝置、清除 Cookie 或使用無痕模式時，要請管理員重設。
