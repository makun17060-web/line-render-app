// /public/liff-address.js
// ONLINE注文用住所入力（LIFF内）

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

  let lineUserId   = "";
  let lineUserName = "";

  // ====== LIFF 初期化 ======
  async function initLiff() {
    try {
      // kind=online はサーバー側では無視されますがそのままでOK
      const confRes = await fetch("/api/liff/config?kind=online", { cache: "no-store" });
      const conf    = await confRes.json();
      const liffId  = (conf?.liffId || "").trim();
      if (!liffId) throw new Error("no liffId online");

      await liff.init({ liffId });
      if (!liff.isLoggedIn()) {
        liff.login();
        return false;
      }
      const prof = await liff.getProfile();
      lineUserId   = prof.userId;
      lineUserName = prof.displayName;
      return true;
    } catch (e) {
      console.error("initLiff error:", e);
      statusMsg.textContent = "LIFF初期化に失敗しました。LINEアプリから開いてください。";
      return false;
    }
  }

  const ok = await initLiff();
  if (!ok || !lineUserId) return;

  // ====== 既存住所読み込み ======
  async function loadAddress() {
    try {
      const res  = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`, {
        cache: "no-store",
      });
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

    if (!addr.postal || !addr.prefecture || !addr.city || !addr.address1 || !addr.name || !addr.phone) {
      statusMsg.textContent = "未入力の項目があります。すべて入力してください。";
      return;
    }

    saveBtn.disabled = true;
    statusMsg.textContent = "住所を保存しています…";

    try {
      // ★ server.js 側の /api/liff/address は
      //   body = { userId, address: {...} } を期待
      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: lineUserId,
          address: addr,
        }),
      });

      const data = await res.json();
      if (!data?.ok) throw new Error(data.error || "save_failed");

      // currentOrder にも反映（ミニアプリ決済用）
      const cur = JSON.parse(sessionStorage.getItem("currentOrder") || "{}");
      cur.address      = addr;
      cur.lineUserId   = lineUserId;
      cur.lineUserName = lineUserName;
      sessionStorage.setItem("currentOrder", JSON.stringify(cur));

      statusMsg.textContent = "住所を保存しました。確認画面に戻ります…";
      setTimeout(() => {
        location.href = "./payment-select.html";

      }, 800);
    } catch (e) {
      console.error("/api/liff/address save error:", e);
      statusMsg.textContent = "保存に失敗しました。通信環境を確認して、もう一度お試しください。";
      saveBtn.disabled = false;
    }
  };

  // ====== 戻るボタン ======
  backBtn.onclick = () => {
    location.href = "/public/confirm.html";
  };
})();
