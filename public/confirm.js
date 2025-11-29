// /public/confirm.js  — Stripe Checkout 版
// - products.js などで保存した「注文内容」を表示
// - 「注文を確定する」ボタンで /api/pay を呼び出し、Stripe Checkout にリダイレクト

(function () {
  "use strict";

  // ==============================
  //  DOM 取得
  // ==============================
  const orderListEl   = document.getElementById("orderList");    // 注文内容を表示する <div> or <ul>
  const totalEl       = document.getElementById("totalAmount");  // 合計金額表示用
  const confirmBtn    = document.getElementById("confirmBtn");   // 「注文を確定する」ボタン
  const backBtn       = document.getElementById("backBtn");      // 「戻る」ボタン（あれば）
  const statusMsgEl   = document.getElementById("statusMsg");    // 状態メッセージ表示（任意）

  // ==============================
  //  注文データの読み込み
  // ==============================
  // ★★ 重要 ★★
  // products.js 側で保存しているキー名に合わせてここを変更してください。
  // 例：
  //   sessionStorage.setItem("orderData", JSON.stringify({ items, totalAmount }));
  //
  // のように保存している場合、STORAGE_KEY = "orderData" にする。
  const STORAGE_KEY = "orderData";

  /**
   * 保存されている注文データを取得
   * 期待する形式:
   * {
   *   items: [
   *     { id, name, unitPrice, quantity },
   *     ...
   *   ],
   *   totalAmount: 1234
   * }
   */
  function loadOrderData() {
    try {
      const raw =
        sessionStorage.getItem(STORAGE_KEY) ||
        localStorage.getItem(STORAGE_KEY);

      if (!raw) return null;

      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return null;

      return {
        items: data.items,
        totalAmount: Number(data.totalAmount || 0),
      };
    } catch (e) {
      console.error("注文データの読込に失敗:", e);
      return null;
    }
  }

  let order = loadOrderData();

  // ==============================
  //  注文内容の描画
  // ==============================
  function renderOrder() {
    if (!order || !order.items.length) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文内容が見つかりません。商品一覧に戻ってやり直してください。</p>";
      }
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    if (orderListEl) {
      orderListEl.innerHTML = "";

      order.items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "order-row";
        row.textContent = `${item.name || "商品"} × ${item.quantity}個  （${item.unitPrice}円／個）`;
        orderListEl.appendChild(row);
      });
    }

    if (totalEl) {
      totalEl.textContent = `${order.totalAmount}円（税込）`;
    }
  }

  // ==============================
  //  ステータス表示ユーティリティ
  // ==============================
  function setStatus(msg) {
    if (!statusMsgEl) return;
    statusMsgEl.textContent = msg || "";
  }

  // ==============================
  //  Stripe 決済開始 (/api/pay)
  // ==============================
  async function startStripeCheckout() {
    if (!order || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    // /api/pay が期待する形式に変換
    const payload = {
      items: order.items.map((it) => ({
        name: it.name || "商品",
        unitPrice: Number(it.unitPrice || it.price || 0), // products.js のプロパティ名に合わせてください
        quantity: Number(it.quantity || 1),
      })),
      totalAmount: Number(order.totalAmount || 0),
    };

    if (!payload.items.length || !payload.totalAmount) {
      alert("注文データに不備があります。商品一覧からやり直してください。");
      return;
    }

    try {
      setStatus("決済を開始しています…");
      if (confirmBtn) confirmBtn.disabled = true;

      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error("決済APIエラー HTTP:", res.status);
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("");
        if (confirmBtn) confirmBtn.disabled = false;
        return;
      }

      const data = await res.json();
      console.log("Stripe /api/pay レスポンス:", data);

      if (!data || !data.ok || !data.url) {
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("");
        if (confirmBtn) confirmBtn.disabled = false;
        return;
      }

      // Stripe Checkout 画面へ遷移
      location.href = data.url;
    } catch (e) {
      console.error("決済開始時の例外:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      setStatus("");
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  // ==============================
  //  イベント設定
  // ==============================
  if (confirmBtn) {
    confirmBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      startStripeCheckout();
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      history.back();
    });
  }

  // ==============================
  //  初期処理
  // ==============================
  renderOrder();
})();
