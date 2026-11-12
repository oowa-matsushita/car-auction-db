"use strict";
// ---------- 分析（ベータ）：売れている車・売れている日・天気との関係 ----------
const an = { data: null, seq: 0 };
const AN_DOW = ["日", "月", "火", "水", "木", "金", "土"];
const anQs = () => `ch=${$("anCh").value}&months=${$("anSpan").value}${$("anOem").checked ? "&oem=1" : ""}`;
const pctS = (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + Math.round(v * 100) + "%");
const man1a = (v) => (v == null ? "—" : (v / 10000).toFixed(1) + "万円");

async function loadAnalysis() {
  const seq = ++an.seq;
  $("anInfo").textContent = "読み込み中…";
  let d;
  try { const res = await fetch("/api/analysis?" + anQs()); d = await res.json(); if (!res.ok) throw new Error(d.error || res.status); }
  catch (e) { $("anInfo").textContent = "❌ 読み込めませんでした（" + e.message + "）"; return; }
  if (seq !== an.seq) return;
  an.data = d;
  drawAnalysis();
}

// 縦の棒グラフ（items: [{label, value, sub, color}]）
function anBars(items, { ht = 170, fmt = (v) => v.toFixed(1), color = "#10b8c4", zero = 0 } = {}) {
  const w = Math.max(300, items.length * 76), padT = 22, padB = 38, ih = ht - padT - padB;
  const vals = items.map((i) => i.value).filter((v) => v != null);
  const max = Math.max(...vals, zero) || 1, min = Math.min(0, ...vals);
  const y = (v) => padT + ih - ((v - min) / (max - min || 1)) * ih;
  const bw = (w - 20) / items.length;
  let g = `<line x1="10" x2="${w - 10}" y1="${y(0)}" y2="${y(0)}" stroke="#c9d1dd"/>`;
  items.forEach((it, i) => {
    const x = 10 + bw * i + bw * 0.15, wv = bw * 0.7;
    if (it.value != null) {
      const top = Math.min(y(it.value), y(0)), hh = Math.abs(y(it.value) - y(0));
      g += `<rect x="${x}" y="${top}" width="${wv}" height="${Math.max(1, hh)}" rx="3" fill="${it.color || color}"><title>${h(it.label)}：${fmt(it.value)}${it.sub ? "（" + it.sub + "）" : ""}</title></rect>`;
      g += `<text x="${x + wv / 2}" y="${it.value >= 0 ? top - 4 : y(0) - 4}" text-anchor="middle" font-size="11" font-weight="700" fill="${it.value >= 0 ? "#172033" : "#c62828"}">${fmt(it.value)}</text>`;
    }
    g += `<text x="${x + wv / 2}" y="${ht - 22}" text-anchor="middle" font-size="11" fill="#334">${h(it.label)}</text>`;
    if (it.sub) g += `<text x="${x + wv / 2}" y="${ht - 8}" text-anchor="middle" font-size="10" fill="#8a93a3">${h(it.sub)}</text>`;
  });
  return `<svg width="100%" viewBox="0 0 ${w} ${ht}" style="max-width:${w}px">${g}</svg>`;
}


