import { splitPages, extractPageJpeg } from "./pdf.js";
import { readPage } from "./reader.js";

// ---- 項目定義 ---------------------------------------------------------------
// DBの列名（id / created_at / updated_at 以外）
const FIELDS = [
  "upload_id", "pdf_key", "page_no", "control_no", "sheet_format", "auction_house", "auction_date",
  "auction_round", "lot_no", "maker", "car_name", "grade", "model_code", "year", "first_reg_month",
  "displacement_cc", "fuel", "shift", "mileage_km", "inspection", "color", "color_code", "score",
  "score_exterior", "score_interior", "equipment", "start_price_man", "bid_price_man",
  "planned_price_man", "result", "handwritten_note", "inspector_note", "needs_review",
  "review_reason", "buyer", "member_name", "chassis_no",
];
const INT_FIELDS = new Set(["upload_id", "page_no", "year", "first_reg_month", "displacement_cc", "mileage_km", "needs_review"]);
const REAL_FIELDS = new Set(["start_price_man", "bid_price_man", "planned_price_man"]);
// 画面から編集できる項目
const EDITABLE = FIELDS.filter((f) => !["upload_id", "pdf_key", "page_no"].includes(f));
const SORTABLE = new Set([...FIELDS, "id", "created_at", "updated_at"]);

// バックアップ/取り込み用TSVの見出し ⇔ DB列名
const TSV_MAP = [
  ["file", "pdf_key"], ["page", "page_no"], ["control_no", "control_no"], ["format", "sheet_format"],
  ["house", "auction_house"], ["date", "auction_date"], ["lot", "lot_no"], ["maker", "maker"],
  ["car", "car_name"], ["grade", "grade"], ["model", "model_code"], ["year", "year"],
  ["cc", "displacement_cc"], ["shift", "shift"], ["km", "mileage_km"], ["color", "color"],
  ["color_code", "color_code"], ["score", "score"], ["ext", "score_exterior"], ["int", "score_interior"],
  ["start", "start_price_man"], ["bid", "bid_price_man"], ["plan", "planned_price_man"],
  ["result", "result"], ["member", "member_name"], ["buyer", "buyer"], ["note", "handwritten_note"],
  ["review", "review_reason"], ["inspector", "inspector_note"], ["fuel", "fuel"],
  ["round", "auction_round"], ["first_reg_month", "first_reg_month"], ["equipment", "equipment"], ["chassis", "chassis_no"],
];

// CSV出力の列
const CSV_COLS = [
  ["buyer", "仕入れ担当"], ["auction_date", "開催日"], ["auction_house", "会場"], ["auction_round", "回"],
  ["lot_no", "出品番号"], ["maker", "メーカー"], ["car_name", "車名"], ["grade", "グレード"],
  ["model_code", "型式"], ["chassis_no", "車台番号"], ["year", "年式"], ["first_reg_month", "初度登録月"], ["displacement_cc", "排気量"],
  ["fuel", "燃料"], ["shift", "シフト"], ["mileage_km", "走行(km)"], ["inspection", "車検"],
  ["color", "色"], ["color_code", "カラーNo"], ["score", "評価点"], ["score_exterior", "外装"],
  ["score_interior", "内装"], ["equipment", "装備"], ["start_price_man", "スタート(万円)"],
  ["bid_price_man", "落札金額(万円)"], ["planned_price_man", "予定車両価格(万円)"], ["result", "結果"],
  ["member_name", "会員名"], ["handwritten_note", "手書きメモ"], ["inspector_note", "検査員記入"],
  ["needs_review", "要確認"], ["review_reason", "要確認の理由"], ["pdf_key", "PDF"], ["page_no", "ページ"],
];

