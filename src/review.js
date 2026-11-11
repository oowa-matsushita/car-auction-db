import { json } from "./util.js";
import { modelName } from "./turnover.js";

// ---- 確認リスト ----------------------------------------------------------------
// データの値から「確認が必要な車」を見つける。確認済みにした車（review_checked = 1）は出さない。
export const REVIEW_ADDED_COLUMNS = [
  "ALTER TABLE vehicles ADD COLUMN review_checked INTEGER DEFAULT 0",
  "CREATE TABLE IF NOT EXISTS crop_regions ( house TEXT NOT NULL, field TEXT NOT NULL, x REAL, y REAL, w REAL, h REAL, updated_at TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY (house, field) )",
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
  { key: "outlier", label: "相場・売値が他の車とかけ離れている" },
  { key: "dup", label: "管理番号が重複" },
  { key: "missing", label: "情報が欠けている" },
  { key: "handbid", label: "落札金額が手書き" },
  { key: "noplan", label: "予定価格が空欄" },
];

// ---- 相場・売値の外れ値 ---------------------------------------------------------------
// 似た車（同じ車種・ハイブリッド/EVかどうか・年式±1年・距離が近い）の中央値と比べる。
// 同じグレードの車が4台以上あればグレードもそろえて比べ（±40%・20万円以上）、
// なければ車種全体と比べる（グレード差があるので ×1.8 以上 / 半分以下・30万円以上のときだけ）
const PEER_KEY = (r) => modelName(r.car_name).toUpperCase().replace(/[\s\-‐－]/g, "");
const isElectrified = (r) => /ハイブリッド|HYBRID|HV|e:|E-POWER|PHEV|EV/i.test(`${r.car_name || ""} ${r.grade || ""}`.normalize("NFKC"));
const gradeKey = (r) => String(r.grade || "").normalize("NFKC").toUpperCase().replace(/ハイブリッド|HYBRID/g, "").trim().split(/[\s・/]+/)[0] || "";
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
function outlierIssues(r, byModel) {
  const out = [];
  if (!r.year) return out;
  const pool = byModel.get(PEER_KEY(r)) || [];
  for (const [f, label] of [["bid_price_man", "落札金額"], ["planned_price_man", "予定価格（売値）"]]) {
    const v = r[f];
    if (v == null) continue;
    const peers = pool.filter((p) => p !== r && p[f] != null && p.year && isElectrified(p) === isElectrified(r) && Math.abs(p.year - r.year) <= 1
      && Math.abs((p.mileage_km || 0) - (r.mileage_km || 0)) <= Math.max(20000, 0.5 * (r.mileage_km || 0)));
    const g = gradeKey(r), same = g ? peers.filter((p) => gradeKey(p) === g) : [];
    const sameGrade = same.length >= 4, use = sameGrade ? same : peers;
    if (use.length < 4) continue;
    const m = Math.round(median(use.map((p) => p[f])) * 10) / 10;
    const [hi, lo, abs] = sameGrade ? [1.4, 0.65, 20] : [1.8, 0.5, 30];
    if ((v > m * hi && v - m >= abs) || (v < m * lo && m - v >= abs)) {
      const pct = Math.round((v / m - 1) * 100);
      out.push(["outlier", `${label} ${v}万円 が、似た車${use.length}台（${sameGrade ? "同じグレード・" : ""}${r.year - 1}〜${r.year + 1}年式・距離が近い）の中央値 ${m}万円 より${pct > 0 ? `${pct}%高い` : `${-pct}%安い`}`]);
    }
  }
  return out;
}

function issuesOf(r, dupCount, byModel) {
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
  if (byModel) out.push(...outlierIssues(r, byModel));
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
    const byModel = new Map();
    for (const r of results) { const k = PEER_KEY(r); if (!k) continue; if (!byModel.has(k)) byModel.set(k, []); byModel.get(k).push(r); }
    const items = [];
    let checked = 0;
    for (const r of results) {
      const iss = issuesOf(r, dupCount, byModel);
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
  // 出品票の「確認する数字の場所」（会場ごと・項目ごとに覚える。x,y,w,h は向きを直した画像に対する割合 0〜1）
  if (path === "/api/crop-regions") {
    if (method === "GET") {
      const { results } = await db.prepare("SELECT house, field, x, y, w, h FROM crop_regions").all();
      return json({ regions: results });
    }
    if (method === "PUT") {
      const b = await request.json();
      const n = (v) => Math.min(1, Math.max(0, Number(v)));
      if (!b.house || !b.field || ![b.x, b.y, b.w, b.h].every((v) => Number.isFinite(Number(v))) || !(b.w > 0.005 && b.h > 0.005)) return json({ error: "場所が正しくありません" }, 400);
      await db.prepare("INSERT INTO crop_regions (house, field, x, y, w, h) VALUES (?,?,?,?,?,?) ON CONFLICT(house, field) DO UPDATE SET x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, updated_at=datetime('now','localtime')")
        .bind(String(b.house), String(b.field), n(b.x), n(b.y), n(b.w), n(b.h)).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await db.prepare("DELETE FROM crop_regions WHERE house = ? AND field = ?").bind(url.searchParams.get("house") || "", url.searchParams.get("field") || "").run();
      return json({ ok: true });
    }
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
