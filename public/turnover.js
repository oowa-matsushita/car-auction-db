"use strict";
// ---------- タブの切り替え（#ledger / #turnover） ----------
const TABS = ["ledger", "turnover", "review"];
function showTab(name) {
  if (!TABS.includes(name)) name = "ledger";
  for (const t of TABS) document.getElementById("tab-" + t).hidden = t !== name;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "turnover") loadTurnover();
  if (name === "review") loadReview();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ---------- 回転率 ----------
// 数える販売（小売＋業販 / 小売のみ / 業販のみ）。選んだものはこのブラウザに覚えておく
const tvCh = () => $("tvCh").value;
const tvQs = () => `ch=${tvCh()}&tax=${$("tvTax").value}`;
const man1 = (v) => (v == null ? "—" : (v / 10000).toFixed(1) + "万円");
try { const v = localStorage.getItem("tvTax"); if (v) $("tvTax").value = v; } catch {}
$("tvTax").onchange = () => { try { localStorage.setItem("tvTax", $("tvTax").value); } catch {} $("tvChartCard").hidden = true; loadTurnover(); };
try { const v = localStorage.getItem("tvCh"); if (v) $("tvCh").value = v; } catch {}
$("tvCh").onchange = () => { try { localStorage.setItem("tvCh", tvCh()); } catch {} $("tvChartCard").hidden = true; loadTurnover(); };
const yen = (v) => (v == null ? "" : Number(v).toLocaleString() + "円");
const pct = (r) => (r == null ? "—" : (r * 100).toFixed(1) + "%");
const monthLabel = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const tvLog = (s) => ($("tvLog").textContent = s);

let tvMonth = null, tvModels = [];
// 条件を続けて変えたとき、古い結果で上書きしないよう、最新の読み込みだけを使う
let tvLoadSeq = 0, tvModelSeq = 0;
async function loadTurnover() {
  const seq = ++tvLoadSeq;
  loadHistory();
  let data;
  try {
    const res = await fetch("/api/turnover?" + tvQs());
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
  } catch (e) { tvLog("❌ 読み込みに失敗しました: " + e.message); return; }
  if (seq !== tvLoadSeq) return;
  const months = data.months || [];
  const maxRate = Math.max(0.0001, ...months.map((m) => m.rate || 0));
  $("tvEmpty").hidden = months.length > 0;
  $("tvRows").innerHTML = months.map((m) => `
    <tr data-month="${m.month}" class="${m.month === tvMonth ? "sel" : ""}" style="cursor:pointer" title="押すと車名ごとの回転率を表示">
      <td><b>${monthLabel(m.month)}</b></td>
      <td class="n">${m.item_count == null ? '<span class="tv-dim">未登録</span>' : m.item_count.toLocaleString() + "台"}</td>
      <td class="n">${m.sold == null ? '<span class="tv-dim">未登録</span>'
        : `<span class="tv-link" data-sales="${m.month}" title="販売データの一覧を見る">${m.sold.toLocaleString()}台</span>`
          + (m.sold_retail || m.sold_wholesale ? `<div class="tv-dim" style="font-size:11px">小売 ${m.sold_retail} / 業販 ${m.sold_wholesale}</div>` : "")}</td>
      <td class="n tv-rate">${pct(m.rate)}</td>
      <td class="n"><b>${man1(m.gross_avg)}</b>${m.gross_total != null ? `<div class="tv-dim" style="font-size:11px">合計 ${Math.round(m.gross_total / 10000).toLocaleString()}万円</div>` : ""}</td>
      <td><div class="tv-bar" style="width:${m.rate == null ? 0 : Math.max(2, (m.rate / maxRate) * 150)}px"></div></td>
      <td style="white-space:nowrap">${m.item_count == null ? "" : `<button class="btn btn-sub" data-del="${m.month}" style="padding:2px 6px">在庫</button>`}
        ${m.sold == null ? "" : `<button class="btn btn-sub" data-delsales="${m.month}" style="padding:2px 6px">販売</button>`}</td>
    </tr>`).join("");
  // 最初は、月初在庫と販売データがそろっている一番新しい月を表示
  if (!tvMonth || !months.some((m) => m.month === tvMonth)) {
    const first = months.find((m) => m.rate != null) || months[0];
    if (first) showModels(first.month); else $("tvModelCard").hidden = true;
  } else showModels(tvMonth);
}

