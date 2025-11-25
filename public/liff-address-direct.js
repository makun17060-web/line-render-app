// /public/liff-address-direct.js
// 直接注文（トーク）用の住所入力LIFF
// - LIFFでuserId取得
// - /api/liff/address に保存（★フラット形式でPOST）
// - 保存後は LIFFを閉じてトークへ戻る

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

  let lineUserId = "";
  let lineUserName = "";

  // -----------------------------
  // 1) LIFF 初期化 & プロフィール取得
  // -----------------------------
  async function initLiff() {
    try {
      const confRes = await fetch("/api/liff/config", { cache:"no-store" });
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
      console.log("LIFF init error:", e);
      statusMsg.textContent = "LIFF初期化に失敗しました。LINEアプリから開いてください。";
      return false;
    }
  }

  const ok = await initLiff();
  if (!ok || !lineUserId) return;

  // -----------------------------
  // 2) 既存住所読み込み（あれば自動入力）
  // -----------------------------
  async function loadAddress() {
    try {
      const res = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`, {
        cache:"no-store"
      });
      const data = await res.json();
      return data?.address || null;
    } catch {
      return null;
    }
  }

  const saved = await loadAddress();
  if (saved) {
    postal.value     = saved.postal || "";
    prefecture.value = saved.prefecture || "";
    city.value       = saved.city || "";
    address1.value   = saved.address1 || "";
    address2.value   = saved.address2 || "";
    name.value       = saved.name || lineUserName || "";
    phone.value      = saved.phone || "";
  } else {
    name.value = lineUserName || "";
  }

  // -----------------------------
  // 3) 保存
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
      // ★ A案ポイント：addressで包まずフラットに送る
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          userId: lineUserId,
          ...addr
        })
      });

      const data = await res.json();
      if (!data?.ok) throw new Error("save failed");

      statusMsg.textContent =
        "保存しました。トーク画面へ戻ります。\n（続きの注文を進めてください）";

      setTimeout(() => {
        try { liff.closeWindow(); }
        catch { location.href = "https://line.me/R/"; }
      }, 800);

    } catch (e) {
      console.log(e);
      statusMsg.textContent = "保存に失敗しました。通信環境を確認してください。";
      saveBtn.disabled = false;
    }
  });

  // -----------------------------
  // 4) 戻る
  // -----------------------------
  backBtn.addEventListener("click", () => {
    try { liff.closeWindow(); }
    catch { history.back(); }
  });

})();
