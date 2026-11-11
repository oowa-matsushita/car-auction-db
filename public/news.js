"use strict";
// ---------- 自動車ニュース（サーバーが各メディアの RSS を自動で集める。30分ごとに新しくなる） ----------
const nw = { items: [], sources: [], categories: {}, cat: "", src: "", stockNames: [], loaded: false };
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
  $("nwCats").innerHTML = [["", "すべて"], ...Object.entries(nw.categories)].map(([k, l]) =>
    `<span class="nw-chip ${nw.cat === k ? "on" : ""}" data-cat="${k}">${h(l)}<span class="n">${count((it) => (!k || it.category === k) && (!nw.src || it.source === nw.src))}</span></span>`).join("");
  $("nwSrcs").innerHTML = [`<span class="nw-chip ${nw.src === "" ? "on" : ""}" data-src="">全メディア</span>`, ...nw.sources.map((s) => {
    const st = nw.status?.[s.id];
    return `<span class="nw-chip ${nw.src === s.id ? "on" : ""}" data-src="${s.id}" title="${st && !st.ok ? "取得できませんでした：" + h(st.error) : ""}"><span class="dot" style="background:${s.color}"></span>${h(s.name)}${st && !st.ok ? " ⚠" : ""}</span>`;
  })].join("");
  const list = base.filter((it) => (!nw.cat || it.category === nw.cat) && (!nw.src || it.source === nw.src));
  const card = (it, hot) => {
    const s = src[it.source] || { name: it.source, color: "#13234a" }, st = stockOf(it);
    const fresh = Date.now() - Date.parse(it.published_at) < 6 * 3600e3;
    const pts = Array.isArray(it.ai_points) && it.ai_points.length ? it.ai_points : null;
    return `<a class="nw-card" href="${h(it.url)}" target="_blank" rel="noopener noreferrer" style="--c:${s.color}">
      ${it.image ? `<div class="img" style="background-image:url('${h(it.image)}')"></div>` : `<div class="img ph">${h(s.name)}</div>`}
      <div class="in">
        <div class="meta"><span class="src">${h(s.name)}</span>${hot ? '<span class="hot">おすすめ</span>' : ""}${fresh ? '<span class="new">NEW</span>' : ""}<span class="cat">${h(nw.categories[it.category] || "その他")}</span><span>${ago(it.published_at)}</span></div>
        <div class="t">${h(it.ai_title || it.title)}</div>
        ${it.ai_title ? `<div class="orig">元の見出し：${h(it.title)}</div>` : ""}
        ${pts ? `<ul class="pts">${pts.map((p) => `<li>${h(p)}</li>`).join("")}</ul><span class="ai">AIのまとめ</span>`
          : `${it.summary && !it.summary.startsWith("出典") ? `<div class="s">${h(it.summary)}</div>` : ""}<span class="wait">（AIのまとめは順番に作っています）</span>`}
        ${st ? `<span class="stock">📦 在庫の車種：${h(st.name)}</span>` : ""}
      </div></a>`;
  };
  // おすすめ：中古車・オークションなど仕事に関係しそうな記事（直近7日・おすすめ度の高い順に6本）
  const picks = !nw.cat && !nw.src && !q ? base.filter((it) => (it.score || 0) + (stockOf(it) ? 2 : 0) >= 4 && Date.now() - Date.parse(it.published_at) < 7 * 864e5)
    .sort((a, b) => ((b.score || 0) + (stockOf(b) ? 2 : 0)) - ((a.score || 0) + (stockOf(a) ? 2 : 0)) || b.published_at.localeCompare(a.published_at)).slice(0, 6) : [];
  $("nwPick").hidden = !picks.length;
  $("nwPick").innerHTML = picks.length ? `<h3>⭐ おすすめ（中古車・オークション・相場など）</h3><div class="nw-grid">${picks.map((it) => card(it, true)).join("")}</div>` : "";
  const pickSet = new Set(picks.map((x) => x.url));
  $("nwList").innerHTML = list.filter((it) => !pickSet.has(it.url)).slice(0, 200).map((it) => card(it, false)).join("");
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
