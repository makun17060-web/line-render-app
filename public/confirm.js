/**
 * confirm.js — 注文最終確認（代引き対応・堅牢版）
 * 対象HTML:
 *  - confirm.html
 * 必須要素:
 *  - <button id="codBtn" type="button">代引きで注文確定</button>
 *  - <script src="/public/js/confirm.js"></script>
 */

(function () {
  "use strict";

  console.log("[confirm.js] loaded");

  // ==========
  // 設定
  // ==========
  const API_COD = "/api/order/cod/create";
  const REDIRECT_FALLBACK = "/confirm-cod.html";

  // localStorage のキー（あなたの既存実装に合わせて）
  const KEY_UID   = "isoya_userId";   // なければ userId も見る
  const KEY_CART  = "isoya_cart";     // { items:[{id,qty,...}] }
  const KEY_LAST  = "isoya_last_order";

  // ==========
  // util
  // ==========
  function $(id) {
    return document.getElementById(id);
  }

  function loadJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "");
    } catch {
      return null;
    }
  }

  function setDisabled(btn, disabled, text) {
    if (!btn) return;
    btn.disabled = disabled;
    btn.style.pointerEvents = disabled ? "none" : "auto";
    if (text) btn.textContent = text;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }

  // ==========
  // メイン
  // ==========
  document.addEventListener("DOMContentLoaded", () => {
    const codBtn = $("codBtn");

    if (!codBtn) {
      console.warn("[confirm.js] #codBtn not found");
      return;
    }

    // 「押せない」原因調査用（被さり検出）
    codBtn.addEventListener("pointerdown", () => {
      const r = codBtn.getBoundingClientRect();
      const el = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2
      );
      if (el && el !== codBtn && !codBtn.contains(el)) {
        console.warn("[confirm.js] something covers codBtn:", el);
      }
    });

    codBtn.addEventListener("click", async () => {
      setDisabled(codBtn, true, "確定中...");

      try {
        // ==========
        // ユーザーID
        // ==========
        const uid =
          loadJson(KEY_UID) ||
          localStorage.getItem(KEY_UID) ||
          localStorage.getItem("userId") ||
          "";

        if (!uid) {
          throw new Error("NO_UID");
        }

        // ==========
        // カート
        // ==========
        const cart = loadJson(KEY_CART);
        const itemsRaw = cart?.items || [];

        const items = itemsRaw
          .map(it => ({
            id: it.id,
            qty: Number(it.qty || 0),
          }))
          .filter(it => it.id && it.qty > 0);

        if (items.length === 0) {
          throw new Error("EMPTY_ITEMS");
        }

        // ==========
        // サーバーへ確定
        // ==========
        const data = await postJson(API_COD, {
          uid,
          checkout: { items },
        });

        // ==========
        // 確定情報を保存（confirm-cod.html で使う）
        // ==========
        localStorage.setItem(
          KEY_LAST,
          JSON.stringify({
            orderId: data.orderId,
            createdAt: new Date().toISOString(),
            subtotal: data.subtotal,
            shippingFee: data.shippingFee,
            codFee: data.codFee,
            total: data.totalCod,
          })
        );

        // ==========
        // 遷移
        // ==========
        const url =
          `${REDIRECT_FALLBACK}?orderId=` +
          encodeURIComponent(data.orderId || "");

        window.location.href = url;

      } catch (err) {
        console.error("[confirm.js] error:", err);

        let msg = "代引き注文の確定に失敗しました。";
        if (err.message === "NO_UID") msg = "ユーザー情報が取得できません。";
        if (err.message === "EMPTY_ITEMS") msg = "商品が選択されていません。";
        if (err.message === "NO_ADDRESS") msg = "住所が未登録です。";

        alert(msg);

        setDisabled(codBtn, false, "代引きで注文確定");
      }
    });
  });
})();
