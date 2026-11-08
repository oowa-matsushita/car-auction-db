"use strict";
// ---------- タブの切り替え（#ledger / #turnover） ----------
const TABS = ["ledger", "turnover"];
function showTab(name) {
  if (!TABS.includes(name)) name = "ledger";
  for (const t of TABS) document.getElementById("tab-" + t).hidden = t !== name;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  hidePreview();
  if (name === "turnover") loadTurnover();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ---------- 回転率 ----------
const yen = (v) => (v == null ? "" : Number(v).toLocaleString() + "円");
const pct = (r) => (r == null ? "—" : (r * 100).toFixed(1) + "%");
const monthLabel = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const tvLog = (s) => ($("tvLog").textContent = s);

let tvMonth = null, tvModels = [];
async function loadTurnover() {
  let data;
  try {
    const res = await fetch("/api/turnover");
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
  } catch (e) { tvLog("❌ 読み込みに失敗しました: " + e.message); return; }
  const months = data.months || [];
  const maxRate = Math.max(0.0001, ...months.map((m) => m.rate || 0));
  $("tvEmpty").hidden = months.length > 0;
  $("tvRows").innerHTML = months.map((m) => `
    <tr data-month="${m.month}" class="${m.month === tvMonth ? "sel" : ""}" style="cursor:pointer" title="押すと車名ごとの回転率を表示">
      <td><b>${monthLabel(m.month)}</b></td>
      <td class="n">${m.item_count == null ? '<span class="tv-dim">未登録</span>' : m.item_count.toLocaleString() + "台"}</td>
      <td class="n">${m.sold == null ? '<span class="tv-dim">未登録</span>'
        : `<span class="tv-link" data-sales="${m.month}" title="販売データの一覧を見る">${m.sold.toLocaleString()}台</span>`}</td>
      <td class="n tv-rate">${pct(m.rate)}</td>
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
  const res = await fetch(`/api/turnover/${month}/models`);
  const j = await res.json();
  if (!res.ok) return tvLog("❌ " + (j.error || "読み込みに失敗しました"));
  tvModels = j.models;
  $("tvModelTitle").textContent = `車名ごとの回転率（${monthLabel(month)}）`;
  $("tvModelCard").hidden = false;
  drawModels();
}
function drawModels() {
  const q = $("tvModelFilter").value.trim().normalize("NFKC").toUpperCase().replace(/[\s\-‐－]/g, "");
  const list = tvModels.filter((m) => !q || m.name.normalize("NFKC").toUpperCase().replace(/[\s\-‐－]/g, "").includes(q));
  const max = Math.max(0.0001, ...list.map((m) => m.rate || 0));
  $("tvModelRows").innerHTML = list.map((m) => `<tr>
    <td>${h(m.name)}</td>
    <td class="n tv-rate" title="販売 ${m.sold}台 ÷ 月初在庫 ${m.opening}台">${m.rate == null ? '<span class="tv-dim" style="font-size:12px;font-weight:400">月初在庫なし</span>' : pct(m.rate)}</td>
    <td><div class="tv-bar" style="width:${m.rate == null ? 0 : Math.max(2, (m.rate / max) * 190)}px"></div></td>
  </tr>`).join("") || '<tr><td colspan="3" class="tv-dim">該当する車がありません</td></tr>';
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
  const res = await fetch(`/api/turnover/${month}/sales`);
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
        tvLog(`✅ 販売データを取り込みました（${Object.entries(j.months).map(([m, n]) => `${monthLabel(m)} ${n.toLocaleString()}台`).join("、")}）`);
      } else {
        tvLog(`✅ ${monthLabel(j.month)}の月初在庫 ${j.count.toLocaleString()}台を取り込みました`);
      }
    } catch (e) { tvLog(`❌ ${f.name}: ${e.message}`); }
  }
  loadTurnover();
}
dropZone($("dropInv"), $("inInv"), importInventory);

showTab(location.hash.slice(1) || "ledger");
