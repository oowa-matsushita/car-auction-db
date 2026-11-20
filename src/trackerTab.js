// 「🚗 競合落品」タブ：競合落品トラッカー（別Worker・/tracker/ で中継）を画面の中に表示する。
// 画面ファイル（public/）には手を入れず、index.html を配信するときにタブとその中身を差し込む。

const STYLE = `<style>
  /* 競合落品トラッカーを枠いっぱいに表示 */
  #tab-tracker { flex: 1; min-height: 0; display: flex; }
  #tab-tracker iframe { flex: 1; width: 100%; height: 100%; border: 0; background: #eef1ef; }
</style>`;

const BUTTON = `<button data-tab="tracker">🚗 競合落品</button>`;

const SECTION = `<section class="tab" id="tab-tracker" hidden>
  <iframe id="trackerFrame" title="競合落品トラッカー"></iframe>
</section>`;

// turnover.js の前：開いたときの #tracker を覚えておく（turnover.js が #ledger に戻すため）
const BEFORE = `<script>window.__mmsInitHash = location.hash;</script>`;

// turnover.js の後：タブの一覧に加え、はじめて開いたときに中身を読み込む
const AFTER = `<script>
(function () {
  if (typeof TABS === "undefined" || typeof showTab !== "function") return;
  TABS.push("tracker");
  var orig = showTab;
  showTab = function (name) {
    orig(name);
    if (name === "tracker") {
      var f = document.getElementById("trackerFrame");
      if (f && !f.getAttribute("src")) f.src = "/tracker/";
    }
  };
  if (window.__mmsInitHash === "#tracker") showTab("tracker");
})();
</script>`;

export function withTrackerTab(res) {
  return new HTMLRewriter()
    .on("head", { element(e) { e.append(STYLE, { html: true }); } })
    .on('button[data-tab="review"]', { element(e) { e.after(BUTTON, { html: true }); } })
    .on("section#tab-turnover", { element(e) { e.before(SECTION, { html: true }); } })
    .on('script[src="turnover.js"]', {
      element(e) {
        e.before(BEFORE, { html: true });
        e.after(AFTER, { html: true });
      },
    })
    .transform(res);
}
