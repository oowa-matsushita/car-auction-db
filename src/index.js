import Anthropic, { toFile } from "@anthropic-ai/sdk";

// ---- 項目定義 ---------------------------------------------------------------
// DBの列名（id / created_at / updated_at 以外）
const FIELDS = [
  "upload_id", "pdf_key", "page_no", "control_no", "sheet_format", "auction_house", "auction_date",
  "auction_round", "lot_no", "maker", "car_name", "grade", "model_code", "year", "first_reg_month",
  "displacement_cc", "fuel", "shift", "mileage_km", "inspection", "color", "color_code", "score",
  "score_exterior", "score_interior", "equipment", "start_price_man", "bid_price_man",
  "planned_price_man", "result", "handwritten_note", "inspector_note", "needs_review",
  "review_reason", "buyer", "member_name",
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
  ["round", "auction_round"], ["first_reg_month", "first_reg_month"], ["equipment", "equipment"],
];

// CSV出力の列
const CSV_COLS = [
  ["buyer", "仕入れ担当"], ["auction_date", "開催日"], ["auction_house", "会場"], ["auction_round", "回"],
  ["lot_no", "出品番号"], ["maker", "メーカー"], ["car_name", "車名"], ["grade", "グレード"],
  ["model_code", "型式"], ["year", "年式"], ["first_reg_month", "初度登録月"], ["displacement_cc", "排気量"],
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
      where.push("(car_name LIKE ? OR model_code LIKE ? OR grade LIKE ? OR maker LIKE ? OR color LIKE ? OR handwritten_note LIKE ?)");
      args.push(...Array(6).fill(like(w)));
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

// ---- AIによるPDF読み取り --------------------------------------------------------
const nullable = (type) => ({ type: [type, "null"] });
const VEHICLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["vehicles"],
  properties: {
    vehicles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          page_no: { type: "integer", description: "この車両が載っているPDFのページ番号（1始まり）" },
          sheet_format: nullable("string"),
          control_no: nullable("string"),
          auction_house: { ...nullable("string"), description: "会場名 例: USS東京, TAA横浜, CAA中部" },
          auction_date: { ...nullable("string"), description: "開催日 YYYY-MM-DD" },
          auction_round: { ...nullable("string"), description: "開催回" },
          lot_no: { ...nullable("string"), description: "出品番号" },
          maker: nullable("string"),
          car_name: nullable("string"),
          grade: nullable("string"),
          model_code: { ...nullable("string"), description: "型式 例: DBA-ZRR80W" },
          year: { ...nullable("integer"), description: "年式（西暦）。R5→2023, H30→2018" },
          first_reg_month: { ...nullable("integer"), description: "初度登録の月 1-12" },
          displacement_cc: nullable("integer"),
          fuel: nullable("string"),
          shift: { ...nullable("string"), description: "FA, CA, AT, MT, F5 など表記のまま" },
          mileage_km: { ...nullable("integer"), description: "走行距離をkmで。'45千km'なら45000" },
          inspection: { ...nullable("string"), description: "車検 例: R07.05" },
          color: nullable("string"),
          color_code: nullable("string"),
          score: { ...nullable("string"), description: "評価点 例: 4.5, R, RA" },
          score_exterior: nullable("string"),
          score_interior: nullable("string"),
          equipment: { ...nullable("string"), description: "装備をスペース区切りで 例: AC PS PW SR AW" },
          start_price_man: { ...nullable("number"), description: "スタート金額（万円）。千円単位表記なら万円に換算" },
          bid_price_man: { ...nullable("number"), description: "落札金額（万円）" },
          result: { ...nullable("string"), description: "落札/流札/商談 など" },
          member_name: { ...nullable("string"), description: "印字されている会員名" },
          handwritten_note: { ...nullable("string"), description: "手書きの書き込みをすべて文字起こし" },
          inspector_note: { ...nullable("string"), description: "検査員記入欄・注意事項" },
          needs_review: { type: "boolean", description: "読み取りに自信がない項目があれば true" },
          review_reason: nullable("string"),
        },
        required: [
          "page_no", "sheet_format", "control_no", "auction_house", "auction_date", "auction_round", "lot_no",
          "maker", "car_name", "grade", "model_code", "year", "first_reg_month", "displacement_cc", "fuel",
          "shift", "mileage_km", "inspection", "color", "color_code", "score", "score_exterior",
          "score_interior", "equipment", "start_price_man", "bid_price_man", "result", "member_name",
          "handwritten_note", "inspector_note", "needs_review", "review_reason",
        ],
      },
    },
  },
};

