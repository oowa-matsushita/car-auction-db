import { json } from "./util.js";

// ---- 自動車ニュース（各メディアが公開している RSS から見出しを自動で集める） ----------------
// 記事の本文は取り込まず、見出し・要約・画像・リンクだけを出す（クリックで各メディアの記事を開く）
export const NEWS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS news_items ( url TEXT PRIMARY KEY, source TEXT, title TEXT, summary TEXT, image TEXT, published_at TEXT, category TEXT, fetched_at TEXT DEFAULT (datetime('now')) )",
  "ALTER TABLE news_items ADD COLUMN body TEXT",
  "ALTER TABLE news_items ADD COLUMN score INTEGER DEFAULT 0",
  "ALTER TABLE news_items ADD COLUMN ai_title TEXT",
  "ALTER TABLE news_items ADD COLUMN ai_points TEXT",
  "ALTER TABLE news_items ADD COLUMN ai_tries INTEGER DEFAULT 0",
  "ALTER TABLE news_items ADD COLUMN ai_ver INTEGER DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS idx_news_pub ON news_items(published_at)",
  "CREATE TABLE IF NOT EXISTS app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
];

export const NEWS_FEEDS = [
  { id: "response", name: "レスポンス", url: "https://response.jp/rss/index.rdf", color: "#d7262c" },
  { id: "cartop", name: "WEB CARTOP", url: "https://www.webcartop.jp/feed/", color: "#1565c0" },
  { id: "kuruma", name: "くるまのニュース", url: "https://kuruma-news.jp/feed", color: "#2e7d32" },
  { id: "bestcar", name: "ベストカーWeb", url: "https://bestcarweb.jp/feed", color: "#ef6c00" },
  { id: "nikkan", name: "日刊自動車新聞", url: "https://www.netdenjd.com/feed", color: "#6a1b9a" },
  { id: "carwatch", name: "Car Watch", url: "https://car.watch.impress.co.jp/data/rss/1.0/car/feed.rdf", color: "#00838f" },
];

const STALE_MS = 30 * 60 * 1000; // 30分たったら取り直す
const KEEP_DAYS = 14;

// 見出しと要約から分類する（上から順に最初に当たったもの）
const CATEGORIES = [
  ["used", "中古車・相場", /中古|相場|オークション|買取|下取|残価|リセール|値落ち|販売店|ディーラー/],
  ["recall", "リコール", /リコール|改善対策|不具合|無償修理/],
  ["ev", "EV・電動", /EV|電気自動車|ハイブリッド|PHEV|PHV|充電|電動|e:HEV|燃料電池|水素/],
  ["new", "新型・発売", /新型|発売|発表|フルモデルチェンジ|マイナーチェンジ|一部改良|特別仕様|限定車|登場|受注/],
  ["industry", "業界・販売", /販売台数|登録台数|新車販売|決算|生産|値上げ|価格改定|業界|メーカー|関税|補助金|税制/],
];
export function categorize(text) {
  const t = String(text || "").normalize("NFKC");
  return (CATEGORIES.find(([, , re]) => re.test(t)) || ["other"])[0];
}
export const NEWS_CATEGORY_LABELS = Object.fromEntries([...CATEGORIES.map(([k, l]) => [k, l]), ["other", "その他"]]);

