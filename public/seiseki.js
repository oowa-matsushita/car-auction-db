"use strict";
// ---------- 成績：営業（担当者）ごとの販売台数（小売のみ） ----------
const sj = { data: null, seq: 0, open: null };
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

// 担当者を押したとき：直近3か月の月ごとの販売台数（小売のみ）を棒グラフで出す
function sjChart(st) {
  const d = sj.data, ms = d.months.slice(0, 3).reverse();
  const vals = ms.map((m) => { const r = d.rows.find((x) => x.month === m && x.staff === st); return r ? r.retail : 0; });
  const mx = Math.max(...vals, 1), W = 360, H = 130, bw = 70, gap = (W - bw * ms.length) / (ms.length + 1);
  const bars = vals.map((v, i) => { const x = gap + i * (bw + gap), hh = (v / mx) * (H - 52); return `<rect x="${x}" y="${H - 28 - hh}" width="${bw}" height="${Math.max(hh, 1)}" rx="4" fill="#10b8c4"/><text x="${x + bw / 2}" y="${H - 32 - hh}" text-anchor="middle" font-size="15" font-weight="800" fill="#13234a">${v}台</text><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="12" fill="#334">${Number(ms[i].slice(5))}月${i === ms.length - 1 && ms[i] === d.months[0] ? "（途中）" : ""}</text>`; }).join("");
  return `<div style="margin:2px 0 8px"><b style="font-size:12px;color:#13234a">直近3か月の販売台数（小売）</b><svg width="100%" viewBox="0 0 ${W} ${H}" style="max-width:${W}px;display:block">${bars}</svg></div>`;
}

function drawSeiseki() {
  const d = sj.data, body = $("sjBody");
  if (!d || !d.months.length) { body.innerHTML = '<div class="nw-empty">担当者つきの販売データがありません。「担当者名」の列がある販売データのCSVを、回転率のタブから取り込んでください。</div>'; $("sjInfo").textContent = ""; return; }
  const v = $("sjSpan").value;
  const use = v === "all" ? d.months : v === "3" ? d.months.slice(0, 3) : [v];
  const agg = new Map();
  for (const r of d.rows) { if (!use.includes(r.month)) continue; const a = agg.get(r.staff) || { staff: r.staff, name: r.name, n: 0 }; a.n += r.retail; agg.set(r.staff, a); }
  const list = [...agg.values()].filter((a) => a.n > 0).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ja"));
  const total = list.reduce((s, a) => s + a.n, 0);
  $("sjInfo").textContent = use.length === 1 ? `${sjMonthL(use[0])}（小売のみ）` : `${sjMonthL(use[use.length - 1])}〜${sjMonthL(use[0])}（小売のみ）`;
  body.innerHTML = `<div class="sj-card" style="max-width:720px"><table class="sj-tb"><thead><tr><th>営業</th><th>販売台数</th></tr></thead><tbody>${
    list.map((a) => `<tr class="sj-row${sj.open === a.staff ? " on" : ""}" data-st="${h(a.staff)}"><td>${sj.open === a.staff ? "▼" : "▶"} ${h(a.name)}</td><td><b>${a.n}台</b></td></tr>${sj.open === a.staff ? `<tr class="sj-det"><td colspan="2">${sjChart(a.staff)}<div id="sjDet" class="tv-note">読み込み中…</div></td></tr>` : ""}`).join("")}</tbody><tfoot><tr><td><b>合計</b></td><td><b>${total}台</b></td></tr></tfoot></table></div>`;
}
$("sjSpan").addEventListener("change", () => { sj.open = null; drawSeiseki(); });
// 担当者の行を押すと、その人が販売した車の一覧を、行の下に開く
$("sjBody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr.sj-row"); if (!tr) return;
  const st = tr.dataset.st;
  sj.open = sj.open === st ? null : st;
  drawSeiseki();
  if (!sj.open) return;
  const v = $("sjSpan").value, d = sj.data, use = v === "all" ? d.months : v === "3" ? d.months.slice(0, 3) : [v];
  try {
    const r = await fetch(`/api/performance/cars?ch=retail&staff=${encodeURIComponent(st)}&months=${use.join(",")}`), j = await r.json();
    const box = $("sjDet"); if (!box || sj.open !== st) return;
    const man = (x) => (x == null ? "—" : (x / 10000).toFixed(1) + "万円");
    box.className = "";
    box.innerHTML = `<table class="sj-tb sj-in"><thead><tr><th>契約日</th><th>車名</th><th>本体価格（値引後）</th><th>台粗利</th></tr></thead><tbody>${j.cars.map((c) => `<tr><td>${h(String(c.date || "").slice(5).replace("-", "/"))}</td><td>${h(c.car)}${c.is_new ? ' <span class="tv-note">新車</span>' : ""}</td><td>${man(c.price)}</td><td>${man(c.gross)}</td></tr>`).join("")}</tbody></table>`;
  } catch { const box = $("sjDet"); if (box) box.textContent = "読み込めませんでした"; }
});
