import { json, parseDelimited } from "./util.js";

// ---- 回転率（月初在庫 と 販売台数） ---------------------------------------------
// 回転率 = その月の販売台数 ÷ 月初在庫
// 販売台数は販売データCSV（契約日付の月で数える）の台数

export const TURNOVER_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS inv_months ( month TEXT PRIMARY KEY, filename TEXT, item_count INTEGER, uploaded_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE TABLE IF NOT EXISTS inv_items ( month TEXT NOT NULL, stock_no TEXT, maker TEXT, car_name TEXT, first_reg TEXT, inspection_expiry TEXT, color TEXT, mileage_km INTEGER, model_code TEXT, chassis_no TEXT, planned_price INTEGER, cost INTEGER, staff TEXT )",
  "CREATE INDEX IF NOT EXISTS idx_inv_items_stock ON inv_items(month, stock_no)",
  "CREATE INDEX IF NOT EXISTS idx_inv_items_chassis ON inv_items(month, chassis_no)",
  "CREATE TABLE IF NOT EXISTS sales_items ( month TEXT NOT NULL, slip_no TEXT, contract_date TEXT, delivery_date TEXT, car_name TEXT, price INTEGER, discount INTEGER, sales_amount INTEGER, filename TEXT )",
  "CREATE INDEX IF NOT EXISTS idx_sales_items_month ON sales_items(month)",
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

export async function handleTurnover(request, env, url) {
  const path = url.pathname, method = request.method, db = env.DB;

  // 月ごとの一覧
  if (path === "/api/turnover" && method === "GET") {
    // 月初在庫か販売データのどちらかがある月を並べる
    const { results: months } = await db.prepare(`
      WITH ms AS (SELECT month FROM inv_months UNION SELECT DISTINCT month FROM sales_items)
      SELECT ms.month, m.filename, m.item_count,
        (SELECT COUNT(*) FROM sales_items s WHERE s.month = ms.month) AS sold
      FROM ms LEFT JOIN inv_months m ON m.month = ms.month
      ORDER BY ms.month DESC`).all();
    for (const m of months) {
      if (!m.sold) m.sold = null;
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

  // 車名ごとの回転率（その車の販売台数 ÷ その車の月初在庫）
  const mm = path.match(/^\/api\/turnover\/(\d{4}-\d{2})\/models$/);
  if (mm && method === "GET") {
    const month = mm[1];
    const { results: stock } = await db.prepare("SELECT car_name FROM inv_items WHERE month = ?").bind(month).all();
    const { results: sold } = await db.prepare("SELECT car_name FROM sales_items WHERE month = ?").bind(month).all();
    const groups = new Map();
    const add = (name, field) => {
      const key = modelKey(name);
      if (!key) return;
      const g = groups.get(key) || { names: {}, opening: 0, sold: 0 };
      const disp = modelName(name);
      g.names[disp] = (g.names[disp] || 0) + 1;
      g[field]++;
      groups.set(key, g);
    };
    stock.forEach((r) => add(r.car_name, "opening"));
    sold.forEach((r) => add(r.car_name, "sold"));
    const models = [...groups.values()].map((g) => ({
      name: Object.entries(g.names).sort((a, b) => b[1] - a[1])[0][0], // いちばん多い書き方で表示
      opening: g.opening, sold: g.sold,
      rate: g.opening ? g.sold / g.opening : null,
    }));
    models.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.sold - a.sold || a.name.localeCompare(b.name, "ja"));
    return json({ month, opening: stock.length, sold: sold.length, models });
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
