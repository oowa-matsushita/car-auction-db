"use strict";
// ---------- 確認リスト（左：一覧 / 右：直す欄と出品票） ----------
const rv = { items: [], kinds: [], selId: null, token: 0, bmp: null, regions: {}, pick: null };
const RV_FIELDS = [
  ["control_no", "管理番号", 1], ["auction_date", "開催日"], ["bid_price_man", "落札金額(万円)", 1],
  ["planned_price_man", "予定価格(万円)", 1], ["start_price_man", "スタート(万円)"], ["car_name", "車名"],
  ["grade", "グレード"], ["mileage_km", "走行(km)"], ["chassis_no", "車台番号"], ["handwritten_note", "手書きメモ", 0, 1],
];
const RV_NUM = new Set(["bid_price_man", "planned_price_man", "start_price_man", "mileage_km"]);

async function loadRegions() {
  try { const d = await (await fetch("/api/crop-regions")).json(); rv.regions = Object.fromEntries(d.regions.map((g) => [g.house + "|" + g.field, g])); } catch {}
}
async function loadReview(keepId) {
  if (!rv.regionsLoaded) { rv.regionsLoaded = true; await loadRegions(); }
  let d;
  try { d = await (await fetch("/api/review")).json(); } catch { return; }
  rv.items = d.items; rv.kinds = d.kinds;
  $("rvBadge").textContent = d.items.length || "";
  const f = $("rvFilter"), cur = f.value;
  f.innerHTML = '<option value="">すべての種類</option>' + d.kinds.map((k) => {
    const n = d.items.filter((i) => i.kind === k.key).length;
    return `<option value="${k.key}">${k.label}（${n}）</option>`;
  }).join("");
  f.value = cur;
  $("rvCount").textContent = `残り ${d.items.length}台（確認済み ${d.checked}台）`;
  drawReviewList();
  const still = rv.items.find((i) => i.id === (keepId ?? rv.selId));
  if (still) selectReview(still.id, false);
  else if (rv.items.length && document.getElementById("tab-review").hidden === false) selectReview(visibleReview()[0]?.id, true);
}
const visibleReview = () => rv.items.filter((i) => !$("rvFilter").value || i.kind === $("rvFilter").value);
function drawReviewList() {
  let last = "";
  $("rvList").innerHTML = visibleReview().map((i) => {
    let g = "";
    if (i.kind !== last) { last = i.kind; g = `<div class="rv-group">${h(rv.kinds.find((k) => k.key === i.kind).label)}</div>`; }
    return g + `<div class="rv-item ${i.id === rv.selId ? "sel" : ""}" data-id="${i.id}">
      <div class="t">${h(i.control_no || "（管理番号なし）")}　${h(i.car_name)} <span class="s">${h(i.grade || "")}</span></div>
      <div class="s">${h(i.auction_date || "開催日なし")}　${h(i.auction_house || "")}　落札 ${i.bid_price_man ?? "—"} / 予定 ${i.planned_price_man ?? "—"}</div>
      <div class="w">⚠ ${i.issues.map(h).join("　⚠ ")}</div></div>`;
  }).join("") || '<div class="empty">確認が必要な車はありません 🎉</div>';
}
$("rvFilter").onchange = () => { drawReviewList(); const v = visibleReview(); if (v.length) selectReview(v[0].id, true); };
$("rvList").addEventListener("click", (e) => { const it = e.target.closest(".rv-item"); if (it) selectReview(Number(it.dataset.id)); });

