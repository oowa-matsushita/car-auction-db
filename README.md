# 仕入れ台帳（car-auction-db）

中古車オークションの出品票PDFをドロップすると、AI（Claude）が車両情報を読み取って台帳に登録するサイトです。
Cloudflare Workers ＋ D1（データベース）＋ R2（PDF保存）で動きます。

## できること
- 出品票PDFをドロップ → AIが車名・型式・年式・走行・評価点・金額・手書きメモなどを読み取って登録（複数ファイル可）
- 担当者・キーワード・会場・年式・開催日で検索、列見出しクリックで並び替え、列幅はドラッグで変更
- 行をクリックで元のPDFの該当ページを表示、✏️ で編集・削除
- 「予定車両価格 − 落札金額×1.1」を自動計算
- CSV出力（Excel用）、バックアップ（TSV）、TSV/CSV＋PDF の取り込み（他サイトからの移行用）

## 構成
```
public/index.html  画面（ビルド不要）
src/index.js       Worker 本体（/api/* を処理。テーブルは初回アクセス時に自動作成）
schema.sql         テーブル定義（参考）
wrangler.toml      Worker / D1 / R2 の設定
```

## Cloudflare への公開手順（初回のみ）
1. **D1 を作る**：ダッシュボード → ストレージとデータベース → D1 →「データベースを作成」、名前 `car-auction-db`。
   作成後に表示される **データベースID** を `wrangler.toml` の `database_id` に書く。
2. **R2 を作る**：ダッシュボード → R2 →「バケットを作成」、名前 `car-auction-pdfs`。
   （R2 は初回に支払い方法の登録が必要。月10GBまでは無料）
3. **Worker を作る**：Workers & Pages → 作成 → **GitHub からインポート** → このリポジトリを選択（設定は既定のまま）。
   以後、GitHub に push するたびに自動でデプロイされます。
4. **シークレットを設定**：Worker の 設定 → 変数とシークレット → 追加（種類「シークレット」）
   | 名前 | 内容 |
   |---|---|
   | `ANTHROPIC_API_KEY` | https://console.anthropic.com で発行した API キー（PDF読み取りに使用） |
   | `APP_PASSWORD` | サイトのパスワード（設定するとブラウザでパスワードを聞かれます。ユーザー名は何でもOK） |

   任意：`CLAUDE_MODEL`（既定 `claude-opus-5-5`）

## ローカルで動かす
```bash
npm install
cp .dev.vars.example .dev.vars   # API キーなどを書く
npm run dev                      # http://localhost:8787
```

## API
| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/vehicles?buyer=&q=&auction_house=&year_from=&year_to=&date_from=&date_to=&sort=&dir=&limit=` | 一覧・検索 |
| PUT | `/api/vehicles/:id` | 更新 |
| DELETE | `/api/vehicles/:id` | 削除 |
| POST | `/api/upload` | PDF（form の `file`）を AI で読み取って登録 |
| POST | `/api/import` | TSV/CSV 本文を取り込み |
| POST | `/api/import-pdf` | PDF をファイル名のまま保存（TSV の `file` 列と対応） |
| GET | `/api/pdf/:key` | PDF 表示 |
| GET | `/api/export.csv` | CSV 出力（検索条件可） |
| GET | `/api/backup.tsv` | 全件バックアップ |
