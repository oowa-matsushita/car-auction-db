import { json, parseDelimited } from "./util.js";

// ---- 回転率（月初在庫 と 販売台数） ---------------------------------------------
// 回転率 = その月の販売台数 ÷ 月初在庫
// 販売台数は販売データCSV（契約日付の月で数える）の台数

// 後から足した列（すでにある場合のエラーは無視される）
export const TURNOVER_ADDED_COLUMNS = [
  "ALTER TABLE sales_items ADD COLUMN stock_no TEXT",
  "ALTER TABLE sales_items ADD COLUMN chassis_no TEXT",
  "ALTER TABLE sales_items ADD COLUMN customer TEXT",
  "ALTER TABLE sales_items ADD COLUMN channel TEXT",
  "ALTER TABLE sales_items ADD COLUMN cost INTEGER",
  "ALTER TABLE inv_items ADD COLUMN grade TEXT",
];

export const TURNOVER_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS inv_months ( month TEXT PRIMARY KEY, filename TEXT, item_count INTEGER, uploaded_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE TABLE IF NOT EXISTS inv_items ( month TEXT NOT NULL, stock_no TEXT, maker TEXT, car_name TEXT, first_reg TEXT, inspection_expiry TEXT, color TEXT, mileage_km INTEGER, model_code TEXT, chassis_no TEXT, planned_price INTEGER, cost INTEGER, staff TEXT )",
  "CREATE INDEX IF NOT EXISTS idx_inv_items_stock ON inv_items(month, stock_no)",
  "CREATE INDEX IF NOT EXISTS idx_inv_items_chassis ON inv_items(month, chassis_no)",
  "CREATE TABLE IF NOT EXISTS sales_items ( month TEXT NOT NULL, slip_no TEXT, contract_date TEXT, delivery_date TEXT, car_name TEXT, price INTEGER, discount INTEGER, sales_amount INTEGER, filename TEXT, stock_no TEXT, chassis_no TEXT )",
  "CREATE INDEX IF NOT EXISTS idx_sales_items_month ON sales_items(month)",
  "CREATE TABLE IF NOT EXISTS app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
];

