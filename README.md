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

1. **建立 D1 資料庫**：Cloudflare 後台 → Storage & Databases → D1 → Create，名稱填 `product-listing-db`，建好後複製 Database ID。
2. **填入 ID**：把 `wrangler.toml` 裡的 `database_id` 換成剛才複製的 ID。
3. **建立 R2 儲存空間**：R2 → Create bucket，名稱填 `product-listing-photos`。第一次使用 R2 需要綁定付款方式，每月 10GB 以內免費。
4. **連接 GitHub**：Workers & Pages → Create → Import a repository → 選這個 repo。Build command 留空，Deploy command 填 `npx wrangler deploy`。
5. **第一次登入**：部署完成後，請**你本人先打開網頁，選「管理員」**，綁定到你的電腦。接著到「設定」把預設名字改成員工的真名，再勾選每個人的身分。

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