const EXTRACT_PROMPT = `添付PDFは日本の中古車オークションの出品票（オークションシート）や落札票です。
PDFに載っているすべての車両を1台ずつ抽出し、指定のJSON形式で返してください。

- 1ページに複数台載っている場合も、すべて別の車両として出力します。
- page_no にはその車両が載っているページ番号（1始まり）を入れます。
- 金額はすべて「万円」単位の数値にします（例: 125,000円 → 12.5、1250千円 → 125）。
- 年式は西暦の整数に換算します（R05/令和5年 → 2023、H30 → 2018）。
- 手書きの書き込み（金額・メモ・印など）は handwritten_note にできるだけそのまま書き起こします。
- 読めない・存在しない項目は null にします。推測で埋めないでください。
- 読み取りに自信がない項目がある車両は needs_review を true にし、review_reason に理由を書きます。`;

async function extractVehicles(env, pdfBytes, filename) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // Files API にアップロード（Worker内でのbase64変換を避ける）。1日で自動削除。
  const uploaded = await client.files.upload({
    file: await toFile(pdfBytes, filename || "sheet.pdf", { type: "application/pdf" }),
    expires_in_seconds: 86400,
  });
  try {
    const stream = client.beta.messages.stream({
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: VEHICLE_SCHEMA },
      },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "file", file_id: uploaded.id } },
          { type: "text", text: EXTRACT_PROMPT },
        ],
      }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("AIがこのPDFの読み取りを拒否しました");
    if (msg.stop_reason === "max_tokens") throw new Error("PDFが大きすぎて読み取りきれませんでした。ページを分割してください");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const data = JSON.parse(text);
    return data.vehicles || [];
  } finally {
    client.files.delete(uploaded.id).catch(() => {});
  }
}

// ---- テーブル自動作成（初回アクセス時。D1コンソールでの作業は不要） ----
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS uploads ( id INTEGER PRIMARY KEY AUTOINCREMENT, pdf_key TEXT NOT NULL, filename TEXT, status TEXT, vehicle_count INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE TABLE IF NOT EXISTS vehicles ( id INTEGER PRIMARY KEY AUTOINCREMENT, upload_id INTEGER, pdf_key TEXT, page_no INTEGER, control_no TEXT, sheet_format TEXT, auction_house TEXT, auction_date TEXT, auction_round TEXT, lot_no TEXT, maker TEXT, car_name TEXT, grade TEXT, model_code TEXT, year INTEGER, first_reg_month INTEGER, displacement_cc INTEGER, fuel TEXT, shift TEXT, mileage_km INTEGER, inspection TEXT, color TEXT, color_code TEXT, score TEXT, score_exterior TEXT, score_interior TEXT, equipment TEXT, start_price_man REAL, bid_price_man REAL, planned_price_man REAL, result TEXT, handwritten_note TEXT, inspector_note TEXT, needs_review INTEGER DEFAULT 0, review_reason TEXT, buyer TEXT, member_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE INDEX IF NOT EXISTS idx_vehicles_car ON vehicles(car_name)",
  "CREATE INDEX IF NOT EXISTS idx_vehicles_date ON vehicles(auction_date)",
  "CREATE INDEX IF NOT EXISTS idx_vehicles_buyer ON vehicles(buyer)",
];
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) schemaReady = db.batch(SCHEMA.map((q) => db.prepare(q))).catch((e) => { schemaReady = null; throw e; });
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

// ---- ルーティング -------------------------------------------------------------
export default {
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

      // PDFアップロード → AIで読み取り → 登録
      if (path === "/api/upload" && method === "POST") {
        if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY が設定されていません" }, 500);
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") return json({ error: "ファイルがありません" }, 400);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID().slice(0, 8)}_${file.name}`;
        await env.PDFS.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
        const up = await env.DB.prepare("INSERT INTO uploads (pdf_key, filename, status) VALUES (?, ?, 'processing') RETURNING id")
          .bind(key, file.name).first();
        try {
          const vehicles = await extractVehicles(env, bytes, file.name);
          const stmts = await Promise.all(vehicles.map((v) => insertVehicle(env.DB, { ...v, upload_id: up.id, pdf_key: key })));
          if (stmts.length) await env.DB.batch(stmts);
          await env.DB.prepare("UPDATE uploads SET status='done', vehicle_count=? WHERE id=?").bind(vehicles.length, up.id).run();
          return json({ ok: true, count: vehicles.length, pdf_key: key });
        } catch (e) {
          await env.DB.prepare("UPDATE uploads SET status='error', error=? WHERE id=?").bind(String(e.message || e), up.id).run();
          throw e;
        }
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
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
