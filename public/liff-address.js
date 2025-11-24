// /public/liff-address.js
// 住所入力画面
// - LIFFでuserId取得
// - 登録済み住所を自動入力
// - 保存→confirm.htmlへ

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

  function setStatus(t) {
    statusMsg.textContent = t || "";
  }

  async function initLiff() {
    try {
      // server.js から LIFF ID を取得
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = conf?.liffId;

      if (!liffId) throw new Error("no_liff_id");

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }

      const profile = await liff.getProfile();
      lineUserId = profile.userId || "";
      lineUserName = profile.displayName || "";

      if (lineUserId) {
        localStorage.setItem("lineUserId", lineUserId);
        localStorage.setItem("lineUserName", lineUserName);
      }
    } catch (e) {
      console.error("LIFF init error", e);
      setStatus("LIFF初期化に失敗しました。LINE内で開いてください。");
    }
  }

  async function loadSavedAddress() {
    try {
      const userId = lineUserId || localStorage.getItem("lineUserId") || "";
      const url = userId
        ? `/api/liff/address/me?userId=${encodeURIComponent(userId)}`
        : `/api/liff/address/me`;

      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      const a = data?.address;

      if (!data?.ok || !a) return false;

      // 自動入力
      postal.value     = a.postal || "";
      prefecture.value = a.prefecture || "";
      city.value       = a.city || "";
      address1.value   = a.address1 || "";
      address2.value   = a.address2 || "";
      name.value       = a.name || "";
      phone.value      = a.phone || "";

      setStatus("住所は登録済みです。必要なら修正して保存してください。");
      return true;
    } catch (e) {
      console.error("loadSavedAddress error", e);
      return false;
    }
  }

  async function saveAddress() {
    const body = {
      userId: lineUserId || localStorage.getItem("lineUserId") || "",
      name: name.value.trim(),
      phone: phone.value.trim(),
      postal: postal.value.trim(),
      prefecture: prefecture.value.trim(),
      city: city.value.trim(),
      address1: address1.value.trim(),
      address2: address2.value.trim(),
    };

    if (!body.userId) {
      setStatus("userIdが取得できません。LINE内で開いてください。");
      return false;
    }

    if (!body.postal || !body.prefecture || !body.city || !body.address1 || !body.name) {
      setStatus("必須項目（郵便番号/都道府県/市区町村/番地/氏名）を入力してください。");
      return false;
    }

    try {
      setStatus("保存中...");
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data?.ok) throw new Error("save_failed");

      setStatus("保存しました。最終確認へ進みます。");
      return true;
    } catch (e) {
      console.error("saveAddress error", e);
      setStatus("保存に失敗しました。もう一度お試しください。");
      return false;
    }
  }

  function goConfirm() {
    location.href = "/public/confirm.html";
  }

  saveBtn.onclick = async () => {
    const ok = await saveAddress();
    if (ok) goConfirm();
  };

  backBtn.onclick = () => {
    // 「③最終確認へ戻る」＝confirmへ
    goConfirm();
  };

  // init
  await initLiff();
  await loadSavedAddress();
})();
