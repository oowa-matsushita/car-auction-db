import { splitPages, extractPageJpeg, extractOnePage } from "./pdf.js";
import { readPage } from "./reader.js";
import { json, parseDelimited } from "./util.js";
import { REVIEW_ADDED_COLUMNS, handleReview, loadPriceUnits, fixPriceUnit } from "./review.js";
import { handleNews, refreshNews, summarizeNews } from "./news.js";
import { handleAnalysis } from "./analysis.js";
import { TURNOVER_SCHEMA, TURNOVER_ADDED_COLUMNS, handleTurnover } from "./turnover.js";

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

// 車台番号の比べ方：大文字・小文字、ハイフン、空白の違いは同じとみなす
const normChassis = (v) => (v == null ? "" : String(v).toUpperCase().replace(/[-－ー‐\s　]/g, ""));
const CHASSIS_SQL = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(${col}),'-',''),'－',''),'ー',''),' ',''),'　','')`;
// 伏せ字（*）を含む番号は別の車と区別できないので、重複チェックに使わない
const usableChassis = (n) => n.length >= 5 && !/[*＊]/.test(n);

// 車両を登録する文。車台番号がすでに登録されている車は登録しない（meta.changes が 0 になる）
async function insertVehicle(db, v) {
  const cols = FIELDS.filter((f) => v[f] !== undefined);
  const vals = cols.map((c) => normalize(c, v[c]));
  const n = normChassis(v.chassis_no);
  if (!usableChassis(n)) {
    return db.prepare(`INSERT INTO vehicles (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...vals);
  }
  return db.prepare(
    `INSERT INTO vehicles (${cols.join(",")}) SELECT ${cols.map(() => "?").join(",")}
     WHERE NOT EXISTS (SELECT 1 FROM vehicles WHERE ${CHASSIS_SQL("chassis_no")} = ?)`
  ).bind(...vals, n);
}
const insertedCount = (results) => results.reduce((a, r) => a + (r?.meta?.changes || 0), 0);

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
  "CREATE TABLE IF NOT EXISTS page_rotations ( rot_key TEXT NOT NULL, rot_page INTEGER NOT NULL, rotation INTEGER NOT NULL DEFAULT 0, source TEXT, PRIMARY KEY (rot_key, rot_page) )",
  "CREATE TABLE IF NOT EXISTS ai_usage ( day TEXT PRIMARY KEY, pages INTEGER NOT NULL DEFAULT 0 )",
  "CREATE TABLE IF NOT EXISTS upload_pages ( upload_id INTEGER NOT NULL, page_no INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', reader TEXT, vehicle_count INTEGER, error TEXT, updated_at TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY (upload_id, page_no) )",
];
// 既存のデータベースに後から足した列（すでにある場合のエラーは無視）
const ADDED_COLUMNS = [
  "ALTER TABLE uploads ADD COLUMN pages_total INTEGER",
  "ALTER TABLE vehicles ADD COLUMN chassis_no TEXT",
  "ALTER TABLE upload_pages ADD COLUMN skipped INTEGER",
];
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.batch([...SCHEMA, ...TURNOVER_SCHEMA].map((q) => db.prepare(q)));
      for (const q of [...ADDED_COLUMNS, ...TURNOVER_ADDED_COLUMNS, ...REVIEW_ADDED_COLUMNS]) await db.prepare(q).run().catch(() => {});
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---- 認証（APP_PASSWORD を設定した場合のみ） --------------------------------------
// ---- ログイン（ID とパスワード） ----------------------------------------------------
// パスワードそのものはコードに書かず、「ID:パスワード」の SHA-256 だけを持つ。
// Cloudflare の変数 APP_USER / APP_PASSWORD を設定すると、そちらが優先される。
const LOGIN_HASH = "9e83ac1eaa927a37866e004585232f65538ce92ade417d4a546356b5395f3952"; // matsushita / ****
const SESSION_COOKIE = "mms_session";
async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function loginHash(env) {
  return env.APP_USER && env.APP_PASSWORD ? sha256hex(`${env.APP_USER}:${env.APP_PASSWORD}`) : LOGIN_HASH;
}
const sessionToken = async (env) => sha256hex("mms-session:" + (await loginHash(env)));
async function credentialsOk(env, id, pass) { return (await sha256hex(`${id}:${pass}`)) === (await loginHash(env)); }
function getCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}
const LOGIN_PAGE = (msg = "") => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MMS ログイン</title><style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;
  font-family:system-ui,-apple-system,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif;color:#13234a;
  background:radial-gradient(1200px 700px at 15% 10%,#24407e 0%,transparent 60%),radial-gradient(900px 600px at 90% 90%,#0e7c86 0%,transparent 55%),linear-gradient(160deg,#0b1530 0%,#13234a 55%,#0b1530 100%)}
.orb{position:fixed;border-radius:50%;filter:blur(60px);opacity:.55;animation:float 14s ease-in-out infinite}
.o1{width:380px;height:380px;background:#f26b1d;top:-120px;right:-80px}
.o2{width:320px;height:320px;background:#10b8c4;bottom:-120px;left:-60px;animation-delay:-5s}
.o3{width:200px;height:200px;background:#7c5cff;top:55%;left:58%;animation-delay:-9s;opacity:.35}
@keyframes float{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(30px,-25px) scale(1.08)}}
.grid{position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(circle at 50% 50%,#000 30%,transparent 75%)}
.card{position:relative;width:min(380px,92vw);padding:34px 32px 26px;border-radius:20px;background:rgba(255,255,255,.92);
  box-shadow:0 30px 60px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.4) inset;backdrop-filter:blur(14px);animation:rise .6s cubic-bezier(.2,.8,.2,1)}
@keyframes rise{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:none}}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.mark{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(135deg,#f26b1d,#ff9a3d);box-shadow:0 8px 18px rgba(242,107,29,.45)}
.mark svg{width:26px;height:26px}
h1{margin:0;font-size:28px;letter-spacing:6px;font-weight:800;background:linear-gradient(90deg,#13234a,#24407e);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin:0 0 22px;color:#6b7690;font-size:13px;letter-spacing:.5px}
.f{position:relative;margin-top:14px}
.f svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);width:18px;height:18px;stroke:#8a96b0;fill:none;stroke-width:2;transition:stroke .2s}
.f input{width:100%;font-size:16px;padding:14px 44px 14px 42px;border:1.5px solid #d6dce8;border-radius:12px;background:#f7f9fc;outline:none;transition:all .2s;color:#13234a}
.f input::placeholder{color:#9aa4b8}
.f input:focus{border-color:#f26b1d;background:#fff;box-shadow:0 0 0 4px rgba(242,107,29,.15)}
.f input:focus+svg,.f:focus-within svg{stroke:#f26b1d}
.eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:none;cursor:pointer;padding:6px;color:#8a96b0;font-size:13px}
.eye:hover{color:#13234a}
button.go{margin-top:22px;width:100%;padding:14px;font-size:16px;font-weight:700;letter-spacing:2px;color:#fff;border:0;border-radius:12px;cursor:pointer;
  background:linear-gradient(135deg,#f26b1d,#ff8a3d);box-shadow:0 10px 22px rgba(242,107,29,.4);transition:transform .15s,box-shadow .15s}
button.go:hover{transform:translateY(-1px);box-shadow:0 14px 26px rgba(242,107,29,.5)}
button.go:active{transform:translateY(1px)}
.e{margin-top:14px;min-height:1.2em;font-size:13px;color:#d32f2f;text-align:center;font-weight:600}
.e:not(:empty){animation:shake .35s}
@keyframes shake{0%,100%{transform:none}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
.foot{margin-top:6px;text-align:center;font-size:11px;color:#9aa4b8;letter-spacing:1px}
</style></head><body>
<div class="grid"></div><div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div>
<form class="card" method="post" action="/login">
  <div class="brand"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17h-1a1 1 0 0 1-1-1v-4l2-5h11l3 5h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/><path d="M9.5 17.5h5"/></svg></div><h1>MMS</h1></div>
  <p class="sub">仕入れ・回転率の管理画面にログイン</p>
  <div class="f"><input id="id" name="id" placeholder="ID" autocomplete="username" autofocus required><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg></div>
  <div class="f"><input id="pw" name="pw" type="password" placeholder="パスワード" autocomplete="current-password" required><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
    <button type="button" class="eye" onclick="const p=document.getElementById('pw');p.type=p.type==='password'?'text':'password';this.textContent=p.type==='password'?'表示':'隠す'">表示</button></div>
  <button class="go" type="submit">ログイン</button>
  <div class="e">${msg}</div>
  <div class="foot">© MMS</div>
</form></body></html>`;
// ログインしていなければ、ログイン画面（API は 401）を返す。ログインしていれば null
async function checkAuth(request, env, url) {
  const path = url.pathname;
  if (path === "/login" && request.method === "POST") {
    const f = await request.formData().catch(() => null);
    if (f && (await credentialsOk(env, String(f.get("id") || "").trim(), String(f.get("pw") || "")))) {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${SESSION_COOKIE}=${await sessionToken(env)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` } });
    }
    return new Response(LOGIN_PAGE("IDかパスワードが違います"), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/logout") {
    return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (getCookie(request, SESSION_COOKIE) === (await sessionToken(env))) return path === "/login" ? Response.redirect(new URL("/", url), 303) : null;
  // 取り込み用（curl など）：Basic 認証でも通す
  const h = request.headers.get("authorization") || "";
  if (h.startsWith("Basic ")) {
    try {
      const [id, ...rest] = atob(h.slice(6)).split(":");
      if (await credentialsOk(env, id, rest.join(":"))) return null;
    } catch {}
  }
  if (path.startsWith("/api/")) return new Response(JSON.stringify({ error: "ログインしてください" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
  return new Response(LOGIN_PAGE(), { status: path === "/login" ? 200 : 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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

// ---- Workers AI の無料枠を超えないための 1日の上限 ----------------------------------
// 1日に読み取るページ数を WORKERS_AI_DAILY_PAGES（既定 40）までにし、超えた分は翌日 0:05 に回す
const usesWorkersAI = (env) => ["workers-ai", "hybrid"].includes((env.READER || "claude").toLowerCase());
const dailyLimit = (env) => Math.max(1, Number(env.WORKERS_AI_DAILY_PAGES) || 40);
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
async function takeDailySlot(env) {
  const day = todayJST();
  await env.DB.prepare("INSERT INTO ai_usage (day, pages) VALUES (?, 0) ON CONFLICT(day) DO NOTHING").bind(day).run();
  const r = await env.DB.prepare("UPDATE ai_usage SET pages = pages + 1 WHERE day = ? AND pages < ?").bind(day, dailyLimit(env)).run();
  return (r.meta?.changes || 0) > 0;
}
// 待たせていたページを、その日の上限まで読み取りに回す（毎日 0:05 に実行）
async function releaseWaiting(env) {
  const { results } = await env.DB.prepare("SELECT upload_id, page_no FROM upload_pages WHERE status = 'waiting' ORDER BY upload_id, page_no LIMIT ?")
    .bind(dailyLimit(env)).all();
  if (!results.length) return 0;
  await env.DB.batch(results.map((r) => env.DB.prepare("UPDATE upload_pages SET status = 'queued', error = NULL, updated_at = datetime('now','localtime') WHERE upload_id = ? AND page_no = ?").bind(r.upload_id, r.page_no)));
  await enqueue(env, results);
  return results.length;
}
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
    if (usesWorkersAI(env) && !(await takeDailySlot(env))) {
      await setPage({ status: "waiting", error: `今日の無料枠（${dailyLimit(env)}ページ）を使い切ったため、夜0時過ぎに自動で読み取ります` });
      return msg.ack();
    }
    await setPage({ status: "processing" });
    const { reader, vehicles } = await readPage(env, new Uint8Array(await obj.arrayBuffer()));
    // 読み直しの場合に二重登録しないよう、そのページの分を入れ替える
    const stmts = [env.DB.prepare("DELETE FROM vehicles WHERE upload_id = ? AND page_no = ?").bind(upload_id, page_no)];
    const units = await loadPriceUnits(env.DB);
    for (const v of vehicles) { fixPriceUnit(v, units); stmts.push(await insertVehicle(env.DB, { ...v, upload_id, page_no, pdf_key: up.pdf_key })); }
    const res = await env.DB.batch(stmts);
    const added = insertedCount(res.slice(1));
    await setPage({ status: "done", reader, vehicle_count: added, skipped: vehicles.length - added, error: null });
    // AI が判定したページの向きを保存（手で直した向きがあればそちらを優先して上書きしない）
    const rot = Number(String(vehicles.find((v) => v.page_rotation)?.page_rotation || "").replace(/[^\d]/g, ""));
    if ([90, 180, 270].includes(rot)) {
      await env.DB.prepare("INSERT INTO page_rotations (rot_key, rot_page, rotation, source) VALUES (?, ?, ?, 'ai') ON CONFLICT(rot_key, rot_page) DO NOTHING")
        .bind(up.pdf_key, page_no, rot).run();
    }
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
  async scheduled(event, env) {
    await ensureSchema(env.DB);
    // 毎時：自動車ニュースを取り直す ／ 毎日 0:05：待たせていたページを読み取りに回す
    if (event.cron === "5 15 * * *") await releaseWaiting(env);
    await refreshNews(env).catch(() => {});
    await summarizeNews(env, 15).catch(() => {});
  },

  async queue(batch, env) {
    await ensureSchema(env.DB);
    await Promise.all(batch.messages.map((m) => processPage(env, m)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const denied = await checkAuth(request, env, url);
    if (denied) return denied;

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
          env.DB.prepare(`SELECT vehicles.*, (SELECT rotation FROM page_rotations WHERE rot_key = vehicles.pdf_key AND rot_page = COALESCE(vehicles.page_no, 1)) AS page_rotation FROM vehicles ${w.sql} ${orderBy(url)} LIMIT ? OFFSET ?`).bind(...w.args, limit, offset).all(),
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
        if ("chassis_no" in body) {
          const n = normChassis(body.chassis_no);
          if (usableChassis(n)) {
            const dup = await env.DB.prepare(`SELECT id, car_name, auction_date FROM vehicles WHERE ${CHASSIS_SQL("chassis_no")} = ? AND id <> ?`)
              .bind(n, Number(m[1])).first();
            if (dup) return json({ error: `この車台番号はすでに登録されています（${dup.auction_date || ""} ${dup.car_name || ""}）` }, 409);
          }
        }
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
            SUM(p.status = 'waiting') AS waiting,
            SUM(p.status = 'done') AS done,
            SUM(p.status = 'error') AS failed,
            SUM(COALESCE(p.vehicle_count, 0)) AS vehicles,
            SUM(COALESCE(p.skipped, 0)) AS skipped,
            SUM(p.reader = 'claude') AS by_claude,
            SUM(p.reader = 'workers-ai') AS by_workers_ai,
            MAX(p.updated_at) AS updated_at,
            GROUP_CONCAT(DISTINCT CASE WHEN p.status = 'error' THEN p.error END) AS errors
          FROM uploads u JOIN upload_pages p ON p.upload_id = u.id
          WHERE u.created_at >= datetime('now','localtime','-3 days') OR EXISTS (SELECT 1 FROM upload_pages w WHERE w.upload_id = u.id AND w.status IN ('waiting','queued','processing','error'))
          GROUP BY u.id ORDER BY u.id DESC LIMIT 50`).all();
        const used = usesWorkersAI(env) ? await env.DB.prepare("SELECT pages FROM ai_usage WHERE day = ?").bind(todayJST()).first("pages") : null;
        return json({ uploads: results, reader: (env.READER || "claude").toLowerCase(), daily_limit: usesWorkersAI(env) ? dailyLimit(env) : null, used_today: used || 0 });
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
        const stmts = [], units = await loadPriceUnits(env.DB);
        for (const r of rows.slice(1)) {
          const v = {};
          header.forEach((f, i) => { if (f && f !== "upload_id") v[f] = r[i]; });
          if (v.review_reason && v.needs_review === undefined) v.needs_review = 1;
          fixPriceUnit(v, units);
          stmts.push(await insertVehicle(env.DB, v));
        }
        let added = 0;
        for (let i = 0; i < stmts.length; i += 100) added += insertedCount(await env.DB.batch(stmts.slice(i, i + 100)));
        return json({ ok: true, count: added, skipped: stmts.length - added });
      }

      // 取り込み用PDF保存（ファイル名をそのままキーにする：TSVの file 列と対応）
      if (path === "/api/import-pdf" && method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") return json({ error: "ファイルがありません" }, 400);
        await env.PDFS.put(file.name, file.stream(), { httpMetadata: { contentType: "application/pdf" } });
        return json({ ok: true, pdf_key: file.name });
      }

      // 出品票の向きを保存（画面の ⟲ ⟳ ボタン）
      if (path === "/api/page-rotation" && method === "PUT") {
        const b = await request.json();
        const rot = ((Number(b.rotation) % 360) + 360) % 360;
        if (!b.pdf_key || ![0, 90, 180, 270].includes(rot)) return json({ error: "向きの指定が正しくありません" }, 400);
        await env.DB.prepare("INSERT INTO page_rotations (rot_key, rot_page, rotation, source) VALUES (?, ?, ?, 'manual') ON CONFLICT(rot_key, rot_page) DO UPDATE SET rotation = excluded.rotation, source = 'manual'")
          .bind(b.pdf_key, Math.max(1, Number(b.page_no) || 1), rot).run();
        return json({ ok: true, rotation: rot });
      }

      // 出品票のページ画像（画面下の表示用）。初回はPDFから取り出してR2に保存する
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

      // 1台分（1ページ）だけのPDF。初回はPDFから取り出してR2に保存する
      const pp = path.match(/^\/api\/pdf-page\/(.+)$/);
      if (pp && method === "GET") {
        const key = decodeURIComponent(pp[1]);
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const rot = [90, 180, 270].includes(Number(url.searchParams.get("rot"))) ? Number(url.searchParams.get("rot")) : 0;
        const cacheKey = `pagepdf/${key}/${page}${rot ? "_r" + rot : ""}.pdf`;
        const headers = {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(key.split("/").pop().replace(/\.pdf$/i, "") + `_p${page}.pdf`)}`,
          "cache-control": "private, max-age=604800",
        };
        const cached = await env.PDFS.get(cacheKey);
        if (cached) return new Response(cached.body, { headers });
        const pdf = await env.PDFS.get(key);
        if (!pdf) return new Response("PDFが見つかりません", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        const one = await extractOnePage(new Uint8Array(await pdf.arrayBuffer()), page - 1, rot);
        if (!one) return new Response("そのページはPDFにありません", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        await env.PDFS.put(cacheKey, one, { httpMetadata: { contentType: "application/pdf" } });
        return new Response(one, { headers });
      }

      // PDF表示（全ページ）
      const pm = path.match(/^\/api\/pdf\/(.+)$/);
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

      // 分析（ベータ）・天気データ
      if (path === "/api/analysis" || path === "/api/weather" || path === "/api/target") {
        const res = await handleAnalysis(request, env, url);
        if (res) return res;
      }

      // 自動車ニュース
      if (path === "/api/news") {
        const res = await handleNews(request, env, url, ctx);
        if (res) return res;
      }

      // 確認リスト
      if (path.startsWith("/api/review") || path === "/api/price-units" || path === "/api/crop-regions") {
        const res = await handleReview(request, env, url);
        if (res) return res;
      }

      // 回転率（月初在庫・販売台数）
      if (path.startsWith("/api/turnover") || path.startsWith("/api/inventory") || path.startsWith("/api/sales") || path.startsWith("/api/settings")) {
        const res = await handleTurnover(request, env, url);
        if (res) return res;
      }

      if (path.startsWith("/api/")) return json({ error: "見つかりません" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return json({ error: japaneseError(e) }, 500);
    }
  },
};
