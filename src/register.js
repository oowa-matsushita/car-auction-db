// 「📝 登録指示」タブ：一等書記官への登録をClaudeに指示するためのCSVを作る。
// 画面ファイル（public/）には手を入れず、index.html を配信するときにタブを差し込む（trackerTab.js と同じ方式）。

const REG_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS register_orders ( vehicle_id INTEGER PRIMARY KEY, copy_source TEXT, status TEXT NOT NULL DEFAULT 'draft', note TEXT, exported_at TEXT, registered_at TEXT, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE TABLE IF NOT EXISTS register_suppliers ( house TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
];
let regSchemaReady = null;
function regEnsure(db) {
  if (!regSchemaReady) {
    regSchemaReady = db.batch(REG_SCHEMA.map((q) => db.prepare(q))).catch((e) => { regSchemaReady = null; throw e; });
  }
  return regSchemaReady;
}

const regJson = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// 価格の計算方法（app_settings に保存）。仕入金額(税抜) = 落札額(万円)×10000×倍率＋加算
// 一等書記官では「金額詳細入力」の原価税抜に入れると、税込の原価総額は自動で計算される
const REG_DEFAULT_SETTINGS = { cost_mult: 1, cost_add: 0, price_mult: 1, price_add: 0 };
async function regSettings(db) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'register_settings'").first().catch(() => null);
  let s = {};
  try { s = row ? JSON.parse(row.value) : {}; } catch {}
  return { ...REG_DEFAULT_SETTINGS, ...s };
}

// 全角カナ → 半角カナ（一等書記官の表記に合わせる）
const KANA_MAP = (() => {
  const full = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォッャュョーガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ・";
  const half = ["ｱ","ｲ","ｳ","ｴ","ｵ","ｶ","ｷ","ｸ","ｹ","ｺ","ｻ","ｼ","ｽ","ｾ","ｿ","ﾀ","ﾁ","ﾂ","ﾃ","ﾄ","ﾅ","ﾆ","ﾇ","ﾈ","ﾉ","ﾊ","ﾋ","ﾌ","ﾍ","ﾎ","ﾏ","ﾐ","ﾑ","ﾒ","ﾓ","ﾔ","ﾕ","ﾖ","ﾗ","ﾘ","ﾙ","ﾚ","ﾛ","ﾜ","ｦ","ﾝ","ｧ","ｨ","ｩ","ｪ","ｫ","ｯ","ｬ","ｭ","ｮ","ｰ",
    "ｶﾞ","ｷﾞ","ｸﾞ","ｹﾞ","ｺﾞ","ｻﾞ","ｼﾞ","ｽﾞ","ｾﾞ","ｿﾞ","ﾀﾞ","ﾁﾞ","ﾂﾞ","ﾃﾞ","ﾄﾞ","ﾊﾞ","ﾋﾞ","ﾌﾞ","ﾍﾞ","ﾎﾞ","ﾊﾟ","ﾋﾟ","ﾌﾟ","ﾍﾟ","ﾎﾟ","ｳﾞ","･"];
  const m = {};
  [...full].forEach((c, i) => { m[c] = half[i]; });
  return m;
})();
const toHalfKana = (s) => (s == null ? "" : [...String(s)].map((c) => KANA_MAP[c] || c).join(""));

