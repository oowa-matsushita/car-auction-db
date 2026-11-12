import { json } from "./util.js";
import { channelSql, grossOf, netPrice, loadExpense, groupModels, isOffDay, daysOfMonth, modelKey, modelName } from "./turnover.js";

// ---- 分析（ベータ）：売れている車・売れている日・天気との関係 ---------------------------------
export const ANALYSIS_SCHEMA = [
  // 施策メモ（社長のノウハウ）：いつ・どの車種に・何をしたか。効果は販売データから自動で計算する
  "CREATE TABLE IF NOT EXISTS knowhow ( id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, kind TEXT, start_date TEXT NOT NULL, end_date TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now','localtime')) )",
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

  // 施策メモ：一覧（効果つき）・追加・削除
  if (path === "/api/knowhow" || path.startsWith("/api/knowhow/")) {
    if (method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!String(b.model || "").trim() || !/^\d{4}-\d{2}-\d{2}$/.test(b.start || "")) return json({ error: "車種と開始日を入れてください" }, 400);
      await db.prepare("INSERT INTO knowhow (model, kind, start_date, end_date, detail) VALUES (?,?,?,?,?)")
        .bind(String(b.model).trim(), b.kind || "その他", b.start, /^\d{4}-\d{2}-\d{2}$/.test(b.end || "") ? b.end : null, String(b.detail || "").trim()).run();
      return json({ ok: true });
    }
    const del = path.match(/^\/api\/knowhow\/(\d+)$/);
    if (del && method === "DELETE") { await db.prepare("DELETE FROM knowhow WHERE id = ?").bind(Number(del[1])).run(); return json({ ok: true }); }
    if (method === "GET") {
      await loadExpense(db);
      const { results: list } = await db.prepare("SELECT * FROM knowhow ORDER BY start_date DESC, id DESC").all();
      const { results: sales } = await db.prepare("SELECT contract_date AS d, car_name, price, discount, cost, channel FROM sales_items WHERE COALESCE(channel,'') <> 'exclude'").all();
      const last = sales.reduce((m, r) => (r.d && r.d > m ? r.d : m), "");
      const dayMs = 864e5, toT = (d) => Date.parse(d + "T00:00:00Z"), toD = (t) => new Date(t).toISOString().slice(0, 10);
      for (const k of list) {
        const key = modelKey(k.model);
        const mine = sales.filter((r) => r.d && modelKey(r.car_name) === key);
        // 施策の期間（終わりが無ければ、販売データの最後の日まで）と、その前の60日を比べる（1日あたりの台数）
        const aEnd = k.end_date && k.end_date < last ? k.end_date : last;
        const aDays = aEnd >= k.start_date ? Math.round((toT(aEnd) - toT(k.start_date)) / dayMs) + 1 : 0;
        const bStart = toD(toT(k.start_date) - 60 * dayMs), bEnd = toD(toT(k.start_date) - dayMs);
        const pick = (from, to) => mine.filter((r) => r.d >= from && r.d <= to);
        const A = aDays ? pick(k.start_date, aEnd) : [], Bf = pick(bStart, bEnd);
        const g = (rs) => { const v = rs.map((r) => grossOf(r, "ex")).filter((x) => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
        Object.assign(k, { key, name: modelName(k.model), after_days: aDays, after_sold: A.length, after_per_day: aDays ? A.length / aDays : null, after_gross: g(A),
          before_sold: Bf.length, before_per_day: Bf.length / 60, before_gross: g(Bf), lift: aDays && Bf.length ? (A.length / aDays) / (Bf.length / 60) - 1 : null,
          active: k.start_date <= last && (!k.end_date || k.end_date >= last), through: last });
      }
      return json({ items: list, through: last });
    }
  }

  // 今月の小売台数の目標（月ごとに保存。みんなで共通）と、その月の日ごとの小売台数
  if (path === "/api/target") {
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
    await db.prepare("CREATE TABLE IF NOT EXISTS app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')) )").run();
    if (method === "PUT") {
      const b = await request.json().catch(() => ({}));
      const m = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month : month, t = Number(b.retail);
      if (!(t >= 0)) return json({ error: "目標の台数を入れてください" }, 400);
      await db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')").bind("target:" + m, JSON.stringify({ retail: Math.round(t) })).run();
      return json({ ok: true });
    }
    if (method === "GET") {
      const r = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind("target:" + month).first();
      const target = r ? JSON.parse(r.value).retail : null;
      const { results } = await db.prepare("SELECT month, contract_date AS d, COUNT(*) AS n FROM sales_items WHERE channel = 'retail' GROUP BY month, contract_date").all();
      const byDay = {};
      let through = "";
      const past = new Set();
      for (const x of results) { byDay[x.d] = x.n; if (x.month === month) { if (x.d > through) through = x.d; } else if (x.month < month) past.add(x.month); }
      // 土日祝は平日の何倍売れるか（過去の月の小売から）
      let oN = 0, oD = 0, wN = 0, wD = 0;
      for (const pm of past) for (const d of daysOfMonth(pm)) { if (isOffDay(d)) { oN += byDay[d] || 0; oD++; } else { wN += byDay[d] || 0; wD++; } }
      const ratio = oD && wD && wN ? Math.round(((oN / oD) / (wN / wD)) * 100) / 100 : 1.8;
      const days = daysOfMonth(month).map((d) => ({ date: d, off: isOffDay(d), dow: new Date(d + "T00:00:00Z").getUTCDay(), retail: byDay[d] || 0 }));
      return json({ month, target, ratio, through, days });
    }
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
      const a = agg.get(g.key) || { key: g.key, name: g.name, opening: 0, opening_months: 0, sold: 0, gsum: 0, gn: 0, by_month: {}, open_by_month: {}, gross_by_month: {} };
      a.name = g.name; a.opening += g.opening; if (g.opening) a.opening_months++;
      a.sold += g.sold; a.by_month[mo] = g.sold; a.open_by_month[mo] = g.opening;
      if (g.gross_n) a.gross_by_month[mo] = [g.gross_total, g.gross_n];
      if (g.gross_n) { a.gsum += g.gross_total; a.gn += g.gross_n; }
      agg.set(g.key, a);
    }
  }
  const models = [...agg.values()].filter((a) => a.sold || a.opening).map((a) => ({
    key: a.key, name: a.name, sold: a.sold, opening: a.opening, rate: a.opening ? a.sold / a.opening : null,
    gross_avg: a.gn ? Math.round(a.gsum / a.gn) : null, gross_total: a.gn ? a.gsum : null, by_month: a.by_month, open_by_month: a.open_by_month, gross_by_month: a.gross_by_month,
  }));

  // 価格帯（値引き後の本体価格・税込）
  const bandOf = (p) => (p < 500000 ? "〜50万" : p < 1000000 ? "50〜100万" : p < 1500000 ? "100〜150万" : p < 2000000 ? "150〜200万" : p < 3000000 ? "200〜300万" : p < 4000000 ? "300〜400万" : "400万〜");
  const BANDS = ["〜50万", "50〜100万", "100〜150万", "150〜200万", "200〜300万", "300〜400万", "400万〜"];
  const bm = Object.fromEntries(BANDS.map((b) => [b, { band: b, sold: 0, gsum: 0, gn: 0 }]));
  for (const r of sales) { const p = netPrice(r); if (p == null) continue; const b = bm[bandOf(p)]; b.sold++; const g = grossOf(r, "ex"); if (g != null) { b.gsum += g; b.gn++; } }
  const bands = BANDS.map((b) => ({ band: b, sold: bm[b].sold, gross_avg: bm[b].gn ? Math.round(bm[b].gsum / bm[b].gn) : null }));

  return json({ months: use, days, models, bands, place: wx[0]?.place || null, weather_days: wx.length });
}
