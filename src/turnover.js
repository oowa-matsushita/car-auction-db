import { json, parseDelimited } from "./util.js";

// ---- 回転率（月初在庫 と 販売台数） ---------------------------------------------
// 回転率 = その月の販売台数 ÷ 月初在庫
// 販売台数は次の順で決める：手入力 → 販売データCSV（契約日付の月で数える）→ 月初在庫の差
// （その月の月初在庫にあって、翌月の月初在庫に無い車）

export const TURNOVER_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS inv_months ( month TEXT PRIMARY KEY, filename TEXT, item_count INTEGER, uploaded_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE TABLE IF NOT EXISTS inv_items ( month TEXT NOT NULL, stock_no TEXT, maker TEXT, car_name TEXT, first_reg TEXT, inspection_expiry TEXT, color TEXT, mileage_km INTEGER, model_code TEXT, chassis_no TEXT, planned_price INTEGER, cost INTEGER, staff TEXT )",
  "CREATE INDEX IF NOT EXISTS idx_inv_items_stock ON inv_items(month, stock_no)",
  "CREATE INDEX IF NOT EXISTS idx_inv_items_chassis ON inv_items(month, chassis_no)",
  "CREATE TABLE IF NOT EXISTS sales_items ( month TEXT NOT NULL, slip_no TEXT, contract_date TEXT, delivery_date TEXT, car_name TEXT, price INTEGER, discount INTEGER, sales_amount INTEGER, filename TEXT )",
  "CREATE INDEX IF NOT EXISTS idx_sales_items_month ON sales_items(month)",
  "CREATE TABLE IF NOT EXISTS turnover_manual ( month TEXT PRIMARY KEY, sold_count INTEGER, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
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
};
const COLS = ["stock_no", "maker", "car_name", "first_reg", "inspection_expiry", "color", "mileage_km", "model_code", "chassis_no", "planned_price", "cost", "staff"];
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