async function showModels(month) {
  tvMonth = month;
  document.querySelectorAll("#tvRows tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.month === month));
  const seq = ++tvModelSeq;
  const res = await fetch(`/api/turnover/${month}/models?${tvQs()}`);
  const j = await res.json();
  if (seq !== tvModelSeq) return;
  if (!res.ok) return tvLog("❌ " + (j.error || "読み込みに失敗しました"));
  tvModels = j.models;
  $("tvModelTitle").textContent = `車名ごとの回転率（${monthLabel(month)}）`;
  $("tvModelCard").hidden = false;
  drawModels();
}
// 並べ替え（見出しを押すたびに 降順 ⇔ 昇順。値が無いものはいつも最後）
const tvSort = { key: "rate", dir: "desc" };
$("tvModelHead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const k = th.dataset.sort;
  if (tvSort.key === k) tvSort.dir = tvSort.dir === "desc" ? "asc" : "desc";
  else { tvSort.key = k; tvSort.dir = k === "name" ? "asc" : "desc"; }
  drawModels();
});
// ---------- 天気（回転率と平均台粗利の組み合わせ） ----------
// 回転率：40%以上=3、35%以上=2、30%以上=1、それ未満=0
// 台粗利：15万以上=3、10万以上=2、5万以上=1、それ未満=0
// 合計 6=快晴、4〜5=晴れ、3=曇り、1〜2=雨、0=台風
const WEATHER = [
  { min: 6, icon: "☀️", label: "快晴" },
  { min: 4, icon: "🌤️", label: "晴れ" },
  { min: 3, icon: "☁️", label: "曇り" },
  { min: 1, icon: "🌧️", label: "雨" },
  { min: 0, icon: "🌀", label: "台風" },
];
const rateScore = (r) => (r >= 0.4 ? 3 : r >= 0.35 ? 2 : r >= 0.3 ? 1 : 0);
const grossScore = (g) => (g >= 150000 ? 3 : g >= 100000 ? 2 : g >= 50000 ? 1 : 0);
function weatherOf(m) {
  if (m.rate == null || m.gross_avg == null) return null;
  const score = rateScore(m.rate) + grossScore(m.gross_avg);
  return { score, ...WEATHER.find((w) => score >= w.min) };
}

function sortModels(list) {
  const { key, dir } = tvSort, sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const val = (m) => (key === "weather" ? weatherOf(m)?.score ?? null : m[key]);
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = key === "name" ? String(va).localeCompare(String(vb), "ja") : va - vb;
    return c * sign || b.sold - a.sold || a.name.localeCompare(b.name, "ja");
  });
}
function drawModels() {
  document.querySelectorAll("#tvModelHead th").forEach((th) => {
    const on = th.dataset.sort === tvSort.key;
    th.classList.toggle("on", on);
    th.textContent = th.textContent.replace(/ [▼▲]$/, "") + (on ? (tvSort.dir === "desc" ? " ▼" : " ▲") : "");
  });
  const q = $("tvModelFilter").value.trim().normalize("NFKC").toUpperCase().replace(/[\s\-‐－]/g, "");
  const list = sortModels(tvModels).filter((m) => !q || m.name.normalize("NFKC").toUpperCase().replace(/[\s\-‐－]/g, "").includes(q));
  $("tvModelRows").innerHTML = list.map((m) => `<tr data-key="${h(m.key)}">
    <td>${h(m.name)}</td>
    <td class="n">${m.opening.toLocaleString()}台</td>
    <td class="n">${m.sold.toLocaleString()}台</td>
    <td class="n tv-rate">${m.rate == null ? '<span class="tv-dim" style="font-size:12px;font-weight:400">月初在庫なし</span>' : pct(m.rate)}</td>
    <td class="n">${man1(m.gross_avg)}</td>
    ${(() => { const w = weatherOf(m); return w
      ? `<td class="tv-wx" title="${w.label}（回転率${rateScore(m.rate)}点＋台粗利${grossScore(m.gross_avg)}点＝${w.score}点）"><span>${w.icon}</span>${w.label}</td>`
      : '<td class="tv-wx tv-dim" title="月初在庫か台粗利が無いため判定できません">—</td>'; })()}
  </tr>`).join("") || '<tr><td colspan="6" class="tv-dim">該当する車がありません</td></tr>';
}
$("tvModelFilter").addEventListener("input", drawModels);

