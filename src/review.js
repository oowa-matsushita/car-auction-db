import { json } from "./util.js";

// ---- 確認リスト ----------------------------------------------------------------
// データの値から「確認が必要な車」を見つける。確認済みにした車（review_checked = 1）は出さない。
export const REVIEW_ADDED_COLUMNS = ["ALTER TABLE vehicles ADD COLUMN review_checked INTEGER DEFAULT 0"];

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
