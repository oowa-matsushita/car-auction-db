"use strict";
// ---------- 自動車ニュース（サーバーが各メディアの RSS を自動で集める。30分ごとに新しくなる） ----------
const nw = { items: [], sources: [], categories: {}, cat: "focus", src: "", stockNames: [], loaded: false };
// 注目ニュース（はじめはこれだけ表示）：生産中止・受注停止／オークション・相場／新型・モデルチェンジ
const NW_FOCUS = [
  ["stop", "生産中止・受注停止", /生産(を)?(中止|終了|停止|打ち切)|受注(を)?(停止|終了|再開|一時)|販売(を)?(終了|中止|停止)|出荷(を)?停止|生産終了|一時停止|絶版|ディスコン|廃止/],
  ["auction", "オークション・相場", /オークション|相場|落札|USS|出品台数|成約率|中古車(の)?(価格|市場|流通)|残価|リセール/],
  ["model", "新型・モデルチェンジ", /新型|フルモデルチェンジ|マイナーチェンジ|モデルチェンジ|一部改良|ビッグマイナー|(発売|発表|登場|デビュー|予約開始|先行公開|世界初公開).*(車|SUV|セダン|ミニバン|軽|EV|ハイブリッド|モデル|グレード|仕様|トラック|ワゴン)|(車|SUV|セダン|ミニバン|軽|EV|ハイブリッド|モデル|トラック|ワゴン).*(発売|発表|登場|デビュー|予約開始|世界初公開)/],
];
const nwText = (it) => String((it.ai_title || "") + " " + it.title + " " + (it.summary || "") + " " + (Array.isArray(it.ai_points) ? it.ai_points.join(" ") : "")).normalize("NFKC");
// オートバイ・自動運転サービスなど、中古車販売に関係の薄い話題は注目から外す
const NW_EXCLUDE = /バイク|二輪|スクーター|オートバイ|モーターサイクル|ドゥカティ|アプリリア|ハーレー|トライアンフ|GSX|Ninja|CBR|\d{2,4}cc|ロボタクシー|自動運転タクシー|鉄道|航空|船舶|カーナビ|ドラレコ|タイヤ|チャージャー|カー用品/i;
const nwFocusOf = (it) => (NW_EXCLUDE.test(nwText(it)) ? [] : NW_FOCUS.filter(([, , re]) => re.test(nwText(it))).map(([k]) => k));
const nwMatchCat = (it, k) => !k ? true : k === "focus" ? nwFocusOf(it).length > 0 : NW_FOCUS.some(([fk]) => fk === k) ? nwFocusOf(it).includes(k) : it.category === k;
const nwKey = (s) => String(s || "").normalize("NFKC").toUpperCase().replace(/[\s\-‐－・]/g, "");
async function loadNews(force) {
  if (nw.loaded && !force) return drawNews();
  $("nwInfo").textContent = force ? "最新のニュースを取りに行っています…" : "読み込み中…";
  try {
    const res = await fetch("/api/news" + (force ? "?force=1" : ""));
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    Object.assign(nw, { items: d.items, sources: d.sources, categories: d.categories, status: d.status, fetchedAt: d.fetched_at, loaded: true });
  } catch (e) { $("nwInfo").textContent = "❌ 読み込めませんでした（" + e.message + "）"; return; }
  loadStockNames();
  drawNews();
}
// 在庫の車種（最新の月初在庫で5台以上）の名前。見出しに入っていたら「在庫：〇〇」と出す
async function loadStockNames() {
  if (nw.stockNames.length) return;
  try {
    const t = await (await fetch("/api/turnover?" + tvQs())).json();
    const m = (t.months || []).find((x) => x.item_count);
    if (!m) return;
    const d = await (await fetch(`/api/turnover/${m.month}/models?${tvQs()}`)).json();
    nw.stockNames = d.models.filter((x) => x.opening >= 5 && nwKey(x.name).length >= 2).map((x) => ({ name: x.name, key: nwKey(x.name) }))
      .sort((a, b) => b.key.length - a.key.length);
    drawNews();
  } catch {}
}
const stockOf = (it) => { const k = nwKey(it.title); return nw.stockNames.find((s) => k.includes(s.key)); };
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(1, m)}分前`;
  if (m < 60 * 24) return `${Math.round(m / 60)}時間前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
