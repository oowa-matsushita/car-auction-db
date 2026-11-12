"use strict";
// ---------- タブの切り替え（#ledger / #turnover） ----------
const TABS = ["ledger", "turnover", "review", "news"];
// ベータ機能（ニュースのタブ）。右上の「ベータ」ボタンで ON/OFF（このパソコンに覚える。はじめは OFF）
const BETA_TABS = ["news"];
const betaOn = () => { try { return localStorage.getItem("mmsBeta") === "1"; } catch { return false; } };
function applyBeta() {
  const on = betaOn();
  BETA_TABS.forEach((t) => { const b = document.querySelector(`.tabs button[data-tab="${t}"]`); if (b) b.hidden = !on; });
  const bb = document.getElementById("betaBtn");
  if (bb) { bb.textContent = on ? "ベータ ON" : "ベータ OFF"; bb.classList.toggle("on", on); }
}
function showTab(name) {
  if (!TABS.includes(name) || (BETA_TABS.includes(name) && !betaOn())) name = "ledger";
  for (const t of TABS) document.getElementById("tab-" + t).hidden = t !== name;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "turnover") loadTurnover();
  if (name === "review") loadReview();
  if (name === "news" && typeof loadNews === "function") loadNews();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
applyBeta();
document.getElementById("betaBtn").onclick = () => {
  const on = !betaOn();
  try { localStorage.setItem("mmsBeta", on ? "1" : "0"); } catch {}
  applyBeta();
  if (!on && BETA_TABS.some((t) => !document.getElementById("tab-" + t).hidden)) showTab("ledger");
  else if (on) showTab("news");
};
addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ---------- 回転率 ----------
// 数える販売（小売＋業販 / 小売のみ / 業販のみ）。選んだものはこのブラウザに覚えておく
const tvCh = () => $("tvCh").value;
// 台粗利は いつも「本体価格を税抜にして − 本体原価」で計算する
const tvQs = () => `ch=${tvCh()}&tax=ex`;
const man1 = (v) => (v == null ? "—" : (v / 10000).toFixed(1) + "万円");
try { const v = localStorage.getItem("tvCh"); if (v) $("tvCh").value = v; } catch {}
$("tvCh").onchange = () => { try { localStorage.setItem("tvCh", tvCh()); } catch {} clearPanel(); loadTurnover(); };
const yen = (v) => (v == null ? "" : Number(v).toLocaleString() + "円");
const pct = (r) => (r == null ? "—" : (r * 100).toFixed(1) + "%");
const monthLabel = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const tvLog = (s) => ($("tvLog").textContent = s);

