"use strict";
// ---------- ポジション：現在庫（カーセンサー掲載中の車）の年式 × 価格マップ ----------
const ps = { data: null, comp: null, seq: 0, sel: null, ssel: null, hov: null };
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
const PS_SELF = "#1f2d5c";
const PS_PAL = ["#e6550d", "#1a9850", "#7b3294", "#c51b7d", "#2b83ba", "#b8860b", "#00897b", "#8d6e63", "#d73027", "#5e8c00", "#6a51a3", "#0097a7", "#e3a008", "#546e7a"];
const psShopColor = (m, i) => (m.self ? PS_SELF : PS_PAL[i % PS_PAL.length]);
const psNorm = (t) => String(t || "").toLowerCase().replace(/[\s\-ー・.．]/g, "");
const psTextW = (t, fs) => [...t].reduce((a, ch) => a + (ch.charCodeAt(0) < 256 ? fs * 0.58 : fs), 0);

// 軸・格子つきの枠。点の範囲に合わせて 年式（横）と価格（縦）を拡大する
function psFrame(ys, ps_, { W = 1000, H = 600 } = {}) {
  const L = 62, R = 16, T = 16, B = 46;
  const x0 = Math.floor((Math.min(...ys) - 0.45) * 2) / 2, x1 = Math.ceil((Math.max(...ys) + 0.45) * 2) / 2;
  const lo = Math.min(...ps_), hi = Math.max(...ps_), span = hi - lo;
  const step = span > 3e6 ? 1e6 : span > 1.2e6 ? 5e5 : 2e5;
  const y0 = Math.max(0, Math.floor((lo - span * 0.08) / step) * step), y1 = Math.ceil((hi + span * 0.1) / step) * step;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="ps-svg" role="img" aria-label="現在庫のポジショニングマップ">`;
  for (let v = y0; v <= y1 + 1; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e1e6ee"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="#60708a">${Math.round(v / 1e4)}</text>`;
  const xs = x1 - x0 > 8 ? 1 : 0.5;
  for (let y = Math.ceil(x0 / xs) * xs; y <= x1 + 1e-9; y += xs) s += `<line y1="${T}" y2="${H - B}" x1="${X(y)}" x2="${X(y)}" stroke="#e1e6ee"/><text x="${X(y)}" y="${H - B + 18}" text-anchor="middle" font-size="12" fill="#60708a">${psWa(y)}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle" font-size="13" fill="#34445c">年式（新しいほど右）</text>`;
  s += `<text transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="#34445c">平均価格（万円）</text>`;
  return { s, X, Y, W, H, L, R, T, B };
}
const psCross = (f, x, y) => `<line x1="${f.X(x)}" x2="${f.X(x)}" y1="${f.T}" y2="${f.H - f.B}" stroke="#2a3b5c" stroke-opacity=".55" stroke-dasharray="6 5"/><line x1="${f.L}" x2="${f.W - f.R}" y1="${f.Y(y)}" y2="${f.Y(y)}" stroke="#2a3b5c" stroke-opacity=".55" stroke-dasharray="6 5"/>`;
const psQuads = (f) => [["古い・安い", f.L + 6, f.H - f.B - 8, "start"], ["新しい・安い", f.W - f.R - 6, f.H - f.B - 8, "end"], ["古い・高い", f.L + 6, f.T + 16, "start"], ["新しい・高い", f.W - f.R - 6, f.T + 16, "end"]]
  .map(([t, x, y, a]) => `<text x="${x}" y="${y}" text-anchor="${a}" font-size="13" fill="#b2bccb" font-weight="700">${t}</text>`).join("");

