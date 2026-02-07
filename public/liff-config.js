/* public/liff-config.js
   ✅ ここだけ編集すれば全ページに反映される
*/
(function(){
  // あなたが今持ってる LIFF（初めてセット用）
  var TRIAL = "2008406620-yQFRswAu";

  // ▼ まず「全部埋める」：当面は同じIDでOK（動作優先）
  // ※あとで LIFF を分けたくなったら、それぞれ差し替えるだけ
  window.LIFF_ID_ORDER_TRIAL    = TRIAL; // 初めてセット（fukubako / trial）
  window.LIFF_ID_ORDER_AKASHA   = TRIAL; // 通常（あかしゃ）←暫定で同じにする
  window.LIFF_ID_ORDER_ORIGINAL = TRIAL; // オリジナルセット ←暫定
  window.LIFF_ID_ORDER_STORE    = TRIAL; // 店頭 ←暫定

  // 互換用（あなたのコードが参照してることがある）
  window.LIFF_ID_COD = TRIAL;

  // デバッグしたいなら一時的に
  // console.log("[liff-config] loaded", {
  //   TRIAL: window.LIFF_ID_ORDER_TRIAL,
  //   AKASHA: window.LIFF_ID_ORDER_AKASHA,
  //   ORIGINAL: window.LIFF_ID_ORDER_ORIGINAL,
  //   STORE: window.LIFF_ID_ORDER_STORE,
  //   COD: window.LIFF_ID_COD
  // });
})();
