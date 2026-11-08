# MMS（car-auction-db）

中古車の仕入れ・在庫を管理するサイトです。上のタブで画面を切り替えます。

- **📋 仕入れ台帳**：オークションの出品票PDFをドロップすると、AIが車両情報を読み取って登録
- **🔄 回転率**：月初在庫CSVと販売データCSVから、月ごとの回転率（その月の販売台数 ÷ 月初在庫）を表示
Cloudflare Workers ＋ D1（データベース）＋ R2（PDF保存）で動きます。

## できること
- 出品票PDFをドロップ → ページごとに分けて裏側（Cloudflare Queues）で並行してAIが読み取り、自動で登録（複数ファイル可・画面を閉じてもOK）
- 読み取りに失敗したページだけ「失敗分を読み直す」でやり直せる
- 読み取りAIは `READER` で切り替え：`claude`（既定・高精度）／`workers-ai`（Cloudflare の AI・安い）／`hybrid`（Workers AI で読み、怪しいページだけ Claude）
- 担当者・キーワード・会場・年式・開催日で検索、列見出しクリックで並び替え、列幅はドラッグで変更
- 行をクリックで元のPDFの該当ページを表示、✏️ で編集・削除
- 「予定車両価格 − 落札金額×1.1」を自動計算
- CSV出力（Excel用）、バックアップ（TSV）、TSV/CSV＋PDF の取り込み（他サイトからの移行用）

## 回転率
- 「🔄 回転率」タブの枠に CSV をドロップ（月初在庫・販売データのどちらでも。見出しで自動判別）
  - **月初在庫CSV**（在庫No・車名・愛称名・…・仕入金額・入庫担当）：ファイル名の年月（例: `202610____.csv`）の月として取り込み。無ければ「月」を選ぶ
  - **販売データCSV**（伝票No・契約日付・車名・車両本体価格…、1台3行）：契約日付の月ごとに数える
- 販売台数は ①手入力 → ②販売データ → ③月初在庫の差（翌月の月初在庫に無い車）の順で使う
- 同じ月を入れ直すと入れ替わる

## 構成
```
public/index.html  画面（ビルド不要）
src/index.js       Worker 本体（/api/* と読み取り列の処理。テーブルは初回アクセス時に自動作成）
src/reader.js      AI 読み取り（Claude / Workers AI の切り替え）
src/pdf.js         PDF のページ分割・画像の取り出し
src/turnover.js    回転率（月初在庫・販売データ）
src/util.js        共通部品
public/turnover.js 回転率の画面とタブ切り替え
schema.sql         テーブル定義（参考）
wrangler.toml      Worker / D1 / R2 の設定
```

## Cloudflare への公開手順（初回のみ）
1. **D1 を作る**：ダッシュボード → ストレージとデータベース → D1 →「データベースを作成」、名前 `car-auction-db`。
   作成後に表示される **データベースID** を `wrangler.toml` の `database_id` に書く。
2. **R2 を作る**：ダッシュボード → R2 →「バケットを作成」、名前 `car-auction-pdfs`。
   （R2 は初回に支払い方法の登録が必要。月10GBまでは無料）
3. **Queue を作る**（有料プラン）：ダッシュボード → ストレージとデータベース → Queues →「キューを作成」、名前 `car-auction-read`。
4. **Worker を作る**：Workers & Pages → 作成 → **GitHub からインポート** → このリポジトリを選択（設定は既定のまま）。
   以後、GitHub に push するたびに自動でデプロイされます。
5. **シークレット・変数を設定**：Worker の 設定 → 変数とシークレット → 追加（種類「シークレット」）
   | 名前 | 内容 |
   |---|---|
   | `ANTHROPIC_API_KEY` | https://console.anthropic.com で発行した API キー（PDF読み取りに使用） |
   | `APP_PASSWORD` | サイトのパスワード（設定するとブラウザでパスワードを聞かれます。ユーザー名は何でもOK） |

   任意（種類「テキスト」）：
   | 名前 | 内容 |
   |---|---|
   | `READER` | `claude`（既定）／`workers-ai`／`hybrid` |
   | `CLAUDE_MODEL` | 既定 `claude-opus-5-5`。安くするなら `claude-sonnet-5-5` や `claude-haiku-5-5` |
   | `CLAUDE_EFFORT` | 既定 `high`。`medium` / `low` にすると安く速くなる |
   | `WORKERS_AI_MODEL` | 既定 `@cf/meta/llama-4-scout-17b-16e-instruct` |

   ※ `workers-ai` はスキャンした PDF（ページが JPEG 画像のもの）のみ対応。読めないページは `hybrid` なら Claude に回ります。

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
| POST | `/api/upload` | PDF（form の `file`）をページに分けて読み取り列へ |
| GET | `/api/uploads` | 読み取りの進み具合（直近3日） |
| POST | `/api/uploads/retry` | 失敗したページを読み直す |
| POST | `/api/import` | TSV/CSV 本文を取り込み |
| POST | `/api/import-pdf` | PDF をファイル名のまま保存（TSV の `file` 列と対応） |
| GET | `/api/pdf/:key` | PDF 表示 |
| GET | `/api/export.csv` | CSV 出力（検索条件可） |
| GET | `/api/backup.tsv` | 全件バックアップ |
