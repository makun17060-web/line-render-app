// public/liff-address.js
// オンライン注文用住所入力（LIFF内）
// server.js の /api/liff/config と /api/liff/address を使用。

(async function () {
  const $ = (id) => document.getElementById(id);

  const postal     = $("postal");
  const prefecture = $("prefecture");
  const city       = $("city");
  const address1   = $("address1");
  const address2   = $("address2");
  const name       = $("name");
  const phone      = $("phone");

  const saveBtn   = $("saveBtn");
  const backBtn   = $("backBtn");
  const statusMsg = $("statusMsg");

  let lineUserId = "";
  let lineUserName = "";

  // ====== LIFF初期化 ======
  async function initLiff() {
    try {
      // ★ server.js の /api/liff/config をそのまま使う（?kindなし）
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
      return true;
    } catch (e) {
      console.error("LIFF init error:", e);
      statusMsg.textContent = "LIFF初期化に失敗しました。LINEアプリから開いてください。";
      return false;
    }
  }

  const ok = await initLiff();
  if (!ok || !lineUserId) return;

  // ====== 住所読み込み ======
  async function loadAddress() {
    try {
      const res = await fetch(
        `/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      return data?.address || null;
    } catch (e) {
      console.error("loadAddress error:", e);
      return null;
    }
  }

  const saved = await loadAddress();
  if (saved) {
    postal.value     = saved.postal     || "";
    prefecture.value = saved.prefecture || "";
    city.value       = saved.city       || "";
    address1.value   = saved.address1   || "";
    address2.value   = saved.address2   || "";
    name.value       = saved.name       || lineUserName || "";
    phone.value      = saved.phone      || "";
  } else {
    name.value = lineUserName || "";
  }

  // ====== 保存ボタン ======
  saveBtn.onclick = async () => {
    const addr = {
      postal:     postal.value.trim(),
      prefecture: prefecture.value.trim(),
      city:       city.value.trim(),
      address1:   address1.value.trim(),
      address2:   address2.value.trim(),
      name:       name.value.trim(),
      phone:      phone.value.trim(),
    };

    if (
      !addr.postal ||
      !addr.prefecture ||
      !addr.city ||
      !addr.address1 ||
      !addr.name ||
      !addr.phone
    ) {
      statusMsg.textContent = "未入力の項目があります。すべて入力してください。";
      return;
    }

    saveBtn.disabled = true;
    statusMsg.textContent = "保存中…";

    try {
      // ★ server.js 側は { userId, address: { ... } } を想定
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: lineUserId,
          address: addr,
        }),
      });
      const data = await res.json();
      if (!data?.ok) throw new Error("save failed");

      // currentOrder にも住所を保存（confirm.js 用）
      const cur = JSON.parse(sessionStorage.getItem("currentOrder") || "{}");
      cur.address     = addr;
      cur.lineUserId  = lineUserId;
      cur.lineUserName = lineUserName;
      sessionStorage.setItem("currentOrder", JSON.stringify(cur));

      statusMsg.textContent = "住所を保存しました。確認画面へ移動します…";
      setTimeout(() => {
        location.href = "/public/confirm.html";
      }, 600);
    } catch (e) {
      console.error("save address error:", e);
      statusMsg.textContent = "保存に失敗しました。通信環境を確認してください。";
      saveBtn.disabled = false;
    }
  };

  // ====== 戻るボタン ======
  backBtn.onclick = () => {
    // ひとまず商品一覧に戻す（必要なら confirm.html に変更可）
    location.href = "/public/products.html";
  };
})();
