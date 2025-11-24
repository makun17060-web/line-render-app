// /public/liff-address.js
// 住所入力画面
// - LIFFで userId を取得
// - /api/liff/address に保存
// - 保存済みがあれば自動入力（prefill）
// - 保存後は confirm.html へ自然に遷移

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

  function setStatus(msg) {
    statusMsg.textContent = msg || "";
  }

  // ---------- LIFF init ----------
  async function initLiffAndProfile() {
    try {
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = conf?.liffId;

      if (!liffId) throw new Error("LIFF ID not found");

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        // LINEログインへ
        liff.login();
        return false; // login後リロードされる想定
      }

      const prof = await liff.getProfile();
      lineUserId = prof?.userId || "";
      lineUserName = prof?.displayName || "";

      if (lineUserId) {
        localStorage.setItem("lineUserId", lineUserId);
      }
      return true;
    } catch (e) {
      console.error("LIFF init error", e);
      setStatus("LINEアプリ内から開いてください。");
      return false;
    }
  }

  // ---------- 住所の自動読込（prefill） ----------
  async function loadSavedAddress() {
    try {
      const url = lineUserId
        ? `/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`
        : `/api/liff/address/me`;

      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      const a = data?.address;
      if (!a) return;

      postal.value     = a.postal || "";
      prefecture.value = a.prefecture || "";
      city.value       = a.city || "";
      address1.value   = a.address1 || "";
      address2.value   = a.address2 || "";
      name.value       = a.name || lineUserName || "";
      phone.value      = a.phone || "";
    } catch (e) {
      console.error("loadSavedAddress error", e);
    }
  }

  // ---------- 保存 ----------
  async function saveAddress() {
    const payload = {
      userId: lineUserId,
      name: name.value.trim(),
      phone: phone.value.trim(),
      postal: postal.value.trim(),
      prefecture: prefecture.value.trim(),
      city: city.value.trim(),
      address1: address1.value.trim(),
      address2: address2.value.trim(),
    };

    if (!payload.userId) {
      setStatus("LINEユーザー情報が取得できません。");
      return false;
    }
    if (!payload.postal || !payload.prefecture || !payload.city || !payload.address1) {
      setStatus("住所を最後まで入力してください。");
      return false;
    }

    try {
      setStatus("保存中…");
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data?.ok) throw new Error("save failed");
      setStatus("保存しました。最終確認へ進みます…");
      return true;
    } catch (e) {
      console.error("save error", e);
      setStatus("保存に失敗しました。通信環境を確認してください。");
      return false;
    }
  }

  // ---------- イベント ----------
  saveBtn.onclick = async () => {
    const ok = await saveAddress();
    if (!ok) return;

    // 保存後は confirm へ（draftが無ければ products へ戻す）
    const draft = sessionStorage.getItem("orderDraft");
    if (!draft) {
      location.replace("/public/products.html");
      return;
    }
    location.replace("/public/confirm.html");
  };

  backBtn.onclick = () => {
    // 「戻る」は最終確認へ（draftが無い場合は productsへ）
    const draft = sessionStorage.getItem("orderDraft");
    if (!draft) {
      location.replace("/public/products.html");
      return;
    }
    location.replace("/public/confirm.html");
  };

  // ---------- init ----------
  const ok = await initLiffAndProfile();
  if (!ok) return;

  await loadSavedAddress();
  setStatus(""); // 表示をクリア
})();
