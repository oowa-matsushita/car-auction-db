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

  $("anBody").innerHTML = `
    <div class="an-kpis">
      <div class="an-kpi"><span>期間</span><b>${monthLabel(ms[0])}〜${monthLabel(cur)}</b><em>${days.length}日</em></div>
      <div class="an-kpi"><span>販売台数</span><b>${total.toLocaleString()}台</b><em>1日平均 ${(total / days.length).toFixed(1)}台</em></div>
      <div class="an-kpi"><span>平日／土日祝</span><b>${(wkAvg ?? 0).toFixed(1)}／${(offAvg ?? 0).toFixed(1)}台</b><em>1日あたり</em></div>
      <div class="an-kpi"><span>平均台粗利</span><b>${man1a(gn ? gs / gn : null)}</b><em>値引き後・経費を引いた額</em></div>
      <div class="an-kpi"><span>売上高（税抜）</span><b>${Math.round(sales / 1e4).toLocaleString()}万円</b><em>車輛本体−値引き</em></div>
    </div>
    <div class="an-card an-tips"><h3>💡 わかったこと</h3><ul>${tips.map((t) => `<li>${t}</li>`).join("")}</ul></div>
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
  $("anInfo").textContent = hasWx ? `天気：${d.place || ""}（気象庁）` : "天気データなし";
}
["anCh", "anSpan", "anOem"].forEach((id) => $(id).addEventListener("change", loadAnalysis));
if (!$("tab-analysis").hidden) loadAnalysis();
