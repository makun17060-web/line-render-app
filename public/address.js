// /public/liff-address.js
(async function () {
  const $ = (id) => document.getElementById(id);

  const postal = $("postal");
  const prefecture = $("prefecture");
  const city = $("city");
  const address1 = $("address1");
  const address2 = $("address2");
  const name = $("name");
  const phone = $("phone");
  const saveBtn = $("saveBtn");
  const backBtn = $("backBtn");
  const statusMsg = $("statusMsg");

  let lineUserId = "";
  let lineUserName = "";

  async function initLiff() {
    try {
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if (!liffId) throw new Error("LIFF ID not set");

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        liff.login();
        return false;
      }

      const prof = await liff.getProfile();
      lineUserId = prof.userId || "";
      lineUserName = prof.displayName || "";
      return true;
    } catch (e) {
      console.log(e);
      statusMsg.textContent = "LINEアプリ内で開いてください。";
      return false;
    }
  }

  async function loadMyAddress() {
    try {
      const res = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`, { cache:"no-store" });
      const data = await res.json();
      const a = data?.address;
      if (!a) return;
      postal.value = a.postal || "";
      prefecture.value = a.prefecture || "";
      city.value = a.city || "";
      address1.value = a.address1 || "";
      address2.value = a.address2 || "";
      name.value = a.name || lineUserName || "";
      phone.value = a.phone || "";
    } catch {}
  }

  async function saveAddress() {
    saveBtn.disabled = true;
    statusMsg.textContent = "保存中…";

    const payload = {
      lineUserId,
      postal: postal.value.trim(),
      prefecture: prefecture.value.trim(),
      city: city.value.trim(),
      address1: address1.value.trim(),
      address2: address2.value.trim(),
      name: name.value.trim() || lineUserName,
      phone: phone.value.trim()
    };

    try {
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || "save_failed");

      // 注文データ（currentOrder）があれば住所を上書き
      try {
        const o = JSON.parse(sessionStorage.getItem("currentOrder") || "{}");
        o.address = payload;
        sessionStorage.setItem("currentOrder", JSON.stringify(o));
      } catch {}

      statusMsg.textContent = "保存しました！ ③へ戻ります。";
      setTimeout(() => history.back(), 600);

    } catch (e) {
      console.log(e);
      statusMsg.textContent = "保存に失敗しました。\n通信状況をご確認ください。";
      saveBtn.disabled = false;
    }
  }

  const ok = await initLiff();
  if (!ok) return;
  await loadMyAddress();

  saveBtn.addEventListener("click", saveAddress);
  backBtn.addEventListener("click", () => history.back());
})();
