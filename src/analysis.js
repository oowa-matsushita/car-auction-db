import { json } from "./util.js";
import { channelSql, grossOf, netPrice, loadExpense, groupModels, isOffDay } from "./turnover.js";

// ---- 分析（ベータ）：売れている車・売れている日・天気との関係 ---------------------------------
export const ANALYSIS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS weather_daily ( date TEXT PRIMARY KEY, place TEXT, temp REAL, rain REAL, wind REAL, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
];

// 気象庁「過去の気象データ・ダウンロード」の CSV（年月日・平均気温・降水量の合計・平均風速…）を読む
export function parseJmaCsv(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split(","));
  const head = lines.findIndex((c) => c[0] === "年月日");
  if (head < 0) throw new Error("気象庁のCSV（「年月日」の列）が見つかりません");
  const place = (lines[head - 1] || []).find((x, i) => i > 0 && x) || "";
  const col = (re) => lines[head].findIndex((x) => re.test(x));
  const iT = col(/平均気温/), iR = col(/降水量/), iW = col(/平均風速/);
  const out = [];
  for (const c of lines.slice(head + 1)) {
    const m = (c[0] || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) continue;
    const num = (i) => (i < 0 || c[i] === "" || c[i] == null ? null : Number(c[i]));
    out.push({ date: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, place, temp: num(iT), rain: num(iR), wind: num(iW) });
  }
  return out;
}

export async function handleAnalysis(request, env, url) {
  const db = env.DB, path = url.pathname, method = request.method;
  for (const q of ANALYSIS_SCHEMA) await db.prepare(q).run();

  if (path === "/api/weather" && method === "POST") {
    const rows = parseJmaCsv(await request.text());
    if (!rows.length) return json({ error: "天気のデータがありません" }, 400);
    const st = rows.map((r) => db.prepare("INSERT INTO weather_daily (date, place, temp, rain, wind) VALUES (?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET place=excluded.place, temp=excluded.temp, rain=excluded.rain, wind=excluded.wind, updated_at=datetime('now','localtime')")
      .bind(r.date, r.place, r.temp, r.rain, r.wind));
    for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
    return json({ ok: true, count: rows.length, place: rows[0].place, from: rows[0].date, to: rows[rows.length - 1].date });
  }

  if (path !== "/api/analysis" || method !== "GET") return null;
  const ch = url.searchParams.get("ch") || "all";
  const oem = url.searchParams.get("oem") === "1";
  const months = Math.max(0, Number(url.searchParams.get("months")) || 0); // 0 = 全部
  await loadExpense(db);

  const { results: allMonths } = await db.prepare("SELECT DISTINCT month FROM sales_items ORDER BY month").all();
  let use = allMonths.map((r) => r.month);
  if (months) use = use.slice(-months);
  if (!use.length) return json({ days: [], models: [], bands: [], months: [] });
  const ph = use.map(() => "?").join(",");
  const { results: sales } = await db.prepare(`SELECT contract_date, car_name, price, discount, cost, channel FROM sales_items s WHERE month IN (${ph}) ${channelSql(ch)}`).bind(...use).all();
  const { results: wx } = await db.prepare(`SELECT date, place, temp, rain, wind FROM weather_daily WHERE date >= ? AND date <= ?`).bind(use[0] + "-01", use[use.length - 1] + "-31").all();
  const wxBy = Object.fromEntries(wx.map((w) => [w.date, w]));

  // 日ごと（売れなかった日も 0 台で入れる）
  const byDay = {};
  let first = "", last = "";
  for (const r of sales) {
    const d = r.contract_date;
    if (!d) continue;
    if (!first || d < first) first = d;
    if (!last || d > last) last = d;
    const x = (byDay[d] ||= { sold: 0, retail: 0, wholesale: 0, gsum: 0, gn: 0, sales: 0 });
    x.sold++;
    if (r.channel === "retail") x.retail++; else if (r.channel === "wholesale") x.wholesale++;
    const g = grossOf(r, "ex");
    if (g != null) { x.gsum += g; x.gn++; }
    const np = netPrice(r);
    if (np != null) x.sales += Math.round(np / 1.1);
  }
  const days = [];
  if (first) {
    for (let t = Date.parse(first + "T00:00:00Z"); t <= Date.parse(last + "T00:00:00Z"); t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10), x = byDay[d] || { sold: 0, retail: 0, wholesale: 0, gsum: 0, gn: 0, sales: 0 }, w = wxBy[d];
      days.push({ date: d, dow: new Date(t).getUTCDay(), off: isOffDay(d), ...x, temp: w?.temp ?? null, rain: w?.rain ?? null, wind: w?.wind ?? null });
    }
  }

  // 車種ごと：期間の販売台数・平均台粗利・回転率（月初在庫の合計に対する販売の合計）・月ごとの台数
  const agg = new Map();
  for (const mo of use) {
    const { results: stock } = await db.prepare("SELECT car_name FROM inv_items WHERE month = ?").bind(mo).all();
    const { results: sold } = await db.prepare(`SELECT car_name, price, discount, cost FROM sales_items s WHERE month = ? ${channelSql(ch)}`).bind(mo).all();
    for (const g of groupModels(stock, sold, "ex", oem)) {
      const a = agg.get(g.key) || { key: g.key, name: g.name, opening: 0, opening_months: 0, sold: 0, gsum: 0, gn: 0, by_month: {} };
      a.name = g.name; a.opening += g.opening; if (g.opening) a.opening_months++;
      a.sold += g.sold; a.by_month[mo] = g.sold;
      if (g.gross_n) { a.gsum += g.gross_total; a.gn += g.gross_n; }
      agg.set(g.key, a);
    }
  }
  const models = [...agg.values()].filter((a) => a.sold || a.opening).map((a) => ({
    key: a.key, name: a.name, sold: a.sold, opening: a.opening, rate: a.opening ? a.sold / a.opening : null,
    gross_avg: a.gn ? Math.round(a.gsum / a.gn) : null, gross_total: a.gn ? a.gsum : null, by_month: a.by_month,
  }));

  // 価格帯（値引き後の本体価格・税込）
  const bandOf = (p) => (p < 500000 ? "〜50万" : p < 1000000 ? "50〜100万" : p < 1500000 ? "100〜150万" : p < 2000000 ? "150〜200万" : p < 3000000 ? "200〜300万" : p < 4000000 ? "300〜400万" : "400万〜");
  const BANDS = ["〜50万", "50〜100万", "100〜150万", "150〜200万", "200〜300万", "300〜400万", "400万〜"];
  const bm = Object.fromEntries(BANDS.map((b) => [b, { band: b, sold: 0, gsum: 0, gn: 0 }]));
  for (const r of sales) { const p = netPrice(r); if (p == null) continue; const b = bm[bandOf(p)]; b.sold++; const g = grossOf(r, "ex"); if (g != null) { b.gsum += g; b.gn++; } }
  const bands = BANDS.map((b) => ({ band: b, sold: bm[b].sold, gross_avg: bm[b].gn ? Math.round(bm[b].gsum / bm[b].gn) : null }));

  return json({ months: use, days, models, bands, place: wx[0]?.place || null, weather_days: wx.length });
}
