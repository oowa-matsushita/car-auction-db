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
const manYen = (v) => (v == null ? "" : (v / 10000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + "万円");
const pct = (r) => (r == null ? "—" : (r * 100).toFixed(1) + "%");
const monthLabel = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const tvLog = (s) => ($("tvLog").textContent = s);

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
    <tr>
      <td><b>${monthLabel(m.month)}</b></td>
      <td class="n">${m.item_count == null ? '<span class="tv-dim">未登録</span>' : m.item_count.toLocaleString() + "台"}</td>
      <td class="n">${manYen(m.stock_cost)}</td>
      <td class="n">${m.sold_sales == null ? '<span class="tv-dim">未登録</span>'
        : `<span class="tv-link" data-sales="${m.month}" title="販売データの一覧を見る">${m.sold_sales.toLocaleString()}台</span>`}</td>
      <td class="n">${m.sold_diff == null
        ? `<span class="tv-dim" title="${monthLabel(m.month)}と${monthLabel(m.next_month)}の月初在庫があると数えます">—</span>`
        : `<span class="tv-link" data-sold="${m.month}" title="翌月の在庫に無い車の一覧を見る">${m.sold_diff.toLocaleString()}台</span>`}</td>
      <td class="n"><input class="tv-manual" type="number" min="0" step="1" data-manual="${m.month}" value="${m.sold_manual ?? ""}" placeholder="自動"></td>
      <td class="n"><span class="tv-rate">${pct(m.rate)}</span>${m.rate == null ? "" : `<div class="tv-dim" style="font-size:11px">${m.sold_source}：${m.sold.toLocaleString()}台 ÷ ${m.item_count.toLocaleString()}台</div>`}</td>
      <td><div class="tv-bar" style="width:${m.rate == null ? 0 : Math.max(2, (m.rate / maxRate) * 150)}px"></div></td>
      <td style="white-space:nowrap">${m.item_count == null ? "" : `<button class="btn btn-sub" data-del="${m.month}" style="padding:2px 6px">在庫</button>`}
        ${m.sold_sales == null ? "" : `<button class="btn btn-sub" data-delsales="${m.month}" style="padding:2px 6px">販売</button>`}</td>
    </tr>`).join("");
}

$("tvRows").addEventListener("click", async (e) => {
  const sold = e.target.closest("[data-sold]");
  if (sold) return showSold(sold.dataset.sold);
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
    loadTurnover();
  }
});
$("tvRows").addEventListener("change", async (e) => {
  const inp = e.target.closest("[data-manual]");
  if (!inp) return;
  const v = inp.value.trim();
  const res = await fetch(`/api/turnover/${inp.dataset.manual}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sold_count: v === "" ? null : Number(v) }),
  });
  if (!res.ok) alert((await res.json().catch(() => ({}))).error || "保存に失敗しました");
  loadTurnover();
});

async function showSold(month) {
  const res = await fetch(`/api/turnover/${month}/sold`);
  const j = await res.json();
  if (!res.ok) return alert(j.error || "読み込みに失敗しました");
  $("tvSoldTitle").textContent = `${monthLabel(month)}に売れた車（${monthLabel(j.next_month)}の月初在庫に無い車）：${j.rows.length}台`;
  $("tvSoldHead").innerHTML = "<tr><th>在庫No</th><th>メーカー</th><th>車名</th><th>初度</th><th>色</th><th>走行(km)</th><th>型式</th><th>車台番号</th><th>予定売価</th><th>仕入金額</th><th>入庫担当</th></tr>";
  $("tvSoldRows").innerHTML = j.rows.map((r) => `<tr>
    <td>${h(r.stock_no)}</td><td>${h(r.maker)}</td><td>${h(r.car_name)}</td><td>${h(r.first_reg)}</td>
    <td class="clip" style="max-width:140px" title="${h(r.color)}">${h(r.color)}</td>
    <td class="n">${r.mileage_km == null ? "" : r.mileage_km.toLocaleString()}</td><td>${h(r.model_code)}</td><td>${h(r.chassis_no)}</td>
    <td class="n">${r.planned_price ? yen(r.planned_price) : ""}</td><td class="n">${r.cost ? yen(r.cost) : ""}</td><td>${h(r.staff)}</td></tr>`).join("");
  $("tvSoldCard").hidden = false;
  $("tvSoldCard").scrollIntoView({ behavior: "smooth" });
}

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
