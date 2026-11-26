"use strict";
// ---------- 成績：営業（担当者）ごとの販売台数（小売のみ） ----------
const sj = { data: null, seq: 0 };
const sjMonthL = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;

async function loadSeiseki() {
  const seq = ++sj.seq;
  $("sjInfo").textContent = "読み込み中…";
  let d;
  try { const res = await fetch("/api/performance?ch=retail"); d = await res.json(); if (!res.ok) throw new Error(d.error || res.status); }
  catch (e) { $("sjInfo").textContent = "❌ 読み込めませんでした（" + e.message + "）"; return; }
  if (seq !== sj.seq) return;
  sj.data = d;
  const sel = $("sjSpan"), keep = sel.value;
  const opts = d.months.map((m) => [m, sjMonthL(m)]);
  if (d.months.length >= 2) opts.push(["3", "直近3か月"], ["all", "全部の月"]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  sel.value = opts.some(([v]) => v === keep) ? keep : (d.months[0] || "");
  drawSeiseki();
}

function drawSeiseki() {
  const d = sj.data, body = $("sjBody");
  if (!d || !d.months.length) { body.innerHTML = '<div class="nw-empty">担当者つきの販売データがありません。「担当者名」の列がある販売データのCSVを、回転率のタブから取り込んでください。</div>'; $("sjInfo").textContent = ""; return; }
  const v = $("sjSpan").value;
  const use = v === "all" ? d.months : v === "3" ? d.months.slice(0, 3) : [v];
  const agg = new Map();
  for (const r of d.rows) { if (!use.includes(r.month)) continue; const a = agg.get(r.staff) || { name: r.name, n: 0 }; a.n += r.retail; agg.set(r.staff, a); }
  const list = [...agg.values()].filter((a) => a.n > 0).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ja"));
  const total = list.reduce((s, a) => s + a.n, 0);
  $("sjInfo").textContent = use.length === 1 ? `${sjMonthL(use[0])}（小売のみ）` : `${sjMonthL(use[use.length - 1])}〜${sjMonthL(use[0])}（小売のみ）`;
  body.innerHTML = `<div class="sj-card" style="max-width:420px"><table class="sj-tb"><thead><tr><th>営業</th><th>販売台数</th></tr></thead><tbody>${
    list.map((a) => `<tr><td>${h(a.name)}</td><td><b>${a.n}台</b></td></tr>`).join("")}</tbody><tfoot><tr><td><b>合計</b></td><td><b>${total}台</b></td></tr></tfoot></table></div>`;
}
$("sjSpan").addEventListener("change", drawSeiseki);
// 販売データのCSVを、この画面からも取り込める（回転率と成績の両方が更新される）
dropZone($("dropSj"), $("inSj"), importInventory);
