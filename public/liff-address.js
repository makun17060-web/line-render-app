// /public/liff-address.js
// ② 住所入力画面
// - LIFF で userId を取得
// - /api/liff/address に住所を保存
// - 保存後：カートがあれば confirm.html、なければ products.html へ

(async function () {
  const $ = (id) => document.getElementById(id);

  const postal     = $("postal");
  const prefecture = $("prefecture");
  const city       = $("city");
  const address1   = $("address1");
  const address2   = $("address2");
  const name       = $("name");
  const phone      = $("phone");

  const saveBtn = $("saveBtn");
  const backBtn = $("backBtn");
  const statusMsg = $("statusMsg");

  // -----------------------------
  // 1) LIFF 初期化 & プロフィール取得
  // -----------------------------
  let lineUserId = "";
  let lineUserName = "";

  async function initLiff() {
    try {
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if (!liffId) {
        statusMsg.textContent = "LIFF ID が取得できません。";
        return false;
      }

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        liff.login();
        return false;
      }

      const prof = await liff.getProfile();
      lineUserId = prof.userId;
      lineUserName = prof.displayName;

      return true;
    } catch (e) {
      console.log("LIFF init error:", e);
      statusMsg.textContent = "LIFF 初期化に失敗しました。LINE アプリから開いてください。";
      return false;
    }
  }

  const ok = await initLiff();
  if (!ok || !lineUserId) return;

  // -----------------------------
  // 2) 既存住所の読み込み
  // -----------------------------
  async function loadAddress() {
    try {
      const cur = JSON.parse(sessionStorage.getItem("currentOrder") || "{}");
      if (cur.address) return cur.address;

      const res = await fetch(
        `/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      return data?.address || null;
    } catch (e) {
      return null;
    }
  }

  const savedAddr = await loadAddress();
  if (savedAddr) {
    postal.value     = savedAddr.postal     || "";
    prefecture.value = savedAddr.prefecture || "";
    city.value       = savedAddr.city       || "";
    address1.value   = savedAddr.address1   || "";
    address2.value   = savedAddr.address2   || "";
    name.value       = savedAddr.name       || "";
    phone.value      = savedAddr.phone      || "";
  }

  // -----------------------------
  // 3) 保存処理
  // -----------------------------
  saveBtn.addEventListener("click", async () => {
    const addr = {
      postal: postal.value.trim(),
      prefecture: prefecture.value.trim(),
      city: city.value.trim(),
      address1: address1.value.trim(),
      address2: address2.value.trim(),
      name: name.value.trim(),
      phone: phone.value.trim(),
    };

    if (!addr.postal || !addr.prefecture || !addr.city || !addr.address1 ||
        !addr.name || !addr.phone) {
      statusMsg.textContent = "未入力の項目があります。すべて入力してください。";
      return;
    }

    saveBtn.disabled = true;
    statusMsg.textContent = "保存中…";

    try {
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: lineUserId,
          address: addr,
        }),
      });

      const data = await res.json();
      if (!data || !data.ok) {
        throw new Error("住所の保存に失敗しました");
      }

      // sessionStorage の注文データにも保持（カートが無い場合も壊さない）
      const cur = JSON.parse(sessionStorage.getItem("currentOrder") || "{}");
      cur.address = addr;
      cur.lineUserId = lineUserId;
      cur.lineUserName = lineUserName;
      sessionStorage.setItem("currentOrder", JSON.stringify(cur));

      // ★カート（items）があるかチェック
      const hasItems = Array.isArray(cur.items) && cur.items.length > 0;

      if (hasItems) {
        statusMsg.textContent = "住所を保存しました。最終確認へ移動します…";
        setTimeout(() => {
          location.href = "/public/confirm.html";
        }, 600);
      } else {
        // カートが無い → confirmに行っても弾かれるので商品選択へ戻す
        statusMsg.textContent = "住所を保存しました。商品選択画面へ戻ります…";
        setTimeout(() => {
          location.href = "/public/products.html";
        }, 800);
      }

    } catch (e) {
      console.log(e);
      statusMsg.textContent = "保存に失敗しました。ネットワークを確認して再度お試しください。";
      saveBtn.disabled = false;
    }
  });

  // -----------------------------
  // 4) 戻るボタン（カート有無で分岐）
  // -----------------------------
  backBtn.addEventListener("click", () => {
    const cur = JSON.parse(sessionStorage.getItem("currentOrder") || "{}");
    const hasItems = Array.isArray(cur.items) && cur.items.length > 0;
    location.href = hasItems ? "/public/confirm.html" : "/public/products.html";
  });

})();
