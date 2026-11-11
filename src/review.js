import { json } from "./util.js";

// ---- 確認リスト ----------------------------------------------------------------
// データの値から「確認が必要な車」を見つける。確認済みにした車（review_checked = 1）は出さない。
export const REVIEW_ADDED_COLUMNS = [
  "ALTER TABLE vehicles ADD COLUMN review_checked INTEGER DEFAULT 0",
  "CREATE TABLE IF NOT EXISTS price_units ( house TEXT PRIMARY KEY, unit TEXT NOT NULL, source TEXT, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
];

// ---- 会場ごとの金額の単位（学習） ----------------------------------------------------
// 確認リストで「千円単位として1/10にする」を押すと、その会場を「千円」と覚える。
// 覚えた会場の車は、取り込むときに金額が千円のまま入っていそうなら自動で1/10にする。
const houseKey = (h) => String(h ?? "").normalize("NFKC").replace(/\s/g, "");
export async function loadPriceUnits(db) {
  const { results } = await db.prepare("SELECT house, unit FROM price_units").all().catch(() => ({ results: [] }));
  return Object.fromEntries(results.map((r) => [r.house, r.unit]));
}
const num = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(String(v).replace(/[,，\s]/g, "")));
// 千円のまま入っていそうか（落札1000以上、または予定価格の1.5倍を超える、またはスタート1000以上）
export function looksThousand(v) {
  const bid = num(v.bid_price_man), start = num(v.start_price_man), plan = num(v.planned_price_man);
  return (bid != null && (bid >= 1000 || (plan && bid > plan * 1.5))) || (start != null && start >= 1000);
}
// 取り込む前に呼ぶ。直したら true を返す
export function fixPriceUnit(v, units) {
  if (units[houseKey(v.auction_house)] !== "千円" || !looksThousand(v)) return false;
  for (const k of ["start_price_man", "bid_price_man"]) { const n = num(v[k]); if (n != null) v[k] = Math.round(n) / 10; }
  v.review_reason = [v.review_reason, `${v.auction_house}は千円単位のため、スタート・落札金額を自動で1/10にしました`].filter(Boolean).join("／");
  v.needs_review = 1;
  return true;
}

// 種類（表示順＝優先順）
export const REVIEW_KINDS = [
  { key: "price", label: "金額が間違っていそう" },
  { key: "dup", label: "管理番号が重複" },
  { key: "missing", label: "情報が欠けている" },
  { key: "handbid", label: "落札金額が手書き" },
  { key: "noplan", label: "予定価格が空欄" },
];

function issuesOf(r, dupCount) {
  const out = [];
  const bid = r.bid_price_man, plan = r.planned_price_man;
  if (bid != null && bid >= 1000) out.push(["price", `落札金額が ${bid.toLocaleString()}万円（桁ずれ？）`]);
  if (plan != null && plan >= 1000) out.push(["price", `予定価格が ${plan.toLocaleString()}万円（桁ずれ？）`]);
  if (bid && plan && bid > 20 && plan / bid > 2.5) out.push(["price", `予定価格 ${plan}万円 が落札 ${bid}万円 の${(plan / bid).toFixed(1)}倍`]);
  if (bid && plan && plan < bid) out.push(["price", `予定価格 ${plan}万円 が落札 ${bid}万円 より安い`]);
  if (r.control_no && dupCount[r.control_no] > 1) out.push(["dup", `管理番号 ${r.control_no} がほかの車と同じ`]);
  if (!r.control_no) out.push(["missing", "管理番号がない"]);
  if (bid == null) out.push(["missing", "落札金額がない"]);
  if (!r.auction_date) out.push(["missing", "開催日がない"]);
  const reason = r.review_reason || "";
  if (/落札金額は手書き/.test(reason)) out.push(["handbid", "落札金額は手書きの数字から入力"]);
  if (plan == null) out.push(["noplan", /計算式/.test(reason) ? "予定価格が計算式で書かれている" : "予定価格が空欄"]);
  return out;
}