const pad2 = (n) => String(n).padStart(2, "0");
// 西暦の年・月 → 令和の「08-02」
function reiwaYM(year, month) {
  if (!year) return "";
  const r = Number(year) - 2018;
  if (!(r >= 1)) return "";
  return month ? `${pad2(r)}-${pad2(month)}` : pad2(r);
}
// "2026-11-21" → "08-11-21"
function reiwaDate(d) {
  const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const r = Number(m[1]) - 2018;
  return r >= 1 ? `${pad2(r)}-${m[2]}-${m[3]}` : "";
}
// "R10.05" → "10-05"
function inspectionYM(v) {
  const m = String(v || "").match(/^R(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : "";
}
const yen = (man, mult, add) => (man == null || man === "" ? "" : String(Math.round(Number(man) * 10000 * Number(mult) + Number(add))));

const REG_CSV_HEAD = ["コピー元在庫番号", "新在庫番号", "出品番号", "車台番号", "年式(令和)", "車検満了日", "走行距離km", "ボディーカラー", "評価点", "装備品", "追加装備", "仕入日", "入庫日", "仕入先", "仕入金額(税抜)", "仕入経費", "予定価格(車両本体)", "車名(確認用)", "グレード(確認用)", "MMSのID"];
const regCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function regRowToCsv(r, s) {
  const supplier = r.supplier_name || r.auction_house || "";
  const d = reiwaDate(r.auction_date);
  return [
    r.copy_source || "", r.control_no || "", r.lot_no || "", r.chassis_no || "",
    reiwaYM(r.year, r.first_reg_month), inspectionYM(r.inspection), r.mileage_km ?? "",
    toHalfKana(r.color), r.score || "", "", "", d, d, supplier,
    yen(r.bid_price_man, s.cost_mult, s.cost_add), "", yen(r.planned_price_man, s.price_mult, s.price_add),
    r.car_name || "", r.grade || "", r.id,
  ].map(regCell).join(",");
}

const REG_SELECT = `SELECT v.id, v.control_no, v.auction_date, v.auction_house, v.lot_no, v.maker, v.car_name, v.grade, v.model_code,
  v.chassis_no, v.year, v.first_reg_month, v.mileage_km, v.inspection, v.color, v.score, v.bid_price_man, v.planned_price_man,
  v.result, v.pdf_key, v.page_no, o.copy_source, COALESCE(o.status, 'none') AS status, o.note, o.exported_at, o.registered_at,
  s.name AS supplier_name
  FROM vehicles v LEFT JOIN register_orders o ON o.vehicle_id = v.id LEFT JOIN register_suppliers s ON s.house = v.auction_house`;

export async function handleRegister(request, env, url) {
  const path = url.pathname, method = request.method, db = env.DB;
  if (!path.startsWith("/api/register")) return null;
  await regEnsure(db);

  // 一覧
  if (path === "/api/register" && method === "GET") {
    const p = url.searchParams, where = [], args = [];
    if (p.get("date_from")) { where.push("v.auction_date >= ?"); args.push(p.get("date_from")); }
    if (p.get("date_to")) { where.push("v.auction_date <= ?"); args.push(p.get("date_to")); }
    if (p.get("status")) {
      const st = p.get("status").split(",");
      where.push(`COALESCE(o.status,'none') IN (${st.map(() => "?").join(",")})`); args.push(...st);
    }
    for (const w of (p.get("q") || "").split(/[\s　]+/).filter(Boolean)) {
      where.push("(v.car_name LIKE ? OR v.grade LIKE ? OR v.control_no LIKE ? OR v.chassis_no LIKE ? OR v.lot_no LIKE ? OR o.copy_source LIKE ?)");
      args.push(...Array(6).fill(`%${w}%`));
    }
    const { results } = await db.prepare(`${REG_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY v.auction_date DESC, v.control_no DESC, v.id DESC LIMIT 1000`).bind(...args).all();
    return regJson({ rows: results, settings: await regSettings(db) });
  }

  // 1台分のコピー元・状態・メモを保存
  const m = path.match(/^\/api\/register\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json();
    const id = Number(m[1]);
    const cur = await db.prepare("SELECT * FROM register_orders WHERE vehicle_id = ?").bind(id).first();
    const copy = "copy_source" in b ? (String(b.copy_source || "").trim().toUpperCase() || null) : cur?.copy_source ?? null;
    let status = "status" in b ? String(b.status) : cur?.status || "draft";
    if (!["draft", "exported", "registered", "skip"].includes(status)) return regJson({ error: "状態の指定が正しくありません" }, 400);
    const note = "note" in b ? (String(b.note || "").trim() || null) : cur?.note ?? null;
    if (!copy && status === "draft" && !note) {
      await db.prepare("DELETE FROM register_orders WHERE vehicle_id = ?").bind(id).run();
      return regJson({ ok: true, status: "none" });
    }
    await db.prepare(`INSERT INTO register_orders (vehicle_id, copy_source, status, note, registered_at) VALUES (?, ?, ?, ?, CASE WHEN ?='registered' THEN datetime('now','localtime') END)
      ON CONFLICT(vehicle_id) DO UPDATE SET copy_source = excluded.copy_source, status = excluded.status, note = excluded.note,
      registered_at = CASE WHEN excluded.status='registered' THEN COALESCE(register_orders.registered_at, datetime('now','localtime')) ELSE register_orders.registered_at END,
      updated_at = datetime('now','localtime')`).bind(id, copy, status, note, status).run();
    return regJson({ ok: true, status });
  }

  // 状態をまとめて変える（登録済みにする など）
  if (path === "/api/register/status" && method === "POST") {
    const b = await request.json();
    const ids = (b.ids || []).map(Number).filter(Boolean);
    if (!ids.length || !["draft", "exported", "registered", "skip"].includes(b.status)) return regJson({ error: "指定が正しくありません" }, 400);
    await db.batch(ids.map((id) => db.prepare(`INSERT INTO register_orders (vehicle_id, status) VALUES (?, ?)
      ON CONFLICT(vehicle_id) DO UPDATE SET status = excluded.status,
      registered_at = CASE WHEN excluded.status='registered' THEN COALESCE(register_orders.registered_at, datetime('now','localtime')) ELSE register_orders.registered_at END,
      updated_at = datetime('now','localtime')`).bind(id, b.status)));
    return regJson({ ok: true, count: ids.length });
  }

  // 登録指示CSV（選んだ車。コピー元が空の車は出さない）。出した車は「指示済み」にする
  if (path === "/api/register/export.csv" && method === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) return regJson({ error: "車を選んでください" }, 400);
    const { results } = await db.prepare(`${REG_SELECT} WHERE v.id IN (${ids.map(() => "?").join(",")}) ORDER BY v.control_no, v.id`).bind(...ids).all();
    const rows = results.filter((r) => r.copy_source);
    if (!rows.length) return regJson({ error: "コピー元在庫番号が入っている車がありません" }, 400);
    const s = await regSettings(db);
    // テストモード：車台番号を TEST-000001 からの連番にする（番号は続きから。状態は変えない）
    if (url.searchParams.get("test") === "1") {
      const last = Number((await db.prepare("SELECT value FROM app_settings WHERE key = 'register_test_seq'").first().catch(() => null))?.value) || 0;
      rows.forEach((r, i) => { r.chassis_no = "TEST-" + String(last + i + 1).padStart(6, "0"); });
      await db.prepare("INSERT INTO app_settings (key, value) VALUES ('register_test_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')").bind(String(last + rows.length)).run();
      const stampT = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
      return new Response("﻿" + [REG_CSV_HEAD.join(","), ...rows.map((r) => regRowToCsv(r, s))].join("\r\n"), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="touroku_shiji_TEST_${stampT}.csv"` },
      });
    }
    const lines = [REG_CSV_HEAD.join(","), ...rows.map((r) => regRowToCsv(r, s))];
    await db.batch(rows.filter((r) => r.status !== "registered").map((r) => db.prepare("UPDATE register_orders SET status = 'exported', exported_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE vehicle_id = ?").bind(r.id)));
    const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return new Response("﻿" + lines.join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="touroku_shiji_${stamp}.csv"` },
    });
  }

  // 仕入先の呼び方の対応表
  if (path === "/api/register/suppliers" && method === "GET") {
    const { results } = await db.prepare(`SELECT h.house, s.name, h.n FROM (SELECT auction_house AS house, COUNT(*) AS n FROM vehicles WHERE auction_house IS NOT NULL GROUP BY auction_house) h
      LEFT JOIN register_suppliers s ON s.house = h.house ORDER BY h.n DESC`).all();
    return regJson({ rows: results });
  }
  if (path === "/api/register/suppliers" && method === "PUT") {
    const b = await request.json();
    const house = String(b.house || "").trim(), name = String(b.name || "").trim();
    if (!house) return regJson({ error: "会場がありません" }, 400);
    if (!name) await db.prepare("DELETE FROM register_suppliers WHERE house = ?").bind(house).run();
    else await db.prepare("INSERT INTO register_suppliers (house, name) VALUES (?, ?) ON CONFLICT(house) DO UPDATE SET name = excluded.name, updated_at = datetime('now','localtime')").bind(house, name).run();
    return regJson({ ok: true });
  }

  // 価格の計算方法
  if (path === "/api/register/settings" && method === "PUT") {
    const b = await request.json();
    const s = {};
    for (const k of Object.keys(REG_DEFAULT_SETTINGS)) {
      const n = Number(b[k]);
      if (!Number.isFinite(n)) return regJson({ error: "数字を入れてください" }, 400);
      s[k] = n;
    }
    await db.prepare("INSERT INTO app_settings (key, value) VALUES ('register_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')").bind(JSON.stringify(s)).run();
    return regJson({ ok: true, settings: s });
  }

  return regJson({ error: "見つかりません" }, 404);
}

