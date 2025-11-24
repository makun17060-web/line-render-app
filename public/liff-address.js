// /public/liff-address.js
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

  function setStatus(msg) {
    if (statusMsg) statusMsg.textContent = msg;
    console.log("[liff-address]", msg);
  }

  // 0) まず要素が取れてるかチェック
  const requiredEls = [postal, prefecture, city, address1, name, phone, saveBtn];
  if (requiredEls.some((x) => !x)) {
    setStatus("画面部品の読み込みに失敗しました（id名を確認してください）");
    return;
  }

  // 1) LIFF初期化
  let lineUserId = "";
  let lineUserName = "";

  try {
    const confRes = await fetch("/api/liff/config", { cache: "no-store" });
    const conf = await confRes.json();
    const liffId = conf?.liffId;

    if (!liffId) {
      setStatus("LIFF_ID が取得できません。/api/liff/config を確認してください。");
      return;
    }

    await liff.init({ liffId });

    if (!liff.isLoggedIn()) {
      setStatus("LINEアプリ内で開いてください（ログインが必要です）");
      liff.login();
      return;
    }

    const prof = await liff.getProfile();
    lineUserId = prof.userId;
    lineUserName = prof.displayName || "";

    setStatus("読み込み完了しました。");
  } catch (e) {
    setStatus("LIFF初期化でエラー。LINEアプリ内で開いているか確認してください。");
    console.error(e);
    return;
  }

  // 2) 既存住所の読み込み
  try {
    const meRes = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`, { cache: "no-store" });
    const me = await meRes.json();
    if (me?.ok && me.address) {
      const a = me.address;
      postal.value     = a.postal || "";
      prefecture.value = a.prefecture || "";
      city.value       = a.city || "";
      address1.value   = a.address1 || "";
      address2.value   = a.address2 || "";
      name.value       = a.name || lineUserName || "";
      phone.value      = a.phone || "";
    } else {
      name.value = lineUserName || "";
    }
  } catch (e) {
    console.warn("address load error:", e);
  }

  // 3) 保存
  saveBtn.addEventListener("click", async () => {
    try {
      saveBtn.disabled = true;
      setStatus("保存中...");

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

      const res = await fetch("/api/liff/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!data?.ok) {
        setStatus("保存に失敗しました。入力内容を確認してください。");
        saveBtn.disabled = false;
        return;
      }

      setStatus("保存しました。前の画面に戻ります。");

      // ★ LIFF の戻り（productsへ飛ばないように closeWindow）
      if (liff.isInClient()) {
        liff.closeWindow();
      } else {
        history.back();
      }
    } catch (e) {
      console.error(e);
      setStatus("保存時にエラーが発生しました。");
      saveBtn.disabled = false;
    }
  });

  // 4) 戻る
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (liff.isInClient()) liff.closeWindow();
      else history.back();
    });
  }
})();
