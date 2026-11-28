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
  "ALTER TABLE news_items ADD COLUMN ai_kind TEXT",
  "ALTER TABLE news_items ADD COLUMN ai_car TEXT",
  "CREATE INDEX IF NOT EXISTS idx_news_pub ON news_items(published_at)",
  "CREATE TABLE IF NOT EXISTS app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
];

export const NEWS_FEEDS = [
  { id: "response", name: "レスポンス", url: "https://response.jp/rss/index.rdf", color: "#d7262c" },
  { id: "cartop", name: "WEB CARTOP", url: "https://www.webcartop.jp/feed/", color: "#1565c0" },
  { id: "kuruma", name: "くるまのニュース", url: "https://kuruma-news.jp/feed", color: "#2e7d32" },
  { id: "bestcar", name: "ベストカーWeb", url: "https://bestcarweb.jp/feed", color: "#ef6c00" },
  { id: "nikkan", name: "日刊自動車新聞", url: "https://www.netdenjd.com/feed", color: "#6a1b9a" },
  { id: "toyota", name: "トヨタ公式", url: "https://global.toyota/export/jp/allnews_rss.xml", color: "#eb0a1e" },
  { id: "autoprove", name: "AUTOPROVE", url: "https://autoprove.net/feed/", color: "#37474f" },
  { id: "motorfan", name: "Motor-Fan", url: "https://motor-fan.jp/feed/", color: "#5d4037" },
  { id: "autocar", name: "AUTOCAR", url: "https://www.autocar.jp/feed", color: "#00695c" },
  { id: "motorcars", name: "MOTOR CARS", url: "https://motorcars.jp/feed", color: "#455a64" },
  { id: "carsmeet", name: "Carsmeet", url: "https://carsmeet.jp/feed/", color: "#ad1457" },
  { id: "nissan", name: "日産公式", url: "https://global.nissannews.com/ja-JP/rss", color: "#c3002f" },
  { id: "daihatsu", name: "ダイハツ公式", url: "https://www.daihatsu.com/jp/rss.xml", color: "#e60012" },
  { id: "carwatch", name: "Car Watch", url: "https://car.watch.impress.co.jp/data/rss/1.0/car/feed.rdf", color: "#00838f" },
];

const STALE_MS = 30 * 60 * 1000; // 30分たったら取り直す
const KEEP_DAYS = 14;

