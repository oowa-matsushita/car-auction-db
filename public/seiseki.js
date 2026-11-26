"use strict";
// ---------- 成績：担当者ごとの販売台数 ----------
const sj = { data: null, seq: 0 };
const sjMan = (v) => (v == null ? "—" : (v / 10000).toFixed(1) + "万円");
const sjMonthL = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;

async function loadSeiseki() {
  const seq = ++sj.seq;
  $("sjInfo").textContent = "読み込み中…";
  let d;
  try { const res = await fetch("/api/performance?ch=" + $("sjCh").value); d = await res.json(); if (!res.ok) throw new Error(d.error || res.status); }
  catch (e) { $("sjInfo").textContent = "❌ 読み込めませんでした（" + e.message + "）"; return; }
  if (seq !== sj.seq) return;
  sj.data = d;
  // 期間の選び方：月ごと／直近3か月／全部
  const sel = $("sjSpan"), keep = sel.value;
  const opts = d.months.map((m) => [m, sjMonthL(m)]);
  if (d.months.length >= 2) opts.push(["3", "直近3か月"]);
  if (d.months.length >= 2) opts.push(["all", "全部の月"]);
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
  for (const r of d.rows) {
    if (!use.includes(r.month)) continue;
    const a = agg.get(r.staff) || { staff: r.staff, name: r.name, n: 0, retail: 0, wholesale: 0, gsum: 0, gn: 0, sales: 0 };
    a.n += r.n; a.retail += r.retail; a.wholesale += r.wholesale; a.gsum += r.gsum; a.gn += r.gn; a.sales += r.sales;
    agg.set(r.staff, a);
  }
  const list = [...agg.values()].sort((a, b) => b.n - a.n);
  const total = list.reduce((s, a) => s + a.n, 0), tR = list.reduce((s, a) => s + a.retail, 0), tW = list.reduce((s, a) => s + a.wholesale, 0);
  const gS = list.reduce((s, a) => s + a.gsum, 0), gN = list.reduce((s, a) => s + a.gn, 0), sales = list.reduce((s, a) => s + a.sales, 0);
  const label = use.length === 1 ? sjMonthL(use[0]) : `${sjMonthL(use[use.length - 1])}〜${sjMonthL(use[0])}`;
  $("sjInfo").textContent = `${label}・担当者 ${list.length}人`;
  const max = Math.max(...list.map((a) => a.n), 1);
  const bars = list.map((a, i) => `<div class="sj-bar"><span class="rk">${i + 1}</span><span title="${h(a.name)}">${h(a.name)}</span>
      <div class="tr" title="小売 ${a.retail}台・業販 ${a.wholesale}台"><i style="width:${(a.retail / max) * 100}%;background:#10b8c4"></i><i style="width:${(a.wholesale / max) * 100}%;background:#f2994a"></i></div><b class="n">${a.n}台</b></div>`).join("");
  const rows = list.map((a, i) => `<tr><td>${i + 1}</td><td>${h(a.name)}</td><td><b>${a.n}</b></td><td>${a.retail}</td><td>${a.wholesale}</td><td>${total ? Math.round((a.n / total) * 100) : 0}%</td><td>${a.gn ? sjMan(a.gsum / a.gn) : "—"}</td><td>${Math.round(a.sales / 1e4).toLocaleString()}万円</td></tr>`).join("");
  // 月ごとの台数（新しい月から最大4か月）
  const mons = d.months.slice(0, 4).slice().reverse();
  const by = new Map(); for (const r of d.rows) by.set(r.month + "|" + r.staff, r.n);
  const order = [...new Set([...list.map((a) => a.staff), ...d.rows.map((r) => r.staff)])];
  const nameOf = new Map(d.rows.map((r) => [r.staff, r.name]));
  const mmax = Math.max(...d.rows.filter((r) => mons.includes(r.month)).map((r) => r.n), 1);
  const lastTot = (st) => mons.reduce((s, m) => s + (by.get(m + "|" + st) || 0), 0);
  const mrows = order.map((st) => ({ st, t: lastTot(st) })).filter((x) => x.t > 0).sort((a, b) => b.t - a.t)
    .map(({ st }) => `<tr><td>${h(nameOf.get(st) || st)}</td>${mons.map((m) => { const n = by.get(m + "|" + st) || 0; return `<td class="sj-cell"><b>${n || ""}</b><i style="width:${(n / mmax) * 100}%"></i></td>`; }).join("")}</tr>`).join("");
  const partial = d.months[0] && use.includes(d.months[0]) ? "（今月は途中までの数字です）" : "";
  body.innerHTML = `<div class="sj-kpis">
      <div><span>販売台数 ${label}</span><b>${total.toLocaleString()}台</b><em>小売 ${tR.toLocaleString()}台・業販 ${tW.toLocaleString()}台 ${partial}</em></div>
      <div><span>担当者</span><b>${list.length}人</b><em>1人あたり ${list.length ? (total / list.length).toFixed(1) : 0}台</em></div>
      <div><span>平均台粗利</span><b>${gN ? sjMan(gS / gN) : "—"}</b><em>値引き後・経費を引いた額</em></div>
      <div><span>売上高（税抜）</span><b>${Math.round(sales / 1e4).toLocaleString()}万円</b><em>車輛本体−値引き</em></div></div>
    <div class="sj-card"><h3>🏆 担当者ごとの販売台数</h3>${bars}
      <div class="tv-note" style="margin-top:6px"><span class="an-key" style="background:#10b8c4"></span>小売　<span class="an-key" style="background:#f2994a"></span>業販（「業販）」と付いた担当者名も、同じ人にまとめています）</div></div>
    <div class="sj-card"><h3>📋 成績の表</h3><div style="overflow:auto"><table class="sj-tb"><thead><tr><th>順位</th><th>担当者</th><th>台数</th><th>小売</th><th>業販</th><th>構成比</th><th>平均台粗利</th><th>売上高（税抜）</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="sj-card"><h3>📅 月ごとの台数（直近${mons.length}か月）</h3><div style="overflow:auto"><table class="sj-tb"><thead><tr><th>担当者</th>${mons.map((m) => `<th>${sjMonthL(m)}</th>`).join("")}</tr></thead><tbody>${mrows}</tbody></table></div></div>`;
}
$("sjSpan").addEventListener("change", drawSeiseki);
$("sjCh").addEventListener("change", loadSeiseki);