const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]).trim() : ""; };
const strip = (html) => decode(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function parseFeed(xml, feed) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0];
    const title = strip(tag(it, "title"));
    let link = tag(it, "link") || (it.match(/rdf:about="([^"]+)"/) || [])[1] || "";
    link = decode(link).trim();
    if (!title || !/^https?:\/\//.test(link)) continue;
    const descRaw = tag(it, "description") || tag(it, "content:encoded");
    const img = (it.match(/<(?:media:content|media:thumbnail|enclosure)[^>]+url="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i) || [])[1]
      || (decode(descRaw).match(/<img[^>]+src="([^"]+)"/i) || [])[1] || "";
    let summary = strip(descRaw).replace(/^この記事をまとめると\s*/, "");
    let t = title;
    // 要約用の本文（RSS に本文があるメディアだけ。最大1500字）
    const body = strip(tag(it, "content:encoded") || descRaw).slice(0, 1500);
    if (summary.length > 120) summary = summary.slice(0, 120) + "…";
    const d = new Date(tag(it, "pubDate") || tag(it, "dc:date") || Date.now());
    out.push({
      url: link, source: feed.id, title: t, summary, image: /^https:\/\//.test(img) ? img : "",
      published_at: (isNaN(d) ? new Date() : d).toISOString(), category: categorize(t + " " + summary), body, score: interestScore(t + " " + body),
    });
  }
  return out;
}

export async function refreshNews(env) {
  const db = env.DB;
  await ensureNewsSchema(db);
  const results = await Promise.all(NEWS_FEEDS.map(async (f) => {
    try {
      const res = await fetch(f.url, { headers: { "user-agent": "Mozilla/5.0 (compatible; MMS-news/1.0)", accept: "application/rss+xml, application/xml, text/xml" }, cf: { cacheTtl: 300 } });
      if (!res.ok) return { id: f.id, ok: false, error: `HTTP ${res.status}` };
      const items = parseFeed(await res.text(), f);
      return { id: f.id, ok: true, items };
    } catch (e) { return { id: f.id, ok: false, error: String(e?.message || e) }; }
  }));
  const stmts = [];
  for (const r of results) for (const it of r.items || []) {
    stmts.push(db.prepare("INSERT INTO news_items (url, source, title, summary, image, published_at, category, body, score) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title, summary=excluded.summary, image=CASE WHEN excluded.image <> '' THEN excluded.image ELSE news_items.image END, category=excluded.category, body=CASE WHEN excluded.body <> '' THEN excluded.body ELSE news_items.body END, score=excluded.score")
      .bind(it.url, it.source, it.title, it.summary, it.image, it.published_at, it.category, it.body, it.score));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  await db.prepare(`DELETE FROM news_items WHERE published_at < ?`).bind(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString()).run();
  const status = Object.fromEntries(results.map((r) => [r.id, r.ok ? { ok: true, count: r.items.length } : { ok: false, error: r.error }]));
  await db.prepare("INSERT INTO app_settings (key, value) VALUES ('news_fetched', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')")
    .bind(JSON.stringify({ at: new Date().toISOString(), status })).run();
  return status;
}

let newsSchemaOk = false;
async function ensureNewsSchema(db) {
  if (newsSchemaOk) return;
  for (const q of NEWS_SCHEMA) await db.prepare(q).run().catch(() => {}); // ALTER は2回目以降エラーになるので無視
  await db.prepare("DELETE FROM news_items WHERE source LIKE 'g\\_%' ESCAPE '\\'").run().catch(() => {}); // 以前の Google ニュース分は消す
  newsSchemaOk = true;
}

// ---- 中古車・オークションの仕事に関係しそうな「おすすめ度」 --------------------------------
const INTEREST = [
  [/オートオークション|業者オークション|USS|オークション会場|AA会場|TAA|CAA|JU|HAA|アイオーク/, 6],
  [/オークション|落札|出品台数|成約率/, 5],
  [/中古車|中古/, 4], [/相場|価格動向|値上がり|値下がり|高騰|下落/, 4],
  [/買取|下取|査定|業販|輸出|残価|リセール/, 3],
  [/新車販売|登録台数|販売台数|受注停止|納期|値上げ|価格改定|生産停止/, 2],
  [/補助金|税制|関税|決算|倒産|リコール/, 1],
];
export function interestScore(text) {
  const t = String(text || "").normalize("NFKC");
  return INTEREST.reduce((s, [re, w]) => s + (re.test(t) ? w : 0), 0);
}

// ---- AI（Cloudflare Workers AI）で、見出しと中身を短くまとめる ------------------------------
// おすすめ度の高い記事から順に、まとめていない記事を少しずつまとめる（1日の上限 NEWS_AI_DAILY、既定 300本）
async function articleText(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; MMS-news/1.0)" } });
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 400000);
    const og = decode((html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) || [])[1] || "");
    const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1])).filter((x) => x.length > 30);
    return (og + " " + ps.join(" ")).replace(/\s+/g, " ").slice(0, 1800);
  } catch { return ""; }
}
export async function summarizeNews(env, limit = 10) {
  if (!env.AI) return 0;
  const db = env.DB;
  await ensureNewsSchema(db);
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const cnt = await db.prepare("SELECT value FROM app_settings WHERE key = 'news_ai_count'").first();
  let used = 0;
  if (cnt) { const c = JSON.parse(cnt.value); used = c.day === day ? c.n : 0; }
  const cap = Number(env.NEWS_AI_DAILY) || 300;
  const n = Math.min(limit, cap - used);
  if (n <= 0) return 0;
  const { results } = await db.prepare(`SELECT url, title, summary, body FROM news_items WHERE (ai_title IS NULL OR COALESCE(ai_ver,0) < 2) AND COALESCE(ai_tries,0) < 2 AND published_at > ?
    ORDER BY (CASE WHEN title LIKE '%生産%' OR title LIKE '%受注%' OR title LIKE '%オークション%' OR title LIKE '%相場%' OR title LIKE '%新型%' OR title LIKE '%モデルチェンジ%' OR title LIKE '%改良%' THEN 1 ELSE 0 END) DESC, score DESC, published_at DESC LIMIT ?`).bind(new Date(Date.now() - 4 * 864e5).toISOString(), n).all();
  let done = 0;
  for (const it of results) {
    let text = it.body && it.body.length > 120 ? it.body : `${it.summary || ""} ${await articleText(it.url)}`.trim();
    const prompt = `次の自動車ニュースを、中古車販売店の社長が10秒で分かるように日本語でまとめてください。
必ず次のJSONだけを返してください（説明やコードブロックは不要）：
{"title":"何が起きたかが一目で分かる見出し（30字以内。車種名・メーカー・数字（台数・金額・時期）を入れ、あおり表現・疑問形・「〜とは？」は使わない）","points":["要点1（40字以内）","要点2（40字以内）","要点3（40字以内、無ければ省略可）"]}
見出しの良い例：「日産、軽の新型EVを来春発売へ 価格は約250万円」「テスラ サイバートラック、2027年に生産終了の報道」「USS 10月の出品台数16％増、成約率は低下」

元の見出し：${it.title}
本文：${text || "（本文なし。見出しから分かる範囲でまとめる）"}`;
    let out = null;
    try {
      const r = await env.AI.run(env.NEWS_AI_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct", { messages: [{ role: "user", content: prompt }], max_tokens: 400, temperature: 0.2 });
      const raw = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? "");
      const m = raw.match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : null;
      if (j && j.title && Array.isArray(j.points)) out = { title: String(j.title).slice(0, 50), points: j.points.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 3) };
    } catch {}
    if (out) {
      await db.prepare("UPDATE news_items SET ai_title = ?, ai_points = ?, ai_ver = 2 WHERE url = ?").bind(out.title, JSON.stringify(out.points), it.url).run();
      done++;
    } else await db.prepare("UPDATE news_items SET ai_tries = COALESCE(ai_tries,0) + 1 WHERE url = ?").bind(it.url).run();
    used++;
  }
  await db.prepare("INSERT INTO app_settings (key, value) VALUES ('news_ai_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ day, n: used })).run();
  return done;
}

