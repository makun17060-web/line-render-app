// public/pay.js
// pay.html：注文データ表示（商品合計/送料/合計）→ /api/pay → Epsilonへ遷移

(function () {
  const STORAGE_KEY = "isoya_order_v1";

  const itemsEl     = document.getElementById("payItemsArea");
  const itemsTotEl  = document.getElementById("payItemsTotal");
  const shipEl      = document.getElementById("payShipping");
  const finalEl     = document.getElementById("payFinalTotal");
  const payBtn      = document.getElementById("payBtn");
  const backBtn     = document.getElementById("backToConfirmBtn");
  const statusEl    = document.getElementById("payStatusMsg");

  if (!itemsEl || !itemsTotEl || !shipEl || !finalEl || !payBtn || !backBtn || !statusEl) {
    console.warn("pay.html の要素が見つかりません。pay.html を丸ごと版に差し替えてください。");
    return;
  }

  function loadOrder() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }

  function yen(n) {
    const num = Number(n || 0);
    return num.toLocaleString("ja-JP") + "円";
  }

  function calcItemsTotal(items = []) {
    return items.reduce(
      (sum, it) => sum + Number(it.price || 0) * Number(it.qty || 0),
      0
    );
  }

  async function startPayment(payload) {
    const res = await fetch("/api/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data || !data.ok || !data.redirectUrl) {
      throw new Error(data?.error || "payment_start_failed");
    }
    return data.redirectUrl;
  }

  // ====== 注文データ読み込み ======
  const order = loadOrder();
  const items = Array.isArray(order.items) ? order.items : [];
  const shipping = Number(order.shipping || 0);
  const itemsTotal = calcItemsTotal(items);
  const finalTotal = Number(order.finalTotal || (itemsTotal + shipping));

  // ====== 画面描画 ======
  if (!items.length) {
    itemsEl.innerHTML = "<div class='empty'>商品が選択されていません。</div>";
    payBtn.disabled = true;
  } else {
    itemsEl.innerHTML = items.map(it => `
      <div class="row">
        <div class="name">${it.name || ""}</div>
        <div class="qty">× ${it.qty || 0}</div>
        <div class="price">${yen((it.price||0)*(it.qty||0))}</div>
      </div>
    `).join("");
  }

  itemsTotEl.textContent = yen(itemsTotal);
  shipEl.textContent = yen(shipping);
  finalEl.textContent = yen(finalTotal);

  // ====== ボタン ======
  backBtn.addEventListener("click", () => {
    location.href = `${location.origin}/public/confirm.html?v=${Date.now()}`;
  });

  payBtn.addEventListener("click", async () => {
    if (!items.length || finalTotal <= 0) return;

    payBtn.disabled = true;
    statusEl.textContent = "Epsilon決済ページへ移動しています…";

    try {
      const payload = {
        items: items.map(it => ({
          id: it.id,
          name: it.name,
          price: Number(it.price || 0),
          qty: Number(it.qty || 0),
        })),
        total: finalTotal,

        // LINE情報（ない場合は空でOK）
        lineUserId: order.lineUserId || "",
        lineUserName: order.lineUserName || "",

        // 参考用（サーバー側は無視してOK）
        address: order.address || {},
        shipping,
      };

      const redirectUrl = await startPayment(payload);
      statusEl.textContent = "決済ページへ移動します…";
      location.href = redirectUrl;

    } catch (e) {
      console.error("決済開始エラー:", e);
      statusEl.textContent =
        "決済開始に失敗しました。もう一度お試しください。\n" +
        (e?.message || "");
      payBtn.disabled = false;
    }
  });
})();