// CSV の見出し → 保存する列
const HEADER_MAP = {
  "在庫No": "stock_no", "在庫NO": "stock_no", "在庫番号": "stock_no",
  "車名": "maker", "メーカー": "maker",
  "愛称名": "car_name",
  "初度": "first_reg", "初度登録": "first_reg",
  "満了日": "inspection_expiry", "車検満了日": "inspection_expiry",
  "色": "color",
  "走行距離": "mileage_km",
  "型式": "model_code",
  "車台番号": "chassis_no",
  "予定売価本体予定": "planned_price", "予定売価": "planned_price",
  "仕入金額": "cost",
  "入庫担当": "staff",
  "グレード": "grade",
};
const COLS = ["stock_no", "maker", "car_name", "first_reg", "inspection_expiry", "color", "mileage_km", "model_code", "chassis_no", "planned_price", "cost", "staff", "grade"];
const NUM = new Set(["mileage_km", "planned_price", "cost"]);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// 「令和08年10月10日」「2026/10/10」などを 2026-10-10 に直す
function toDate(s) {
  s = clean(s);
  let m = s.match(/^(令和|平成|R|H)\s*0*(\d{1,2})年\s*0*(\d{1,2})月\s*0*(\d{1,2})日?/i);
  if (m) {
    const y = Number(m[2]) + (/^(令和|R)/i.test(m[1]) ? 2018 : 1988);
    return `${y}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})[\/\-年]\s*(\d{1,2})[\/\-月]\s*(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}
const toInt = (x) => {
  const n = Number(String(x ?? "").replace(/[,円\s]/g, ""));
  return String(x ?? "").trim() === "" || !Number.isFinite(n) ? null : Math.round(n);
};

// 販売データCSV（1台が複数行。見出しも同じ行数）。例：
//   見出し1行目: 伝票No, 契約日付, 車名, 車両本体価格, …
//   見出し2行目:       , 納車日,     , 車両本体値引, …
//   見出し3行目:       ,       ,     , 売上高, …
// 見出しの「何行目の何列目か」を覚えて、各車の同じ位置から値を取る。
// 在庫No・車台番号の列があれば、月初在庫や仕入れ台帳とつなぐのに使う。
const SALES_FIELDS = {
  slip_no: ["伝票No", "伝票NO", "伝票番号"],
  contract_date: ["契約日付", "契約日", "日付"],
  delivery_date: ["納車日", "納車日付"],
  car_name: ["愛称名", "車名"], // 新しい形式では「車名」はメーカー名なので「愛称名」を優先
  price: ["車両本体価格", "車輛本体価格", "本体価格"],
  customer: ["顧客名"],
  fees: ["販売諸費用計"],
  cost: ["本体価格原価", "車輌本体原価", "車両本体原価"],
  discount: ["車両本体値引", "値引"],
  sales_amount: ["売上高"],
  stock_no: ["在庫No", "在庫NO", "在庫番号"],
  chassis_no: ["車台番号"],
};
// ---- 販売の区分（小売 / 業販 / 数えない） ----
// 顧客名で決める。名前はスペースを除いて比べる。
const SALES_RULES = {
  exclude: ["(株)USS静岡", "株式会社ジェイボーイ", "国際オートパーツ株式会社"], // 数えない
  wholesale: ["株式会社オートサーバー", "株式会社オークネット"],                // 業販
  retail: ["神戸晋也"],                                                        // 諸費用0円でも小売にする
};
const nameKey = (v) => clean(v).replace(/\s/g, "");
export function salesChannel(r) {
  const c = nameKey(r.customer);
  if (!c) return null; // 顧客名の無い古い形式は区分なし（すべて数える）
  if (SALES_RULES.exclude.map(nameKey).includes(c)) return "exclude";
  if (SALES_RULES.retail.map(nameKey).includes(c)) return "retail";
  if (SALES_RULES.wholesale.map(nameKey).includes(c)) return "wholesale";
  if (r.fees === 0) return "wholesale"; // 販売諸費用0円＝業者向け
  return "retail";
}
// 回転率で数える販売の条件（ch: all=小売+業販 / retail / wholesale）
// 台粗利 ＝ 本体価格（税抜）− 本体原価 − 1台あたりの経費（陸送など 税込3.3万円 ＝ 税抜3万円）
export const GROSS_EXPENSE_IN = 33000, GROSS_EXPENSE_EX = 30000;
export const grossSql = (tax) => (tax === "in" ? `(price - cost - ${GROSS_EXPENSE_IN})` : `(ROUND(price / 1.1) - cost - ${GROSS_EXPENSE_EX})`);
export const grossOf = (r, tax) => (r.cost && r.price != null ? (tax === "in" ? r.price - r.cost - GROSS_EXPENSE_IN : Math.round(r.price / 1.1) - r.cost - GROSS_EXPENSE_EX) : null);
export function channelSql(ch) {
  if (ch === "retail") return "AND COALESCE(channel,'retail') = 'retail'";
  if (ch === "wholesale") return "AND channel = 'wholesale'";
  return "AND COALESCE(channel,'') <> 'exclude'";
}

function parseSales(rows) {
  const iNo = rows[0].map(clean).findIndex((h) => SALES_FIELDS.slip_no.includes(h));
  const iDate = rows[0].map(clean).findIndex((h) => SALES_FIELDS.contract_date.includes(h));
  const isStart = (r) => clean(r[iNo]) && toDate(r[iDate]);
  let hdrN = rows.findIndex((r, i) => i > 0 && isStart(r));
  if (hdrN < 1) return [];
  const pos = {};
  for (let ri = 0; ri < hdrN; ri++) {
    rows[ri].forEach((h, ci) => {
      h = clean(h);
      for (const [f, names] of Object.entries(SALES_FIELDS)) {
        const rank = names.indexOf(h);
        if (rank >= 0 && (!pos[f] || rank < pos[f][2])) pos[f] = [ri, ci, rank];
      }
    });
  }
  const recs = [];
  for (let i = hdrN; i < rows.length; i++) {
    if (!isStart(rows[i])) continue;
    const block = rows.slice(i, i + hdrN);
    const get = (f) => (pos[f] && block[pos[f][0]] ? block[pos[f][0]][pos[f][1]] : "");
    recs.push({
      slip_no: clean(get("slip_no")), contract_date: toDate(get("contract_date")), delivery_date: toDate(get("delivery_date")),
      car_name: clean(get("car_name")), price: toInt(get("price")), discount: toInt(get("discount")), sales_amount: toInt(get("sales_amount")),
      stock_no: clean(get("stock_no")), chassis_no: clean(get("chassis_no")),
      customer: clean(get("customer")), fees: pos.fees ? toInt(get("fees")) : null,
      cost: pos.cost ? toInt(get("cost")) || null : null,
    });
  }
  return recs;
}
// 半角カナ → 全角などの表記ゆれをそろえる
const clean = (v) => String(v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

// ---- 車名のまとめ方 ----
// 例: N-BOX / N-BOX新型 / N-BOXカスタム / N-BOXカスタム新型 → N-BOX
//     スペーシアカスタム新型 → スペーシア、N-VANe: → N-VAN、ハリアーPHEV → ハリアー
// 車名の後ろのメモ（▼書類10/6送、■本店陸送、●代車… など）は取り除く
// シリーズでまとめる車（例: CX-3 / CX-5 / CX-60 → CXシリーズ、N-BOXジョイ → N-BOX）
const MODEL_SERIES = [
  { re: /^CX\s*[-ー－‐]?\s*\d/i, name: "CXシリーズ" },
  { re: /^N\s*[-ー－‐]?\s*BOX/i, name: "N-BOX" }, // N-BOX・カスタム・新型・ジョイ・スラッシュなど
];
const MODEL_SUFFIXES = ["新型", "旧型", "カスタム", "ハイブリッド", "スティングレー", "ハイウェイスター", "+スタイル", "PHEV", "PHV", "HV", "EV", "e:", "+"];
export function modelName(name) {
  let s = String(name ?? "").normalize("NFKC").split(/[▼■●★☆◇◆※□△▲]/)[0];
  s = s.replace(/ムーブ/g, "ムーヴ").replace(/\s+/g, " ").trim();
  const series = MODEL_SERIES.find((x) => x.re.test(s));
  if (series) return series.name;
  for (let changed = true; changed;) {
    changed = false;
    for (const suf of MODEL_SUFFIXES) {
      if (s.length > suf.length && s.toUpperCase().endsWith(suf.toUpperCase())) {
        s = s.slice(0, -suf.length).trim();
        changed = true;
      }
    }
  }
  return s;
}
// 同じ車とみなすための鍵（大文字小文字・ハイフン・空白の違いを無視）
const modelKey = (name) => modelName(name).toUpperCase().replace(/[\s\-‐－]/g, "");

// 月初在庫と販売の車名を、車の種類ごとにまとめて数える
function groupModels(stockRows, soldRows, tax = "ex") {
  const groups = new Map();
  const add = (name, field) => {
    const key = modelKey(name);
    if (!key) return;
    const g = groups.get(key) || { key, names: {}, opening: 0, sold: 0, gsum: 0, gn: 0 };
    const disp = modelName(name);
    g.names[disp] = (g.names[disp] || 0) + 1;
    g[field]++;
    groups.set(key, g);
  };
  stockRows.forEach((r) => add(r.car_name, "opening"));
  soldRows.forEach((r) => {
    add(r.car_name, "sold");
    const gp = grossOf(r, tax), g = groups.get(modelKey(r.car_name));
    if (g && gp != null) { g.gsum += gp; g.gn++; }
  });
  return [...groups.values()].map((g) => ({
    key: g.key,
    name: Object.entries(g.names).sort((a, b) => b[1] - a[1])[0][0], // いちばん多い書き方で表示
    opening: g.opening, sold: g.sold,
    rate: g.opening ? g.sold / g.opening : null,
    gross_avg: g.gn ? Math.round(g.gsum / g.gn) : null, gross_total: g.gn ? g.gsum : null,
  }));
}

export async function handleTurnover(request, env, url) {
  const path = url.pathname, method = request.method, db = env.DB;

  // 月ごとの一覧
  const ch = url.searchParams.get("ch") || "all";
  const tax = url.searchParams.get("tax") === "in" ? "in" : "ex";
  // 天気マークの基準（みんなで共通）
  if (path === "/api/settings/weather") {
    if (method === "GET") {
      const r = await db.prepare("SELECT value FROM app_settings WHERE key = 'weather'").first();
      return json({ weather: r ? JSON.parse(r.value) : null });
    }
    if (method === "PUT") {
      const b = await request.json();
      const nums = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(Number(x)));
      if (b && b.reset) { await db.prepare("DELETE FROM app_settings WHERE key = 'weather'").run(); return json({ ok: true, weather: null }); }
      if (!b || !nums(b.rate, 3) || !nums(b.gross, 3) || !nums(b.levels, 4)) return json({ error: "基準の数字が正しくありません" }, 400);
      const v = { rate: b.rate.map(Number), gross: b.gross.map(Number), levels: b.levels.map(Number) };
      await db.prepare("INSERT INTO app_settings (key, value) VALUES ('weather', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')").bind(JSON.stringify(v)).run();
      return json({ ok: true, weather: v });
    }
  }

  if (path === "/api/turnover" && method === "GET") {
    // 月初在庫か販売データのどちらかがある月を並べる
    const { results: months } = await db.prepare(`
      WITH ms AS (SELECT month FROM inv_months UNION SELECT DISTINCT month FROM sales_items)
      SELECT ms.month, m.filename, m.item_count,
        (SELECT COUNT(*) FROM sales_items s WHERE s.month = ms.month ${channelSql(ch)}) AS sold,
        (SELECT COUNT(*) FROM sales_items s WHERE s.month = ms.month AND channel = 'retail') AS sold_retail,
        (SELECT COUNT(*) FROM sales_items s WHERE s.month = ms.month AND channel = 'wholesale') AS sold_wholesale,
        (SELECT SUM(${grossSql(tax)}) FROM sales_items s WHERE s.month = ms.month ${channelSql(ch)} AND cost > 0) AS gross_total,
        (SELECT COUNT(*) FROM sales_items s WHERE s.month = ms.month ${channelSql(ch)} AND cost > 0) AS gross_n
      FROM ms LEFT JOIN inv_months m ON m.month = ms.month
      ORDER BY ms.month DESC`).all();
    for (const m of months) {
      if (!m.sold) m.sold = null;
      m.rate = m.sold != null && m.item_count ? m.sold / m.item_count : null;
      m.gross_avg = m.gross_n ? Math.round(m.gross_total / m.gross_n) : null;
    }
    const forecast = await forecastOf(db, months, ch);
    return json({ months, tax, forecast });
  }

  // 月初在庫CSVを取り込む（同じ月があれば入れ替え）
  if (path === "/api/inventory" && method === "POST") {
    const month = url.searchParams.get("month") || "";
    const rows = parseDelimited(await request.text());
    if (rows.length < 2) return json({ error: "データ行がありません" }, 400);
    const head = rows[0].map(clean);

    // 販売データCSV なら契約日付の月ごとに入れ替える
    if (head.includes("伝票No") && (head.includes("契約日付") || head.includes("日付"))) {
      const recs = parseSales(rows);
      if (!recs.length) return json({ error: "販売データの行が見つかりません" }, 400);
      const byMonth = {};
      for (const r of recs) (byMonth[r.contract_date.slice(0, 7)] ||= []).push(r);
      const filename = url.searchParams.get("filename") || "";
      const stmts = [];
      for (const [mo, list] of Object.entries(byMonth)) {
        stmts.push(db.prepare("DELETE FROM sales_items WHERE month = ?").bind(mo));
        for (const r of list) {
          stmts.push(db.prepare("INSERT INTO sales_items (month, slip_no, contract_date, delivery_date, car_name, price, discount, sales_amount, filename, stock_no, chassis_no, customer, channel, cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(mo, r.slip_no, r.contract_date, r.delivery_date, r.car_name, r.price, r.discount, r.sales_amount, filename, r.stock_no, r.chassis_no, r.customer || null, salesChannel(r), r.cost));
        }
      }
      for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
      const linked = recs.filter((r) => r.stock_no || r.chassis_no).length;
      const chCount = { retail: 0, wholesale: 0, exclude: 0 };
      for (const r of recs) { const c = salesChannel(r); if (c) chCount[c]++; }
      return json({ ok: true, kind: "sales", linked, channels: recs.some((r) => r.customer) ? chCount : null, months: Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, v.length])), count: recs.length });
    }

    if (!MONTH_RE.test(month)) return json({ error: "何月の在庫か分かりません。ファイル名に年月（例: 202610）を入れるか、「月」を選んでください" }, 400);
    const header = head.map((h) => HEADER_MAP[h] || null);
    if (!header.includes("stock_no") && !header.includes("chassis_no")) {
      return json({ error: "月初在庫（在庫No・車台番号の列）でも販売データ（伝票No・契約日付の列）でもないCSVです" }, 400);
    }
    const items = [];
    for (const r of rows.slice(1)) {
      const v = {};
      header.forEach((k, i) => { if (k) v[k] = clean(r[i]); });
      if (!v.stock_no && !v.chassis_no) continue;
      items.push(COLS.map((c) => {
        const x = v[c] ?? "";
        if (!NUM.has(c)) return x;
        const n = Number(String(x).replace(/[,円km\s]/g, ""));
        return x === "" || !Number.isFinite(n) ? null : Math.round(n);
      }));
    }
    const stmts = [
      db.prepare("DELETE FROM inv_items WHERE month = ?").bind(month),
      db.prepare("INSERT INTO inv_months (month, filename, item_count) VALUES (?, ?, ?) ON CONFLICT(month) DO UPDATE SET filename = excluded.filename, item_count = excluded.item_count, uploaded_at = datetime('now','localtime')")
        .bind(month, url.searchParams.get("filename") || "", items.length),
    ];
    const ins = `INSERT INTO inv_items (month, ${COLS.join(",")}) VALUES (?, ${COLS.map(() => "?").join(",")})`;
    for (const it of items) stmts.push(db.prepare(ins).bind(month, ...it));
    for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
    return json({ ok: true, kind: "inventory", month, count: items.length });
  }

  // 車名ごとの回転率（その車の販売台数 ÷ その車の月初在庫）
  const mm = path.match(/^\/api\/turnover\/(\d{4}-\d{2})\/models$/);
  if (mm && method === "GET") {
    const month = mm[1];
    const { results: stock } = await db.prepare("SELECT car_name FROM inv_items WHERE month = ?").bind(month).all();
    const { results: sold } = await db.prepare(`SELECT car_name, price, cost FROM sales_items WHERE month = ? ${channelSql(ch)}`).bind(month).all();
    const models = groupModels(stock, sold, tax);
    models.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.sold - a.sold || a.name.localeCompare(b.name, "ja"));
    return json({ month, opening: stock.length, sold: sold.length, models });
  }

  // 週ごとの回転率（その週の販売台数 ÷ その月の月初在庫）。週は月曜〜日曜で、月の初めと終わりは月の中だけで区切る
  const wk = path.match(/^\/api\/turnover\/(\d{4}-\d{2})\/weeks$/);
  if (wk && method === "GET") {
    const month = wk[1];
    const inv = await db.prepare("SELECT item_count FROM inv_months WHERE month = ?").bind(month).first();
    const opening = inv?.item_count || null;
    const { results } = await db.prepare(`SELECT contract_date AS d, COUNT(*) AS n, SUM(CASE WHEN cost > 0 THEN ${grossSql(tax)} END) AS g, SUM(CASE WHEN cost > 0 THEN 1 ELSE 0 END) AS gn
      FROM sales_items s WHERE month = ? ${channelSql(ch)} GROUP BY contract_date`).bind(month).all();
    const byDay = Object.fromEntries(results.map((r) => [r.d, r]));
    const through = results.reduce((x, r) => (r.d && r.d > x ? r.d : x), "");
    const weeks = [];
    let w = null;
    for (const d of daysOfMonth(month)) {
      const dow = new Date(d + "T00:00:00Z").getUTCDay();
      if (!w || dow === 1) { w = { no: weeks.length + 1, from: d, to: d, days: 0, off_days: 0, sold: 0, g: 0, gn: 0 }; weeks.push(w); }
      w.to = d; w.days++; if (isOffDay(d)) w.off_days++;
      const r = byDay[d];
      if (r) { w.sold += r.n; w.g += r.g || 0; w.gn += r.gn || 0; }
    }
    for (const x of weeks) {
      x.rate = opening ? x.sold / opening : null;
      x.gross_avg = x.gn ? Math.round(x.g / x.gn) : null;
      x.status = !through || x.from > through ? "future" : x.to > through ? "partial" : "done";
      delete x.g; delete x.gn;
    }
    return json({ month, opening, through, weeks });
  }

  // 車の種類ごとの回転率の推移（月初在庫と販売データがそろっている月だけ）
  if (path === "/api/turnover/history" && method === "GET") {
    const { results: months } = await db.prepare(
      "SELECT m.month FROM inv_months m WHERE EXISTS (SELECT 1 FROM sales_items s WHERE s.month = m.month) ORDER BY m.month"
    ).all();
    const out = { months: [], models: {} };
    for (const { month } of months) {
      const { results: stock } = await db.prepare("SELECT car_name FROM inv_items WHERE month = ?").bind(month).all();
      const { results: sold } = await db.prepare(`SELECT car_name, price, cost FROM sales_items WHERE month = ? ${channelSql(ch)}`).bind(month).all();
      out.months.push({ month, opening: stock.length, sold: sold.length, rate: stock.length ? sold.length / stock.length : null });
      for (const g of groupModels(stock, sold, tax)) {
        const m = (out.models[g.key] ||= { name: g.name, points: {} });
        m.points[month] = { opening: g.opening, sold: g.sold, rate: g.rate, gross_avg: g.gross_avg };
      }
    }
    return json(out);
  }

  // ある車種の、その月に売れた車（年式・距離・色・グレードは月初在庫と仕入れ台帳から）
  const ms = path.match(/^\/api\/turnover\/(\d{4}-\d{2})\/model-sales$/);
  if (ms && method === "GET") {
    const month = ms[1], key = url.searchParams.get("key") || "";
    const { results } = await db.prepare(`SELECT * FROM sales_items WHERE month = ? ${channelSql(ch)} ORDER BY contract_date, slip_no`).bind(month).all();
    const list = results.filter((r) => modelKey(r.car_name) === key);
    const out = [];
    for (const r of list) {
      let inv = null;
      if (r.stock_no) inv = await db.prepare("SELECT * FROM inv_items WHERE stock_no = ? ORDER BY month DESC LIMIT 1").bind(r.stock_no).first();
      if (!inv && r.chassis_no) inv = await db.prepare("SELECT * FROM inv_items WHERE chassis_no = ? ORDER BY month DESC LIMIT 1").bind(r.chassis_no).first();
      const chassis = r.chassis_no || inv?.chassis_no || "";
      let veh = null;
      const n = chassis.toUpperCase().replace(/[-－‐\s　]/g, "");
      if (n.length >= 5) {
        veh = await db.prepare("SELECT grade, year, mileage_km, color FROM vehicles WHERE REPLACE(REPLACE(UPPER(chassis_no),'-',''),' ','') = ? ORDER BY id DESC LIMIT 1").bind(n).first().catch(() => null);
      }
      out.push({
        contract_date: r.contract_date, car_name: (r.car_name || "").split(/[▼■●★☆◇◆※□△▲]/)[0].trim() || inv?.car_name || "",
        year: inv?.first_reg || (veh?.year ? String(veh.year) : ""),
        mileage_km: inv?.mileage_km ?? veh?.mileage_km ?? null,
        color: inv?.color || veh?.color || "",
        grade: inv?.grade || veh?.grade || "",
        price: r.price, cost: r.cost, gross: grossOf(r, tax), customer: r.customer, channel: r.channel, linked: !!inv,
      });
    }
    return json({ month, rows: out, linkable: list.some((r) => r.stock_no || r.chassis_no) });
  }

  // その月の販売データ一覧
  const sl = path.match(/^\/api\/turnover\/(\d{4}-\d{2})\/sales$/);
  if (sl && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM sales_items WHERE month = ? ORDER BY contract_date, slip_no").bind(sl[1]).all();
    return json({ month: sl[1], rows: results });
  }

  // 販売データを月ごと削除
  const sd = path.match(/^\/api\/sales\/(\d{4}-\d{2})$/);
  if (sd && method === "DELETE") {
    await db.prepare("DELETE FROM sales_items WHERE month = ?").bind(sd[1]).run();
    return json({ ok: true });
  }

  // 月初在庫を削除
  const dm = path.match(/^\/api\/inventory\/(\d{4}-\d{2})$/);
  if (dm && method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM inv_items WHERE month = ?").bind(dm[1]),
      db.prepare("DELETE FROM inv_months WHERE month = ?").bind(dm[1]),
    ]);
    return json({ ok: true });
  }

  return null;
}

// ---- 当月の着地予想 ----------------------------------------------------------------
// 祝日（内閣府の「国民の祝日」。振替休日・国民の休日を含む）
const JP_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
  "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05",
  "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
]);
const dayStr = (y, mo, d) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const isOffDay = (s) => { const w = new Date(s + "T00:00:00Z").getUTCDay(); return w === 0 || w === 6 || JP_HOLIDAYS.has(s); };
function daysOfMonth(month) {
  const [y, mo] = month.split("-").map(Number), n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => dayStr(y, mo, i + 1));
}
// 当月（日本時間）の販売台数から、月末の台数と回転率を予想する。
// 土日祝は平日より売れるので、過去の月の「土日祝1日あたり ÷ 平日1日あたり」の比で重みを付ける。
async function forecastOf(db, months, ch) {
  const now = new Date(Date.now() + 9 * 3600e3), cur = now.toISOString().slice(0, 7);
  const m = months.find((x) => x.month === cur);
  if (!m || !m.sold) return null;
  const { results } = await db.prepare(`SELECT month, contract_date AS d, COUNT(*) AS n FROM sales_items s WHERE 1=1 ${channelSql(ch)} GROUP BY month, contract_date`).all();
  const byDay = {}, pastMonths = new Set();
  let through = "";
  for (const r of results) {
    if (!r.d) continue;
    byDay[r.d] = (byDay[r.d] || 0) + r.n;
    if (r.month === cur) { if (r.d > through) through = r.d; } else pastMonths.add(r.month);
  }
  if (!through) return null;
  // 過去の月から、土日祝と平日の売れ方の比を出す（データが少なければ 1.5 倍とみなす）
  let offN = 0, offD = 0, wkN = 0, wkD = 0;
  for (const pm of pastMonths) for (const d of daysOfMonth(pm)) { if (isOffDay(d)) { offN += byDay[d] || 0; offD++; } else { wkN += byDay[d] || 0; wkD++; } }
  const ratio = offD && wkD && wkN && offN ? (offN / offD) / (wkN / wkD) : 1.5;
  let elW = 0, elO = 0, restW = 0, restO = 0;
  for (const d of daysOfMonth(cur)) { if (d <= through) (isOffDay(d) ? elO++ : elW++); else (isOffDay(d) ? restO++ : restW++); }
  const done = elW + elO * ratio, total = done + restW + restO * ratio;
  if (!done) return null;
  const factor = total / done, sold = Math.round(m.sold * factor);
  return {
    month: cur, through, factor, sold, rate: m.item_count ? (m.sold * factor) / m.item_count : null,
    ratio: Math.round(ratio * 100) / 100, rest_weekday: restW, rest_off: restO, done_weekday: elW, done_off: elO,
  };
}
