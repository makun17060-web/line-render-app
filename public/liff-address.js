// /public/liff-address.js
// 住所入力画面
// - LIFFで userId を取得
// - 保存済みなら自動入力
// - 保存後は confirm.html へ進む

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

  function setStatus(msg) {
    statusMsg.textContent = msg || "";
  }

  // -----------------------------
  // 1) LIFF 初期化 & プロフィール取得
  // -----------------------------
  async function initLiff() {
    try {
      // server.js の /api/liff/config から LIFF ID を取得
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = conf?.liffId;

      if (!liffId) throw new Error("LIFF ID not found");

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        // ブラウザ直開きの場合はログイン誘導
        liff.login();
        return false;
      }

      const profile = await liff.getProfile();
      lineUserId = profile?.userId || "";

      if (lineUserId) {
        localStorage.setItem("lineUserId", lineUserId);
      }

      return true;
    } catch (e) {
      console.warn("LIFF init failed:", e);
      // ブラウザで開いた場合でも入力はできるようにする
      lineUserId = localStorage.getItem("lineUserId") || "";
      return false;
    }
  }

  // -----------------------------
  // 2) 保存済み住所を取得して自動入力
  // -----------------------------
  async function loadSavedAddress() {
    try {
      const url = lineUserId
        ? `/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`
        : `/api/liff/address/me`;

      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      const a = data?.address;
      if (!data?.ok || !a) return;

      postal.value     = a.postal || "";
      prefecture.value = a.prefecture || "";
      city.value       = a.city || "";
      address1.value   = a.address1 || "";
      address2.value   = a.address2 || "";
      name.value       = a.name || "";
      phone.value      = a.phone || "";
    } catch (e) {
      console.error("loadSavedAddress error:", e);
    }
  }

  // -----------------------------
  // 3) 保存
  // -----------------------------
  async function saveAddress() {
    const payload = {
      userId: lineUserId || localStorage.getItem("lineUserId") || "",
      postal: postal.value.trim(),
      prefecture: prefecture.value.trim(),
      city: city.value.trim(),
      address1: address1.value.trim(),
      address2: address2.value.trim(),
      name: name.value.trim(),
      phone: phone.value.trim(),
    };

    if (!payload.postal || !payload.prefecture || !payload.city || !payload.address1 || !payload.name || !payload.phone) {
      setStatus("未入力の項目があります。すべてご入力ください。");
      return;
    }

    setStatus("保存中...");

    try {
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || "save_failed");

      setStatus("住所を保存しました。最終確認へ進みます。");

      // confirmへ
      setTimeout(() => {
        location.href = "/public/confirm.html";
      }, 300);

    } catch (e) {
      console.error("saveAddress error:", e);
      setStatus("保存に失敗しました。通信状態をご確認ください。");
    }
  }

  saveBtn.onclick = saveAddress;

  // 「戻る」も最終確認へ（※最終から住所へ戻らなくてOK方針）
  backBtn.onclick = () => {
    location.href = "/public/confirm.html";
  };

  // -----------------------------
  // init
  // -----------------------------
  setStatus("読み込み中...");
  await initLiff();
  await loadSavedAddress();
  setStatus("");
})();