// ---- 画面（index.html に差し込む） ---------------------------------------------
const REG_STYLE = `<style>
#tab-register{flex:1;min-height:0;overflow:auto;padding:12px 16px;font-size:13px}
#tab-register .rg-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
#tab-register .rg-bar input,#tab-register .rg-bar select{padding:5px 7px;border:1px solid #c7cfdd;border-radius:6px;font-size:13px}
#tab-register button{padding:6px 12px;border:1px solid #b9c3d6;border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
#tab-register button.rg-main{background:#f26b1d;border-color:#f26b1d;color:#fff;font-weight:700}
#tab-register button:disabled{opacity:.5;cursor:default}
#tab-register table{border-collapse:collapse;width:100%;background:#fff}
#tab-register th,#tab-register td{border:1px solid #dde3ee;padding:4px 6px;white-space:nowrap;text-align:left}
#tab-register th{background:#13234a;color:#fff;position:sticky;top:0;z-index:1}
#tab-register td.num{text-align:right}
#tab-register input.rg-src{width:110px;padding:3px 5px;border:1px solid #c7cfdd;border-radius:4px;font-family:monospace;text-transform:uppercase}
#tab-register input.rg-src.ok{background:#fff6ec;border-color:#f26b1d}
#tab-register .st{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px}
#tab-register .st-none{background:#eef1f6;color:#6b7690}
#tab-register .st-draft{background:#fff1e0;color:#b25300}
#tab-register .st-exported{background:#e3effd;color:#1f5fb4}
#tab-register .st-registered{background:#e2f6e9;color:#17803d}
#tab-register .st-skip{background:#f3f3f3;color:#999}
#tab-register details{margin:10px 0;background:#fff;border:1px solid #dde3ee;border-radius:8px;padding:8px 12px}
#tab-register details summary{cursor:pointer;font-weight:700}
#tab-register .rg-help{color:#6b7690;font-size:12px;margin:4px 0 10px}
#tab-register .rg-sup td input{width:160px}
</style>`;