// ---------- 経営アドバイス（ルールで判定。最終判断は人が行う） ----------
// 使う数字：締まった月（今月の途中は除く）の 回転率（販売合計÷月初在庫合計）・平均台粗利・月平均の販売台数、最新の月初在庫
function anAdvice(d, days) {
  const ms = d.months, cur = ms[ms.length - 1];
  const curPartial = days.length && days[days.length - 1].date < cur + "-28";
  const done = curPartial ? ms.slice(0, -1) : ms;
  if (!done.length) return null;
  const latest = [...ms].reverse().find((mo) => d.models.some((m) => (m.open_by_month || {})[mo]));
  const rowsAll = d.models.map((m) => {
    let so = 0, op = 0, gs = 0, gn = 0;
    for (const mo of done) { so += m.by_month[mo] || 0; op += (m.open_by_month || {})[mo] || 0; const g = (m.gross_by_month || {})[mo]; if (g) { gs += g[0]; gn += g[1]; } }
    const per = so / done.length, stock = (m.open_by_month || {})[latest] || 0;
    return { key: m.key, name: m.name, sold: so, opening: op, rate: op ? so / op : null, gross: gn ? gs / gn : null, per, stock, cover: per ? stock / per : Infinity };
  });
  const rows = rowsAll.filter((r) => r.opening >= 3 * done.length || r.sold >= 2 * done.length); // 数字が少なすぎる車種は除く
  const tot = rows.reduce((a, r) => ({ s: a.s + r.sold, o: a.o + r.opening, g: a.g + (r.gross ?? 0) * r.sold, n: a.n + (r.gross != null ? r.sold : 0) }), { s: 0, o: 0, g: 0, n: 0 });
  const R = tot.o ? tot.s / tot.o : 0, G = tot.n ? tot.g / tot.n : 0;
  const man = (v) => (v / 10000).toFixed(1) + "万円";
  const ok = (r) => r.rate != null && r.gross != null;
  // ① 在庫を増やす：回転が速く（平均の1.3倍以上）、粗利も平均並み以上、在庫が2.5か月分未満
  // 目標の在庫＝月平均の販売台数の2.5か月分。今の在庫が目標より少ない車種だけ
  const grow = rows.filter((r) => ok(r) && r.rate >= Math.max(R * 1.3, 0.3) && r.gross >= G * 0.9 && r.per >= 2 && r.stock < r.per * 2.5 - 0.5)
    .map((r) => ({ ...r, target: Math.round(r.per * 2.5), add: Math.max(1, Math.round(r.per * 2.5 - r.stock)), score: (r.rate / R) * (r.gross / G) }))
    .sort((a, b) => b.score - a.score).slice(0, 8);
  // 施策メモ（社長のノウハウ）：実施中の施策で、前の60日より1日あたりの販売が30%以上増えた車種は「施策の効果あり」として在庫を増やす候補に入れる
  const khBy = {};
  for (const k of (an.kh || [])) if (k.active) (khBy[k.key] ||= []).push(k);
  for (const r of rowsAll) {
    const ks = khBy[r.key];
    if (!ks || grow.some((g) => g.key === r.key)) continue;
    const best = ks.filter((k) => k.lift != null && k.lift >= 0.3).sort((a, b) => b.lift - a.lift)[0];
    if (best) grow.push({ ...r, kh: best });
  }
  // ② 値上げを試せる：よく売れるのに粗利が薄い
  const up = rows.filter((r) => ok(r) && r.rate >= Math.max(R * 1.3, 0.3) && r.gross < G * 0.7 && r.per >= 2)
    .sort((a, b) => b.rate - a.rate).slice(0, 6);
  // ③ 価格を見直す：回転が遅く（平均の0.6倍以下）、在庫が5台以上
  const slow = rows.filter((r) => r.rate != null && r.rate <= R * 0.6 && r.stock >= 5)
    .map((r) => ({ ...r, waste: r.stock * (1 - r.rate) })).sort((a, b) => b.waste - a.waste).slice(0, 10);
  // 表の1行。目標の在庫＝月平均の販売の2.5か月分。増減＝目標−今の在庫
  const row = (r, kind) => {
    const target = Math.round(r.per * 2.5), diff = target - r.stock;
    let price = "—", act = "";
    if (kind === "grow") act = r.kh ? `施策の効果あり（1日の販売 ${r.kh.lift >= 0 ? "+" : ""}${Math.round(r.kh.lift * 100)}%）→ 仕入れを増やす` : "仕入れを増やす";
    if (kind === "up") { price = '<span class="up">+3〜5万円</span>'; act = "値上げを試す"; }
    if (kind === "slow") {
      const room = r.gross != null ? r.gross - G : null;
      if (room != null && room >= 30000) { price = `<span class="dn">−${(Math.min(Math.floor(room / 10000) * 10000, 100000) / 10000).toFixed(0)}万円</span>`; act = "値下げ"; }
      else if (room != null && room > -30000) { price = '<span class="dn">−3万円前後</span>'; act = "小幅値下げ＋仕入れ減"; }
      else { act = r.gross != null && r.gross < 0 ? "仕入れ停止・業販へ" : "仕入れ減・業販へ"; }
    }
    const cover = isFinite(r.cover) ? r.cover.toFixed(1) : "—";
    const kh = (an.kh || []).filter((k) => k.active && k.key === r.key);
    return `<tr><td class="nm">${h(r.name)}${kh.map((k) => `<span class="kh-b" title="${h(k.start_date)}〜${h(k.end_date || "")}：${h(k.detail || "")}">📝${h(k.kind)}</span>`).join("")}</td>
      <td class="n">${pct(r.rate)}</td><td class="n${r.gross != null && r.gross < 0 ? " neg" : ""}">${r.gross == null ? "—" : man(r.gross)}</td>
      <td class="n">${r.per.toFixed(1)}台</td><td class="n">${r.stock}台</td>
      <td class="n${isFinite(r.cover) && r.cover >= 4 ? " warn" : ""}">${cover}${isFinite(r.cover) ? "か月" : ""}</td>
      <td class="n">${target}台</td><td class="n ${diff > 0 ? "plus" : diff < 0 ? "minus" : ""}">${diff > 0 ? "+" : ""}${diff}台</td>
      <td class="n">${price}</td><td class="act">${act}</td></tr>`;
  };
  const table = (list, kind) => list.length ? `<table class="tv-table adv-table"><thead><tr><th>車種</th><th>回転率</th><th>平均台粗利</th><th>月平均販売</th><th>今の在庫</th><th>在庫の月数</th><th>目標在庫</th><th>あと何台</th><th>おすすめ価格</th><th>やること</th></tr></thead>
    <tbody>${list.map((r) => row(r, kind)).join("")}</tbody></table>` : '<div class="tv-dim">当てはまる車種はありません</div>';
  return { R, G, done, latest, html: `
    <div class="adv-col grow"><h4>📦 売れているので在庫を増やしたい車種</h4>${table(grow, "grow")}</div>
    <div class="adv-col slow" style="margin-top:10px"><h4>💴 売れていないので価格を見直したい車種</h4>${table(slow, "slow")}</div>
    ${up.length ? `<div class="adv-col upc" style="margin-top:10px"><h4>📈 よく売れるのに粗利が薄い（値上げを試せる）車種</h4>${table(up, "up")}</div>` : ""}
    <div class="tv-note" style="margin-top:8px">全体の回転率 ${pct(R)}・平均台粗利 ${man(G)}。目標在庫＝月平均販売の2.5か月分、あと何台＝目標在庫−今の在庫。おすすめ値下げは「全体の平均台粗利を下回らない範囲（最大10万円）」。期間：${monthLabel(done[0])}〜${monthLabel(done[done.length - 1])}（締まった月）、在庫は${monthLabel(latest)}の月初在庫。機械的な候補なので、季節・相場・車の状態も見て決めてください。</div>` };
}
function drawAnalysis() {
  const d = an.data, days = d.days;
  if (!days.length) { $("anBody").innerHTML = '<div class="empty">販売データがありません</div>'; $("anInfo").textContent = ""; return; }
  // 「普段」＝同じ月・同じ曜日の種類（平日／土日祝）の1日平均。天気の影響だけを見るために、これと比べる
  const base = {};
  for (const x of days) { const k = x.date.slice(0, 7) + (x.off ? "o" : "w"); (base[k] ||= { s: 0, n: 0 }); base[k].s += x.sold; base[k].n++; }
  for (const x of days) { const b = base[x.date.slice(0, 7) + (x.off ? "o" : "w")]; x.idx = b.s / b.n ? x.sold / (b.s / b.n) : null; }
  const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null);
  const idxOf = (a) => { const v = a.filter((x) => x.idx != null); return v.length ? avg(v, (x) => x.idx) - 1 : null; };
  const total = days.reduce((s, x) => s + x.sold, 0), gs = days.reduce((s, x) => s + x.gsum, 0), gn = days.reduce((s, x) => s + x.gn, 0), sales = days.reduce((s, x) => s + x.sales, 0);
  const wk = days.filter((x) => !x.off), off = days.filter((x) => x.off);
  const wkAvg = avg(wk, (x) => x.sold), offAvg = avg(off, (x) => x.sold);
  const hasWx = days.some((x) => x.rain != null);

  // 曜日別（祝日は別に）
  const dowItems = [1, 2, 3, 4, 5, 6, 0].map((w) => {
    const a = days.filter((x) => x.dow === w && !(x.off && w >= 1 && w <= 5));
    return { label: AN_DOW[w], value: avg(a, (x) => x.sold), sub: `${a.length}日`, color: w === 0 ? "#e5533d" : w === 6 ? "#3d7be5" : "#10b8c4" };
  });
  const hol = days.filter((x) => x.off && x.dow >= 1 && x.dow <= 5);
  if (hol.length) dowItems.push({ label: "祝日", value: avg(hol, (x) => x.sold), sub: `${hol.length}日`, color: "#e58a3d" });

  // 雨の量・気温（指数：普段より何%）
  const rainBins = [["降らない", (r) => r === 0], ["小雨 〜5mm", (r) => r > 0 && r < 5], ["雨 5〜20mm", (r) => r >= 5 && r < 20], ["大雨 20mm〜", (r) => r >= 20]];
  const rainItems = rainBins.map(([l, f]) => { const a = days.filter((x) => x.rain != null && f(x.rain)); return { label: l, value: idxOf(a), sub: `${a.length}日・${(avg(a, (x) => x.sold) ?? 0).toFixed(1)}台/日`, n: a.length }; });
  const tempBins = [["〜10℃", (t) => t < 10], ["10〜15℃", (t) => t >= 10 && t < 15], ["15〜20℃", (t) => t >= 15 && t < 20], ["20〜25℃", (t) => t >= 20 && t < 25], ["25〜28℃", (t) => t >= 25 && t < 28], ["28℃〜", (t) => t >= 28]];
  const tempItems = tempBins.map(([l, f]) => { const a = days.filter((x) => x.temp != null && f(x.temp)); return { label: l, value: a.length ? idxOf(a) : null, sub: `${a.length}日` }; }).filter((x) => x.sub !== "0日");
  // 雨の次の日（10mm以上の雨の翌日）
  const after = days.filter((x, i) => i > 0 && days[i - 1].rain != null && days[i - 1].rain >= 10);
  const afterIdx = idxOf(after);
  const rainyIdx = idxOf(days.filter((x) => x.rain != null && x.rain >= 5));

  // 売れている車
  const models = [...d.models].sort((a, b) => b.sold - a.sold);
  const ms = d.months, lastFull = ms.length > 1 ? ms[ms.length - 2] : null, cur = ms[ms.length - 1];
  const curPartial = days.length && days[days.length - 1].date < cur + "-28";
  const trendMonth = curPartial ? lastFull : cur;
  const prevMonths = ms.filter((m) => m < trendMonth);
  const trend = models.filter((m) => m.sold >= 3 && prevMonths.length).map((m) => {
    const prev = prevMonths.map((mo) => m.by_month[mo] || 0), pAvg = prev.reduce((s, v) => s + v, 0) / prev.length, now = m.by_month[trendMonth] || 0;
    return { ...m, now, pAvg, diff: now - pAvg };
  });
  const up = [...trend].sort((a, b) => b.diff - a.diff).filter((x) => x.diff > 0).slice(0, 8);
  const down = [...trend].sort((a, b) => a.diff - b.diff).filter((x) => x.diff < 0).slice(0, 8);

  // 気づき（文章）
  const tips = [];
  if (wkAvg && offAvg) tips.push(`土日祝は1日 <b>${offAvg.toFixed(1)}台</b>、平日は <b>${wkAvg.toFixed(1)}台</b>。土日祝は平日の <b>${(offAvg / wkAvg).toFixed(1)}倍</b> 売れています。`);
  const best = [...dowItems].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
  const worst = [...dowItems].filter((x) => x.label !== "祝日").sort((a, b) => (a.value ?? 99) - (b.value ?? 99))[0];
  if (best && worst) tips.push(`いちばん売れるのは <b>${best.label}曜日</b>（1日${best.value.toFixed(1)}台）、いちばん少ないのは <b>${worst.label}曜日</b>（${worst.value.toFixed(1)}台）。`.replace("祝日曜日", "祝日"));
  if (hasWx && rainyIdx != null) tips.push(`雨（5mm以上）の日は、同じ月・同じ曜日の種類の日と比べて <b>${pctS(rainyIdx)}</b>。${afterIdx != null && after.length >= 3 ? `大きな雨（10mm以上）の次の日は <b>${pctS(afterIdx)}</b>（${after.length}日）。` : ""}`);
  if (hasWx) { const t = tempItems.filter((x) => x.value != null).sort((a, b) => b.value - a.value); if (t.length >= 2) tips.push(`気温では <b>${t[0].label}</b> の日がいちばん売れ（${pctS(t[0].value)}）、<b>${t[t.length - 1].label}</b> の日がいちばん売れません（${pctS(t[t.length - 1].value)}）。`); }
  if (models[0]) tips.push(`いちばん売れている車は <b>${h(models[0].name)}</b>（${models[0].sold}台）。${up[0] ? `${monthLabel(trendMonth)}にいちばん伸びたのは <b>${h(up[0].name)}</b>（${up[0].now}台、それまでの月平均${up[0].pAvg.toFixed(1)}台）。` : ""}`);
  if (!hasWx) tips.push("天気のデータがまだありません。気象庁の「過去の気象データ」のCSVを送っていただければ取り込みます。");

  // 日別の推移（棒：販売台数、上から下がる青：雨量）
  const W = Math.max(600, days.length * 6), H = 190, pT = 26, pB = 26, ih = H - pT - pB, bw = W / days.length;
  const maxS = Math.max(...days.map((x) => x.sold), 1), maxR = Math.max(...days.map((x) => x.rain || 0), 1);
  let dg = "";
  days.forEach((x, i) => {
    const bh = (x.sold / maxS) * ih, rx = i * bw;
    dg += `<rect x="${rx + 0.5}" y="${pT + ih - bh}" width="${Math.max(1, bw - 1)}" height="${bh}" fill="${x.off ? "#f2994a" : "#10b8c4"}"><title>${x.date}（${AN_DOW[x.dow]}${x.off && x.dow >= 1 && x.dow <= 5 ? "・祝" : ""}）販売 ${x.sold}台${x.rain != null ? `／雨 ${x.rain}mm・${x.temp}℃` : ""}</title></rect>`;
    if (x.rain) dg += `<rect x="${rx + 0.5}" y="${pT}" width="${Math.max(1, bw - 1)}" height="${(x.rain / maxR) * ih * 0.45}" fill="rgba(61,123,229,.45)"><title>${x.date} 雨 ${x.rain}mm</title></rect>`;
    if (x.date.endsWith("-01")) dg += `<line x1="${rx}" x2="${rx}" y1="${pT - 4}" y2="${pT + ih}" stroke="#c9d1dd"/><text x="${rx + 3}" y="${H - 8}" font-size="11" fill="#556">${Number(x.date.slice(5, 7))}月</text>`;
  });
  const dayChart = `<div style="overflow-x:auto"><svg width="${W}" height="${H}">${dg}</svg></div>
    <div class="tv-note"><span class="an-key" style="background:#10b8c4"></span>平日 <span class="an-key" style="background:#f2994a"></span>土日祝 <span class="an-key" style="background:rgba(61,123,229,.45)"></span>雨の量（上から）　棒にマウスを当てると、その日の台数と天気が出ます</div>`;

  const topDays = [...days].sort((a, b) => b.sold - a.sold).slice(0, 10);
  const wxTxt = (x) => (x.rain == null ? "—" : `${x.rain === 0 ? "☀️" : x.rain < 5 ? "🌦️" : "🌧️"} ${x.rain}mm・${x.temp}℃`);
  const mRow = (m) => {
    const bars = ms.map((mo) => m.by_month[mo] || 0), mx = Math.max(...bars, 1);
    return `<tr><td>${h(m.name)}</td><td class="n"><b>${m.sold}</b>台</td><td class="n">${m.rate == null ? "—" : pct(m.rate)}</td><td class="n">${man1a(m.gross_avg)}</td>
      <td><span class="an-spark">${bars.map((v, i) => `<i style="height:${Math.max(2, (v / mx) * 22)}px" title="${monthLabel(ms[i])} ${v}台"></i>`).join("")}</span></td></tr>`;
  };
  const tRow = (m) => `<tr><td>${h(m.name)}</td><td class="n"><b>${m.now}</b>台</td><td class="n">${m.pAvg.toFixed(1)}台</td><td class="n" style="color:${m.diff >= 0 ? "#1f9d45" : "#c62828"};font-weight:700">${m.diff >= 0 ? "+" : ""}${m.diff.toFixed(1)}</td></tr>`;

  if (!an.khLoaded) { an.khLoaded = true; loadKnowhow(); }
  const adv = anAdvice(d, days);
  $("anBody").innerHTML = `
    <div class="an-kpis">
      <div class="an-kpi"><span>期間</span><b>${monthLabel(ms[0])}〜${monthLabel(cur)}</b><em>${days.length}日</em></div>
      <div class="an-kpi"><span>販売台数</span><b>${total.toLocaleString()}台</b><em>1日平均 ${(total / days.length).toFixed(1)}台</em></div>
      <div class="an-kpi"><span>平日／土日祝</span><b>${(wkAvg ?? 0).toFixed(1)}／${(offAvg ?? 0).toFixed(1)}台</b><em>1日あたり</em></div>
      <div class="an-kpi"><span>平均台粗利</span><b>${man1a(gn ? gs / gn : null)}</b><em>値引き後・経費を引いた額</em></div>
      <div class="an-kpi"><span>売上高（税抜）</span><b>${Math.round(sales / 1e4).toLocaleString()}万円</b><em>車輛本体−値引き</em></div>
    </div>
    <div class="an-card an-tips"><h3>💡 わかったこと</h3><ul>${tips.map((t) => `<li>${t}</li>`).join("")}</ul></div>
    <div class="an-card tg" id="anTarget"><h3>🎯 今月の小売目標</h3><div class="tv-note">読み込み中…</div></div>
    ${adv ? `<div class="an-card adv"><h3>🤖 AI分析 <span class="tv-note">（売れ筋の在庫と、価格を見直したい車種）</span></h3>${adv.html}</div>` : ""}
    <div class="an-card kh" id="anKh"><h3>📝 施策メモ（社長のノウハウ）</h3><div class="tv-note">読み込み中…</div></div>
    <div class="an-grid">
      <div class="an-card"><h3>📅 曜日別（1日あたりの販売台数）</h3>${anBars(dowItems)}</div>
      <div class="an-card"><h3>☔ 雨の量と売れ行き <span class="tv-note">（普段＝同じ月・同じ曜日の種類の日と比べた増減）</span></h3>${hasWx ? anBars(rainItems, { fmt: (v) => pctS(v), color: "#3d7be5" }) : '<div class="tv-note">天気のデータがありません</div>'}</div>
      <div class="an-card"><h3>🌡️ 気温と売れ行き <span class="tv-note">（普段と比べた増減）</span></h3>${hasWx ? anBars(tempItems.map((x) => ({ ...x, color: x.value >= 0 ? "#f2994a" : "#9aa4b8" })), { fmt: (v) => pctS(v) }) : '<div class="tv-note">天気のデータがありません</div>'}</div>
      <div class="an-card"><h3>💴 価格帯別（値引き後の本体価格）</h3>${anBars(d.bands.map((b) => ({ label: b.band, value: b.sold, sub: b.gross_avg == null ? "" : "粗利" + (b.gross_avg / 10000).toFixed(1) + "万" })), { fmt: (v) => v + "台", color: "#7c5cff" })}</div>
    </div>
    <div class="an-card"><h3>📈 日ごとの販売台数と雨</h3>${dayChart}</div>
    <div class="an-grid">
      <div class="an-card"><h3>🚗 売れている車 TOP20 <span class="tv-note">（期間の販売台数）</span></h3>
        <table class="tv-table an-table"><thead><tr><th>車種</th><th>販売</th><th>回転率</th><th>平均台粗利</th><th>月ごと</th></tr></thead><tbody>${models.slice(0, 20).map(mRow).join("")}</tbody></table></div>
      <div class="an-card"><h3>📊 ${trendMonth ? monthLabel(trendMonth) : ""}に伸びた車・落ちた車 <span class="tv-note">（それまでの月平均と比べた台数）</span></h3>
        <div class="an-two"><div><div class="an-sub">⬆ 伸びた</div><table class="tv-table an-table"><thead><tr><th>車種</th><th>その月</th><th>月平均</th><th>差</th></tr></thead><tbody>${up.map(tRow).join("") || '<tr><td colspan="4" class="tv-dim">なし</td></tr>'}</tbody></table></div>
        <div><div class="an-sub">⬇ 落ちた</div><table class="tv-table an-table"><thead><tr><th>車種</th><th>その月</th><th>月平均</th><th>差</th></tr></thead><tbody>${down.map(tRow).join("") || '<tr><td colspan="4" class="tv-dim">なし</td></tr>'}</tbody></table></div></div></div>
    </div>
    <div class="an-card"><h3>🏆 よく売れた日 TOP10</h3>
      <table class="tv-table an-table"><thead><tr><th>日付</th><th>曜日</th><th>販売</th><th>天気（${h(d.place || "")}）</th><th>普段との差</th></tr></thead><tbody>${topDays.map((x) => `<tr><td>${x.date}</td><td>${AN_DOW[x.dow]}${x.off && x.dow >= 1 && x.dow <= 5 ? "（祝）" : ""}</td><td class="n"><b>${x.sold}</b>台</td><td>${wxTxt(x)}</td><td class="n">${pctS(x.idx - 1)}</td></tr>`).join("")}</tbody></table></div>`;
  loadTarget();
  drawKnowhow();
  $("anInfo").textContent = hasWx ? `天気：${d.place || ""}（気象庁）` : "天気データなし";
}
["anCh", "anSpan", "anOem"].forEach((id) => $(id).addEventListener("change", loadAnalysis));
if (!$("tab-analysis").hidden) loadAnalysis();

