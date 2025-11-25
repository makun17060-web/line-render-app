// /public/roulette.js
// - LIFF初期化（/api/liff/config から LIFF ID取得）
// - 1ユーザー1回制限（localStorage）
// - 住所入力ボタン → /public/liff-address-direct.html を LIFF内で開く

(async function () {
  const $ = (id) => document.getElementById(id);

  const statusMsg  = $("statusMsg");
  const wheelText  = $("wheelText");
  const spinBtn    = $("spinBtn");
  const addrBtn    = $("addrBtn");
  const closeBtn   = $("closeBtn");
  const resultArea = $("resultArea");

  let lineUserId = "";
  let lineUserName = "";

  // =========================
  // 1) LIFF 初期化
  // =========================
  async function initLiff() {
    try {
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if (!liffId) throw new Error("no liffId");

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        liff.login();
        return false;
      }

      const prof = await liff.getProfile();
      lineUserId = prof.userId;
      lineUserName = prof.displayName;

      statusMsg.textContent = `ようこそ ${lineUserName} さん！`;
      return true;
    } catch (e) {
      console.log("LIFF init error:", e);
      statusMsg.textContent = "LINEアプリ内から開いてください（LIFF初期化失敗）";
      spinBtn.disabled = true;
      addrBtn.disabled = true;
      return false;
    }
  }

  const ok = await initLiff();
  if (!ok || !lineUserId) return;

  // =========================
  // 2) 1回制限チェック
  // =========================
  const KEY_SPIN = `roulette_spun_${lineUserId}`;
  const KEY_RESULT = `roulette_result_${lineUserId}`;

  function hasSpun() {
    return localStorage.getItem(KEY_SPIN) === "1";
  }
  function saveResult(text) {
    localStorage.setItem(KEY_SPIN, "1");
    localStorage.setItem(KEY_RESULT, text);
  }
  function loadResult() {
    return localStorage.getItem(KEY_RESULT) || "";
  }

  if (hasSpun()) {
    const prev = loadResult();
    wheelText.textContent = "完了";
    resultArea.textContent = `あなたはすでに回しています。\n結果：${prev}`;
    spinBtn.disabled = true;
  }

  // =========================
  // 3) ルーレット設定
  // =========================
  const prizes = [
    "当たり：えびせん 1袋プレゼント！",
    "当たり：次回5%OFFクーポン！",
    "はずれ：またのご来店お待ちしてます！",
    "当たり：のりせん 1袋プレゼント！",
  ];

  function randomPrize() {
    const i = Math.floor(Math.random() * prizes.length);
    return prizes[i];
  }

  // 簡易アニメーション
  function spinAnimation(done) {
    const steps = 18 + Math.floor(Math.random() * 10);
    let c = 0;
    const timer = setInterval(() => {
      wheelText.textContent = prizes[c % prizes.length].replace(/^当たり：|はずれ：/, "");
      c++;
      if (c >= steps) {
        clearInterval(timer);
        done();
      }
    }, 120);
  }

  // =========================
  // 4) 回す
  // =========================
  spinBtn.addEventListener("click", () => {
    if (hasSpun()) return;

    spinBtn.disabled = true;
    statusMsg.textContent = "ルーレット中…";

    spinAnimation(() => {
      const prize = randomPrize();
      wheelText.textContent = "STOP";
      resultArea.textContent = `結果：\n${prize}`;

      saveResult(prize);
      statusMsg.textContent = "結果を保存しました。";

      // ※必要ならここでサーバーに結果送信も可能
      // fetch("/api/roulette/log", {method:"POST", headers:{...}, body:JSON.stringify({userId:lineUserId, prize})})
    });
  });

  // =========================
  // 5) 住所入力ボタン
  // =========================
  addrBtn.addEventListener("click", () => {
    // LIFF内で住所入力ページを開く
    liff.openWindow({
      url: location.origin + "/public/liff-address-direct.html",
      external: false
    });
  });

  // =========================
  // 6) トークへ戻る
  // =========================
  closeBtn.addEventListener("click", () => {
    try { liff.closeWindow(); }
    catch { location.href = "https://line.me/R/"; }
  });

})();