// ---- ユーティリティ -----------------------------------------------------------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function normalize(field, v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return INT_FIELDS.has(field) || REAL_FIELDS.has(field) ? (v ? 1 : 0) : String(v);
  if (typeof v === "string") {
    v = v.trim();
    if (v === "") return null;
  }
  if (field === "needs_review") return ["1", "true", "TRUE", "要確認", "○", "yes"].includes(String(v)) || v === 1 ? 1 : 0;
  if (field === "year") {
    // 和暦（R07, H30, 令和7 など）も西暦に直す
    const m = String(v).match(/^(R|H|令和|平成)\s*0*(\d{1,2})/i);
    if (m) return Number(m[2]) + (/^(R|令和)/i.test(m[1]) ? 2018 : 1988);
  }
  if (INT_FIELDS.has(field) || REAL_FIELDS.has(field)) {
    const n = Number(String(v).replace(/[,，\s]/g, ""));
    if (!Number.isFinite(n)) return null;
    return INT_FIELDS.has(field) ? Math.round(n) : n;
  }
  return String(v);
}

function buildWhere(url) {
  const p = url.searchParams;
  const where = [], args = [];
  const like = (v) => `%${v}%`;
  if (p.get("buyer")) { where.push("buyer LIKE ?"); args.push(like(p.get("buyer"))); }
  if (p.get("auction_house")) { where.push("auction_house LIKE ?"); args.push(like(p.get("auction_house"))); }
  if (p.get("q")) {
    // スペース区切りで AND 検索
    for (const w of p.get("q").split(/[\s　]+/).filter(Boolean)) {
      where.push("(car_name LIKE ? OR model_code LIKE ? OR grade LIKE ? OR maker LIKE ? OR color LIKE ? OR handwritten_note LIKE ? OR chassis_no LIKE ?)");
      args.push(...Array(7).fill(like(w)));
    }
  }
  if (p.get("year_from")) { where.push("year >= ?"); args.push(Number(p.get("year_from"))); }
  if (p.get("year_to")) { where.push("year <= ?"); args.push(Number(p.get("year_to"))); }
  if (p.get("date_from")) { where.push("auction_date >= ?"); args.push(p.get("date_from")); }
  if (p.get("date_to")) { where.push("auction_date <= ?"); args.push(p.get("date_to")); }
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
}

function orderBy(url) {
  const sort = url.searchParams.get("sort");
  const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
  if (sort && SORTABLE.has(sort)) return `ORDER BY ${sort} IS NULL, ${sort} ${dir}, id DESC`;
  return "ORDER BY car_name DESC, grade DESC, color DESC, id DESC";
}