// ---------- 今月の小売台数の目標と、週ごとの目標・進み具合 ----------
// 日の重み：平日＝1、土日祝＝過去の小売の「土日祝1日÷平日1日」（ratio）。目標をこの重みで日ごとに配る
let anTg = null;
async function loadTarget() {
  try { const r = await fetch("/api/target"); anTg = await r.json(); if (!r.ok) throw 0; } catch { $("anTarget").innerHTML = '<h3>🎯 今月の小売目標</h3><div class="tv-dim">読み込めませんでした</div>'; return; }
  drawTarget();
}
function drawTarget() {
  const t = anTg, box = $("anTarget");
  if (!t || !box) return;
  const wgt = (x) => (x.off ? t.ratio : 1);
  const totalW = t.days.reduce((s, x) => s + wgt(x), 0);
  const thr = t.through || "";
  const doneDays = t.days.filter((x) => thr && x.date <= thr), restDays = t.days.filter((x) => !thr || x.date > thr);
  const actual = doneDays.reduce((s, x) => s + x.retail, 0);
  const doneW = doneDays.reduce((s, x) => s + wgt(x), 0), restW = totalW - doneW;
  const T = t.target;
  const status = (a, plan) => { if (!plan) return ""; const r = a / plan; return r >= 1.05 ? '<span class="st up">上振れ</span>' : r >= 0.95 ? '<span class="st on">オンピッチ</span>' : '<span class="st dn">下振れ</span>'; };
  const mlabel = `${Number(t.month.slice(5))}月`;
  const input = `<span class="tg-in">${mlabel}の小売目標 <input type="number" id="anTgIn" min="0" step="1" value="${T ?? ""}" placeholder="例 400"> 台 <button class="btn btn-ok" id="anTgSave" style="padding:3px 12px">保存</button></span>`;
  if (T == null) { box.innerHTML = `<h3>🎯 今月の小売目標</h3>${input}<div class="tv-note" style="margin-top:6px">目標を入れると、土日祝の日数（土日祝は平日の${t.ratio}倍売れる計算）に合わせて週ごとの目標を自動で決め、進み具合を出します。</div>`; bindTg(); return; }
  const planToDate = T * (doneW / totalW);
  const land = doneW ? Math.round(actual / doneW * totalW) : 0;
  const need = Math.max(0, T - actual);
  const perW = restW ? need / restW : 0;
  // 週ごと（月曜〜日曜。月の初めと終わりは月の中だけ）
  const weeks = [];
  for (const x of t.days) { if (!weeks.length || x.dow === 1) weeks.push({ days: [] }); weeks[weeks.length - 1].days.push(x); }
  const fmtD = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}(${AN_DOW[new Date(d + "T00:00:00Z").getUTCDay()]})`;
  let cum = 0;
  const rows = weeks.map((w, i) => {
    const W = w.days.reduce((s, x) => s + wgt(x), 0), goal = T * W / totalW;
    const done = w.days.filter((x) => thr && x.date <= thr), dW = done.reduce((s, x) => s + wgt(x), 0);
    const act = done.reduce((s, x) => s + x.retail, 0), off = w.days.filter((x) => x.off).length;
    const state = !done.length ? '<span class="st fu">これから</span>' : done.length === w.days.length ? (act >= goal ? '<span class="st up">達成</span>' : '<span class="st dn">未達</span>') : status(act, goal * dW / W) + '<span class="tv-dim" style="font-size:10px">（途中）</span>';
    cum += goal;
    return `<tr class="${!done.length ? "fu" : ""}"><td><b>${i + 1}週目</b></td><td style="text-align:left">${fmtD(w.days[0].date)}${w.days.length > 1 ? "〜" + fmtD(w.days[w.days.length - 1].date) : ""}</td>
      <td class="n">${w.days.length - off}日</td><td class="n">${off}日</td><td class="n"><b>${Math.round(goal)}台</b></td><td class="n">${Math.round(cum)}台</td>
      <td class="n">${done.length ? act + "台" : "—"}</td><td class="n">${done.length && done.length < w.days.length && dW ? `<span class="tg-fc" title="済んだ日のペースで週末までいった場合（土日祝の重みつき）">${Math.round(act / dW * W)}台</span>` : ""}</td><td class="n ${done.length ? (act - goal * dW / W >= 0 ? "plus" : "minus") : ""}">${done.length ? (act - Math.round(goal * dW / W) >= 0 ? "+" : "") + (act - Math.round(goal * dW / W)) + "台" : "—"}</td><td>${state}</td></tr>`;
  }).join("");
  const restOff = restDays.filter((x) => x.off).length, restWk = restDays.length - restOff;
  box.innerHTML = `<h3>🎯 今月の小売目標</h3>${input}
    <div class="tg-kpis">
      <div><span>${thr ? fmtD(thr) + "までの実績" : "実績"}</span><b>${actual}台</b><em>目標 ${T}台の ${Math.round(actual / T * 100)}%</em></div>
      <div><span>今日までの目標</span><b>${Math.round(planToDate)}台</b><em>差 ${actual - Math.round(planToDate) >= 0 ? "+" : ""}${actual - Math.round(planToDate)}台</em></div>
      <div><span>進み具合</span><b>${status(actual, planToDate) || "—"}</b><em>±5%以内をオンピッチ</em></div>
      <div><span>このままの着地見込み</span><b>${land}台</b><em>目標まで ${land - T >= 0 ? "+" : ""}${land - T}台</em></div>
      <div><span>残りで必要</span><b>${need}台</b><em>平日 ${perW.toFixed(1)}台/日・土日祝 ${(perW * t.ratio).toFixed(1)}台/日（残り 平日${restWk}日・土日祝${restOff}日）</em></div>
    </div>
    <table class="tv-table tg-table"><thead><tr><th>週</th><th style="text-align:left">期間</th><th>平日</th><th>土日祝</th><th>週の目標</th><th>累計目標</th><th>実績</th><th>着地予想</th><th>目標との差</th><th>状態</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="tv-note" style="margin-top:4px">週の目標＝月の目標を日数で割り振ったもの（平日1日＝1、土日祝1日＝${t.ratio}として計算。過去の小売の実績から）。実績は小売のみ・契約日で数えます。途中の週は、済んだ日の分の目標と比べています。</div>`;
  bindTg();
}
function bindTg() {
  const b = $("anTgSave");
  if (!b) return;
  const save = async () => {
    const v = Number($("anTgIn").value);
    if (!(v >= 0) || $("anTgIn").value === "") return alert("目標の台数を入れてください");
    await fetch("/api/target", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ month: anTg.month, retail: v }) });
    anTg.target = Math.round(v); drawTarget();
  };
  b.onclick = save;
  $("anTgIn").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

// ---------- 施策メモ（社長のノウハウ）：いつ・どの車種に・何をしたかを記録し、効果を自動で測る ----------
async function loadKnowhow() {
  try { const r = await fetch("/api/knowhow"); const d = await r.json(); an.kh = d.items || []; an.khThrough = d.through; } catch { an.kh = []; }
  if (an.data) drawAnalysis();
}
function drawKnowhow() {
  const box = $("anKh");
  if (!box) return;
  const names = [...new Set((an.data?.models || []).map((m) => m.name.replace(/（.*$/, "")))].sort((a, b) => a.localeCompare(b, "ja"));
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const KINDS = ["値下げ", "値上げ", "重点販売", "仕入れ強化", "仕入れ停止", "広告・掲載", "その他"];
  const lift = (k) => (k.lift == null ? "—" : `<b class="${k.lift >= 0 ? "plus" : "minus"}">${k.lift >= 0 ? "+" : ""}${Math.round(k.lift * 100)}%</b>`);
  const man = (v) => (v == null ? "—" : (v / 10000).toFixed(1) + "万");
  box.innerHTML = `<h3>📝 施策メモ（社長のノウハウ） <span class="tv-note">価格変更や重点販売を記録すると、前の60日と比べた効果を自動で出し、AI分析にも反映します</span></h3>
    <div class="kh-form">
      <input id="khModel" list="khModels" placeholder="車種（例：ライズ）" style="width:150px"><datalist id="khModels">${names.map((n) => `<option value="${h(n)}">`).join("")}</datalist>
      <select id="khKind">${KINDS.map((k) => `<option>${k}</option>`).join("")}</select>
      <label>開始 <input type="date" id="khStart" value="${today}"></label>
      <label>終了 <input type="date" id="khEnd"></label>
      <input id="khDetail" placeholder="内容・ねらい（例：売れるように5万円値下げ。今月の重点車種）" style="flex:1;min-width:240px">
      <button class="btn btn-ok" id="khAdd">記録する</button>
    </div>
    ${(an.kh || []).length ? `<table class="tv-table kh-table"><thead><tr><th>車種</th><th>施策</th><th>期間</th><th>内容・ねらい</th><th>施策中の販売</th><th>前の60日</th><th>1日あたりの変化</th><th>台粗利（前→中）</th><th></th></tr></thead><tbody>
      ${an.kh.map((k) => `<tr class="${k.active ? "on" : ""}"><td class="nm">${h(k.name || k.model)}${k.active ? '<span class="kh-b">実施中</span>' : ""}</td><td>${h(k.kind || "")}</td>
        <td>${h(k.start_date.slice(5).replace("-", "/"))}〜${k.end_date ? h(k.end_date.slice(5).replace("-", "/")) : ""}</td><td class="dt">${h(k.detail || "")}</td>
        <td class="n">${k.after_days ? `${k.after_sold}台（${k.after_days}日）` : "まだ"}</td><td class="n">${k.before_sold}台</td><td class="n">${lift(k)}</td>
        <td class="n">${man(k.before_gross)} → ${man(k.after_gross)}</td><td><button class="btn btn-sub" data-khdel="${k.id}" style="padding:1px 6px;font-size:11px">削除</button></td></tr>`).join("")}</tbody></table>`
      : '<div class="tv-dim" style="margin-top:6px">まだ記録はありません。</div>'}
    <div class="tv-note" style="margin-top:4px">効果＝施策を始めた日から${an.khThrough ? an.khThrough.slice(5).replace("-", "/") : "最新"}まで（終了日があればその日まで）の1日あたりの販売台数を、始める前の60日と比べたもの（小売＋業販）。実施中で+30%以上の車種は、AI分析の「在庫を増やしたい車種」に「施策の効果あり」として入ります。</div>`;
  $("khAdd").onclick = async () => {
    const body = { model: $("khModel").value, kind: $("khKind").value, start: $("khStart").value, end: $("khEnd").value, detail: $("khDetail").value };
    if (!body.model.trim() || !body.start) return alert("車種と開始日を入れてください");
    const r = await fetch("/api/knowhow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) return alert((await r.json().catch(() => ({}))).error || "記録できませんでした");
    loadKnowhow();
  };
  box.querySelectorAll("[data-khdel]").forEach((b) => (b.onclick = async () => {
    if (!confirm("この施策メモを消しますか？")) return;
    await fetch("/api/knowhow/" + b.dataset.khdel, { method: "DELETE" }); loadKnowhow();
  }));
}
