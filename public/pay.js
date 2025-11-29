// public/pay.js — confirm 画面用 Stripe 決済 + 商品合計表示版

(async function () {
  const $ = (id) => document.getElementById(id);

  const itemsBox       = $("itemsBox");
  const itemsTotalText = $("itemsTotalText");
  const shippingText   = $("shippingText");
  const finalTotalText = $("finalTotalText");
  const statusEl       = $("status");
  const payButton      = $("payButton");
  const cancelButton   = $("cancelButton");

  let orderData    = null;
  let lineUserId   = "";
  let lineUserName = "";

  function setStatus(msg, isError = false) {
    statusEl.style.color = isError ? "#d00" : "#555";
    statusEl.textContent = msg || "";
  }

  function yen(n) {
    return (Number(n) || 0).toLocaleString("ja-JP") + "円";
  }

  // ========== 1) LIFF 初期化 ==========
  async function initLiff() {
    const confRes = await fetch("/api/liff/config");
    const conf = await confRes.json();
    if (!conf || !conf.liffId) {
      throw new Error("LIFF ID が取得できませんでした (/api/liff/config)");
    }

    await liff.init({ liffId: conf.liffId });

    if (!liff.isLoggedIn()) {
      liff.login();
      return; // ログイン後に再読み込みされる想定
    }

    const prof = await liff.getProfile();
    lineUserId   = prof.userId || "";
    lineUserName = prof.displayName || "LINEユーザー";
  }

  // ========== 2) カート読み込み ==========
  function loadCart() {
    // ★ どのキーで保存されているか分からない場合があるので、
    //   よくありそうなキーを順番に試します。
    const candidateKeys = [
      "IS_CART",
      "miniappCart",
      "cart",
      "CART_ITEMS"
    ];

    for (const key of candidateKeys) {
      try {
        const raw = sessionStorage.getItem(key) ?? localStorage.getItem(key);
        if (!raw) continue;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || !arr.length) continue;

        // 正常な配列を見つけたら、それを採用
        console.log("use cart key:", key, arr);
        return arr.map((it) => ({
          id:    String(it.id || ""),
          name:  String(it.name || ""),
          price: Number(it.price || 0),
          qty:   Number(it.qty || 0),
        })).filter((it) => it.id && it.qty > 0);
      } catch (e) {
        console.warn("parse cart error for key:", key, e);
      }
    }

    return [];
  }

  // ========== 3) 商品一覧を confirm に表示 ==========
  function renderItems(items) {
    if (!items || items.length === 0) {
      itemsBox.innerHTML =
        '<div class="row"><span>商品がありません</span><span></span></div>';
      return;
    }

    itemsBox.innerHTML = "";
    items.forEach((it) => {
      const lineTotal = (Number(it.price) || 0) * (Number(it.qty) || 0);
      const row = document.createElement("div");
      const nameSpan = document.createElement("span");
      const qtySpan  = document.createElement("span");
      nameSpan.className = "name";
      qtySpan.className  = "qty";

      nameSpan.textContent = it.name || it.id;
      qtySpan.textContent  = `${it.qty}個 / ${yen(lineTotal)}`;

      row.appendChild(nameSpan);
      row.appendChild(qtySpan);
      itemsBox.appendChild(row);
    });
  }

  // ========== 4) 住所 & 送料計算 ==========
  async function loadAddressAndShipping(items) {
    // ① フロント側で商品合計を必ず計算
    const itemsTotal = items.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );

    // ② 住所取得（/api/liff/address/me）
    let address = null;
    try {
      const addrRes = await fetch(
        `/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`
      );
      const addrJson = await addrRes.json();
      if (addrJson && addrJson.ok && addrJson.address) {
        address = addrJson.address;
      }
    } catch (e) {
      console.warn("address fetch error:", e);
    }

    // ③ 送料計算（/api/shipping）
    let shipping = 0;
    try {
      const shipRes = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((it) => ({
            id: it.id,
            price: Number(it.price) || 0,
            qty: Number(it.qty) || 0,
          })),
          address: address || {},
        }),
      });
      const shipJson = await shipRes.json();
      if (shipJson && shipJson.ok) {
        // サーバから itemsTotal も来るが、画面表示はフロント計算を優先
        shipping = Number(shipJson.shipping || 0);
      } else {
        console.warn("/api/shipping error:", shipJson);
      }
    } catch (e) {
      console.warn("shipping api error:", e);
    }

    const codFee     = 0; // Stripe カード決済なので 0
    const finalTotal = itemsTotal + shipping + codFee;

    // ④ confirm 画面に反映（← ここが「商品合計が反映されない」対策の本体）
    itemsTotalText.textContent = yen(itemsTotal);
    shippingText.textContent   = yen(shipping);
    finalTotalText.textContent = `${yen(finalTotal)}（商品合計 + 送料）`;

    // ⑤ /api/pay-stripe に送るデータ（server.js の Stripe 用エンドポイント）
    orderData = {
      items,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      address,
      lineUserId,
      lineUserName,
      payment: "stripe_card",
      method:  "delivery", // 店頭受取も使うなら条件で切り替え
    };
  }

  // ========== 5) Stripe Checkout 開始 (/api/pay-stripe) ==========
  async function startStripeCheckout() {
    try {
      if (!orderData) {
        alert("注文情報が読み込めていません。もう一度お試しください。");
        return;
      }

      setStatus("Stripe決済ページへ遷移します...", false);
      payButton.disabled = true;

      const res = await fetch("/api/pay-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderData),
      });
      const data = await res.json();

      if (!data || !data.ok || !data.checkoutUrl) {
        console.error("pay-stripe error:", data);
        setStatus("決済の準備に失敗しました。時間をおいて再度お試しください。", true);
        payButton.disabled = false;
        return;
      }

      // Stripe Checkout へリダイレクト
      location.href = data.checkoutUrl;
    } catch (e) {
      console.error("startStripeCheckout error:", e);
      setStatus("決済処理中にエラーが発生しました。時間をおいて再度お試しください。", true);
      payButton.disabled = false;
    }
  }

  // ========== 6) 初期化全体 ==========
  async function init() {
    try {
      setStatus("読み込み中...", false);

      await initLiff();

      const items = loadCart();
      if (!items || items.length === 0) {
        renderItems([]);
        itemsTotalText.textContent = yen(0);
        shippingText.textContent   = yen(0);
        finalTotalText.textContent = yen(0);
        setStatus("カートが空です。ミニアプリから商品を選び直してください。", true);
        payButton.disabled = true;
        return;
      }

      renderItems(items);
      await loadAddressAndShipping(items);

      setStatus(""); // 正常
    } catch (e) {
      console.error("init error:", e);
      setStatus(e.message || "初期化中にエラーが発生しました。時間をおいて再度お試しください。", true);
      payButton.disabled = true;
    }
  }

  // ========== イベント登録 ==========
  payButton.addEventListener("click", startStripeCheckout);
  cancelButton.addEventListener("click", () => {
    if (history.length > 1) {
      history.back();
    } else {
      try {
        if (window.liff && typeof liff.closeWindow === "function") {
          liff.closeWindow();
        }
      } catch (e) {}
    }
  });

  // 実行
  await init();
})();