// 見出しと要約から分類する（上から順に最初に当たったもの）
const CATEGORIES = [
  ["supply", "需給（生産・受注）", /生産終了|生産停止|生産中止|生産を終了|生産打ち切り|販売終了|販売を終了|販売停止|販売中止|受注停止|受注終了|受注を停止|受注を終了|受注再開|受注を再開|注文受付|注文の受付|受付停止|受付終了|オーダーストップ|出荷停止|供給停止|供給不足|納期遅延|納期長期化|減産|増産|廃止|廃盤|絶版|ラストモデル|最終モデル|ファイナル/],
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
    const rawTitle = strip(tag(it, "title")), title = feed.id === "daihatsu" ? rawTitle.replace(/^\d{4}-\d{2}-\d{2}\s+(\[[^\]]*\]\s*)?/, "") : rawTitle;
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
    // 日付のないフィード（ダイハツ）は、見出しの先頭の「2026-11-27」を使う
    const tm = rawTitle.match(/^(\d{4})-(\d{2})-(\d{2})\s/);
    const d = new Date(tag(it, "pubDate") || tag(it, "dc:date") || (tm ? `${tm[1]}-${tm[2]}-${tm[3]}T09:00:00+09:00` : Date.now()));
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
      const items = parseFeed(await res.text(), f).slice(0, 40);
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
  [/生産終了|生産停止|生産中止|販売終了|販売停止|受注停止|受注終了|受注再開|注文受付|オーダーストップ|出荷停止|供給停止|減産|廃止|ラストモデル|最終モデル/, 8],
  [/新車販売|登録台数|販売台数|納期|値上げ|価格改定/, 2],
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
  const { results } = await db.prepare(`SELECT url, title, summary, body FROM news_items WHERE (ai_title IS NULL OR COALESCE(ai_ver,0) < 2 OR (COALESCE(ai_ver,0) < 3 AND category = 'supply')) AND COALESCE(ai_tries,0) < 2 AND published_at > ?
    ORDER BY (CASE WHEN title LIKE '%生産%' OR title LIKE '%受注%' OR title LIKE '%オークション%' OR title LIKE '%相場%' OR title LIKE '%新型%' OR title LIKE '%モデルチェンジ%' OR title LIKE '%改良%' THEN 1 ELSE 0 END) DESC, score DESC, published_at DESC LIMIT ?`).bind(new Date(Date.now() - 4 * 864e5).toISOString(), n).all();
  let done = 0;
  for (const it of results) {
    let text = it.body && it.body.length > 120 ? it.body : `${it.summary || ""} ${await articleText(it.url)}`.trim();
    const prompt = `次の自動車ニュースを、中古車販売店の社長が10秒で分かるように日本語でまとめてください。
必ず次のJSONだけを返してください（説明やコードブロックは不要）：
{"kind":"記事の種類を次から1つ：stop（生産終了・販売終了・受注停止・受付終了・出荷停止・供給停止）／resume（受注再開・販売再開・生産再開）／model（新型・モデルチェンジ・一部改良・新発売）／price（値上げ・価格改定）／market（中古車相場・オークション・販売台数・業界動向）／none（クルマの売り買いや需給に関係ない話題。道路・ラジオ・バイク・レースなど）","car":"主な車種名（例：ライズ、N-BOX。複数あれば最も中心の1つ。無ければ空文字）","title":"何が起きたかが一目で分かる見出し（30字以内。車種名・メーカー・数字（台数・金額・時期）を入れ、あおり表現・疑問形・「〜とは？」は使わない）","points":["要点1（40字以内）","要点2（40字以内）","要点3（40字以内、無ければ省略可）"]}
見出しの良い例：「日産、軽の新型EVを来春発売へ 価格は約250万円」「テスラ サイバートラック、2027年に生産終了の報道」「USS 10月の出品台数16％増、成約率は低下」

元の見出し：${it.title}
本文：${text || "（本文なし。見出しから分かる範囲でまとめる）"}`;
    let out = null;
    try {
      const r = await env.AI.run(env.NEWS_AI_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct", { messages: [{ role: "user", content: prompt }], max_tokens: 400, temperature: 0.2 });
      const raw = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? "");
      const m = raw.match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : null;
      if (j && j.title && Array.isArray(j.points)) out = { kind: ["stop", "resume", "model", "price", "market", "none"].includes(j.kind) ? j.kind : "market", car: String(j.car || "").slice(0, 30), title: String(j.title).slice(0, 50), points: j.points.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 3) };
    } catch {}
    if (out) {
      await db.prepare("UPDATE news_items SET ai_title = ?, ai_points = ?, ai_ver = 3, ai_kind = ?, ai_car = ? WHERE url = ?").bind(out.title, JSON.stringify(out.points), out.kind, out.car, it.url).run();
      done++;
    } else await db.prepare("UPDATE news_items SET ai_tries = COALESCE(ai_tries,0) + 1 WHERE url = ?").bind(it.url).run();
    used++;
  }
  await db.prepare("INSERT INTO app_settings (key, value) VALUES ('news_ai_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ day, n: used })).run();
  return done;
}

export async function handleNews(request, env, url, ctx) {
  if (request.method !== "GET") return null;
  // タブのバッジ用：直近3日の「需給（生産・受注）」の記事の数
  if (url.pathname === "/api/news/badge") {
    await ensureNewsSchema(env.DB);
    const since = new Date(Date.now() - 3 * 864e5).toISOString();
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM news_items WHERE category = 'supply' AND COALESCE(ai_kind, '') <> 'none' AND published_at >= ?").bind(since).first();
    return json({ supply: r ? r.n : 0 });
  }
  if (url.pathname !== "/api/news") return null;
  const db = env.DB;
  await ensureNewsSchema(db);
  const meta = await db.prepare("SELECT value FROM app_settings WHERE key = 'news_fetched'").first();
  let fetched = meta ? JSON.parse(meta.value) : null;
  const force = url.searchParams.get("force") === "1";
  const stale = !fetched || Date.now() - Date.parse(fetched.at) > STALE_MS;
  if (force || !fetched) {
    // はじめて／手動のときだけ、取り終わるまで待つ
    const status = await refreshNews(env);
    fetched = { at: new Date().toISOString(), status };
  } else if (stale && ctx && ctx.waitUntil) {
    // 古いときは、今ある記事をすぐ返して、裏で取り直す（表示を待たせない）
    ctx.waitUntil(refreshNews(env).catch(() => {}));
  }
  // まとめていない記事があれば、裏で少しずつ AI にまとめさせる（画面は待たない）
  if (ctx?.waitUntil) ctx.waitUntil(summarizeNews(env, 12).catch(() => {}));
  const { results } = await db.prepare("SELECT url, source, title, summary, image, published_at, category, score, ai_title, ai_points, ai_kind, ai_car FROM news_items ORDER BY published_at DESC LIMIT 400").all();
  for (const r of results) r.ai_points = r.ai_points ? JSON.parse(r.ai_points) : null;
  return json({ items: results, fetched_at: fetched.at, status: fetched.status, sources: NEWS_FEEDS.map(({ id, name, color }) => ({ id, name, color })), categories: NEWS_CATEGORY_LABELS });
}
