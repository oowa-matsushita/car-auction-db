"use strict";
// ---------- 確認リスト（左：一覧 / 右：直す欄と出品票） ----------
const rv = { items: [], kinds: [], selId: null, token: 0, bmp: null };
const RV_FIELDS = [
  ["control_no", "管理番号", 1], ["auction_date", "開催日"], ["bid_price_man", "落札金額(万円)", 1],
  ["planned_price_man", "予定価格(万円)", 1], ["start_price_man", "スタート(万円)"], ["car_name", "車名"],
  ["grade", "グレード"], ["mileage_km", "走行(km)"], ["chassis_no", "車台番号"], ["handwritten_note", "手書きメモ", 0, 1],
];
const RV_NUM = new Set(["bid_price_man", "planned_price_man", "start_price_man", "mileage_km"]);

async function loadReview(keepId) {
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
}
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
$("rvCv").onclick = () => $("rvBig").onclick();

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
