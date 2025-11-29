// public/pay.js — Stripe（カード）＋ 送料 ＋ 代引きボタン対応版

(async function () {
  const $ = (id) => document.getElementById(id);

  const itemsBox       = $("itemsBox");
  const itemsTotalText = $("itemsTotalText");
  const shippingText   = $("shippingText");
  const finalTotalText = $("finalTotalText");
  const payButton      = $("payButton");
  const codButton      = $("codButton");
  const cancelButton   = $("cancelButton");
  const statusEl       = $("status");

  let orderData    = null;
  let lineUserId   = "";
  let lineUserName = "";

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
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
      return; // ログイン後に再読み込みされる
    }

    const prof = await liff.getProfile();
    lineUserId   = prof.userId || "";
    lineUserName = prof.displayName || "LINEユーザー";
  }

  // ========== 2) currentOrder から注文読み込み ==========
  function loadCurrentOrder() {
    try {
      const raw = sessionStorage.getItem("currentOrder");
      if (!raw) return { order: null, items: [] };

      const data = JSON.parse(raw);
      const itemsRaw = Array.isArray(data.items) ? data.items : [];

      const items = itemsRaw.map((it) => ({
        id:    String(it.id || ""),
        name:  String(it.name || ""),
        price: Number(it.price || 0),
        qty:   Number(it.qty || 0),
      })).filter((it) => it.id && it.qty > 0);

      return { order: data, items };
    } catch (e) {
      console.error("currentOrder の読み込みエラー:", e);
      return { order: null, items: [] };
    }
  }

  // ========== 3) 商品一覧を描画 ==========
  function renderItems(items) {
    if (!items || items.length === 0) {
      itemsBox.innerHTML =
        '<div style="font-size:13px;color:#666;">商品がありません。</div>';
      return;
    }

    itemsBox.innerHTML = "";
    items.forEach((it) => {
      const lineTotal = (Number(it.price) || 0) * (Number(it.qty) || 0);

      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.fontSize = "13px";
      row.style.marginBottom = "4px";

      const nameSpan = document.createElement("span");
      const qtySpan  = document.createElement("span");

      nameSpan.textContent = it.name || it.id;
      qtySpan.textContent  = `${it.qty}個 / ${yen(lineTotal)}`;

      row.appendChild(nameSpan);
      row.appendChild(qtySpan);
      itemsBox.appendChild(row);
    });
  }

  // ========== 4) 住所 & 送料 & 合計計算 ==========
  async function loadAddressAndShipping(items) {
    // ① 商品合計（フロントで必ず計算）
    const itemsTotal = items.reduce(
      (sum, it) =>
        sum +
        (Number(it.price) || 0) * (Number(it.qty) || 0),
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
        shipping = Number(shipJson.shipping || 0);
      } else {
        console.warn("/api/shipping error:", shipJson);
      }
    } catch (e) {
      console.warn("shipping api error:", e);
    }

    const codFee     = 0; // Stripe用デフォルトでは 0
    const finalTotal = itemsTotal + shipping + codFee;

    // ④ 確認画面へ反映
    itemsTotalText.textContent = yen(itemsTotal);
    shippingText.textContent   = yen(shipping);
    finalTotalText.textContent = `${yen(finalTotal)}（商品合計 + 送料）`;

    // ⑤ サーバに送る注文データ
    orderData = {
      items,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      address,
      lineUserId,
      lineUserName,
      payment: "stripe_card", // デフォルトはカード想定
      method:  "delivery",    // 必要あれば「店頭受取」等に変更可能
    };
  }

  // ========== 5) Stripe Checkout 開始 ==========
  async function startStripeCheckout() {
    try {
      if (!orderData) {
        alert("注文情報が読み込めていません。もう一度お試しください。");
        return;
      }

      setStatus("Stripe決済ページへ遷移します...", false);
      if (payButton) payButton.disabled = true;
      if (codButton) codButton.disabled = true;

      const res = await fetch("/api/pay-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderData),
      });
      const data = await res.json();

      if (!data || !data.ok || !data.checkoutUrl) {
        console.error("pay-stripe error:", data);
        setStatus("決済の準備に失敗しました。時間をおいて再度お試しください。", true);
        if (payButton) payButton.disabled = false;
        if (codButton) codButton.disabled = false;
        return;
      }

      // Stripe Checkout へリダイレクト
      location.href = data.checkoutUrl;
    } catch (e) {
      console.error("startStripeCheckout error:", e);
      setStatus("決済処理中にエラーが発生しました。時間をおいて再度お試しください。", true);
      if (payButton) payButton.disabled = false;
      if (codButton) codButton.disabled = false;
    }
  }

  // ========== 6) 初期化全体 ==========
  async function init() {
    try {
      setStatus("読み込み中...", false);

      await initLiff();

      const { order, items } = loadCurrentOrder();
      console.log("currentOrder:", order, items);

      if (!items || items.length === 0) {
        renderItems([]);
        itemsTotalText.textContent = yen(0);
        shippingText.textContent   = yen(0);
        finalTotalText.textContent = yen(0);
        setStatus("カートが空です。ミニアプリから商品を選び直してください。", true);
        if (payButton) payButton.disabled = true;
        if (codButton) codButton.disabled = true;
        return;
      }

      renderItems(items);
      await loadAddressAndShipping(items);

      setStatus(""); // 正常
    } catch (e) {
      console.error("init error:", e);
      setStatus(
        e.message || "初期化中にエラーが発生しました。時間をおいて再度お試しください。",
        true
      );
      if (payButton) payButton.disabled = true;
      if (codButton) codButton.disabled = true;
    }
  }

  // ========== 7) ボタンイベント ==========
  if (payButton) {
    payButton.addEventListener("click", startStripeCheckout);
  }

  // 代引き（現金）ボタン
  if (codButton) {
    codButton.addEventListener("click", async () => {
      try {
        if (!orderData) {
          alert("注文情報がありません。");
          return;
        }

        // 代引き用に payment 種別だけ変更してサーバへ送信
        const payload = {
          ...orderData,
          payment: "cod",
        };

        const res = await fetch("/api/order/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (!data || !data.ok) {
          console.error("/api/order/complete (cod) error:", data);
          alert("注文確定に失敗しました。時間をおいて再度お試しください。");
          return;
        }

        // 代引き専用の完了画面へ遷移
        location.href = "/public/cod-success.html";
      } catch (e) {
        console.error("cod error:", e);
        alert("エラーが発生しました。時間をおいてお試しください。");
      }
    });
  }

  if (cancelButton) {
    cancelButton.addEventListener("click", () => {
      if (history.length > 1) {
        history.back();
      } else {
        try {
          if (window.liff && typeof liff.closeWindow === "function") {
            liff.closeWindow();
          } else {
            window.close();
          }
        } catch (e) {
          window.close();
        }
      }
    });
  }

  // 実行
  await init();
})();
