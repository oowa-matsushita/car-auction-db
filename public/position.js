"use strict";
// ---------- ポジション：現在庫（カーセンサー掲載中の車）の年式 × 価格マップ ----------
const ps = { data: null, seq: 0, sel: null };
const PS_COL = { fresh: "#1aa6b7", mid: "#f0a92b", old: "#d9534f", none: "#8896a8" };

// 年式（R07 / H30 など）→ 西暦
function psYear(y) {
  const m = /^([RHS])0*(\d+)/.exec(String(y || "").toUpperCase());
  if (!m) return null;
  return { R: 2018, H: 1988, S: 1925 }[m[1]] + Number(m[2]);
}
const psWa = (y) => (y >= 2019 ? "R" + String(Math.round((y - 2018) * 10) / 10).replace(/^(\d)(\.|$)/, "0$1$2") : y >= 1989 ? "H" + Math.round((y - 1988) * 10) / 10 : String(Math.round(y)));
const psMan = (v) => (v == null ? "—" : Math.round(v / 10000).toLocaleString() + "万円");
function psKm(s) {
  const t = String(s || "").replace(/,/g, "");
  let m = /([\d.]+)\s*万/.exec(t); if (m) return Number(m[1]) * 10000;
  m = /([\d.]+)/.exec(t); return m ? Number(m[1]) : null;
}
const psAvg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

async function loadPosition() {
  const seq = ++ps.seq;
  $("psInfo").textContent = "読み込み中…";
  let d;
  try { const res = await fetch("/api/carsensor"); d = await res.json(); if (!res.ok) throw new Error(d.error || res.status); }
  catch (e) { $("psInfo").textContent = "❌ 読み込めませんでした（" + e.message + "）"; return; }
  // 競合店の現在庫（競合落品トラッカー）。取れなくても自社だけは出す
  let comp = null;
  try { const r2 = await fetch("/tracker/api/stock"); const j = await r2.json(); if (r2.ok && Array.isArray(j)) comp = j; } catch {}
  if (seq !== ps.seq) return;
  ps.data = d; ps.comp = comp;
  drawPosition();
}

function psModels(cars, minN) {
  const by = new Map();
  for (const c of cars) { const k = c.key || c.name || c.model; (by.get(k) || by.set(k, { name: c.name || c.model, cars: [] }).get(k)).cars.push(c); }
  const out = [];
  for (const [k, g] of by) {
    if (g.cars.length < minN) continue;
    const yr = g.cars.map((c) => c._y), pr = g.cars.map((c) => c.price), km = g.cars.map((c) => psKm(c.mileage)).filter((v) => v != null);
    out.push({ key: k, name: g.name, n: g.cars.length, y: psAvg(yr), p: psAvg(pr), pmin: Math.min(...pr), pmax: Math.max(...pr), km: psAvg(km), days: psAvg(g.cars.map((c) => c.posted).filter((v) => v != null)) });
  }
  return out.sort((a, b) => b.n - a.n);
}
// 店舗ごと：自社（カーセンサー掲載）＋ 競合店（トラッカーの現在庫）
function psShops(cars, comp, q) {
  const ok = (...t) => !q || t.join(" ").toLowerCase().includes(q.toLowerCase());
  const mk = (key, name, list, self) => {
    if (!list.length) return null;
    const pr = list.map((c) => c.price), km = list.map((c) => c.km).filter((v) => v != null), dy = list.map((c) => c.days).filter((v) => v != null);
    return { key, name, n: list.length, y: psAvg(list.map((c) => c.y)), p: psAvg(pr), pmin: Math.min(...pr), pmax: Math.max(...pr), km: psAvg(km), days: psAvg(dy), self };
  };
  const out = [mk("self", "自社", cars.filter((c) => ok(c.name, c.model, c.grade)).map((c) => ({ y: c._y, price: c.price, km: psKm(c.mileage), days: c.posted })), true)];
  const by = new Map();
  for (const c of comp || []) {
    if (!(c.year > 0) || !(c.total_price > 0) || !ok(c.model, c.grade, c.maker)) continue;
    (by.get(c.shop_code) || by.set(c.shop_code, { name: c.shop_name || c.shop_code, list: [] }).get(c.shop_code)).list.push({ y: c.year, price: c.total_price * 1e4, km: c.mileage > 0 ? c.mileage : null, days: c.days });
  }
  for (const [k, g] of by) out.push(mk(k, g.name.replace(/（株）|株式会社/g, "").replace(/　/g, " ").trim(), g.list, false));
  return out.filter(Boolean).sort((a, b) => b.n - a.n);
}
const psColor = (days) => (days == null ? PS_COL.none : days <= 30 ? PS_COL.fresh : days <= 90 ? PS_COL.mid : PS_COL.old);