let tvMonth = null, tvModels = [], tvForecast = null, tvSelKey = null;
// 当月の着地予想（回転率の右に出す）
const fcTitle = (f) => `${f.through.slice(5).replace("-", "/")}までの販売から予想。残り 平日${f.rest_weekday}日・土日祝${f.rest_off}日（土日祝は平日の${f.ratio}倍売れる計算。過去の販売データから）`;
const fcHtml = (rate, f) => (rate == null || !f ? '<span class="tv-dim">—</span>' : `<span class="tv-fc" title="${fcTitle(f)}">${pct(rate * f.factor)}</span>`);
const fcOn = () => !!(tvForecast && tvForecast.month === tvMonth);
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
  tvForecast = data.forecast || null;
  $("tvEmpty").hidden = months.length > 0;
  // 回転率の横グラフ（目盛りは全部の月で共通。当月は着地予想を薄い色で重ねる）
  const fcRate = (m) => (tvForecast && tvForecast.month === m.month && m.rate != null ? m.rate * tvForecast.factor : null);
  const barMax = Math.max(0.0001, ...months.map((m) => Math.max(m.rate || 0, fcRate(m) || 0)));
  const BW = 90;
  const rateBar = (m) => m.rate == null ? "" : `<div class="tv-hbar" style="width:${BW}px" title="回転率 ${pct(m.rate)}${fcRate(m) != null ? `／着地予想 ${pct(fcRate(m))}` : ""}">
      ${fcRate(m) != null ? `<div class="fc" style="width:${(Math.min(fcRate(m), barMax) / barMax) * BW}px"></div>` : ""}
      <div class="now" style="width:${Math.max(2, (m.rate / barMax) * BW)}px"></div></div>`;
  $("tvRows").innerHTML = months.map((m) => `
    <tr data-month="${m.month}" class="${m.month === tvMonth ? "sel" : ""}" style="cursor:pointer" title="押すと車名ごとの回転率を表示">
      <td><b>${monthLabel(m.month)}</b></td>
      <td class="n">${m.item_count == null ? '<span class="tv-dim">未登録</span>' : m.item_count.toLocaleString() + "台"}</td>
      <td class="n">${m.sold == null ? '<span class="tv-dim">未登録</span>'
        : `<span class="tv-link" data-sales="${m.month}" title="販売データの一覧を見る">${m.sold.toLocaleString()}台</span>`
          + (m.sold_retail || m.sold_wholesale ? `<div class="tv-dim" style="font-size:11px">小売 ${m.sold_retail} / 業販 ${m.sold_wholesale}</div>` : "")}</td>
      <td class="n tv-rate">${pct(m.rate)}</td>
      <td class="n">${tvForecast && tvForecast.month === m.month ? fcHtml(m.rate, tvForecast) + `<div class="tv-dim" style="font-size:11px;font-weight:400">販売 ${tvForecast.sold.toLocaleString()}台の見込み</div>` : ""}</td>
      <td class="n"><b>${man1(m.gross_avg)}</b>${m.gross_total != null ? `<div class="tv-dim" style="font-size:11px">合計 ${Math.round(m.gross_total / 10000).toLocaleString()}万円</div>` : ""}</td>
      <td>${rateBar(m)}</td>
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
  if (tvSelKey) showCarSold(tvSelKey);
  showWeeks(month);
}

// ---------- 週ごとの回転率（選んでいる月） ----------
let tvWeekSeq = 0;
const WD = "日月火水木金土";
const mdw = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}(${WD[new Date(d + "T00:00:00Z").getUTCDay()]})`;
async function showWeeks(month) {
  const seq = ++tvWeekSeq;
  let j;
  try { const res = await fetch(`/api/turnover/${month}/weeks?${tvQs()}`); j = await res.json(); if (!res.ok) throw 0; } catch { return; }
  if (seq !== tvWeekSeq) return;
  $("tvWeekTitle").textContent = `週ごとの回転率（${Number(month.slice(5))}月）`;
  $("tvWeekTitle").title = j.opening ? `回転率は 週の販売台数 ÷ ${monthLabel(month)}の月初在庫 ${j.opening.toLocaleString()}台` : "";
  $("tvWeekRows").innerHTML = j.weeks.map((w) => `<tr class="${w.status}">
    <td><b>${w.no}週目</b></td>
    <td style="text-align:left;white-space:nowrap">${mdw(w.from)}${w.from === w.to ? "" : "〜" + mdw(w.to)}${w.status === "partial" ? `<span class="tag" title="${mdw(j.through)}までの販売データ">途中</span>` : w.status === "future" ? '<span class="tag" style="background:#eef1f6;color:#8a93a3">これから</span>' : ""}</td>
    <td class="n" style="white-space:nowrap">${w.days}日<span class="tv-dim" style="font-size:11px">（休${w.off_days}）</span></td>
    <td class="n">${w.status === "future" ? "—" : w.sold.toLocaleString() + "台"}</td>
    <td class="n tv-rate">${w.status === "future" || w.rate == null ? "—" : pct(w.rate)}</td>
    <td class="n">${w.status === "future" ? "—" : man1(w.gross_avg)}</td>
  </tr>`).join("");
  $("tvWeekCard").hidden = false;
}
// たたむ／ひらく（このパソコンに覚える）
const setWeekOpen = (open) => { $("tvWeekBody").hidden = !open; $("tvWeekArrow").textContent = open ? "▼" : "▶"; try { localStorage.setItem("tvWeekOpen", open ? "1" : "0"); } catch {} };
try { if (localStorage.getItem("tvWeekOpen") === "0") setWeekOpen(false); } catch {}
$("tvWeekHead").onclick = (e) => { if (!e.target.closest(".tv-i")) setWeekOpen($("tvWeekBody").hidden); };
// 並べ替え（見出しを押すたびに 降順 ⇔ 昇順。値が無いものはいつも最後）
const tvSort = { key: "weather", dir: "desc" }; // はじめは天気の良い順（快晴から）
$("tvModelHead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const k = th.dataset.sort;
  if (tvSort.key === k) tvSort.dir = tvSort.dir === "desc" ? "asc" : "desc";
  else { tvSort.key = k; tvSort.dir = k === "name" ? "asc" : "desc"; }
  drawModels();
});
// ---------- 天気（回転率と平均台粗利の組み合わせ） ----------
// 基準は「⚙ 天気の基準」ボタンで変えられる（サーバーに保存してみんなで共通）
// rate：回転率(%) の 3点/2点/1点 の下限、gross：平均台粗利(万円) の 3点/2点/1点 の下限
// levels：快晴/晴れ/曇り/雨 になる合計点の下限（それ未満は台風）
const WX_DEFAULT = { rate: [40, 35, 30], gross: [15, 10, 5], levels: [6, 4, 3, 1] };
const CHART_DEFAULT = { rate: 80, gross: 40 }; // グラフの上限（回転率 %・台粗利 万円）
const EXPENSE_DEFAULT = 3.5; // 1台あたりの経費（万円）。台粗利から引く
let wxCfg = { ...structuredClone(WX_DEFAULT), chart: { ...CHART_DEFAULT } };
const WX_LOOK = [["🌞", "快晴"], ["🌤️", "晴れ"], ["☁️", "曇り"], ["🌧️", "雨"], ["🌀", "台風"]];
const stepScore = (v, cuts) => { const i = cuts.findIndex((c) => v >= c); return i < 0 ? 0 : 3 - i; };
const rateScore = (r) => stepScore(r * 100 + 1e-9, wxCfg.rate);
const grossScore = (g) => stepScore(g / 10000 + 1e-9, wxCfg.gross);
function weatherOf(m) {
  if (m.rate == null || m.gross_avg == null) return null;
  const score = rateScore(m.rate) + grossScore(m.gross_avg);
  let i = wxCfg.levels.findIndex((l) => score >= l);
  if (i < 0) i = 4;
  return { score, icon: WX_LOOK[i][0], label: WX_LOOK[i][1] };
}
function wxLegend() {
  const c = wxCfg, L = c.levels;
  const rng = (i) => { const lo = L[i], hi = i === 0 ? 6 : L[i - 1] - 1; return lo >= hi ? `${lo}点` : `${lo}〜${hi}点`; };
  $("wxLegend").innerHTML = `天気：🌞快晴(${rng(0)}) 🌤️晴れ(${rng(1)}) ☁️曇り(${rng(2)}) 🌧️雨(${rng(3)}) <span class="wx-red"><i>🌀</i>台風(${L[3] - 1 <= 0 ? "0点" : `0〜${L[3] - 1}点`})</span>`;
  $("wxLegend").title = `回転率：${c.rate[0]}%以上=3点・${c.rate[1]}%以上=2点・${c.rate[2]}%以上=1点／台粗利：${c.gross[0]}万以上=3点・${c.gross[1]}万以上=2点・${c.gross[2]}万以上=1点`;
}
async function loadWx() {
  try {
    const d = await (await fetch("/api/settings/weather")).json();
    wxCfg = d.weather || structuredClone(WX_DEFAULT);
  } catch {}
  if (!wxCfg.chart) wxCfg.chart = { ...CHART_DEFAULT };
  wxLegend(); if (typeof tvModels !== "undefined" && tvModels.length) drawModels();
  if (typeof drawPanelChart === "function") drawPanelChart();
}
function openWx() {
  const c = wxCfg, ch = c.chart || CHART_DEFAULT, exp = c.expense ?? EXPENSE_DEFAULT;
  const inp = (id, v, step, w = 64) => `<input id="${id}" type="number" step="${step}" min="0" value="${v}" style="width:${w}px">`;
  const lv = (i, icon, label, cls = "") => `<div class="lv ${cls}"><div class="ic">${icon}</div><div class="nm">${label}</div>${i == null ? '<div class="th">それ未満</div>' : `<div class="th">${inp("wxL" + i, c.levels[i], 1, 52)}点以上</div>`}</div>`;
  $("wxForm").innerHTML = `<div class="hd"><b>⚙ 回転率の設定</b><span style="flex:1"></span><button type="button" class="btn btn-sub" id="wxClose" style="padding:2px 10px">閉じる ✕</button></div>
    <div class="wx-body">
      <section>
        <h3>💰 台粗利の計算</h3>
        <div class="wx-formula">台粗利 ＝ 本体価格（値引後・税抜） − 本体原価 − <span class="hl">経費 ${inp("wxExp", exp, 0.1, 70)} 万円</span></div>
        <div class="tv-note">経費は1台あたり（陸送など）。台粗利からそのまま引きます。</div>
      </section>
      <section>
        <h3>🌤️ 天気の基準</h3>
        <div class="tv-note" style="margin-bottom:6px">① 回転率と平均台粗利に、それぞれ 0〜3点を付けます</div>
        <table class="wx-grid">
          <thead><tr><th></th><th>3点</th><th>2点</th><th>1点</th><th>0点</th></tr></thead>
          <tbody>
            <tr><th>回転率</th><td>${inp("wxR0", c.rate[0], 0.1)}%以上</td><td>${inp("wxR1", c.rate[1], 0.1)}%以上</td><td>${inp("wxR2", c.rate[2], 0.1)}%以上</td><td class="dim">それ未満</td></tr>
            <tr><th>平均台粗利</th><td>${inp("wxG0", c.gross[0], 0.1)}万円以上</td><td>${inp("wxG1", c.gross[1], 0.1)}万円以上</td><td>${inp("wxG2", c.gross[2], 0.1)}万円以上</td><td class="dim">それ未満</td></tr>
          </tbody>
        </table>
        <div class="tv-note" style="margin:10px 0 6px">② 2つの点数の合計（0〜6点）で天気が決まります</div>
        <div class="wx-levels">${lv(0, "🌞", "快晴")}${lv(1, "🌤️", "晴れ")}${lv(2, "☁️", "曇り")}${lv(3, "🌧️", "雨")}${lv(null, "<span class='wx-red'><i>🌀</i></span>", "台風", "bad")}</div>
      </section>
      <section>
        <h3>📈 グラフの上限 <span class="tv-note" style="font-weight:400">（どの車でも同じ目盛り。超える値は端に▲で表示）</span></h3>
        <div class="wx-row">回転率 ${inp("wxCR", ch.rate, 5)} %まで　　平均台粗利 ${inp("wxCG", ch.gross, 5)} 万円まで</div>
      </section>
      <div id="wxErr" class="wx-err"></div>
      <div class="wx-foot">
        <button type="button" class="btn btn-ok" id="wxSave" style="padding:6px 22px;font-size:14px">保存</button>
        <button type="button" class="btn btn-sub" id="wxReset">はじめの設定に戻す</button>
        <span style="flex:1"></span><span class="tv-note">保存した設定は、このサイトを見る全員で共通です。</span>
      </div>
    </div>`;
  const v = (id) => ($(id).value.trim() === "" ? NaN : Number($(id).value));
  $("wxClose").onclick = () => $("wxDlg").close();
  $("wxReset").onclick = async () => {
    if (!confirm(`はじめの設定に戻しますか？\n（経費 ${EXPENSE_DEFAULT}万円、回転率 40/35/30%、台粗利 15/10/5万円、快晴6・晴れ4・曇り3・雨1点、グラフの上限 80%・40万円）`)) return;
    await fetch("/api/settings/weather", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reset: true }) });
    $("wxDlg").close(); await loadWx(); loadTurnover();
  };
  $("wxSave").onclick = async () => {
    const b = { rate: [v("wxR0"), v("wxR1"), v("wxR2")], gross: [v("wxG0"), v("wxG1"), v("wxG2")], levels: [v("wxL0"), v("wxL1"), v("wxL2"), v("wxL3")], chart: { rate: v("wxCR"), gross: v("wxCG") }, expense: v("wxExp") };
    const desc = (a) => a.every((x, i) => i === 0 || a[i - 1] > x);
    const err = [...b.rate, ...b.gross, ...b.levels, b.chart.rate, b.chart.gross, b.expense].some((x) => !Number.isFinite(x)) ? "空欄があります"
      : b.expense < 0 ? "経費は 0 以上にしてください"
      : !(b.chart.rate > 0 && b.chart.gross > 0) ? "グラフの上限は 0 より大きい数を入れてください"
      : !desc(b.rate) ? "回転率は 3点 ＞ 2点 ＞ 1点 の順に大きくしてください"
      : !desc(b.gross) ? "台粗利は 3点 ＞ 2点 ＞ 1点 の順に大きくしてください"
      : !desc(b.levels) || b.levels[0] > 6 || b.levels[3] < 0 ? "天気の点数は 快晴 ＞ 晴れ ＞ 曇り ＞ 雨 の順に、0〜6点の間で入れてください" : "";
    if (err) { $("wxErr").textContent = "⚠ " + err; return; }
    const res = await fetch("/api/settings/weather", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    if (!res.ok) { $("wxErr").textContent = "⚠ " + ((await res.json().catch(() => ({}))).error || "保存できませんでした"); return; }
    const expChanged = b.expense !== (wxCfg.expense ?? EXPENSE_DEFAULT);
    $("wxDlg").close(); await loadWx();
    if (expChanged) { tvHistory = null; loadTurnover(); } // 台粗利を計算し直す
  };
  $("wxDlg").showModal();
}
$("wxBtn").onclick = openWx;
loadWx();