// 販売データCSV（1台が3行：1行目 伝票No・契約日付・車名・車両本体価格 / 2行目 納車日・値引 / 3行目 売上高）
function parseSales(rows) {
  const head = rows[0].map(clean);
  const col = (name) => head.indexOf(name);
  const iNo = col("伝票No"), iDate = col("契約日付"), iCar = col("車名"), iPrice = col("車両本体価格");
  const recs = [];
  let cur = null, line = 0;
  for (const r of rows.slice(1)) {
    const no = clean(r[iNo]), date = toDate(r[iDate]);
    if (no && date) {
      cur = { slip_no: no, contract_date: date, delivery_date: null, car_name: clean(r[iCar]), price: toInt(r[iPrice]), discount: null, sales_amount: null };
      recs.push(cur); line = 1;
    } else if (cur) {
      line++;
      if (line === 2) { cur.delivery_date = toDate(r[iDate]); cur.discount = toInt(r[iPrice]); }
      if (line === 3) cur.sales_amount = toInt(r[iPrice]);
    }
  }
  return recs;
}
function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}
// 半角カナ → 全角などの表記ゆれをそろえる
const clean = (v) => String(v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

// 翌月の月初在庫に無い車（＝売れた車）を探す条件。在庫No で照合し、無ければ車台番号で照合する
const NOT_IN_NEXT = `NOT EXISTS (SELECT 1 FROM inv_items b WHERE b.month = ?2 AND (
  (a.stock_no <> '' AND b.stock_no = a.stock_no) OR (a.stock_no = '' AND a.chassis_no <> '' AND b.chassis_no = a.chassis_no)))`;

export async function handleTurnover(request, env, url) {
  const path = url.pathname, method = request.method, db = env.DB;

  // 月ごとの一覧
  if (path === "/api/turnover" && method === "GET") {
    // 月初在庫か販売データのどちらかがある月を並べる
    const { results: months } = await db.prepare(`
      WITH ms AS (SELECT month FROM inv_months UNION SELECT DISTINCT month FROM sales_items)
      SELECT ms.month, m.filename, m.item_count,
        (SELECT SUM(cost) FROM inv_items i WHERE i.month = ms.month) AS stock_cost,
        (SELECT COUNT(*) FROM sales_items s WHERE s.month = ms.month) AS sold_sales,
        (SELECT SUM(sales_amount) FROM sales_items s WHERE s.month = ms.month) AS sales_amount,
        t.sold_count AS sold_manual
      FROM ms LEFT JOIN inv_months m ON m.month = ms.month LEFT JOIN turnover_manual t ON t.month = ms.month
      ORDER BY ms.month DESC`).all();
    const have = new Set(months.filter((m) => m.item_count != null).map((m) => m.month));
    for (const m of months) {
      const nm = nextMonth(m.month);
      m.next_month = nm;
      m.sold_diff = have.has(m.month) && have.has(nm)
        ? await db.prepare(`SELECT COUNT(*) AS n FROM inv_items a WHERE a.month = ?1 AND ${NOT_IN_NEXT}`).bind(m.month, nm).first("n")
        : null;
      if (!m.sold_sales) m.sold_sales = null;
      m.sold = m.sold_manual ?? m.sold_sales ?? m.sold_diff;
      m.sold_source = m.sold_manual != null ? "手入力" : m.sold_sales != null ? "販売データ" : m.sold_diff != null ? "在庫の差" : null;
      m.rate = m.sold != null && m.item_count ? m.sold / m.item_count : null;
    }
    return json({ months });
  }

  // 月初在庫CSVを取り込む（同じ月があれば入れ替え）
  if (path === "/api/inventory" && method === "POST") {
    const month = url.searchParams.get("month") || "";
    const rows = parseDelimited(await request.text());
    if (rows.length < 2) return json({ error: "データ行がありません" }, 400);
    const head = rows[0].map(clean);

    // 販売データCSV なら契約日付の月ごとに入れ替える
    if (head.includes("伝票No") && head.includes("契約日付")) {
      const recs = parseSales(rows);
      if (!recs.length) return json({ error: "販売データの行が見つかりません" }, 400);
      const byMonth = {};
      for (const r of recs) (byMonth[r.contract_date.slice(0, 7)] ||= []).push(r);
      const filename = url.searchParams.get("filename") || "";
      const stmts = [];
      for (const [mo, list] of Object.entries(byMonth)) {
        stmts.push(db.prepare("DELETE FROM sales_items WHERE month = ?").bind(mo));
        for (const r of list) {
          stmts.push(db.prepare("INSERT INTO sales_items (month, slip_no, contract_date, delivery_date, car_name, price, discount, sales_amount, filename) VALUES (?,?,?,?,?,?,?,?,?)")
            .bind(mo, r.slip_no, r.contract_date, r.delivery_date, r.car_name, r.price, r.discount, r.sales_amount, filename));
        }
      }
      for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
      return json({ ok: true, kind: "sales", months: Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, v.length])), count: recs.length });
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

  // その月に売れた車の一覧（月初在庫の差）
  const sm = path.match(/^\/api\/turnover\/(\d{4}-\d{2})\/sold$/);
  if (sm && method === "GET") {
    const month = sm[1], nm = nextMonth(month);
    const has = await db.prepare("SELECT 1 FROM inv_months WHERE month = ?").bind(nm).first();
    if (!has) return json({ error: `${nm} の月初在庫がまだ取り込まれていないため、売れた車を出せません` }, 400);
    const { results } = await db.prepare(`SELECT a.* FROM inv_items a WHERE a.month = ?1 AND ${NOT_IN_NEXT} ORDER BY a.maker, a.car_name`)
      .bind(month, nm).all();
    return json({ month, next_month: nm, rows: results });
  }

  // 販売台数の手入力（空にすると自動に戻る）
  const tm = path.match(/^\/api\/turnover\/(\d{4}-\d{2})$/);
  if (tm && method === "PUT") {
    const body = await request.json();
    const v = body.sold_count;
    if (v === null || v === "" || v === undefined) {
      await db.prepare("DELETE FROM turnover_manual WHERE month = ?").bind(tm[1]).run();
    } else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return json({ error: "販売台数は0以上の整数で入力してください" }, 400);
      await db.prepare("INSERT INTO turnover_manual (month, sold_count) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET sold_count = excluded.sold_count, updated_at = datetime('now','localtime')")
        .bind(tm[1], n).run();
    }
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
