// /public/payment-select.js
// 支払い方法を選んで sessionStorage に保存 → confirm.html へ進む

(function () {
  "use strict";

  const cardBtn   = document.getElementById("cardBtn");
  const codBtn    = document.getElementById("codBtn");
  const backBtn   = document.getElementById("backBtn");
  const statusMsg = document.getElementById("statusMsg");

  function setStatus(msg) {
    if (!statusMsg) return;
    statusMsg.textContent = msg || "";
  }

  function goConfirm(method) {
    try {
      // "card" or "cod" を保存しておく（必要なら confirm.js で参照）
      sessionStorage.setItem("paymentMethod", method);
    } catch (e) {
      console.warn("sessionStorage error:", e);
    }
    // confirm 画面へ
    location.href = "./confirm.html";
  }

  if (cardBtn) {
    cardBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      setStatus("クレジットカード決済を選択しました。確認画面へ進みます…");
      goConfirm("card");
    });
  }

  if (codBtn) {
    codBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      setStatus("代金引換を選択しました。確認画面へ進みます…");
      goConfirm("cod");
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      history.back();
    });
  }
})();
