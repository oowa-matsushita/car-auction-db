import { json } from "./util.js";

// ---- 自動車ニュース（各メディアが公開している RSS から見出しを自動で集める） ----------------
// 記事の本文は取り込まず、見出し・要約・画像・リンクだけを出す（クリックで各メディアの記事を開く）
export const NEWS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS news_items ( url TEXT PRIMARY KEY, source TEXT, title TEXT, summary TEXT, image TEXT, published_at TEXT, category TEXT, fetched_at TEXT DEFAULT (datetime('now')) )",
  "CREATE INDEX IF NOT EXISTS idx_news_pub ON news_items(published_at)",
  "CREATE TABLE IF NOT EXISTS app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')) )",
];

export const NEWS_FEEDS = [
  { id: "response", name: "レスポンス", url: "https://response.jp/rss/index.rdf", color: "#d7262c" },
  { id: "cartop", name: "WEB CARTOP", url: "https://www.webcartop.jp/feed/", color: "#1565c0" },
  { id: "kuruma", name: "くるまのニュース", url: "https://kuruma-news.jp/feed", color: "#2e7d32" },
  { id: "bestcar", name: "ベストカーWeb", url: "https://bestcarweb.jp/feed", color: "#ef6c00" },
  // Google ニュース（個人利用）。テーマごとに検索して、直近1週間の記事を集める
  ...[
    ["g_used", "Google：中古車", "中古車 OR 中古車相場 OR 中古車販売"],
    ["g_auction", "Google：オークション", "オートオークション OR USS OR 業者オークション"],
    ["g_industry", "Google：自動車業界", "新車販売 OR 自動車業界 OR 登録台数"],
  ].map(([id, name, q]) => ({ id, name, google: true, color: "#5f6368", url: `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=ja&gl=JP&ceid=JP:ja` })),
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
    if (feed.google) {
      // Google ニュースは「見出し - 媒体名」。媒体名は要約欄に出す
      const pub = strip(tag(it, "source"));
      if (pub && t.endsWith(" - " + pub)) t = t.slice(0, -(pub.length + 3));
      summary = pub ? `出典：${pub}` : "";
      if (out.length >= 40) break;
    }
    if (summary.length > 120) summary = summary.slice(0, 120) + "…";
    const d = new Date(tag(it, "pubDate") || tag(it, "dc:date") || Date.now());
    out.push({
      url: link, source: feed.id, title: t, summary, image: /^https:\/\//.test(img) ? img : "",
      published_at: (isNaN(d) ? new Date() : d).toISOString(), category: feed.id === "g_auction" || feed.id === "g_used" ? (categorize(t) === "other" ? "used" : categorize(t)) : categorize(t + " " + summary),
    });
  }
  return out;
}

export async function refreshNews(env) {
  const db = env.DB;
  for (const q of NEWS_SCHEMA) await db.prepare(q).run();
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
    stmts.push(db.prepare("INSERT INTO news_items (url, source, title, summary, image, published_at, category) VALUES (?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title, summary=excluded.summary, image=CASE WHEN excluded.image <> '' THEN excluded.image ELSE news_items.image END, category=excluded.category")
      .bind(it.url, it.source, it.title, it.summary, it.image, it.published_at, it.category));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  await db.prepare(`DELETE FROM news_items WHERE published_at < ?`).bind(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString()).run();
  const status = Object.fromEntries(results.map((r) => [r.id, r.ok ? { ok: true, count: r.items.length } : { ok: false, error: r.error }]));
  await db.prepare("INSERT INTO app_settings (key, value) VALUES ('news_fetched', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')")
    .bind(JSON.stringify({ at: new Date().toISOString(), status })).run();
  return status;
}

export async function handleNews(request, env, url) {
  if (url.pathname !== "/api/news" || request.method !== "GET") return null;
  const db = env.DB;
  for (const q of NEWS_SCHEMA) await db.prepare(q).run();
  const meta = await db.prepare("SELECT value FROM app_settings WHERE key = 'news_fetched'").first();
  let fetched = meta ? JSON.parse(meta.value) : null;
  const force = url.searchParams.get("force") === "1";
  if (force || !fetched || Date.now() - Date.parse(fetched.at) > STALE_MS) {
    const status = await refreshNews(env);
    fetched = { at: new Date().toISOString(), status };
  }
  const { results } = await db.prepare("SELECT url, source, title, summary, image, published_at, category FROM news_items ORDER BY published_at DESC LIMIT 300").all();
  return json({ items: results, fetched_at: fetched.at, status: fetched.status, sources: NEWS_FEEDS.map(({ id, name, color }) => ({ id, name, color })), categories: NEWS_CATEGORY_LABELS });
}
