// public/pay.js — Stripe専用・送料込み計算版

(async function () {
  const $ = (id) => document.getElementById(id);

  const itemsBox = $("itemsBox");
  const itemsTotalText = $("itemsTotalText");
  const shippingText = $("shippingText");
  const finalTotalText = $("finalTotalText");
  const payBtn = $("payBtn");

  let orderData = null;
  let lineUserId = "";
  let lineUserName = "";

  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }

  // ======================
  // 1) LIFF 初期化
  // ======================
  async function initLiff() {
    const conf = await fetch("/api/liff/config").then((r) => r.json());
    if (!conf?.liffId) throw new Error("LIFF ID が取得できません");

    await liff.init({ liffId: conf.liffId });
    if (!liff.isLoggedIn()) liff.login();

    const prof = await liff.getProfile();
    lineUserId = prof.userId;
    lineUserName = prof.displayName;
  }

  // ======================
  // 2) カート取得（sessionStorage）
  // ======================
  function loadCart() {
    try {
      const raw = sessionStorage.getItem("IS_CART");
      const arr = JSON.parse(raw || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  // ======================
  // 3) 商品表示
  // ======================
  function renderItems(items) {
    itemsBox.innerHTML = items
      .map(
        (it) => `
        <div class="row">
          <span>${it.name} × ${it.qty}</span>
          <span>${yen(it.price * it.qty)}</span>
        </div>`
      )
      .join("");
  }

  // ======================
  // 4) 住所 + 送料計算 取得
  // ======================
  async function loadAddressAndShipping(items) {
    const url = `/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`;
    const addr = await fetch(url).then((r) => r.json());

    const shippingRes = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        address: addr?.address || {},
      }),
    });

    const ship = await shippingRes.json();
    if (!ship.ok) throw new Error("送料計算に失敗しました");

    const itemsTotal = Number(ship.itemsTotal || 0);
    const shipping = Number(ship.shipping || 0);
    const codFee = 0;
    const finalTotal = itemsTotal + shipping + codFee;

    // ---- 表示 ----
    itemsTotalText.textContent = yen(itemsTotal);
    shippingText.textContent = yen(shipping);
    finalTotalText.textContent = `${yen(finalTotal)}（商品合計 + 送料）`;

    orderData = {
      items,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      address: addr?.address || null,
      lineUserId,
      lineUserName,
      payment: "stripe_card",
      method: "delivery",
    };
  }

  // ======================
  // 5) Stripe Checkout 開始
  // ======================
  async function startStripeCheckout() {
    if (!orderData) return alert("注文情報がありません");

    const res = await fetch("/api/pay-stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData),
    });

    const data = await res.json();
    if (!data.ok) {
      alert("Stripe決済の準備に失敗しました");
      console.error(data);
      return;
    }

    // Stripe チェックアウトへ遷移
    location.href = data.checkoutUrl;
  }

  // ======================
  // MAIN
  // ======================
  await initLiff();

  const items = loadCart();
  renderItems(items);

  await loadAddressAndShipping(items);

  payBtn.addEventListener("click", startStripeCheckout);
})();