export async function handleNews(request, env, url, ctx) {
  if (url.pathname !== "/api/news" || request.method !== "GET") return null;
  const db = env.DB;
  await ensureNewsSchema(db);
  const meta = await db.prepare("SELECT value FROM app_settings WHERE key = 'news_fetched'").first();
  let fetched = meta ? JSON.parse(meta.value) : null;
  const force = url.searchParams.get("force") === "1";
  if (force || !fetched || Date.now() - Date.parse(fetched.at) > STALE_MS) {
    const status = await refreshNews(env);
    fetched = { at: new Date().toISOString(), status };
  }
  // まとめていない記事があれば、裏で少しずつ AI にまとめさせる（画面は待たない）
  if (ctx?.waitUntil) ctx.waitUntil(summarizeNews(env, 12).catch(() => {}));
  const { results } = await db.prepare("SELECT url, source, title, summary, image, published_at, category, score, ai_title, ai_points FROM news_items ORDER BY published_at DESC LIMIT 400").all();
  for (const r of results) r.ai_points = r.ai_points ? JSON.parse(r.ai_points) : null;
  return json({ items: results, fetched_at: fetched.at, status: fetched.status, sources: NEWS_FEEDS.map(({ id, name, color }) => ({ id, name, color })), categories: NEWS_CATEGORY_LABELS });
}