$("tvRows").addEventListener("click", async (e) => {
  const sales = e.target.closest("[data-sales]");
  if (sales) return showSales(sales.dataset.sales);
  const ds = e.target.closest("[data-delsales]");
  if (ds) {
    if (!confirm(`${monthLabel(ds.dataset.delsales)}の販売データを削除しますか？`)) return;
    await fetch(`/api/sales/${ds.dataset.delsales}`, { method: "DELETE" });
    $("tvSoldCard").hidden = true;
    return loadTurnover();
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    if (!confirm(`${monthLabel(del.dataset.del)}の月初在庫を削除しますか？`)) return;
    await fetch(`/api/inventory/${del.dataset.del}`, { method: "DELETE" });
    $("tvSoldCard").hidden = true;
    return loadTurnover();
  }
  const tr = e.target.closest("tr[data-month]");
  if (tr) showModels(tr.dataset.month);
});

async function showSales(month) {
  const res = await fetch(`/api/turnover/${month}/sales?${tvQs()}`);
  const j = await res.json();
  if (!res.ok) return alert(j.error || "読み込みに失敗しました");
  $("tvSoldTitle").textContent = `${monthLabel(month)}の販売データ（契約日付が${monthLabel(month)}の車）：${j.rows.length}台`;
  $("tvSoldHead").innerHTML = "<tr><th>伝票No</th><th>契約日</th><th>納車日</th><th>車名</th><th>車両本体価格</th><th>値引</th><th>売上高</th></tr>";
  $("tvSoldRows").innerHTML = j.rows.map((r) => `<tr>
    <td>${h(r.slip_no)}</td><td>${h(r.contract_date)}</td><td>${h(r.delivery_date)}</td><td>${h(r.car_name)}</td>
    <td class="n">${yen(r.price)}</td><td class="n">${r.discount ? yen(r.discount) : ""}</td><td class="n">${yen(r.sales_amount)}</td></tr>`).join("");
  $("tvSoldCard").hidden = false;
  $("tvSoldCard").scrollIntoView({ behavior: "smooth" });
}