async function insertVehicle(db, v) {
  const cols = FIELDS.filter((f) => v[f] !== undefined);
  const stmt = `INSERT INTO vehicles (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
  return db.prepare(stmt).bind(...cols.map((c) => normalize(c, v[c])));
}

// 区切り文字（タブ/カンマ）を自動判定する簡易パーサ（ダブルクォート対応）
function parseDelimited(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = firstLine.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"' && cur === "") q = true;
    else if (c === sep) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const cellOut = (v, sep) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (sep === "\t") return s.replace(/[\t\r\n]+/g, " ");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---- テーブル自動作成（初回アクセス時。D1コンソールでの作業は不要） ----
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS uploads ( id INTEGER PRIMARY KEY AUTOINCREMENT, pdf_key TEXT NOT NULL, filename TEXT, status TEXT, vehicle_count INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE TABLE IF NOT EXISTS vehicles ( id INTEGER PRIMARY KEY AUTOINCREMENT, upload_id INTEGER, pdf_key TEXT, page_no INTEGER, control_no TEXT, sheet_format TEXT, auction_house TEXT, auction_date TEXT, auction_round TEXT, lot_no TEXT, maker TEXT, car_name TEXT, grade TEXT, model_code TEXT, year INTEGER, first_reg_month INTEGER, displacement_cc INTEGER, fuel TEXT, shift TEXT, mileage_km INTEGER, inspection TEXT, color TEXT, color_code TEXT, score TEXT, score_exterior TEXT, score_interior TEXT, equipment TEXT, start_price_man REAL, bid_price_man REAL, planned_price_man REAL, result TEXT, handwritten_note TEXT, inspector_note TEXT, needs_review INTEGER DEFAULT 0, review_reason TEXT, buyer TEXT, member_name TEXT, chassis_no TEXT, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE INDEX IF NOT EXISTS idx_vehicles_car ON vehicles(car_name)",
  "CREATE INDEX IF NOT EXISTS idx_vehicles_date ON vehicles(auction_date)",
  "CREATE INDEX IF NOT EXISTS idx_vehicles_buyer ON vehicles(buyer)",
  "CREATE INDEX IF NOT EXISTS idx_vehicles_upload ON vehicles(upload_id, page_no)",
  "CREATE TABLE IF NOT EXISTS upload_pages ( upload_id INTEGER NOT NULL, page_no INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', reader TEXT, vehicle_count INTEGER, error TEXT, updated_at TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY (upload_id, page_no) )",
];
// 既存のデータベースに後から足した列（すでにある場合のエラーは無視）
const ADDED_COLUMNS = [
  "ALTER TABLE uploads ADD COLUMN pages_total INTEGER",
  "ALTER TABLE vehicles ADD COLUMN chassis_no TEXT",
];
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.batch(SCHEMA.map((q) => db.prepare(q)));
      for (const q of ADDED_COLUMNS) await db.prepare(q).run().catch(() => {});
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---- 認証（APP_PASSWORD を設定した場合のみ） --------------------------------------
function checkAuth(request, env) {
  if (!env.APP_PASSWORD) return null;
  const h = request.headers.get("authorization") || "";
  if (h.startsWith("Basic ")) {
    try {
      const pass = atob(h.slice(6)).split(":").slice(1).join(":");
      if (pass === env.APP_PASSWORD) return null;
    } catch {}
  }
  return new Response("パスワードが必要です", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="shiire-daicho", charset="UTF-8"' },
  });
}

// ---- 読み取り待ちの列（Cloudflare Queues） ----------------------------------------
const pageKey = (uploadId, pageNo) => `pages/${uploadId}/${pageNo}.pdf`;
async function enqueue(env, jobs) {
  for (let i = 0; i < jobs.length; i += 100) {
    await env.READ_QUEUE.sendBatch(jobs.slice(i, i + 100).map((j) => ({ body: { upload_id: j.upload_id, page_no: j.page_no } })));
  }
}

// エラーを日本語の説明に直す（英語のまま画面に出さない）
function japaneseError(e) {
  const msg = String(e?.message || e || "");
  const status = e?.status;
  if (/[ぁ-んァ-ン一-龥]/.test(msg) && !status) return msg; // もともと日本語のもの
  if (status === 401 || /authentication|x-api-key/i.test(msg)) return "APIキーが正しくありません。Cloudflare に登録したキーを確認してください";
  if (/credit balance|billing|payment/i.test(msg)) return "Anthropic の残高が足りません。console.anthropic.com の「Billing」で入金してください";
  if (status === 403) return "このAPIキーでは使えない機能です（権限がありません）";
  if (status === 404 || /model/i.test(msg) && /not.?found/i.test(msg)) return "指定したAIモデルが見つかりません（CLAUDE_MODEL の設定を確認してください）";
  if (status === 413 || /too large|too long/i.test(msg)) return "PDFのページが大きすぎて読み取れません";
  if (status === 429 || /rate.?limit/i.test(msg)) return "AIへの依頼が混み合っています。少し待ってから「失敗分を読み直す」を押してください";
  if (status === 529 || /overloaded/i.test(msg)) return "AIが混雑しています。少し待ってから「失敗分を読み直す」を押してください";
  if (status >= 500) return "AI側で一時的なエラーが起きました。「失敗分を読み直す」を押してください";
  if (/JSON/i.test(msg)) return "AIの返事を読み取れませんでした。「失敗分を読み直す」を押してください";
  if (status === 400) return "AIへの依頼の形に問題がありました（プログラムの不具合です。開発者に連絡してください）";
  if (/fetch|network|timeout|timed out/i.test(msg)) return "通信エラーが起きました。「失敗分を読み直す」を押してください";
  return "読み取り中に予期しないエラーが起きました。「失敗分を読み直す」を押してください";
}

const MAX_ATTEMPTS = 3;
async function processPage(env, msg) {
  const { upload_id, page_no } = msg.body;
  const setPage = (fields) => {
    const cols = Object.keys(fields);
    return env.DB.prepare(`UPDATE upload_pages SET ${cols.map((c) => c + " = ?").join(", ")}, updated_at = datetime('now','localtime') WHERE upload_id = ? AND page_no = ?`)
      .bind(...Object.values(fields), upload_id, page_no).run();
  };
  try {
    const up = await env.DB.prepare("SELECT pdf_key FROM uploads WHERE id = ?").bind(upload_id).first();
    const obj = up && await env.PDFS.get(pageKey(upload_id, page_no));
    if (!obj) { await setPage({ status: "error", error: "ページのファイルが見つかりません" }); return msg.ack(); }
    await setPage({ status: "processing" });
    const { reader, vehicles } = await readPage(env, new Uint8Array(await obj.arrayBuffer()));
    // 読み直しの場合に二重登録しないよう、そのページの分を入れ替える
    const stmts = [env.DB.prepare("DELETE FROM vehicles WHERE upload_id = ? AND page_no = ?").bind(upload_id, page_no)];
    for (const v of vehicles) stmts.push(await insertVehicle(env.DB, { ...v, upload_id, page_no, pdf_key: up.pdf_key }));
    await env.DB.batch(stmts);
    await setPage({ status: "done", reader, vehicle_count: vehicles.length, error: null });
    await env.PDFS.delete(pageKey(upload_id, page_no));
    msg.ack();
  } catch (e) {
    console.error(`upload ${upload_id} p.${page_no}:`, e);
    const ja = japaneseError(e);
    // 400（依頼の形の誤り）は何度やっても同じなので、すぐ失敗にする
    if (msg.attempts >= MAX_ATTEMPTS || e?.status === 400 || e?.status === 401) {
      await setPage({ status: "error", error: ja });
      msg.ack();
    } else {
      await setPage({ status: "queued", error: ja });
      msg.retry({ delaySeconds: 15 * msg.attempts });
    }
  }
}

// ---- ルーティング -------------------------------------------------------------
export default {
  async queue(batch, env) {
    await ensureSchema(env.DB);
    await Promise.all(batch.messages.map((m) => processPage(env, m)));
  },

  async fetch(request, env) {
    const denied = checkAuth(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path.startsWith("/api/")) await ensureSchema(env.DB);

      // 一覧・検索
      if (path === "/api/vehicles" && method === "GET") {
        const w = buildWhere(url);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 5000);
        const offset = Number(url.searchParams.get("offset")) || 0;
        const [{ results }, total] = await Promise.all([
          env.DB.prepare(`SELECT * FROM vehicles ${w.sql} ${orderBy(url)} LIMIT ? OFFSET ?`).bind(...w.args, limit, offset).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM vehicles ${w.sql}`).bind(...w.args).first("n"),
        ]);
        return json({ total, rows: results });
      }

      // 1件 更新 / 削除
      const m = path.match(/^\/api\/vehicles\/(\d+)$/);
      if (m && method === "PUT") {
        const body = await request.json();
        const cols = EDITABLE.filter((f) => f in body);
        if (!cols.length) return json({ error: "更新する項目がありません" }, 400);
        await env.DB.prepare(
          `UPDATE vehicles SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now','localtime') WHERE id = ?`
        ).bind(...cols.map((c) => normalize(c, body[c])), Number(m[1])).run();
        return json({ ok: true });
      }
      if (m && method === "DELETE") {
        await env.DB.prepare("DELETE FROM vehicles WHERE id = ?").bind(Number(m[1])).run();
        return json({ ok: true });
      }

      // PDFアップロード → ページごとに分けて読み取り待ちの列（Queue）に入れる
      if (path === "/api/upload" && method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") return json({ error: "ファイルがありません" }, 400);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let pages;
        try { pages = await splitPages(bytes); }
        catch (e) { return json({ error: "PDFを開けませんでした（" + (e.message || e) + "）" }, 400); }
        if (!pages.length) return json({ error: "ページがありません" }, 400);
        const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID().slice(0, 8)}_${file.name}`;
        await env.PDFS.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
        const up = await env.DB.prepare("INSERT INTO uploads (pdf_key, filename, status, pages_total) VALUES (?, ?, 'processing', ?) RETURNING id")
          .bind(key, file.name, pages.length).first();
        await Promise.all(pages.map((p, i) => env.PDFS.put(pageKey(up.id, i + 1), p, { httpMetadata: { contentType: "application/pdf" } })));
        await env.DB.batch(pages.map((_, i) => env.DB.prepare("INSERT INTO upload_pages (upload_id, page_no) VALUES (?, ?)").bind(up.id, i + 1)));
        await enqueue(env, pages.map((_, i) => ({ upload_id: up.id, page_no: i + 1 })));
        return json({ ok: true, upload_id: up.id, pages: pages.length });
      }

      // 読み取りの進み具合（直近のアップロード）
      if (path === "/api/uploads" && method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT u.id, u.filename, u.created_at, u.pages_total,
            SUM(p.status IN ('queued','processing')) AS pending,
            SUM(p.status = 'done') AS done,
            SUM(p.status = 'error') AS failed,
            SUM(COALESCE(p.vehicle_count, 0)) AS vehicles,
            SUM(p.reader = 'claude') AS by_claude,
            SUM(p.reader = 'workers-ai') AS by_workers_ai,
            MAX(p.updated_at) AS updated_at,
            GROUP_CONCAT(DISTINCT CASE WHEN p.status = 'error' THEN p.error END) AS errors
          FROM uploads u JOIN upload_pages p ON p.upload_id = u.id
          WHERE u.created_at >= datetime('now','localtime','-3 days')
          GROUP BY u.id ORDER BY u.id DESC LIMIT 50`).all();
        return json({ uploads: results, reader: (env.READER || "claude").toLowerCase() });
      }

      // 失敗したページを取り消す（同じPDFを何度も入れてしまったときなど）
      if (path === "/api/uploads/discard" && method === "POST") {
        const { results } = await env.DB.prepare("SELECT upload_id, page_no FROM upload_pages WHERE status = 'error'").all();
        await Promise.all(results.map((r) => env.PDFS.delete(pageKey(r.upload_id, r.page_no))));
        await env.DB.prepare("DELETE FROM upload_pages WHERE status = 'error'").run();
        return json({ ok: true, count: results.length });
      }

      // 失敗したページを読み直す
      if (path === "/api/uploads/retry" && method === "POST") {
        const { results } = await env.DB.prepare("SELECT upload_id, page_no FROM upload_pages WHERE status = 'error'").all();
        if (results.length) {
          await env.DB.prepare("UPDATE upload_pages SET status = 'queued', error = NULL, updated_at = datetime('now','localtime') WHERE status = 'error'").run();
          await enqueue(env, results);
        }
        return json({ ok: true, count: results.length });
      }

      // TSV/CSV 取り込み
      if (path === "/api/import" && method === "POST") {
        const rows = parseDelimited(await request.text());
        if (rows.length < 2) return json({ error: "データ行がありません" }, 400);
        const map = Object.fromEntries(TSV_MAP);
        const header = rows[0].map((h) => {
          h = h.trim();
          return map[h] || (FIELDS.includes(h) ? h : null) || (CSV_COLS.find(([, l]) => l === h) || [])[0] || null;
        });
        const stmts = [];
        for (const r of rows.slice(1)) {
          const v = {};
          header.forEach((f, i) => { if (f && f !== "upload_id") v[f] = r[i]; });
          if (v.review_reason && v.needs_review === undefined) v.needs_review = 1;
          stmts.push(await insertVehicle(env.DB, v));
        }
        for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
        return json({ ok: true, count: stmts.length });
      }

      // 取り込み用PDF保存（ファイル名をそのままキーにする：TSVの file 列と対応）
      if (path === "/api/import-pdf" && method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") return json({ error: "ファイルがありません" }, 400);
        await env.PDFS.put(file.name, file.stream(), { httpMetadata: { contentType: "application/pdf" } });
        return json({ ok: true, pdf_key: file.name });
      }

      // 出品票のページ画像（マウスを乗せたときのプレビュー用）。初回はPDFから取り出してR2に保存する
      const im = path.match(/^\/api\/page-image\/(.+)$/);
      if (im && method === "GET") {
        const key = decodeURIComponent(im[1]);
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const cacheKey = `img/${key}/${page}.jpg`;
        const headers = { "content-type": "image/jpeg", "cache-control": "private, max-age=604800" };
        const cached = await env.PDFS.get(cacheKey);
        if (cached) return new Response(cached.body, { headers });
        const pdf = await env.PDFS.get(key);
        if (!pdf) return new Response("PDFが見つかりません", { status: 404 });
        const jpeg = await extractPageJpeg(new Uint8Array(await pdf.arrayBuffer()), page - 1);
        if (!jpeg) return new Response("このページは画像として取り出せません", { status: 404 });
        await env.PDFS.put(cacheKey, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
        return new Response(jpeg, { headers });
      }

      // PDF表示
      const pm = path.match(/^\/api\/pdf(?:-page)?\/(.+)$/);
      if (pm && method === "GET") {
        const key = decodeURIComponent(pm[1]);
        const obj = await env.PDFS.get(key);
        if (!obj) return new Response("PDFが見つかりません", { status: 404 });
        return new Response(obj.body, {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(key.split("/").pop())}`,
            "cache-control": "private, max-age=3600",
          },
        });
      }

      // CSV出力（Excel向けにBOM付き）
      if (path === "/api/export.csv" && method === "GET") {
        const w = buildWhere(url);
        const { results } = await env.DB.prepare(`SELECT * FROM vehicles ${w.sql} ${orderBy(url)}`).bind(...w.args).all();
        const lines = [CSV_COLS.map(([, l]) => l).join(",")];
        for (const r of results) lines.push(CSV_COLS.map(([k]) => cellOut(r[k], ",")).join(","));
        return new Response("﻿" + lines.join("\r\n"), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="shiire_${new Date().toISOString().slice(0, 10)}.csv"`,
          },
        });
      }

      // バックアップ（取り込み用TSV）
      if (path === "/api/backup.tsv" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM vehicles ORDER BY id").all();
        const lines = [TSV_MAP.map(([h]) => h).join("\t")];
        for (const r of results) {
          lines.push(TSV_MAP.map(([, f]) => {
            if (f === "review_reason" && r.needs_review && !r.review_reason) return "要確認";
            return cellOut(r[f], "\t");
          }).join("\t"));
        }
        return new Response("﻿" + lines.join("\r\n"), {
          headers: {
            "content-type": "text/tab-separated-values; charset=utf-8",
            "content-disposition": `attachment; filename="backup_${new Date().toISOString().slice(0, 10)}.tsv"`,
          },
        });
      }

      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return json({ error: japaneseError(e) }, 500);
    }
  },
};