function sortModels(list) {
  const { key, dir } = tvSort, sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const val = (m) => (key === "weather" ? weatherOf(m)?.score ?? null : key === "forecast" ? m.rate : m[key]);
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = key === "name" ? String(va).localeCompare(String(vb), "ja") : va - vb;
    return c * sign || (key === "weather" ? ((a.rate ?? -1) - (b.rate ?? -1)) * sign : 0) || b.sold - a.sold || a.name.localeCompare(b.name, "ja");
  });
}
function drawModels() {
  document.querySelectorAll("#tvModelHead th").forEach((th) => {
    const on = th.dataset.sort === tvSort.key;
    th.classList.toggle("on", on);
    th.textContent = th.textContent.replace(/ [▼▲]$/, "") + (on ? (tvSort.dir === "desc" ? " ▼" : " ▲") : "");
  });
  const q = $("tvModelFilter").value.trim().normalize("NFKC").toUpperCase().replace(/[\s\-‐－]/g, "");
  $("tvFcHead").hidden = !fcOn();
  const minOn = $("tvMinOn").checked, minN = Number($("tvMinN").value) || 0;
  const list = sortModels(tvModels).filter((m) => (!q || m.name.normalize("NFKC").toUpperCase().replace(/[\s\-‐－]/g, "").includes(q)) && (!minOn || m.opening >= minN));
  $("tvModelRows").innerHTML = list.map((m) => `<tr data-key="${h(m.key)}" class="${m.key === tvSelKey ? "sel" : ""}">
    <td>${h(m.name)}</td>
    <td class="n">${m.opening.toLocaleString()}台</td>
    <td class="n">${m.sold.toLocaleString()}台</td>
    <td class="n tv-rate">${m.rate == null ? '<span class="tv-dim" style="font-size:12px;font-weight:400">月初在庫なし</span>' : pct(m.rate)}</td>
    ${fcOn() ? `<td class="n">${fcHtml(m.rate, tvForecast)}</td>` : ""}
    <td class="n">${man1(m.gross_avg)}</td>
    ${(() => { const w = weatherOf(m); return w
      ? `<td class="tv-wx${w.label === "台風" ? " wx-red" : ""}" title="${w.label}（回転率${rateScore(m.rate)}点＋台粗利${grossScore(m.gross_avg)}点＝${w.score}点）"><span>${w.icon}</span>${w.label}</td>`
      : '<td class="tv-wx tv-dim" title="月初在庫か台粗利が無いため判定できません">—</td>'; })()}
  </tr>`).join("") || '<tr><td colspan="7" class="tv-dim">該当する車がありません</td></tr>';
}
$("tvModelFilter").addEventListener("input", drawModels);
// クリア：車名のしぼり込み・月初在庫●台以上（5台に戻す）・並べ替え（天気の良い順）・選んだ車とグラフを はじめの状態に戻す
$("tvModelClear").onclick = () => {
  $("tvModelFilter").value = "";
  $("tvMinOn").checked = true; $("tvMinN").value = 5;
  try { localStorage.removeItem("tvMin"); } catch {}
  tvSort.key = "weather"; tvSort.dir = "desc";
  clearPanel();
  drawModels();
  $("tvModelCard").querySelector(".scroll").scrollTop = 0;
};
// 「月初在庫●台以上のみ」（はじめは5台以上だけ表示。変えた値はこのパソコンに覚える）
try { const v = JSON.parse(localStorage.getItem("tvMin") || "null"); if (v) { $("tvMinOn").checked = !!v.on; $("tvMinN").value = v.n; } } catch {}
const saveMin = () => { try { localStorage.setItem("tvMin", JSON.stringify({ on: $("tvMinOn").checked, n: Number($("tvMinN").value) || 0 })); } catch {} };
$("tvMinOn").addEventListener("change", () => { saveMin(); drawModels(); });
$("tvMinN").addEventListener("input", () => { if (!$("tvMinOn").checked) $("tvMinOn").checked = true; saveMin(); drawModels(); });