function selectReview(id, scroll) {
  const r = rv.items.find((i) => i.id === id);
  if (!r) return;
  rv.selId = id;
  document.querySelectorAll(".rv-item").forEach((el) => el.classList.toggle("sel", Number(el.dataset.id) === id));
  if (scroll) document.querySelector(`.rv-item[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  $("rvForm").innerHTML = `<div class="rv-issues">⚠ ${r.issues.map(h).join("　⚠ ")}${r.review_reason ? `<span style="color:#667">　（メモ：${h(r.review_reason)}）</span>` : ""}</div>` +
    RV_FIELDS.map(([k, l, key, wide]) => `<label class="${key ? "key" : ""} ${wide ? "wide" : ""}">${l}<input data-f="${k}" value="${h(r[k] ?? "")}"></label>`).join("") +
    `<button class="btn btn-ok" id="rvSave">保存</button>
     ${r.kind === "price" && r.bid_price_man >= 100 ? `<button class="btn btn-sub" id="rvThousand" title="この会場の金額は千円単位だと覚えて、同じ会場のほかの車も直します">千円単位として1/10にする（${h(r.auction_house || "会場")}を覚える）</button>` : ""}
     <button class="btn btn-main" id="rvOk" style="font-size:13px;padding:6px 14px" title="この車を確認済みにして一覧から外す">✔ 確認済み（次へ）</button>`;
  $("rvSave").onclick = () => saveReview(false);
  if ($("rvThousand")) $("rvThousand").onclick = async () => {
    const res = await fetch(`/api/review/${r.id}/thousand`, { method: "POST" });
    const j = await res.json();
    if (!res.ok) return alert(j.error || "直せませんでした");
    alert(`スタート・落札金額を1/10にしました。\n${j.house}は「千円単位」と覚えました${j.others ? `（同じ会場のほかの車 ${j.others}台も直しました）` : ""}。`);
    await loadReview(r.id);
    if (typeof load === "function") load();
  };
  $("rvOk").onclick = () => saveReview(true);
  drawZoomCards(r);
  $("rvForm").querySelectorAll("input").forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") saveReview(false); }));
  showReviewSheet(r);
}
async function saveReview(done) {
  const r = rv.items.find((i) => i.id === rv.selId);
  if (!r) return;
  const body = {};
  $("rvForm").querySelectorAll("input[data-f]").forEach((inp) => {
    const k = inp.dataset.f, v = inp.value.trim();
    const val = v === "" ? null : RV_NUM.has(k) ? Number(v.replace(/[,，]/g, "")) : v;
    if (String(val ?? "") !== String(r[k] ?? "")) body[k] = val;
  });
  if (Object.keys(body).length) {
    const res = await fetch(`/api/vehicles/${r.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return alert((await res.json().catch(() => ({}))).error || "保存に失敗しました");
  }
  const list = visibleReview(), idx = list.findIndex((i) => i.id === r.id);
  let next = r.id;
  if (done) {
    await fetch(`/api/review/${r.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ checked: true }) });
    next = (list[idx + 1] || list[idx - 1] || {}).id;
  }
  await loadReview(next);
  if (typeof load === "function") load(); // 仕入れ台帳の表も更新
}

// 出品票（向きは仕入れ台帳と共通）
async function showReviewSheet(r) {
  const token = ++rv.token, cv = $("rvCv");
  cv.hidden = true; rv.bmp = null;
  if (!r.pdf_key) { $("rvMsg").textContent = "この車には出品票のPDFがありません"; return; }
  $("rvMsg").textContent = "出品票を読み込み中…";
  try {
    const res = await fetch(`/api/page-image/${encodeURIComponent(r.pdf_key)}?page=${r.page_no || 1}`);
    if (!res.ok) throw new Error(await res.text());
    const bmp = await createImageBitmap(await res.blob());
    if (token !== rv.token) return;
    rv.bmp = bmp; drawReviewSheet(r.page_rotation || 0);
  } catch (e) { if (token === rv.token) $("rvMsg").textContent = "出品票を表示できません（" + e.message + "）"; }
}
function drawReviewSheet(rot) {
  const cv = $("rvCv"), bmp = rv.bmp, side = rot === 90 || rot === 270;
  cv.width = side ? bmp.height : bmp.width; cv.height = side ? bmp.width : bmp.height;
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.translate(cv.width / 2, cv.height / 2); ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  cv.hidden = false; $("rvMsg").textContent = "";
  const r = rv.items.find((i) => i.id === rv.selId);
  if (r) drawZoomCards(r);
}

// ---------- 確認する数字を切り出して大きく表示 ----------
// 会場ごと・項目ごとに「数字の場所」を一度囲めば覚え、同じ会場の出品票では自動で切り出す
const RV_ZOOM_FIELDS = [
  ["planned_price_man", "予定価格", /予定/], ["bid_price_man", "落札金額", /落札/], ["start_price_man", "スタート", /スタート/],
  ["control_no", "管理番号", /管理番号/], ["auction_date", "開催日", /開催日/],
];
const houseKey = (r) => String(r.auction_house || "").normalize("NFKC").replace(/\s/g, "") || "（会場なし）";
const zoomFieldsOf = (r) => RV_ZOOM_FIELDS.filter(([, , re]) => r.issues.some((t) => re.test(t)));
// 手書きメモの計算式（例「4,037,000−35＝368」「403.7-35」「2851200-18」）から予定価格の候補（万円）を出す
function planCandidates(r) {
  const text = [r.handwritten_note, r.review_reason].filter(Boolean).join(" ").normalize("NFKC").replace(/[−ー－‐]/g, "-").replace(/＝/g, "=");
  const man = (s) => { const v = Number(String(s).replace(/,/g, "")); return !Number.isFinite(v) ? null : v >= 100000 ? v / 10000 : v; };
  const out = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*-\s*(\d[\d,]*(?:\.\d+)?)(?:\s*=\s*(\d[\d,]*(?:\.\d+)?))?/g)) {
    const a = man(m[1]), b = man(m[2]);
    if (a == null || b == null || a < 10 || a > 5000) continue;
    const v = Math.round((a - b) * 10) / 10;
    if (v > 0) out.push({ v, src: m[0] });
    const c = m[3] ? man(m[3]) : null;
    if (c != null && Math.abs(c - v) >= 0.1 && c > 0 && c < 5000) out.push({ v: Math.round(c * 10) / 10, src: m[0] + "（＝の右）" });
  }
  return out.filter((c, i) => out.findIndex((x) => x.v === c.v) === i);
}
function drawZoomCards(r) {
  const box = $("rvZoom");
  if (!box) return;
  const fields = zoomFieldsOf(r);
  if (!fields.length) { box.innerHTML = ""; drawRegionMarks(r, []); return; }
  const cv = $("rvCv"), ready = rv.bmp && !cv.hidden;
  box.innerHTML = fields.map(([f, label]) => {
    const reg = rv.regions[houseKey(r) + "|" + f];
    const cands = f === "planned_price_man" ? planCandidates(r) : [];
    return `<div class="rv-zc" data-f="${f}">
      <div class="hd"><b>${label}</b><span class="now">今の値：<b>${r[f] ?? "（空欄）"}</b></span><span style="flex:1"></span>
        <button class="btn btn-sub" data-pick="${f}" title="出品票の上で、${label}が書いてある場所をドラッグで囲みます。${h(r.auction_house || "")}の出品票では次から自動で切り出します">📐 ${reg ? "場所を直す" : "場所を囲む"}</button>
        ${reg ? `<button class="btn btn-sub" data-unpick="${f}" title="覚えた場所を消す">✕</button>` : ""}</div>
      ${cands.length ? `<div class="cands">計算式から：${cands.map((c) => `<button class="btn btn-ok" data-cand="${f}" data-v="${c.v}" title="${h(c.src)}">${c.v}万円 を入れる</button>`).join(" ")}<span class="tv-note">（${h(cands[0].src)}）</span></div>` : ""}
      ${reg ? (ready ? `<canvas class="crop"></canvas>` : '<div class="ph">出品票を読み込み中…</div>')
        : `<div class="ph">${h(r.auction_house || "この会場")}の出品票で、${label}の場所はまだ決まっていません。「📐 場所を囲む」を押して、下の出品票の上でドラッグしてください。</div>`}
    </div>`;
  }).join("");
  if (ready) box.querySelectorAll(".rv-zc").forEach((card) => {
    const reg = rv.regions[houseKey(r) + "|" + card.dataset.f], c = card.querySelector("canvas.crop");
    if (!reg || !c) return;
    const sx = reg.x * cv.width, sy = reg.y * cv.height, sw = reg.w * cv.width, sh = reg.h * cv.height;
    const maxW = Math.max(240, card.clientWidth - 16), maxH = 170, sc = Math.min(maxW / sw, maxH / sh, 4);
    c.width = Math.round(sw * sc); c.height = Math.round(sh * sc);
    c.getContext("2d").drawImage(cv, sx, sy, sw, sh, 0, 0, c.width, c.height);
  });
  drawRegionMarks(r, fields.map(([f]) => f));
}
// 出品票の上に、覚えた場所をオレンジの枠で示す
function drawRegionMarks(r, fields) {
  const wrap = $("rvMarks"), cv = $("rvCv");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (cv.hidden) return;
  const cr = cv.getBoundingClientRect(), pr = cv.parentElement.getBoundingClientRect();
  for (const f of fields) {
    const reg = rv.regions[houseKey(r) + "|" + f];
    if (!reg) continue;
    const d = document.createElement("div");
    d.className = "rv-mark";
    Object.assign(d.style, { left: cr.left - pr.left + reg.x * cr.width + "px", top: cr.top - pr.top + reg.y * cr.height + "px", width: reg.w * cr.width + "px", height: reg.h * cr.height + "px" });
    d.title = RV_ZOOM_FIELDS.find((x) => x[0] === f)[1];
    wrap.appendChild(d);
  }
}
addEventListener("resize", () => { const r = rv.items.find((i) => i.id === rv.selId); if (r && !$("tab-review").hidden) drawZoomCards(r); });
$("rvZoom").addEventListener("click", async (e) => {
  const r = rv.items.find((i) => i.id === rv.selId);
  if (!r) return;
  const cand = e.target.closest("[data-cand]");
  if (cand) { const inp = $("rvForm").querySelector(`input[data-f="${cand.dataset.cand}"]`); if (inp) { inp.value = cand.dataset.v; inp.focus(); inp.classList.add("flash"); setTimeout(() => inp.classList.remove("flash"), 900); } return; }
  const pick = e.target.closest("[data-pick]");
  if (pick) { startPick(pick.dataset.pick); return; }
  const un = e.target.closest("[data-unpick]");
  if (un) {
    if (!confirm("この会場で覚えた場所を消しますか？")) return;
    await fetch(`/api/crop-regions?house=${encodeURIComponent(houseKey(r))}&field=${un.dataset.unpick}`, { method: "DELETE" });
    delete rv.regions[houseKey(r) + "|" + un.dataset.unpick];
    drawZoomCards(r);
  }
});
// 場所を囲む（ドラッグ）
function startPick(field) {
  if (!rv.bmp || $("rvCv").hidden) return alert("出品票の読み込みが終わってから押してください");
  rv.pick = { field };
  $("rvPickMsg").textContent = `出品票の上で「${RV_ZOOM_FIELDS.find((x) => x[0] === field)[1]}」が書いてある場所をドラッグで囲んでください（Escでやめる）`;
  $("rvPickMsg").hidden = false;
  $("rvCv").classList.add("picking");
}
function endPick() { rv.pick = null; $("rvPickMsg").hidden = true; $("rvCv").classList.remove("picking"); $("rvSel").hidden = true; }
addEventListener("keydown", (e) => { if (e.key === "Escape" && rv.pick) endPick(); });
const cvPos = (e) => { const cr = $("rvCv").getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - cr.left) / cr.width)), y: Math.min(1, Math.max(0, (e.clientY - cr.top) / cr.height)) }; };
$("rvCv").addEventListener("mousedown", (e) => {
  if (!rv.pick) return;
  e.preventDefault();
  rv.pick.start = cvPos(e);
});
addEventListener("mousemove", (e) => {
  if (rv.pick?.start) {
    const a = rv.pick.start, b = cvPos(e), cv = $("rvCv"), cr = cv.getBoundingClientRect(), pr = cv.parentElement.getBoundingClientRect(), s = $("rvSel");
    Object.assign(s.style, { left: cr.left - pr.left + Math.min(a.x, b.x) * cr.width + "px", top: cr.top - pr.top + Math.min(a.y, b.y) * cr.height + "px", width: Math.abs(a.x - b.x) * cr.width + "px", height: Math.abs(a.y - b.y) * cr.height + "px" });
    s.hidden = false;
  }
});
addEventListener("mouseup", async (e) => {
  if (!rv.pick?.start) return;
  const a = rv.pick.start, b = cvPos(e), field = rv.pick.field;
  const reg = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  rv.pick.start = null;
  if (reg.w < 0.01 || reg.h < 0.01) return; // 小さすぎる（クリックだけ）は無視して、囲み直しを待つ
  const r = rv.items.find((i) => i.id === rv.selId);
  endPick();
  if (!r) return;
  const house = houseKey(r);
  rv.regions[house + "|" + field] = { house, field, ...reg };
  drawZoomCards(r);
  await fetch("/api/crop-regions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ house, field, ...reg }) });
});
// 虫めがね（出品票の上にマウスを当てると、その周りを大きく表示）
$("rvCv").addEventListener("mousemove", (e) => {
  const lens = $("rvLens"), cv = $("rvCv");
  if (rv.pick || !rv.bmp) { lens.hidden = true; return; }
  const p = cvPos(e), Z = 2.5, lw = lens.width, lh = lens.height;
  const cr = cv.getBoundingClientRect(), scale = cv.width / cr.width; // 画面1pxあたりの画像px
  const sw = (lw / Z) * scale, sh = (lh / Z) * scale;
  const ctx = lens.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, lw, lh);
  ctx.drawImage(cv, p.x * cv.width - sw / 2, p.y * cv.height - sh / 2, sw, sh, 0, 0, lw, lh);
  const pr = cv.parentElement.getBoundingClientRect();
  let left = e.clientX - pr.left + 18, top = e.clientY - pr.top + 18;
  if (left + lw > pr.width - 4) left = e.clientX - pr.left - lw - 18;
  if (top + lh > pr.height - 4) top = e.clientY - pr.top - lh - 18;
  Object.assign(lens.style, { left: left + "px", top: top + "px" });
  lens.hidden = false;
});
$("rvCv").addEventListener("mouseleave", () => ($("rvLens").hidden = true));
async function rotateReview(delta) {
  const r = rv.items.find((i) => i.id === rv.selId);
  if (!r || !rv.bmp) return;
  const rot = ((((r.page_rotation || 0) + delta) % 360) + 360) % 360;
  rv.items.forEach((x) => { if (x.pdf_key === r.pdf_key && (x.page_no || 1) === (r.page_no || 1)) x.page_rotation = rot; });
  drawReviewSheet(rot);
  await fetch("/api/page-rotation", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pdf_key: r.pdf_key, page_no: r.page_no || 1, rotation: rot }) });
}
$("rvRotL").onclick = () => rotateReview(-90);
$("rvRotR").onclick = () => rotateReview(90);
$("rvBig").onclick = () => { const r = rv.items.find((i) => i.id === rv.selId); if (r && r.pdf_key) openPdf(r); };
$("rvCv").ondblclick = () => $("rvBig").onclick(); // ダブルクリックで大きく（クリックは虫めがね・場所囲みに使う）

// ↑↓キーで前後の車へ（入力欄の中では効かない）
addEventListener("keydown", (e) => {
  if (document.getElementById("tab-review").hidden || document.querySelector("dialog[open]")) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const list = visibleReview(), i = list.findIndex((x) => x.id === rv.selId);
  const n = list[i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)];
  if (n) { e.preventDefault(); selectReview(n.id, true); }
});
loadReview();