function drawPosition() {
  const d = ps.data, body = $("psBody");
  if (!d || !d.month) { body.innerHTML = '<div class="nw-empty">カーセンサーのデータがまだありません（分析タブから取り込めます）</div>'; $("psInfo").textContent = ""; return; }
  const cars = d.cars.filter((c) => c.price > 0 && psYear(c.year)).map((c) => ({ ...c, _y: psYear(c.year) }));
  const mode = $("psMode").value, minN = Math.max(1, Number($("psMin").value) || 1), q = $("psQ").value.trim();
  $("psInfo").textContent = `掲載中 ${cars.length}台（${d.month}・${d.through}まで）`;
  if (!cars.length) { body.innerHTML = '<div class="nw-empty">年式と価格のある車がありません</div>'; return; }

  const shopMode = mode === "shop";
  const models = shopMode ? psShops(cars, ps.comp, q) : psModels(cars, mode === "model" ? minN : 1);
  if (!models.length) { body.innerHTML = '<div class="nw-empty">条件に合う車がありません</div>'; return; }
  const me = shopMode ? models.find((m) => m.self) : null;
  const myY = me ? me.y : psAvg(cars.map((c) => c._y)), myP = me ? me.p : psAvg(cars.map((c) => c.price));
  if (shopMode) $("psInfo").textContent = `自社 ${me ? me.n : 0}台 ＋ 競合${models.filter((m) => !m.self).length}店 ${models.filter((m) => !m.self).reduce((a, m) => a + m.n, 0)}台` + (ps.comp ? "" : "（競合のデータを読み込めませんでした）") + (q ? `　車名「${q}」で絞り込み中` : "");
  // 軸の範囲は、いま描く点（車種ごと＝平均、1台ずつ＝全部）に合わせる
  const ptY = mode !== "car" ? models.map((m) => m.y) : cars.map((c) => c._y), ptP = mode !== "car" ? models.map((m) => m.p) : cars.map((c) => c.price);
  const x0 = Math.min(...ptY, myY) - 0.7, x1 = Math.max(...ptY, myY) + 0.7;
  const yMax = Math.ceil(Math.max(...ptP, myP) / 1e6 + 0.3) * 1e6;
  const W = 1000, H = 600, L = 70, R = 20, T = 20, B = 50;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => H - B - (v / yMax) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="ps-svg" role="img" aria-label="現在庫のポジショニングマップ">`;
  // 格子と軸
  for (let v = 0; v <= yMax; v += 5e5) { const big = v % 1e6 === 0; if (!big && yMax > 4e6) continue; s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e1e6ee"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="#60708a">${v / 1e4}</text>`; }
  for (let y = Math.ceil(x0); y <= x1; y++) s += `<line y1="${T}" y2="${H - B}" x1="${X(y)}" x2="${X(y)}" stroke="#e1e6ee"/><text x="${X(y)}" y="${H - B + 20}" text-anchor="middle" font-size="12" fill="#60708a">${psWa(y)}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" font-size="13" fill="#34445c">年式（新しいほど右）</text>`;
  s += `<text transform="translate(16 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="#34445c">平均価格（万円）</text>`;
  // 自社の平均の十字線
  s += `<line x1="${X(myY)}" x2="${X(myY)}" y1="${T}" y2="${H - B}" stroke="#2a3b5c" stroke-dasharray="6 5"/><line x1="${L}" x2="${W - R}" y1="${Y(myP)}" y2="${Y(myP)}" stroke="#2a3b5c" stroke-dasharray="6 5"/>`;
  const qs = [["古い・安い", L + 6, H - B - 8, "start"], ["新しい・安い", W - R - 6, H - B - 8, "end"], ["古い・高い", L + 6, T + 16, "start"], ["新しい・高い", W - R - 6, T + 16, "end"]];
  for (const [t, x, y, a] of qs) s += `<text x="${x}" y="${y}" text-anchor="${a}" font-size="13" fill="#9aa8bd" font-weight="700">${t}</text>`;

  const hit = (n) => q && String(n).toLowerCase().includes(q.toLowerCase());
  if (mode !== "car") {
    const rmax = Math.max(...models.map((m) => m.n));
    for (const m of [...models].sort((a, b) => b.n - a.n)) {
      const r = 6 + 26 * Math.sqrt(m.n / rmax), on = ps.sel === m.key || (!shopMode && hit(m.name)), fill = m.self ? "#2a3b5c" : psColor(m.days);
      s += `<g class="ps-b" data-k="${h(m.key)}"><circle cx="${X(m.y)}" cy="${Y(m.p)}" r="${r}" fill="${fill}" fill-opacity="${on || m.self ? 0.9 : 0.55}" stroke="${on ? "#111" : "#fff"}" stroke-width="${on ? 2.5 : 1.2}"><title>${h(m.name)}\n${m.n}台　平均 ${psWa(m.y)}年式 ・ ${psMan(m.p)}</title></circle>`;
      if (shopMode || m.n >= Math.max(8, rmax * 0.25) || on) s += `<text x="${X(m.y)}" y="${Y(m.p) - r - 4}" text-anchor="middle" font-size="${m.self ? 14 : 12}" font-weight="${m.self ? 800 : 700}" fill="#1f2d44" paint-order="stroke" stroke="#fff" stroke-width="3">${h(m.self ? "★ 自社" : m.name.length > 9 ? m.name.slice(0, 8) + "…" : m.name)}</text>`;
      s += "</g>";
    }
  } else {
    cars.forEach((c, i) => {
      const jx = (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.7, on = hit(c.name);
      s += `<circle cx="${X(c._y + jx)}" cy="${Y(c.price)}" r="${on ? 5 : 3.2}" fill="${on ? "#111" : psColor(c.posted)}" fill-opacity="${on ? 0.95 : 0.45}"><title>${h(c.name)} ${h(c.grade || "")}\n${c.year} ・ ${psMan(c.price)} ・ ${h(c.mileage || "")}</title></circle>`;
    });
  }
  if (!shopMode) s += `<circle cx="${X(myY)}" cy="${Y(myP)}" r="9" fill="#fff" stroke="#2a3b5c" stroke-width="3"/><text x="${X(myY) + (X(myY) > W * 0.6 ? -14 : 14)}" y="${Y(myP) - 12}" text-anchor="${X(myY) > W * 0.6 ? "end" : "start"}" font-size="13" font-weight="800" fill="#2a3b5c" paint-order="stroke" stroke="#fff" stroke-width="4">★ 自社の平均 ${psWa(myY)}年式 ・ ${psMan(myP)}</text>`;
  s += "</svg>";

  // 右の表
  const sel = models.find((m) => m.key === ps.sel);
  const legend = `<div class="ps-leg"><span><i style="background:${PS_COL.fresh}"></i>掲載30日以内</span><span><i style="background:${PS_COL.mid}"></i>〜90日</span><span><i style="background:${PS_COL.old}"></i>90日超（滞留）</span>${mode !== "car" ? "<span>円の大きさ＝台数</span>" : ""}${shopMode ? `<span><i style="background:#2a3b5c"></i>自社</span>` : ""}</div>`;
  const price = cars.map((c) => c.price).sort((a, b) => a - b), med = price[Math.floor(price.length / 2)];
  const stat = `<div class="ps-me"><b>★ 自社のポジション</b><br>平均年式 <b>${psWa(myY)}</b>（${myY.toFixed(1)}年）・平均価格 <b>${psMan(myP)}</b>・中央値 ${psMan(med)}<br><span>新しい車（R07以降）の割合 ${Math.round((cars.filter((c) => c._y >= 2025).length / cars.length) * 100)}% ／ 300万円以上の割合 ${Math.round((cars.filter((c) => c.price >= 3e6).length / cars.length) * 100)}%</span></div>`;
  let compNote = "";
  if (shopMode) { const cs = models.filter((m) => !m.self), cn = cs.reduce((a, m) => a + m.n, 0); if (cn) compNote = `<div class="ps-me"><b>競合${cs.length}店の平均</b>（${cn}台）<br>平均年式 <b>${psWa(cs.reduce((a, m) => a + m.y * m.n, 0) / cn)}</b>・平均価格 <b>${psMan(cs.reduce((a, m) => a + m.p * m.n, 0) / cn)}</b></div>`; }
  let rows = "";
  for (const m of models) rows += `<tr class="${m.key === ps.sel ? "on" : ""}" style="${m.self ? "font-weight:800" : ""}" data-k="${h(m.key)}"><td>${h(m.name)}</td><td>${m.n}</td><td>${psWa(m.y)}</td><td>${psMan(m.p)}</td><td>${m.days == null ? "—" : Math.round(m.days) + "日"}</td></tr>`;
  const detail = sel ? `<div class="ps-me"><b>${h(sel.name)}</b>　${sel.n}台<br>平均 ${psWa(sel.y)}年式 ・ ${psMan(sel.p)}（${psMan(sel.pmin)}〜${psMan(sel.pmax)}）<br>平均走行 ${sel.km == null ? "—" : Math.round(sel.km).toLocaleString() + "km"} ・ 平均掲載 ${sel.days == null ? "—" : Math.round(sel.days) + "日"}</div>` : "";
  body.innerHTML = `<div class="ps-wrap"><div class="ps-main">${legend}${s}</div><div class="ps-side">${stat}${compNote}${detail}<table class="ps-tb"><thead><tr><th>${shopMode ? "店舗" : "車種"}</th><th>台数</th><th>年式</th><th>平均価格</th><th>掲載</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  body.querySelectorAll("[data-k]").forEach((el) => (el.onclick = () => { ps.sel = ps.sel === el.dataset.k ? null : el.dataset.k; drawPosition(); }));
}

["psMode", "psMin"].forEach((id) => $(id).addEventListener("change", drawPosition));
$("psQ").addEventListener("input", drawPosition);