// 月初在庫・販売データCSVの取り込み（Shift_JIS のCSVもそのまま読めるようにする）
async function readText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("shift_jis").decode(buf); }
}
function monthFromName(name) {
  const m = name.match(/(20\d{2})[-_年]?(0[1-9]|1[0-2])/);
  return m ? `${m[1]}-${m[2]}` : null;
}
async function importInventory(files) {
  for (const f of [...files]) {
    const month = monthFromName(f.name) || $("invMonth").value || "";
    tvLog(`取り込み中… ${f.name}`);
    try {
      const res = await fetch(`/api/inventory?month=${month}&filename=${encodeURIComponent(f.name)}`, { method: "POST", body: await readText(f) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      if (j.kind === "sales") {
        tvLog(`✅ 販売データを取り込みました（${Object.entries(j.months).map(([m, n]) => `${monthLabel(m)} ${n.toLocaleString()}件`).join("、")}）`
          + (j.channels ? `　小売 ${j.channels.retail}台・業販 ${j.channels.wholesale}台・数えない ${j.channels.exclude}台` : ""));
      } else {
        tvLog(`✅ ${monthLabel(j.month)}の月初在庫 ${j.count.toLocaleString()}台を取り込みました`);
      }
    } catch (e) { tvLog(`❌ ${f.name}: ${e.message}`); }
  }
  loadTurnover();
}
dropZone($("dropInv"), $("inInv"), importInventory);

// ---------- 回転率の推移グラフ（折れ線：その車＝実線、全体＝点線） ----------
let tvHistory = null;
let tvHistSeq = 0;
async function loadHistory() {
  const seq = ++tvHistSeq;
  try { const d = await (await fetch("/api/turnover/history?" + tvQs())).json(); if (seq === tvHistSeq) tvHistory = d; } catch { if (seq === tvHistSeq) tvHistory = null; }
}
const INK = "#172033", INK2 = "#5b6475", GRID = "#e3e8ef", BAR = "#10b8c4", GROSS = "#e0702a";
const shortMonth = (m, first) => (first || m.endsWith("-01") ? `${m.slice(2, 4)}年` : "") + `${Number(m.slice(5))}月`;
// points: [{month, rate, opening, sold, all}]（all は全体の回転率）
// 1本の折れ線グラフ（key の値を fmt で表示。各点に値を書く）
function lineChartSvg(points, { w, h, key, fmt, axisFmt, color, floor = 0 }) {
  const padL = 52, padR = 24, padT = 22, padB = 24;
  const iw = w - padL - padR, ih = h - padT - padB;
  const vals = points.map((p) => p[key]).filter((v) => v != null);
  const maxV = Math.max(floor, ...vals) * 1.15 || 1, minV = Math.min(0, ...vals);
  const step = niceStepAny(maxV - minV), top = Math.ceil(maxV / step) * step, bot = Math.floor(minV / step) * step;
  const y = (v) => padT + ih - ((v - bot) / (top - bot)) * ih;
  const band = iw / Math.max(1, points.length);
  const cx = (i) => padL + band * i + band / 2;
  let g = "";
  for (let v = bot; v <= top + 1e-9; v += step) {
    g += `<line x1="${padL}" x2="${w - padR}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 && bot < 0 ? "#b8c0cc" : GRID}" stroke-width="1"/>`;
    g += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="${INK2}">${axisFmt(v)}</text>`;
  }
  points.forEach((p, i) => { g += `<text x="${cx(i)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="${INK2}">${shortMonth(p.month, i === 0)}</text>`; });
  const pts = points.map((p, i) => (p[key] == null ? null : [cx(i), y(p[key])]));
  let cur = [];
  const flush = () => { if (cur.length > 1) g += `<polyline points="${cur.map((q) => q.join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`; cur = []; };
  for (const q of pts) { if (q) cur.push(q); else flush(); }
  flush();
  pts.forEach((q, i) => {
    if (!q) return;
    g += `<circle cx="${q[0]}" cy="${q[1]}" r="4.5" fill="${color}" stroke="${color}" stroke-width="2"/>`;
    g += `<text x="${q[0]}" y="${q[1] - 9}" text-anchor="middle" font-size="11" font-weight="700" fill="${INK}" stroke="#fff" stroke-width="3" paint-order="stroke">${fmt(points[i][key])}</text>`;
  });
  points.forEach((p, i) => { g += `<rect class="hit" data-i="${i}" x="${padL + band * i}" y="${padT}" width="${band}" height="${ih}" fill="transparent"/>`; });
  return `<svg class="tv-chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${g}</svg>`;
}
function niceStepAny(range) {
  const raw = range / 5, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}
function modelPoints(key) {
  if (!tvHistory || !tvHistory.models[key]) return [];
  const pts = tvHistory.models[key].points;
  return tvHistory.months.map((m) => ({ month: m.month, ...(pts[m.month] || { opening: 0, sold: 0, rate: null, gross_avg: null }) }));
}
const pointText = (p) => `${monthLabel(p.month)}<br>回転率 <b>${p.rate == null ? "—（月初在庫なし）" : pct(p.rate)}</b><br>販売 ${p.sold}台 ÷ 月初在庫 ${p.opening}台<br>平均台粗利 <b>${man1(p.gross_avg)}</b>`;

// 押したとき：大きなグラフ
function showChart(key) {
  const pts = modelPoints(key);
  if (!pts.length) return;
  $("tvChartTitle").textContent = `${tvHistory.models[key].name} の回転率と台粗利の推移`;
  const w = Math.min(820, $("tvChartBody").clientWidth || 820);
  $("tvChartBody").innerHTML =
    `<div class="tv-note" style="font-weight:700;color:${INK}">回転率</div>` +
    lineChartSvg(pts, { w, h: 220, key: "rate", fmt: (v) => (v * 100).toFixed(1) + "%", axisFmt: (v) => Math.round(v * 100) + "%", color: BAR, floor: 0.1 }) +
    `<div class="tv-note" style="font-weight:700;color:${INK};margin-top:6px">平均台粗利</div>` +
    lineChartSvg(pts, { w, h: 200, key: "gross_avg", fmt: (v) => (v / 10000).toFixed(1) + "万", axisFmt: (v) => Number((v / 10000).toFixed(1)) + "万", color: GROSS, floor: 100000 });
  $("tvChartTable").innerHTML = `<table class="tv-table" style="min-width:0;width:auto"><thead><tr><th>月</th><th>月初在庫</th><th>販売台数</th><th>回転率</th><th>平均台粗利</th></tr></thead><tbody>` +
    pts.map((p) => `<tr><td>${monthLabel(p.month)}</td><td class="n">${p.opening}台</td><td class="n">${p.sold}台</td><td class="n">${pct(p.rate)}</td><td class="n">${man1(p.gross_avg)}</td></tr>`).join("") + "</tbody></table>";
  const tip = $("tvTip");
  $("tvChartBody").querySelectorAll("svg").forEach((svg) => {
    svg.addEventListener("mousemove", (e) => {
      const hit = e.target.closest(".hit");
      if (!hit) { tip.style.display = "none"; return; }
      tip.innerHTML = pointText(pts[hit.dataset.i]);
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 220) + "px";
      tip.style.top = e.clientY + 14 + "px";
      tip.style.display = "block";
    });
    svg.addEventListener("mouseleave", () => (tip.style.display = "none"));
  });
  $("tvChartCard").hidden = false;
  $("tvChartCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  showCarSold(key);
}

// その車の、選んでいる月に売れた車の一覧
async function showCarSold(key) {
  const month = tvMonth;
  $("tvCarSoldTitle").textContent = `${monthLabel(month)}に売れた ${tvHistory.models[key]?.name || ""}`;
  $("tvCarSoldRows").innerHTML = '<tr><td colspan="9" class="tv-dim">読み込み中…</td></tr>';
  const res = await fetch(`/api/turnover/${month}/model-sales?${tvQs()}&key=${encodeURIComponent(key)}`);
  const j = await res.json();
  if (!res.ok) { $("tvCarSoldRows").innerHTML = `<tr><td colspan="9">${h(j.error || "読み込みに失敗しました")}</td></tr>`; return; }
  $("tvCarSoldTitle").textContent += `：${j.rows.length}台`;
  $("tvCarSoldNote").textContent = j.rows.length && !j.linkable
    ? "※ 販売データに「在庫No」か「車台番号」の列が無いため、年式・距離・色・グレードは出せません。在庫No入りの販売データCSVを入れ直すと表示されます。"
    : "年式・距離・色は月初在庫から、グレードは仕入れ台帳（車台番号が一致する車）から表示します。";
  const dash = '<span class="tv-dim">—</span>';
  $("tvCarSoldRows").innerHTML = j.rows.map((r) => `<tr>
    <td>${h(r.contract_date)}</td><td>${h(r.car_name)}</td><td>${r.year ? h(r.year) : dash}</td>
    <td class="n">${r.mileage_km == null ? dash : r.mileage_km.toLocaleString() + "km"}</td>
    <td>${r.color ? h(r.color) : dash}</td><td>${r.grade ? h(r.grade) : dash}</td>
    <td class="n">${r.price == null ? dash : yen(r.price)}</td>
    <td class="n">${r.cost == null ? dash : yen(r.cost)}</td>
    <td class="n"><b>${r.gross == null ? dash : yen(r.gross)}</b></td></tr>`).join("") || '<tr><td colspan="9" class="tv-dim">この月に売れた車はありません</td></tr>';
}
$("tvModelRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-key]");
  if (tr) showChart(tr.dataset.key);
});
$("tvChartClose").onclick = () => ($("tvChartCard").hidden = true);

showTab(location.hash.slice(1) || "ledger");