$("tvRows").addEventListener("click", async (e) => {
  const sales = e.target.closest("[data-sales]");
  if (sales) return showSales(sales.dataset.sales);
  const ds = e.target.closest("[data-delsales]");
  if (ds) {
    if (!confirm(`${monthLabel(ds.dataset.delsales)}の販売データを削除しますか？`)) return;
    await fetch(`/api/sales/${ds.dataset.delsales}`, { method: "DELETE" });
    return loadTurnover();
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    if (!confirm(`${monthLabel(del.dataset.del)}の月初在庫を削除しますか？`)) return;
    await fetch(`/api/inventory/${del.dataset.del}`, { method: "DELETE" });
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
  $("tvSoldDlg").showModal();
}
$("tvSoldClose").onclick = () => $("tvSoldDlg").close();

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

// ---------- 回転率と台粗利の推移グラフ ----------
let tvHistory = null;
let tvHistSeq = 0;
async function loadHistory() {
  const seq = ++tvHistSeq;
  try { const d = await (await fetch("/api/turnover/history?" + tvQs())).json(); if (seq === tvHistSeq) { tvHistory = d; if (tvSelKey) drawPanelChart(); } } catch { if (seq === tvHistSeq) tvHistory = null; }
}
const INK = "#172033", INK2 = "#5b6475", GRID = "#e3e8ef", BAR = "#10b8c4", GROSS = "#e0702a";
const shortMonth = (m, first) => (first || m.endsWith("-01") ? `${m.slice(2, 4)}年` : "") + `${Number(m.slice(5))}月`;
// 回転率と平均台粗利を1つのグラフに（左の目盛り＝回転率、右の目盛り＝台粗利）
// 目盛りはどの車でも同じ（回転率 0〜80%、台粗利 0〜40万円）。はみ出す値は上下の端に▲▼で印を付け、本当の値を書く
// 上限は「設定」で変えられる（wxCfg.chart）。横線の本数は、両方の目盛りがきりのいい数になる本数を選ぶ
const DUAL = { rateMax: 0.8, grossMax: 400000, div: 8 };
function setDualScale() {
  const c = wxCfg.chart || CHART_DEFAULT, R = c.rate, G = c.gross;
  DUAL.rateMax = R / 100; DUAL.grossMax = G * 10000;
  const ok = (x) => Math.abs(x - Math.round(x)) < 1e-9;
  DUAL.div = [8, 10, 5, 6, 4, 7, 9, 12].find((d) => ok(R / d) && ok(G / d)) || [8, 10, 5, 6, 4].find((d) => ok(R / d) || ok(G / d)) || 8;
}
const tick = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1));
function dualChartSvg(points, w, h) {
  setDualScale();
  const padL = 46, padR = 50, padT = 24, padB = 40;
  const iw = w - padL - padR, ih = h - padT - padB;
  const yr = (v) => padT + ih - (Math.max(0, Math.min(1, v / DUAL.rateMax))) * ih;
  const yg = (v) => padT + ih - (Math.max(0, Math.min(1, v / DUAL.grossMax))) * ih;
  const band = iw / Math.max(1, points.length), cx = (i) => padL + band * i + band / 2;
  let g = "";
  for (let k = 0; k <= DUAL.div; k++) {
    const yy = padT + ih - (ih * k) / DUAL.div;
    g += `<line x1="${padL}" x2="${w - padR}" y1="${yy}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    g += `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${BAR}" font-weight="700">${tick((DUAL.rateMax * 100 * k) / DUAL.div)}%</text>`;
    g += `<text x="${w - padR + 6}" y="${yy + 4}" font-size="10" fill="${GROSS}" font-weight="700">${tick((DUAL.grossMax / 10000) * k / DUAL.div)}万</text>`;
  }
  points.forEach((p, i) => { g += `<text x="${cx(i)}" y="${padT + ih + 16}" text-anchor="middle" font-size="10" fill="${INK2}">${shortMonth(p.month, i === 0)}</text>`; });
  // 凡例
  g += `<g font-size="11" fill="${INK}"><line x1="${padL}" x2="${padL + 18}" y1="${h - 8}" y2="${h - 8}" stroke="${BAR}" stroke-width="2.5"/><circle cx="${padL + 9}" cy="${h - 8}" r="3.5" fill="${BAR}"/><text x="${padL + 24}" y="${h - 4}">回転率（左の目盛り）</text>
    <line x1="${padL + 150}" x2="${padL + 168}" y1="${h - 8}" y2="${h - 8}" stroke="${GROSS}" stroke-width="2.5" stroke-dasharray="5 3"/><rect x="${padL + 155.5}" y="${h - 11.5}" width="7" height="7" fill="${GROSS}"/><text x="${padL + 174}" y="${h - 4}">平均台粗利（右の目盛り）</text></g>`;
  const series = [
    { key: "rate", y: yr, max: DUAL.rateMax, color: BAR, dash: "", fmt: (v) => (v * 100).toFixed(1) + "%", above: true, shape: "circle" },
    { key: "gross_avg", y: yg, max: DUAL.grossMax, color: GROSS, dash: "5 3", fmt: (v) => (v / 10000).toFixed(1) + "万", above: false, shape: "rect" },
  ];
  const labels = [];
  for (const s of series) {
    const pts = points.map((p, i) => (p[s.key] == null ? null : [cx(i), s.y(p[s.key]), p[s.key]]));
    let cur = [];
    const flush = () => { if (cur.length > 1) g += `<polyline points="${cur.map((q) => q[0] + "," + q[1]).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-dasharray="${s.dash}" stroke-linejoin="round"/>`; cur = []; };
    for (const q of pts) { if (q) cur.push(q); else flush(); }
    flush();
    pts.forEach((q) => {
      if (!q) return;
      const [x, y, v] = q, over = v > s.max, under = v < 0;
      if (over || under) g += `<text x="${x}" y="${over ? y + 4 : y + 4}" text-anchor="middle" font-size="12" fill="${s.color}">${over ? "▲" : "▼"}</text>`;
      else if (s.shape === "circle") g += `<circle cx="${x}" cy="${y}" r="4.5" fill="${s.color}"/>`;
      else g += `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="${s.color}"/>`;
      labels.push({ x, y, text: s.fmt(v), color: s.color, up: s.above });
    });
  }
  // 数字が重ならないように、同じ月で近いときは上下に分ける
  for (const l of labels) {
    const other = labels.find((o) => o !== l && o.x === l.x);
    let up = l.up;
    if (other && Math.abs(other.y - l.y) < 22) up = l.y < other.y || (l.y === other.y && l.up);
    const ty = up ? l.y - 9 : l.y + 17;
    g += `<text x="${l.x}" y="${Math.max(12, Math.min(padT + ih - 2, ty))}" text-anchor="middle" font-size="11" font-weight="700" fill="${l.color}" stroke="#fff" stroke-width="3" paint-order="stroke">${l.text}</text>`;
  }
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
  const span = Number($("tvSpan").value) || 0;
  const months = [...tvHistory.months].sort((a, b) => a.month.localeCompare(b.month));
  return (span ? months.slice(-span) : months).map((m) => ({ month: m.month, ...(pts[m.month] || { opening: 0, sold: 0, rate: null, gross_avg: null }) }));
}
const pointText = (p) => `${monthLabel(p.month)}<br>回転率 <b>${p.rate == null ? "—（月初在庫なし）" : pct(p.rate)}</b><br>販売 ${p.sold}台 ÷ 月初在庫 ${p.opening}台<br>平均台粗利 <b>${man1(p.gross_avg)}</b>`;