const REG_BUTTON = `<button data-tab="register">📝 登録指示</button>`;

const REG_SECTION = `<section class="tab" id="tab-register" hidden>
  <div class="rg-help">一等書記官に登録したい車に<b>コピー元在庫番号</b>を入れ、チェックして「CSVを出す」。そのCSVをClaudeに渡すと、引用新規で登録します。空欄の項目はコピー元のまま残ります。</div>
  <div class="rg-bar">
    開催日 <input type="date" id="rgFrom"> ～ <input type="date" id="rgTo">
    <select id="rgStatus">
      <option value="none,draft,exported">未登録すべて</option>
      <option value="none">未入力</option>
      <option value="draft">コピー元入力済み</option>
      <option value="exported">指示済み</option>
      <option value="registered">登録済み</option>
      <option value="skip">対象外</option>
      <option value="">すべて</option>
    </select>
    <input id="rgQ" placeholder="車名・在庫番号・車台番号" size="22">
    <button id="rgLoad">表示</button>
    <span style="flex:1"></span>
    <span id="rgCount"></span>
    <button id="rgDone">選んだ車を登録済みに</button>
    <button id="rgSkip">対象外に</button>
    <button class="rg-main" id="rgExport">選んだ車のCSVを出す</button>
    <button id="rgExportTest" title="車台番号を TEST-000001 からの連番にしたCSV。状態は変わりません" style="border-color:#7c5cff;color:#5a3fd6;font-weight:700">🧪 テストモード</button>
  </div>
  <table><thead><tr>
    <th><input type="checkbox" id="rgAll"></th><th>状態</th><th>コピー元在庫番号</th><th>新在庫番号</th><th>開催日</th><th>会場→仕入先</th><th>出品番号</th>
    <th>車名</th><th>グレード</th><th>型式</th><th>車台番号</th><th>年式</th><th>走行km</th><th>車検</th><th>色</th><th>評価</th><th>落札(万)</th><th>予定(万)</th><th>メモ</th>
  </tr></thead><tbody id="rgBody"></tbody></table>
  <details id="rgSettings"><summary>価格の計算方法</summary>
    <div class="rg-help">仕入金額(税抜) ＝ 落札額(万円)×10000×倍率＋加算（一等書記官の「原価税抜」に入れる値）／ 予定価格 ＝ 予定車両価格(万円)×10000×倍率＋加算</div>
    仕入金額：倍率 <input id="rgCm" size="5"> 加算 <input id="rgCa" size="8">
    予定価格：倍率 <input id="rgPm" size="5"> 加算 <input id="rgPa" size="8">
    <button id="rgSaveSet">保存</button>
  </details>
  <details id="rgSup"><summary>仕入先の呼び方（MMSの会場名 → 一等書記官の仕入先名）</summary>
    <div class="rg-help">空欄なら会場名のまま出します。</div>
    <table class="rg-sup"><thead><tr><th>会場（MMS）</th><th>台数</th><th>一等書記官の仕入先名</th></tr></thead><tbody id="rgSupBody"></tbody></table>
  </details>
</section>`;

