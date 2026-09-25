# TZG 商品上架跟進

內部團隊用的上架協作系統。商品從「廣告數據表」同步進來，走 開單 → 去背 → 上架 → 優化 → 行銷檢查 五步，一張全覽表看出每件走到哪、哪一步比團隊平均慢、卡在誰手上、被退件幾次。

規格見 [docs/spec-v3.md](docs/spec-v3.md)。

## 技術

- Cloudflare Workers：API 和前端靜態檔
- D1：資料庫，資料表在第一次打開網頁時自動建立，並自動建立預設成員（管理員 1、行銷 2、美編 2、上架 2、設計師 1）
- R2：存放選品照片、去背圖、優化截圖和商品首圖
- Google Apps Script：試算表那一端的讀取程式（`public/apps-script.txt`，系統的「連線設定」會帶入密碼）
- 前端：純 HTML／CSS／JS，沒有建置步驟
- 時間、團隊平均與試算表比對放在 `src/worktime.js`、`src/analytics.js`、`src/sheet.js`，是純函式，有單元測試

## 部署到 Cloudflare

D1 資料庫 `product-listing-db` 和 R2 儲存空間 `product-listing-photos` 已經建好，`wrangler.toml` 裡的 D1 ID 也已經填好，只剩下面兩步：

1. **連接 GitHub**：Cloudflare 後台 → Workers & Pages → Create → Import a repository → 選這個 repo 的 `main` 分支。Build command 留空，Deploy command 填 `npx wrangler deploy`。
2. **第一次登入**：部署完成後，請**你本人先打開網頁，選「管理員」**，綁定到你的電腦。接著到「設定」把預設名字改成員工的真名，再勾選每個人的身分。

3. **接上試算表**：設計師或管理員在「全覽」按「連線設定」，照步驟把程式貼進試算表的 Apps Script 並部署，網址貼回來後按「同步試算表」，再按「同步首圖」。

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