export async function handleReview(request, env, url) {
  const db = env.DB, path = url.pathname, method = request.method;

  if (path === "/api/review" && method === "GET") {
    const { results } = await db.prepare(
      "SELECT vehicles.*, (SELECT rotation FROM page_rotations WHERE rot_key = vehicles.pdf_key AND rot_page = COALESCE(vehicles.page_no, 1)) AS page_rotation FROM vehicles"
    ).all();
    const dupCount = {};
    for (const r of results) if (r.control_no) dupCount[r.control_no] = (dupCount[r.control_no] || 0) + 1;
    const items = [];
    let checked = 0;
    for (const r of results) {
      const iss = issuesOf(r, dupCount);
      if (!iss.length) continue;
      if (r.review_checked) { checked++; continue; }
      const kind = REVIEW_KINDS.find((k) => iss.some((i) => i[0] === k.key)).key; // いちばん優先度の高い種類で分ける
      items.push({ ...r, kind, issues: iss.map((i) => i[1]) });
    }
    const order = Object.fromEntries(REVIEW_KINDS.map((k, i) => [k.key, i]));
    items.sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === "dup" ? String(a.control_no).localeCompare(String(b.control_no)) : 0)
      || String(a.auction_date || "").localeCompare(String(b.auction_date || "")) || String(a.control_no || "").localeCompare(String(b.control_no || "")));
    return json({ kinds: REVIEW_KINDS, items, checked });
  }

  // 千円単位として1/10にし、その会場を覚える（同じ会場のほかの車も直す）
  const t = path.match(/^\/api\/review\/(\d+)\/thousand$/);
  if (t && method === "POST") {
    const v = await db.prepare("SELECT * FROM vehicles WHERE id = ?").bind(Number(t[1])).first();
    if (!v) return json({ error: "車が見つかりません" }, 404);
    const house = houseKey(v.auction_house);
    const stmts = [db.prepare("UPDATE vehicles SET start_price_man = ROUND(start_price_man * 10) / 100.0, bid_price_man = ROUND(bid_price_man * 10) / 100.0, updated_at = datetime('now','localtime') WHERE id = ?").bind(v.id)];
    if (house) stmts.push(db.prepare("INSERT INTO price_units (house, unit, source) VALUES (?, '千円', 'manual') ON CONFLICT(house) DO UPDATE SET unit = '千円', updated_at = datetime('now','localtime')").bind(house));
    await db.batch(stmts);
    // 同じ会場で、千円のまま入っていそうなほかの車もまとめて直す
    let others = 0;
    if (house) {
      const { results } = await db.prepare("SELECT * FROM vehicles WHERE id <> ? AND REPLACE(auction_house, ' ', '') = ?").bind(v.id, house).all();
      const fix = results.filter(looksThousand);
      if (fix.length) {
        await db.batch(fix.map((r) => db.prepare("UPDATE vehicles SET start_price_man = ROUND(start_price_man * 10) / 100.0, bid_price_man = ROUND(bid_price_man * 10) / 100.0, needs_review = 1, review_reason = TRIM(COALESCE(review_reason || '／', '') || ?), updated_at = datetime('now','localtime') WHERE id = ?")
          .bind(`${v.auction_house}は千円単位のため、スタート・落札金額を自動で1/10にしました`, r.id)));
        others = fix.length;
      }
    }
    return json({ ok: true, house: v.auction_house, others });
  }
  if (path === "/api/price-units" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM price_units ORDER BY house").all();
    return json({ units: results });
  }

  // 確認済みにする / 戻す
  const m = path.match(/^\/api\/review\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json();
    await db.prepare("UPDATE vehicles SET review_checked = ?, needs_review = CASE WHEN ? = 1 THEN 0 ELSE needs_review END, updated_at = datetime('now','localtime') WHERE id = ?")
      .bind(b.checked ? 1 : 0, b.checked ? 1 : 0, Number(m[1])).run();
    return json({ ok: true });
  }
  return null;
}