const REG_SCRIPT = `<script>
(function () {
  if (typeof TABS === "undefined" || typeof showTab !== "function") return;
  TABS.push("register");
  var loaded = false;
  var orig = showTab;
  showTab = function (name) { orig(name); if (name === "register" && !loaded) { loaded = true; init(); } };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return s == null ? "" : String(s).replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]; }); };
  var LABEL = { none: "未入力", draft: "コピー元入力済み", exported: "指示済み", registered: "登録済み", skip: "対象外" };
  var rows = [];
  function api(path, opt) {
    return fetch(path, opt).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function put(path, body) { return api(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  function ymd(d) { return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
  function init() {
    var now = new Date();
    $("rgFrom").value = ymd(new Date(now.getTime() - 14 * 86400000));
    $("rgTo").value = ymd(now);
    $("rgLoad").onclick = load;
    $("rgQ").onkeydown = function (e) { if (e.key === "Enter") load(); };
    $("rgStatus").onchange = load;
    $("rgAll").onchange = function () { document.querySelectorAll("#rgBody .rg-chk").forEach(function (c) { c.checked = $("rgAll").checked; }); count(); };
    $("rgExport").onclick = function () { exportCsv(false); };
    $("rgExportTest").onclick = function () { exportCsv(true); };
    $("rgDone").onclick = function () { bulk("registered"); };
    $("rgSkip").onclick = function () { bulk("skip"); };
    $("rgSaveSet").onclick = saveSettings;
    $("rgSup").addEventListener("toggle", function () { if ($("rgSup").open) loadSup(); });
    load();
  }
  function load() {
    var q = new URLSearchParams({ date_from: $("rgFrom").value, date_to: $("rgTo").value, status: $("rgStatus").value, q: $("rgQ").value });
    api("/api/register?" + q).then(function (j) {
      rows = j.rows;
      var s = j.settings; $("rgCm").value = s.cost_mult; $("rgCa").value = s.cost_add; $("rgPm").value = s.price_mult; $("rgPa").value = s.price_add;
      render();
    }).catch(function (e) { alert("読み込めませんでした：" + e.message); });
  }
  function render() {
    $("rgAll").checked = false;
    $("rgBody").innerHTML = rows.map(function (r) {
      var yr = r.year ? ("R" + String(r.year - 2018).padStart(2, "0") + (r.first_reg_month ? "." + String(r.first_reg_month).padStart(2, "0") : "")) : "";
      return "<tr data-id='" + r.id + "'>" +
        "<td><input type='checkbox' class='rg-chk'></td>" +
        "<td><span class='st st-" + r.status + "'>" + LABEL[r.status] + "</span></td>" +
        "<td><input class='rg-src" + (r.copy_source ? " ok" : "") + "' value='" + esc(r.copy_source) + "' placeholder='Z26-xxxx-xx'></td>" +
        "<td>" + esc(r.control_no) + "</td><td>" + esc(r.auction_date) + "</td>" +
        "<td>" + esc(r.auction_house) + (r.supplier_name ? " → " + esc(r.supplier_name) : "") + "</td>" +
        "<td>" + esc(r.lot_no) + "</td><td>" + esc(r.car_name) + "</td><td>" + esc(r.grade) + "</td><td>" + esc(r.model_code) + "</td>" +
        "<td>" + esc(r.chassis_no) + "</td><td>" + yr + "</td><td class='num'>" + esc(r.mileage_km) + "</td><td>" + esc(r.inspection) + "</td>" +
        "<td>" + esc(r.color) + "</td><td>" + esc(r.score) + "</td><td class='num'>" + esc(r.bid_price_man) + "</td><td class='num'>" + esc(r.planned_price_man) + "</td>" +
        "<td><input class='rg-note' value='" + esc(r.note) + "' size='14'></td></tr>";
    }).join("") || "<tr><td colspan='19'>該当する車がありません</td></tr>";
    document.querySelectorAll("#rgBody .rg-src").forEach(function (inp) {
      inp.onchange = function () { save(inp, { copy_source: inp.value }); };
    });
    document.querySelectorAll("#rgBody .rg-note").forEach(function (inp) {
      inp.onchange = function () { save(inp, { note: inp.value }); };
    });
    document.querySelectorAll("#rgBody .rg-chk").forEach(function (c) { c.onchange = count; });
    count();
  }
  function rowOf(el) { var tr = el.closest("tr"); var id = Number(tr.dataset.id); return { tr: tr, id: id, r: rows.find(function (x) { return x.id === id; }) }; }
  function save(inp, body) {
    var o = rowOf(inp);
    if ("copy_source" in body) inp.value = inp.value.trim().toUpperCase();
    put("/api/register/" + o.id, body).then(function (j) {
      if ("copy_source" in body) { o.r.copy_source = inp.value; inp.classList.toggle("ok", !!inp.value); }
      o.r.status = j.status;
      var st = o.tr.querySelector(".st"); st.className = "st st-" + j.status; st.textContent = LABEL[j.status];
    }).catch(function (e) { alert("保存できませんでした：" + e.message); });
  }
  function selected() { return Array.prototype.map.call(document.querySelectorAll("#rgBody .rg-chk:checked"), function (c) { return Number(c.closest("tr").dataset.id); }); }
  function count() { var n = selected().length; $("rgCount").textContent = n ? n + "台選択" : ""; }
  function exportCsv(test) {
    var ids = selected();
    if (!ids.length) return alert("車を選んでください");
    var noSrc = ids.filter(function (id) { var r = rows.find(function (x) { return x.id === id; }); return !r.copy_source; }).length;
    if (noSrc && !confirm("コピー元在庫番号が空の車が " + noSrc + " 台あります。その車はCSVに入りません。続けますか？")) return;
    if (test && !confirm("テストモード：車台番号を TEST-000001 からの連番にしたCSVを出します（状態は変わりません）。")) return;
    fetch("/api/register/export.csv?ids=" + ids.join(",") + (test ? "&test=1" : "")).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error); });
      var name = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/);
      return r.blob().then(function (b) {
        var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name ? name[1] : "touroku_shiji.csv"; a.click();
        setTimeout(load, 500);
      });
    }).catch(function (e) { alert("CSVを出せませんでした：" + e.message); });
  }
  function bulk(status) {
    var ids = selected();
    if (!ids.length) return alert("車を選んでください");
    if (!confirm(ids.length + "台を「" + LABEL[status] + "」にします。よろしいですか？")) return;
    api("/api/register/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids, status: status }) }).then(load)
      .catch(function (e) { alert("変更できませんでした：" + e.message); });
  }
  function saveSettings() {
    put("/api/register/settings", { cost_mult: $("rgCm").value, cost_add: $("rgCa").value, price_mult: $("rgPm").value, price_add: $("rgPa").value })
      .then(function () { alert("保存しました"); }).catch(function (e) { alert("保存できませんでした：" + e.message); });
  }
  function loadSup() {
    api("/api/register/suppliers").then(function (j) {
      $("rgSupBody").innerHTML = j.rows.map(function (r) {
        return "<tr><td>" + esc(r.house) + "</td><td class='num'>" + r.n + "</td><td><input data-house='" + esc(r.house) + "' value='" + esc(r.name) + "'></td></tr>";
      }).join("");
      document.querySelectorAll("#rgSupBody input").forEach(function (inp) {
        inp.onchange = function () { put("/api/register/suppliers", { house: inp.dataset.house, name: inp.value }).catch(function (e) { alert("保存できませんでした：" + e.message); }); };
      });
    });
  }
  if (window.__mmsInitHash === "#register") showTab("register");
})();
</script>`;

export function withRegisterTab(res) {
  return new HTMLRewriter()
    .on("head", { element(e) { e.append(REG_STYLE, { html: true }); } })
    .on('button[data-tab="review"]', { element(e) { e.after(REG_BUTTON, { html: true }); } })
    .on("section#tab-turnover", { element(e) { e.before(REG_SECTION, { html: true }); } })
    .on('script[src="turnover.js"]', { element(e) { e.after(REG_SCRIPT, { html: true }); } })
    .transform(res);
}
