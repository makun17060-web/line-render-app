// confirm.js — オンライン注文 共通確認画面（クレジット or 代引き）

(function () {
  "use strict";

  const COD_FEE = 330; // 代引き手数料（画面の表示と合わせる）

  const orderListEl   = document.getElementById("orderList");
  const sumItemsEl    = document.getElementById("sumItems");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumTotalEl    = document.getElementById("sumTotal");
  const cardTotalEl   = document.getElementById("cardTotalText");
  const statusEl      = document.getElementById("statusMsg");

  const cardBtn = document.getElementById("cardBtn");
  const codBtn  = document.getElementById("codBtn");
  const backBtn = document.getElementById("backBtn");

  function setStatus(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
  }

  function yen(n) {
    return (Number(n || 0)).toLocaleString("ja-JP") + "円";
  }

  function renderOrderList(items) {
    if (!orderListEl) return;
    if (!items || !items.length) {
      orderListEl.innerHTML = "<p class=\"order-row\">カートに商品がありません。</p>";
      return;
    }

    orderListEl.innerHTML = items
      .map(it => {
        const name = it.name || it.id || "商品";
        const qty  = Number(it.qty || 0);
        const price = Number(it.price || 0);
        const rowTotal = price * qty;
        return (
          `<div class="order-row">` +
            `${name} × ${qty}個 = ${yen(rowTotal)}` +
          `</div>`
        );
      })
      .join("");
  }

  // sessionStorage から orderDraft を読み込む
  function loadOrderDraft() {
    try {
      const raw = sessionStorage.getItem("orderDraft");
      if (!raw) return null;
      const draft = JSON.parse(raw);
      if (!draft || !Array.isArray(draft.items)) return null;
      return draft;
    } catch (e) {
      console.warn("orderDraft parse error:", e);
      return null;
    }
  }

  // /api/shipping で送料と合計を計算
  async function calcShipping(items, address) {
    try {
      const payload = {
        items: (items || []).map(it => ({
          id:    it.id,
          price: Number(it.price || 0),
          qty:   Number(it.qty || 0),
        })),
        address: {
          prefecture: address?.prefecture || "",
          addr1:      address?.address1   || "",
        },
      };

      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        console.warn("/api/shipping response NG:", data);
        return {
          itemsTotal: (items || []).reduce(
            (s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)),
            0
          ),
          region: "",
          shipping: 0,
          finalTotal: 0,
        };
      }

      return {
        itemsTotal: Number(data.itemsTotal || 0),
        region:     data.region || "",
        shipping:   Number(data.shipping || 0),
        finalTotal: Number(data.finalTotal || 0),
      };
    } catch (e) {
      console.error("/api/shipping error:", e);
      // 通信失敗時は送料0円で計算だけして返す
      const itemsTotal = (items || []).reduce(
        (s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)),
        0
      );
      return {
        itemsTotal,
        region: "",
        shipping: 0,
        finalTotal: itemsTotal,
      };
    }
  }

  async function init() {
    setStatus("注文情報を読み込んでいます…");

    const draft = loadOrderDraft();
    if (!draft) {
      setStatus("注文情報が見つかりません。最初からやり直してください。");
      if (cardBtn) cardBtn.disabled = true;
      if (codBtn)  codBtn.disabled  = true;
      return;
    }

    const items   = draft.items || [];
    const address = draft.address || null;

    renderOrderList(items);

    // サーバーで送料計算
    const ship = await calcShipping(items, address);
    const itemsTotal = ship.itemsTotal;
    const shipping   = ship.shipping;
    const cardTotal  = itemsTotal + shipping;
    const codTotal   = cardTotal + COD_FEE;

    // 金額を画面に反映
    if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
    if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
    if (sumTotalEl)    sumTotalEl.textContent    = yen(codTotal);
    if (cardTotalEl)   cardTotalEl.textContent   = yen(cardTotal);

    // confirm-card / confirm-cod で再利用できるように保存
    const summary = {
      items,
      address,
      lineUserId:   draft.lineUserId   || "",
      lineUserName: draft.lineUserName || "",
      itemsTotal,
      shipping,
      region: ship.region || "",
      codFee: COD_FEE,
      cardTotal,
      codTotal,
    };
    sessionStorage.setItem("orderSummary", JSON.stringify(summary));

    setStatus("お支払い方法を選択してください。");
  }

  // ========= イベント =========
  document.addEventListener("DOMContentLoaded", () => {
    init();

    if (cardBtn) {
      cardBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        // クレジット明細画面へ
        window.location.href = "./confirm-card.html" + (window.location.search || "");
      });
    }

    if (codBtn) {
      codBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        // 代引き明細画面へ
        window.location.href = "./confirm-cod.html" + (window.location.search || "");
      });
    }

    if (backBtn) {
      backBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        // 商品一覧に戻す（お好みで history.back() でもOK）
        window.location.href = "./products.html";
      });
    }
  });
})();