// ラベルが重ならないように、置き場所を順に探す（置けないときは引き出し線）
function psLabels(items, f) {
  const placed = [], out = [];
  const hit = (a, b) => !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);
  for (const it of items) {
    const fs = it.fs || 12, w = psTextW(it.text, fs) + 4, hgt = fs + 4;
    let best = null;
    for (const ring of [0, 1, 2, 3, 4]) {
      const d = it.r + 5 + ring * 15;
      const cand = [[0, -d], [0, d + hgt], [d + 2, 0], [-d - 2, 0], [d * 0.75, -d * 0.75], [-d * 0.75, -d * 0.75], [d * 0.75, d * 0.75 + hgt], [-d * 0.75, d * 0.75 + hgt]];
      for (const [dx, dy] of cand) {
        const cx = it.x + dx, cy = it.y + dy;
        const anchor = dx > 4 ? "start" : dx < -4 ? "end" : "middle";
        const x1 = anchor === "start" ? cx : anchor === "end" ? cx - w : cx - w / 2;
        const box = { x1, x2: x1 + w, y1: cy - hgt + 3, y2: cy + 3 };
        if (box.x1 < f.L || box.x2 > f.W - f.R || box.y1 < f.T || box.y2 > f.H - f.B) continue;
        if (placed.some((p) => hit(p, box))) continue;
        best = { box, cx, cy, anchor, ring }; break;
      }
      if (best) break;
    }
    if (!best) continue; // どうしても置けない店は、ラベルなし（一覧の色で見分ける）
    placed.push(best.box);
    const lead = best.ring >= 1 ? `<line x1="${it.x}" y1="${it.y}" x2="${(best.box.x1 + best.box.x2) / 2}" y2="${(best.box.y1 + best.box.y2) / 2}" stroke="#8896a8" stroke-width=".8"/>` : "";
    out.push(`${lead}<text x="${best.cx}" y="${best.cy}" text-anchor="${best.anchor}" font-size="${fs}" font-weight="${it.bold ? 800 : 600}" fill="${it.color || "#1f2d44"}" paint-order="stroke" stroke="#fff" stroke-width="3.5" pointer-events="none">${h(it.text)}</text>`);
  }
  return out.join("");
}

function psModelMatch(own, name) { const a = psNorm(name), b = psNorm(own); return !!a && !!b && (a === b || b.includes(a) || (a.length >= 3 && a.includes(b))); }

