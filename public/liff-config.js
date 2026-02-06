// public/liff-config.js
// ✅ LIFF ID を 1か所に集約するための設定ファイル
// ここだけ直せば、全ページの LIFF ID が揃います。

(function () {
  "use strict";

  // ▼ ここが「正」の LIFF ID（あなたのEC導線で使うもの）
  // 例: 通常の confirm / pay-card / cod-register が安定して動いている LIFF
  window.LIFF_ID_DEFAULT = "2008406620-G5j1gjzM";

  // 互換: たまに別名で参照したい場合
  window.LIFF_ID_ORDER = window.LIFF_ID_DEFAULT;
  window.LIFF_ID_COD = window.LIFF_ID_DEFAULT;
})();
