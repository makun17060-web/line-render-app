/* public/liff-config.js
   ✅ ここだけ編集すれば全ページに反映される
*/
(function(){
  // ✅ 読み込めた判定（任意だけど超おすすめ）
  window.__LIFF_CONFIG_LOADED__ = true;

  // あなたが今持ってる LIFF（初めてセット用）
  var TRIAL = "2008406620-yQFRswAu";

  // ▼ まず「全部埋める」：当面はそれぞれのIDを入れる（動作優先）
  // ※あとで LIFF を分けたくなったら、ここだけ差し替えればOK
  window.LIFF_ID_ORDER_TRIAL    = "2008406620-yQFRswAu"; // 初めてセット（fukubako / trial）
  window.LIFF_ID_ORDER_AKASHA   = "2008406620-G5j1gjzM"; // 通常（あかしゃ）
  window.LIFF_ID_ORDER_ORIGINAL = "2008406620-Bd9Zo9od"; // オリジナルセット
  window.LIFF_ID_ORDER_STORE    = "2008406620-7tSkOcqd"; // 店頭

  // 互換用（あなたのコードの fallback が参照する）
  window.LIFF_ID_COD = TRIAL;

  // （任意）住所専用を作るならここも
  // window.LIFF_ID_ADDR = TRIAL;
})();