// 押したとき：大きなグラフ
function showChart(key) {
  // 推移データの読み込み前に押しても、読み込み後にグラフを描く（loadHistory から drawPanelChart）
  tvSelKey = key;
  document.querySelectorAll("#tvModelRows tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.key === key));
  const name = tvHistory?.models[key]?.name || tvModels.find((m) => m.key === key)?.name || key;
  $("tvChartTitle").textContent = `${name} の回転率と台粗利の推移`;
  if (tvHistory) drawPanelChart(); else $("tvChartBody").innerHTML = '<div class="hint" style="padding-top:60px;text-align:center">読み込み中…</div>';
  showCarSold(key);
}
// 下の枠の大きさに合わせてグラフを描く（枠の位置・大きさは固定）
function drawPanelChart() {
  if (!tvSelKey) return;
  const pts = modelPoints(tvSelKey), box = $("tvChartBody");
  if (!pts.length) { box.innerHTML = '<div class="hint" style="padding-top:60px;text-align:center">この車の推移データがありません</div>'; return; }
  box.innerHTML = dualChartSvg(pts, Math.max(320, box.clientWidth), Math.max(200, box.clientHeight));
}
// グラフにマウスを当てたときの数字（描き直しても効くよう、枠に1回だけ付ける）
$("tvChartBody").addEventListener("mousemove", (e) => {
  const tip = $("tvTip"), hit = e.target.closest(".hit");
  if (!hit || !tvSelKey) { tip.style.display = "none"; return; }
  const p = modelPoints(tvSelKey)[hit.dataset.i];
  if (!p) return;
  tip.innerHTML = pointText(p);
  tip.style.left = Math.min(e.clientX + 14, innerWidth - 220) + "px";
  tip.style.top = Math.min(e.clientY + 14, innerHeight - 110) + "px";
  tip.style.display = "block";
});
$("tvChartBody").addEventListener("mouseleave", () => ($("tvTip").style.display = "none"));
// 「〇ヶ月分を表示」（はじめは4か月。変えた値はこのパソコンに覚える）
try { const v = localStorage.getItem("tvSpan"); if (v && [...$("tvSpan").options].some((o) => o.value === v)) $("tvSpan").value = v; } catch {}
$("tvSpan").onchange = () => { try { localStorage.setItem("tvSpan", $("tvSpan").value); } catch {} drawPanelChart(); };
addEventListener("resize", () => { if (!$("tab-turnover").hidden) drawPanelChart(); });
function clearPanel() {
  tvSelKey = null;
  $("tvChartTitle").textContent = "回転率と台粗利の推移";
  $("tvCarSoldTitle").textContent = ""; $("tvCarSoldNote").textContent = ""; $("tvCarSoldRows").innerHTML = "";
  $("tvChartBody").innerHTML = '<div class="hint" style="padding-top:60px;text-align:center">右下の「車名ごとの回転率」で車名を押すと、ここにグラフが出ます</div>';
}

// その車の、選んでいる月に売れた車の一覧
async function showCarSold(key) {
  const month = tvMonth;
  $("tvCarSoldTitle").textContent = `${monthLabel(month)}に売れた ${tvHistory?.models[key]?.name || tvModels.find((m) => m.key === key)?.name || ""}`;
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
    <td class="n">${r.mileage_km == null ? dash : r.mileage_km.toLocaleString()}</td>
    <td>${r.color ? h(r.color) : dash}</td><td>${r.grade ? h(r.grade) : dash}</td>
    <td class="n" title="${r.discount ? `車両本体価格 ${yen(r.list_price)} − 値引 ${yen(-r.discount)}` : ""}">${r.price == null ? dash : yen(r.price)}${r.discount ? `<div class="tv-dim" style="font-size:11px">値引 ${yen(-r.discount)}</div>` : ""}</td>
    <td class="n">${r.cost == null ? dash : yen(r.cost)}</td>
    <td class="n"><b>${r.gross == null ? dash : yen(r.gross)}</b></td></tr>`).join("") || '<tr><td colspan="9" class="tv-dim">この月に売れた車はありません</td></tr>';
}
$("tvModelRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-key]");
  if (tr) showChart(tr.dataset.key);
});

showTab(location.hash.slice(1) || "ledger");

// ---------- 仕入れ台帳：車の行にマウスを当てると、その車種の回転率と台粗利のグラフを出す ----------
// 車名のまとめ方はサーバー（src/turnover.js の modelName）と同じ
const MODEL_SERIES_C = [
  { re: /^CX\s*[-ー－‐]?\s*\d/i, name: "CXシリーズ" },
  { re: /^N\s*[-ー－‐]?\s*BOX/i, name: "N-BOX" },
];
const MODEL_SUFFIXES_C = ["新型", "旧型", "カスタム", "ハイブリッド", "スティングレー", "ハイウェイスター", "+スタイル", "PHEV", "PHV", "HV", "EV", "e:", "+"];
function modelNameC(name) {
  let s = String(name ?? "").normalize("NFKC").split(/[▼■●★☆◇◆※□△▲]/)[0];
  s = s.replace(/ムーブ/g, "ムーヴ").replace(/\s+/g, " ").trim();
  const series = MODEL_SERIES_C.find((x) => x.re.test(s));
  if (series) return series.name;
  for (let changed = true; changed;) {
    changed = false;
    for (const suf of MODEL_SUFFIXES_C) if (s.length > suf.length && s.toUpperCase().endsWith(suf.toUpperCase())) { s = s.slice(0, -suf.length).trim(); changed = true; }
  }
  return s;
}
const modelKeyC = (name) => modelNameC(name).toUpperCase().replace(/[\s\-‐－]/g, "");

let ledgerTvLoading = null;
function ensureTvData() {
  if (tvHistory) return Promise.resolve();
  if (!ledgerTvLoading) {
    ledgerTvLoading = Promise.all([
      loadHistory(),
      wxCfg ? null : loadWx(),
      fetch("/api/turnover?" + tvQs()).then((r) => r.json()).then((d) => { if (!tvForecast) tvForecast = d.forecast || null; }).catch(() => {}),
    ]).finally(() => { ledgerTvLoading = null; });
  }
  return ledgerTvLoading;
}
let ledgerHoverTimer = null, ledgerHoverKey = null;
function ledgerPopHtml(car) {
  const key = modelKeyC(car);
  const m = tvHistory?.models[key];
  if (!m) return `<b>${h(modelNameC(car) || car || "（車名なし）")}</b><div class="tv-note" style="margin-top:4px">この車種は、月初在庫・販売データに見つかりません。</div>`;
  const pts = modelPoints(key);
  const last = [...pts].reverse().find((p) => p.rate != null || p.sold) || pts[pts.length - 1];
  const w = last ? weatherOf(last) : null;
  const fc = tvForecast && last && tvForecast.month === last.month && last.rate != null ? last.rate * tvForecast.factor : null;
  return `<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap"><b>${h(m.name)}</b>
      <span class="tv-note">${last ? monthLabel(last.month) + (fc != null ? "（途中）" : "") : ""}</span>
      ${w ? `<span class="${w.label === "台風" ? "wx-red" : ""}" style="margin-left:auto;font-size:13px"><span>${w.icon}</span>${w.label}</span>` : ""}</div>
    <div style="font-size:13px;margin:4px 0 2px">回転率 <b style="color:#0b6f78">${last ? pct(last.rate) : "—"}</b>
      ${fc != null ? `<span class="tv-fc" style="margin-left:4px">着地予想 ${pct(fc)}</span>` : ""}
      　台粗利 <b style="color:#c25a00">${last ? man1(last.gross_avg) : "—"}</b>
      <div class="tv-note">月初在庫 ${last?.opening ?? 0}台・販売 ${last?.sold ?? 0}台</div></div>
    ${dualChartSvg(pts, 380, 210)}`;
}
function placePop(pop, x, y) {
  const r = pop.getBoundingClientRect();
  let left = x + 18, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 18;
  if (top + r.height > innerHeight - 8) top = Math.max(8, y - r.height - 14);
  pop.style.left = Math.max(8, left) + "px"; pop.style.top = top + "px";
}
$("rows").addEventListener("mousemove", (e) => {
  const tr = e.target.closest("tr[data-i]"), pop = $("tvPop");
  if (!tr) { pop.style.display = "none"; return; }
  const car = state.rows[tr.dataset.i]?.car_name;
  if (pop.style.display === "block" && ledgerHoverKey === tr.dataset.i) { placePop(pop, e.clientX, e.clientY); return; }
  pop.style.display = "none";
  clearTimeout(ledgerHoverTimer);
  const x = e.clientX, y = e.clientY, idx = tr.dataset.i;
  ledgerHoverTimer = setTimeout(async () => {
    await ensureTvData();
    if (!tr.matches(":hover")) return;
    ledgerHoverKey = idx;
    pop.innerHTML = ledgerPopHtml(car);
    pop.style.display = "block";
    placePop(pop, x, y);
  }, 350);
});
$("rows").addEventListener("mouseleave", () => { clearTimeout(ledgerHoverTimer); ledgerHoverKey = null; $("tvPop").style.display = "none"; });
addEventListener("scroll", () => { $("tvPop").style.display = "none"; }, true);