function drawPosition() {
  const d = ps.data, body = $("psBody");
  if (!d || !d.month) { body.innerHTML = '<div class="nw-empty">カーセンサーのデータがまだありません（分析タブから取り込めます）</div>'; $("psInfo").textContent = ""; return; }
  const cars = d.cars.filter((c) => c.price > 0 && psYear(c.year)).map((c) => ({ ...c, _y: psYear(c.year) }));
  const mode = $("psMode").value, minN = Math.max(1, Number($("psMin").value) || 1), q = $("psQ").value.trim();
  $("psMin").disabled = mode !== "model";
  if (!cars.length) { body.innerHTML = '<div class="nw-empty">年式と価格のある車がありません</div>'; return; }
  if (mode === "model" && ps.sel) return drawModelDetail(cars, body);
  const shopMode = mode === "shop";
  const items = shopMode ? psShops(cars, ps.comp, q) : psModels(cars, mode === "model" ? minN : 1);
  $("psInfo").textContent = shopMode ? "" : `掲載中 ${cars.length}台（${d.month}・${d.through}まで）`;
  if (!items.length) { body.innerHTML = '<div class="nw-empty">条件に合う車がありません</div>'; return; }
  const me = shopMode ? items.find((m) => m.self) : null;
  const myY = me ? me.y : psAvg(cars.map((c) => c._y)), myP = me ? me.p : psAvg(cars.map((c) => c.price));
  if (shopMode) { const cs = items.filter((m) => !m.self); $("psInfo").textContent = `自社 ${me ? me.n : 0}台 ＋ 競合${cs.length}店 ${cs.reduce((a, m) => a + m.n, 0)}台` + (ps.comp ? "" : "（競合のデータを読み込めませんでした）") + (q ? `　車名「${q}」で絞り込み中` : ""); }

  const hit = (n) => q && String(n).toLowerCase().includes(q.toLowerCase());
  const f = psFrame(mode !== "car" ? [...items.map((m) => m.y), myY] : [...cars.map((c) => c._y), myY], mode !== "car" ? [...items.map((m) => m.p), myP] : [...cars.map((c) => c.price), myP]);
  let s = f.s + psCross(f, myY, myP) + psQuads(f);
  const colorOf = new Map(); items.forEach((m, i) => colorOf.set(m.key, shopMode ? psShopColor(m, i) : psColor(m.days)));
  const rmax = Math.max(...items.map((m) => m.n));
  if (mode !== "car") {
    const lab = [];
    for (const m of [...items].sort((a, b) => b.n - a.n)) {
      const r = (shopMode ? 5 : 6) + (shopMode ? 15 : 24) * Math.sqrt(m.n / rmax), on = (shopMode ? ps.ssel : ps.sel) === m.key || (!shopMode && hit(m.name)), fill = colorOf.get(m.key);
      s += `<g class="ps-b" data-k="${h(m.key)}"><circle cx="${f.X(m.y)}" cy="${f.Y(m.p)}" r="${r}" fill="${fill}" fill-opacity="${on || m.self ? 0.92 : 0.6}" stroke="${on ? "#111" : "#fff"}" stroke-width="${on ? 2.5 : 1.3}"><title>${h(m.name)}\n${m.n}台　平均 ${psWa(m.y)}年式 ・ ${psMan(m.p)}</title></circle></g>`;
      if (shopMode || m.n >= Math.max(8, rmax * 0.25) || on) lab.push({ x: f.X(m.y), y: f.Y(m.p), r, text: m.self ? "★ 自社" : m.name.length > 11 ? m.name.slice(0, 10) + "…" : m.name, fs: m.self ? 14 : 12, bold: m.self, color: m.self ? PS_SELF : "#1f2d44", pri: m.self ? 1e9 : m.n });
    }
    lab.sort((a, b) => b.pri - a.pri);
    s += psLabels(lab, f);
  } else {
    cars.forEach((c, i) => {
      const jx = (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.7, on = hit(c.name);
      s += `<circle cx="${f.X(c._y + jx)}" cy="${f.Y(c.price)}" r="${on ? 5 : 3.2}" fill="${on ? "#111" : psColor(c.posted)}" fill-opacity="${on ? 0.95 : 0.45}"><title>${h(c.name)} ${h(c.grade || "")}\n${c.year} ・ ${psMan(c.price)} ・ ${h(c.mileage || "")}</title></circle>`;
    });
  }
  if (!shopMode) s += `<circle cx="${f.X(myY)}" cy="${f.Y(myP)}" r="9" fill="#fff" stroke="#2a3b5c" stroke-width="3"/><text x="${f.X(myY) + (f.X(myY) > f.W * 0.6 ? -14 : 14)}" y="${f.Y(myP) - 12}" text-anchor="${f.X(myY) > f.W * 0.6 ? "end" : "start"}" font-size="13" font-weight="800" fill="#2a3b5c" paint-order="stroke" stroke="#fff" stroke-width="4">★ 自社の平均 ${psWa(myY)}年式 ・ ${psMan(myP)}</text>`;
  s += "</svg>";

  const sel = items.find((m) => m.key === (shopMode ? ps.ssel : ps.sel));
  const legend = shopMode ? `<div class="ps-leg"><span>色＝店舗（右の一覧と同じ色）</span><span>円の大きさ＝台数</span><span>右の一覧にマウスを乗せると、その店だけ濃くなります</span></div>`
    : `<div class="ps-leg"><span><i style="background:${PS_COL.fresh}"></i>掲載30日以内</span><span><i style="background:${PS_COL.mid}"></i>〜90日</span><span><i style="background:${PS_COL.old}"></i>90日超（滞留）</span>${mode !== "car" ? "<span>円の大きさ＝台数</span><span>車種の丸をクリックすると、その車種の店舗ごとの在庫車両を表示します</span>" : ""}</div>`;
  const price = cars.map((c) => c.price).sort((a, b) => a - b), med = price[Math.floor(price.length / 2)];
  const stat = `<div class="ps-me"><b>★ 自社のポジション</b><br>平均年式 <b>${psWa(psAvg(cars.map((c) => c._y)))}</b>・平均価格 <b>${psMan(psAvg(cars.map((c) => c.price)))}</b>・中央値 ${psMan(med)}<br><span>新しい車（R07以降）の割合 ${Math.round((cars.filter((c) => c._y >= 2025).length / cars.length) * 100)}% ／ 300万円以上の割合 ${Math.round((cars.filter((c) => c.price >= 3e6).length / cars.length) * 100)}%</span></div>`;
  let compNote = "";
  if (shopMode) { const cs = items.filter((m) => !m.self), cn = cs.reduce((a, m) => a + m.n, 0); if (cn) compNote = `<div class="ps-me"><b>競合${cs.length}店の平均</b>（${cn}台）<br>平均年式 <b>${psWa(cs.reduce((a, m) => a + m.y * m.n, 0) / cn)}</b>・平均価格 <b>${psMan(cs.reduce((a, m) => a + m.p * m.n, 0) / cn)}</b></div>`; }
  let rows = "";
  items.forEach((m, i) => { rows += `<tr class="${m.key === (shopMode ? ps.ssel : ps.sel) ? "on" : ""}" data-k="${h(m.key)}" style="${m.self ? "font-weight:800" : ""}"><td>${shopMode ? `<i class="ps-dot" style="background:${psShopColor(m, i)}"></i>` : ""}${h(m.name)}</td><td>${m.n}</td><td>${psWa(m.y)}</td><td>${psMan(m.p)}</td><td>${m.days == null ? "—" : Math.round(m.days) + "日"}</td></tr>`; });
  const detail = sel ? `<div class="ps-me"><b>${h(sel.name)}</b>　${sel.n}台<br>平均 ${psWa(sel.y)}年式 ・ ${psMan(sel.p)}（${psMan(sel.pmin)}〜${psMan(sel.pmax)}）<br>平均走行 ${sel.km == null ? "—" : Math.round(sel.km).toLocaleString() + "km"} ・ 平均掲載 ${sel.days == null ? "—" : Math.round(sel.days) + "日"}</div>` : "";
  body.innerHTML = `<div class="ps-wrap"><div class="ps-main">${legend}${s}</div><div class="ps-side">${stat}${compNote}${detail}<table class="ps-tb"><thead><tr><th>${shopMode ? "店舗" : "車種"}</th><th>台数</th><th>年式</th><th>平均価格</th><th>掲載</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  psWire(body, (k) => { if (shopMode) ps.ssel = ps.ssel === k ? null : k; else ps.sel = k; drawPosition(); });
}

// 丸・一覧の行：クリックで選択、マウスを乗せるとその店（車種）だけ濃くする
function psWire(body, onClick) {
  const hl = (k) => body.querySelectorAll("svg .ps-b, svg .ps-c").forEach((el) => (el.style.opacity = !k || el.dataset.k === k ? "" : "0.12"));
  body.querySelectorAll("[data-k]").forEach((el) => {
    el.onclick = () => onClick(el.dataset.k);
    el.onmouseenter = () => hl(el.dataset.k);
    el.onmouseleave = () => hl(null);
  });
}

// 車種ごとで丸を押したとき：その車種の、店舗ごとの在庫車両を1台ずつ表示
function drawModelDetail(cars, body) {
  const all = psModels(cars, 1), m = all.find((x) => x.key === ps.sel);
  if (!m) { ps.sel = null; return drawPosition(); }
  const own = cars.filter((c) => (c.key || c.name || c.model) === m.key).map((c) => ({ shop: "self", name: "自社", y: c._y, price: c.price, grade: c.grade, km: psKm(c.mileage), days: c.posted }));
  const comp = (ps.comp || []).filter((c) => c.year > 0 && c.total_price > 0 && psModelMatch(c.model, m.name))
    .map((c) => ({ shop: c.shop_code, name: String(c.shop_name || c.shop_code).replace(/（株）|株式会社/g, "").replace(/　/g, " ").trim(), y: c.year, price: c.total_price * 1e4, grade: c.grade, km: c.mileage > 0 ? c.mileage : null, days: c.days }));
  const list = [...own, ...comp];
  const by = new Map();
  for (const c of list) (by.get(c.shop) || by.set(c.shop, { key: c.shop, name: c.name, self: c.shop === "self", cars: [] }).get(c.shop)).cars.push(c);
  const shops = [...by.values()].map((g) => ({ ...g, n: g.cars.length, y: psAvg(g.cars.map((c) => c.y)), p: psAvg(g.cars.map((c) => c.price)), pmin: Math.min(...g.cars.map((c) => c.price)), pmax: Math.max(...g.cars.map((c) => c.price)) })).sort((a, b) => (b.self - a.self) || b.n - a.n);
  $("psInfo").textContent = `${m.name}：自社 ${own.length}台 ＋ 競合${shops.filter((x) => !x.self).length}店 ${comp.length}台` + (ps.comp ? "" : "（競合のデータを読み込めませんでした）");
  const back = `<button class="ps-back" id="psBack">← 車種一覧にもどる</button>`;
  if (!list.length) { body.innerHTML = `<div class="ps-main">${back}<div class="nw-empty">この車種の在庫がありません</div></div>`; $("psBack").onclick = () => { ps.sel = null; drawPosition(); }; return; }
  const myY = own.length ? psAvg(own.map((c) => c.y)) : null, myP = own.length ? psAvg(own.map((c) => c.price)) : null;
  const f = psFrame(list.map((c) => c.y), list.map((c) => c.price));
  let s = f.s + psQuads(f) + (myY != null ? psCross(f, myY, myP) : "");
  const col = new Map(); shops.forEach((x, i) => col.set(x.key, psShopColor(x, i)));
  // 自社を最前面にするため、競合 → 自社 の順に描く
  const order = [...shops].sort((a, b) => a.self - b.self);
  for (const g of order) g.cars.forEach((c, i) => {
    const jx = (((i * 2654435761 + g.key.length * 97) % 1000) / 1000 - 0.5) * 0.5, on = ps.ssel === g.key;
    s += `<circle class="ps-c" data-k="${h(g.key)}" cx="${f.X(c.y + jx)}" cy="${f.Y(c.price)}" r="${g.self ? 6.5 : 4.6}" fill="${col.get(g.key)}" fill-opacity="${g.self ? 0.95 : 0.7}" stroke="${on ? "#111" : "#fff"}" stroke-width="${on ? 2 : 1}"><title>${h(g.name)}\n${h(c.grade || "")}\n${psWa(c.y)}年式 ・ ${psMan(c.price)}${c.km != null ? " ・ " + Math.round(c.km).toLocaleString() + "km" : ""}${c.days != null ? " ・ 掲載" + Math.round(c.days) + "日" : ""}</title></circle>`;
  });
  if (myY != null) s += `<text x="${f.X(myY) + (f.X(myY) > f.W * 0.6 ? -8 : 8)}" y="${f.Y(myP) - 8}" text-anchor="${f.X(myY) > f.W * 0.6 ? "end" : "start"}" font-size="13" font-weight="800" fill="${PS_SELF}" paint-order="stroke" stroke="#fff" stroke-width="4">★ 自社の平均 ${psWa(myY)} ・ ${psMan(myP)}</text>`;
  s += "</svg>";
  let rows = "";
  shops.forEach((x, i) => { rows += `<tr class="${x.key === ps.ssel ? "on" : ""}" data-k="${h(x.key)}" style="${x.self ? "font-weight:800" : ""}"><td><i class="ps-dot" style="background:${col.get(x.key)}"></i>${h(x.name)}</td><td>${x.n}</td><td>${psWa(x.y)}</td><td>${psMan(x.p)}</td><td>${psMan(x.pmin)}〜${psMan(x.pmax)}</td></tr>`; });
  const cn = comp.length;
  const note = cn ? `<div class="ps-me"><b>競合${shops.filter((x) => !x.self).length}店の平均</b>（${cn}台）<br>平均年式 <b>${psWa(psAvg(comp.map((c) => c.y)))}</b>・平均価格 <b>${psMan(psAvg(comp.map((c) => c.price)))}</b></div>` : `<div class="ps-me">競合店にこの車種の在庫が見つかりませんでした</div>`;
  body.innerHTML = `<div class="ps-wrap"><div class="ps-main">${back}<span class="ps-ttl">${h(m.name)}　店舗ごとの在庫車両（1つの点＝1台）</span><div class="ps-leg"><span>色＝店舗（右の一覧と同じ色）</span><span>一覧にマウスを乗せると、その店の車だけ濃くなります</span></div>${s}</div><div class="ps-side">${note}<table class="ps-tb"><thead><tr><th>店舗</th><th>台数</th><th>年式</th><th>平均価格</th><th>価格帯</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  $("psBack").onclick = () => { ps.sel = null; ps.ssel = null; drawPosition(); };
  psWire(body, (k) => { ps.ssel = ps.ssel === k ? null : k; drawPosition(); });
}

$("psMode").addEventListener("change", () => { ps.sel = null; ps.ssel = null; drawPosition(); });
$("psMin").addEventListener("change", drawPosition);
$("psQ").addEventListener("input", drawPosition);