function drawNews() {
  const q = nwKey($("nwQ").value), onlyStock = $("nwStock").checked;
  // 同じ見出しが複数のメディア（Google 経由など）にあれば1つにまとめる
  const seen = new Set();
  const base = nw.items.filter((it) => { const k = nwKey(it.title).slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((it) => (!q || nwKey(it.title + it.summary).includes(q)) && (!onlyStock || stockOf(it)));
  const count = (f) => base.filter(f).length;
  const src = Object.fromEntries(nw.sources.map((s) => [s.id, s]));
  const chip = ([k, l], cls = "") => `<span class="nw-chip ${cls} ${nw.cat === k ? "on" : ""}" data-cat="${k}">${h(l)}<span class="n">${count((it) => nwMatchCat(it, k) && (!nw.src || it.source === nw.src))}</span></span>`;
  $("nwCats").innerHTML = chip(["focus", "★ 注目（生産中止・相場・新型）"], "focus") + NW_FOCUS.map(([k, l]) => chip([k, l], "sub")).join("")
    + '<span class="nw-sep"></span>' + [["", "すべて"], ...Object.entries(nw.categories)].map((c) => chip(c)).join("");
  $("nwSrcs").innerHTML = [`<span class="nw-chip ${nw.src === "" ? "on" : ""}" data-src="">全メディア</span>`, ...nw.sources.map((s) => {
    const st = nw.status?.[s.id];
    return `<span class="nw-chip ${nw.src === s.id ? "on" : ""}" data-src="${s.id}" title="${st && !st.ok ? "取得できませんでした：" + h(st.error) : ""}"><span class="dot" style="background:${s.color}"></span>${h(s.name)}${st && !st.ok ? " ⚠" : ""}</span>`;
  })].join("");
  const list = base.filter((it) => nwMatchCat(it, nw.cat) && (!nw.src || it.source === nw.src));
  // 1記事＝1行。AIが付けた見出し（無ければ元の見出し）と、要点を1行にまとめて出す
  const card = (it, hot) => {
    const s = src[it.source] || { name: it.source, color: "#13234a" }, st = stockOf(it);
    const fresh = Date.now() - Date.parse(it.published_at) < 6 * 3600e3;
    const pts = Array.isArray(it.ai_points) && it.ai_points.length ? it.ai_points : null;
    const tags = nwFocusOf(it).map((k) => `<span class="fcs ${k}">${h(NW_FOCUS.find((f) => f[0] === k)[1])}</span>`).join("") || `<span class="cat">${h(nw.categories[it.category] || "その他")}</span>`;
    const detail = [pts ? pts.join(" ／ ") : (it.summary && !it.summary.startsWith("出典") ? it.summary : ""), `元の見出し：${it.title}`].filter(Boolean).join("\n");
    return `<a class="nw-row ${hot ? "hot" : ""}" href="${h(it.url)}" target="_blank" rel="noopener noreferrer" style="--c:${s.color}" title="${h(detail)}">
      <span class="when">${fresh ? '<b class="new">NEW</b>' : ""}${ago(it.published_at)}</span>
      <span class="tg">${hot ? '<span class="hot-b">おすすめ</span>' : ""}${tags}</span>
      <span class="ti"><b class="${it.ai_title ? "ai" : "wait"}">${h(it.ai_title || it.title)}</b>${pts ? `<span class="pt">${h(pts.join(" ／ "))}</span>` : it.ai_title ? "" : '<span class="pt wait">（AIが見出しを作っています）</span>'}${st ? `<span class="stk">📦 在庫：${h(st.name)}</span>` : ""}</span>
      <span class="sr"><span class="src" style="background:${s.color}">${h(s.name)}</span></span></a>`;
  };
  // おすすめ：中古車・オークションなど仕事に関係しそうな記事（直近7日・おすすめ度の高い順に6本）
  const picks = !nw.cat && !nw.src && !q ? base.filter((it) => (it.score || 0) + (stockOf(it) ? 2 : 0) >= 4 && Date.now() - Date.parse(it.published_at) < 7 * 864e5)
    .sort((a, b) => ((b.score || 0) + (stockOf(b) ? 2 : 0)) - ((a.score || 0) + (stockOf(a) ? 2 : 0)) || b.published_at.localeCompare(a.published_at)).slice(0, 6) : [];
  $("nwPick").hidden = !picks.length;
  $("nwPick").innerHTML = picks.length ? `<h3>⭐ おすすめ（中古車・オークション・相場など）</h3><div class="nw-rows">${picks.map((it) => card(it, true)).join("")}</div>` : "";
  const pickSet = new Set(picks.map((x) => x.url));
  $("nwList").innerHTML = '<div class="nw-rows">' + list.filter((it) => !pickSet.has(it.url)).slice(0, 300).map((it) => card(it, false)).join("") + "</div>";
  $("nwEmpty").hidden = list.length > 0;
  const t = nw.fetchedAt ? new Date(nw.fetchedAt) : null;
  $("nwInfo").textContent = `${list.length}件` + (t ? `｜最終取得 ${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}（30分ごとに自動で更新）` : "");
}
$("nwCats").addEventListener("click", (e) => { const c = e.target.closest("[data-cat]"); if (c) { nw.cat = c.dataset.cat; drawNews(); } });
$("nwSrcs").addEventListener("click", (e) => { const c = e.target.closest("[data-src]"); if (c) { nw.src = c.dataset.src; drawNews(); } });
$("nwQ").addEventListener("input", drawNews);
$("nwStock").addEventListener("change", drawNews);
$("nwReload").onclick = () => loadNews(true);
if (!$("tab-news").hidden) loadNews();
