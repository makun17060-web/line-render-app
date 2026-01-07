/**
 * confirm.js — 注文最終確認（代引き/クレジット分離UI対応・堅牢版）
 *
 * ✅ 対象HTML（例）
 * - buttons: #cardBtn #codBtn #backBtn
 * - totals : #subtotal #codFee #totalCod #totalCard（ある場合）
 * - optional split view:
 *   #subtotal2 #shipping2 #subtotal3 #shipping3 #totalCard #totalCod
 *
 * ✅ API
 * - POST /api/order/quote
 * - POST /api/pay/stripe/create
 * - POST /api/order/cod/create
 *
 * ✅ localStorage
 * - isoya_userId
 * - isoya_cart / isoya_cart_original / isoya_cart_fukubako
 */

(function () {
  "use strict";

  // =========================
  // 設定
  // =========================
  const API_QUOTE = "/api/order/quote";
  const API_STRIPE = "/api/pay/stripe/create";
  const API_COD = "/api/order/cod/create";

  const KEY_UID = "isoya_userId";
  const KEY_LAST = "isoya_last_order";

  // =========================
  // util
  // =========================
  function $(id) { return document.getElementById(id); }

  function safeJsonParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  function loadJson(key) {
    const v = localStorage.getItem(key);
    if (!v) return null;
    return safeJsonParse(v);
  }

  function yen(n) {
    return (Number(n) || 0).toLocaleString("ja-JP") + "円";
  }

  function setDisabled(btn, disabled, text) {
    if (!btn) return;
    btn.disabled = disabled;
    btn.style.pointerEvents = disabled ? "none" : "auto";
    if (text) btn.textContent = text;
  }

  function setBusy(disabled) {
    const codBtn = $("codBtn");
    const cardBtn = $("cardBtn");
    if (codBtn) setDisabled(codBtn, disabled, disabled ? "確定中…" : "代引きで注文確定");
    if (cardBtn) setDisabled(cardBtn, disabled, disabled ? "移動中…" : "クレジットで支払う");
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function getMode() {
    const qs = new URLSearchParams(location.search);
    return (qs.get("mode") || "").trim(); // "", "original", "fukubako"
  }

  function resolveCartKey(mode) {
    if (mode === "original") return "isoya_cart_original";
    if (mode === "fukubako") return "isoya_cart_fukubako";
    return "isoya_cart";
  }

  function resolveBackTo(mode) {
    if (mode === "original") return "/original-set.html";
    if (mode === "fukubako") return "/fukubako.html";
    return "/products.html";
  }

  function ensureUidSoft() {
    // ✅ confirm.js は “落ちない” が優先：localStorage から取れるだけ取る
    const v1 = (localStorage.getItem(KEY_UID) || "").trim();
    if (v1) return v1;

    // 過去互換
    const v2 = (localStorage.getItem("userId") || "").trim();
    if (v2) return v2;

    return "";
  }

  function normalizeItems(cart) {
    const itemsRaw = Array.isArray(cart?.items) ? cart.items : [];
    return itemsRaw
      .map(it => ({
        id: (it?.id || "").trim(),
        qty: Number(it?.qty || 0),
      }))
      .filter(it => it.id && it.qty > 0);
  }

  function detectCovering(btn) {
    try {
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (el && el !== btn && !btn.contains(el)) {
        console.warn("[confirm.js] something covers button:", btn.id, el);
      }
    } catch {}
  }

  function fillTextIfExists(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  // =========================
  // main
  // =========================
  document.addEventListener("DOMContentLoaded", async () => {
    console.log("[confirm.js] loaded");

    const mode = getMode();
    const KEY_CART = resolveCartKey(mode);
    const backTo = resolveBackTo(mode);

    const backBtn = $("backBtn");
    const cardBtn = $("cardBtn");
    const codBtn = $("codBtn");

    if (backBtn) backBtn.addEventListener("click", () => location.href = backTo);

    // ボタンが存在しない場合も落とさない
    if (codBtn) {
      codBtn.addEventListener("pointerdown", () => detectCovering(codBtn));
    }
    if (cardBtn) {
      cardBtn.addEventListener("pointerdown", () => detectCovering(cardBtn));
    }

    // 必須情報
    const uid = ensureUidSoft();
    const cart = loadJson(KEY_CART) || { items: [] };
    const items = normalizeItems(cart);

    if (!uid) {
      alert("ユーザー情報が取得できません。いったん商品ページから開き直してください。");
      location.href = backTo;
      return;
    }
    if (items.length === 0) {
      alert("カートが空です。商品選択へ戻ります。");
      location.href = backTo;
      return;
    }

    // まず見積り（送料/手数料）
    try {
      fillTextIfExists("shipping", "計算中…");
      fillTextIfExists("codFee", "計算中…");
      fillTextIfExists("totalCod", "計算中…");
      fillTextIfExists("totalCard", "計算中…");

      // split UI も計算中に
      fillTextIfExists("subtotal2", "計算中…");
      fillTextIfExists("shipping2", "計算中…");
      fillTextIfExists("subtotal3", "計算中…");
      fillTextIfExists("shipping3", "計算中…");

      const quote = await postJson(API_QUOTE, { uid, checkout: { items } });

      const shippingFee = Number(quote.shippingFee || 0);
      const codFee = Number(quote.codFee || 0);
      const totalCod = Number(quote.totalCod || 0);
      const totalCard = totalCod - codFee;

      // subtotalはHTML側が計算済みの想定もあるので、あれば流用して splitへコピー
      const subtotalText = $("subtotal") ? $("subtotal").textContent : "";

      // 通常表示（存在すれば）
      fillTextIfExists("shipping", `${yen(shippingFee)}（ヤマト ${quote.size || ""}サイズ）`);
      fillTextIfExists("codFee", yen(codFee));
      fillTextIfExists("totalCod", yen(totalCod));
      if ($("totalCard")) fillTextIfExists("totalCard", yen(totalCard));

      // split表示（存在すれば）
      if ($("subtotal2")) fillTextIfExists("subtotal2", subtotalText || "—");
      if ($("shipping2")) fillTextIfExists("shipping2", `${yen(shippingFee)}（ヤマト ${quote.size || ""}サイズ）`);
      if ($("subtotal3")) fillTextIfExists("subtotal3", subtotalText || "—");
      if ($("shipping3")) fillTextIfExists("shipping3", `${yen(shippingFee)}（ヤマト ${quote.size || ""}サイズ）`);

    } catch (e) {
      console.error("[confirm.js] quote failed:", e);
      // 見積り失敗でも「確定」は試せるので、ここでは止めない
      fillTextIfExists("shipping", "—");
      fillTextIfExists("codFee", "—");
      fillTextIfExists("totalCod", "—");
      if ($("totalCard")) fillTextIfExists("totalCard", "—");
    }

    // =========================
    // クレジット：Stripeへ
    // =========================
    if (cardBtn) {
      cardBtn.addEventListener("click", async () => {
        setBusy(true);
        try {
          const data = await postJson(API_STRIPE, { uid, checkout: { items } });
          if (!data?.url) throw new Error("stripe url missing");
          // ✅ Stripeへ
          window.location.href = data.url;
        } catch (e) {
          console.error("[confirm.js] stripe create failed:", e);
          alert("クレジット決済の開始に失敗しました: " + (e?.message || e));
          setBusy(false);
        }
      });
    }

    // =========================
    // 代引：確定 → 完了へ
    // =========================
    if (codBtn) {
      codBtn.addEventListener("click", async () => {
        setBusy(true);
        try {
          const data = await postJson(API_COD, { uid, checkout: { items } });

          // ✅ 確定情報を保存（完了ページなどで使える）
          localStorage.setItem(KEY_LAST, JSON.stringify({
            orderId: data.orderId || "",
            createdAt: new Date().toISOString(),
            subtotal: data.subtotal,
            shippingFee: data.shippingFee,
            codFee: data.codFee,
            total: data.totalCod,
            mode,
          }));

          // ✅ このconfirmで使っているカートだけ空にする
          localStorage.setItem(KEY_CART, JSON.stringify({ items: [] }));

          // ✅ 完了へ
          window.location.href = `/complete.html?method=cod&orderId=${encodeURIComponent(data.orderId || "")}`;
        } catch (e) {
          console.error("[confirm.js] cod create failed:", e);

          let msg = "代引き注文の確定に失敗しました。";
          const m = String(e?.message || "");

          if (m.includes("NO_UID")) msg = "ユーザー情報が取得できません。";
          if (m.includes("EMPTY_ITEMS")) msg = "商品が選択されていません。";
          if (m.includes("NO_ADDRESS")) msg = "住所が未登録です。住所入力へ戻ってください。";
          if (m.includes("HTTP 400")) msg = "入力内容に不備があります（住所・商品・送料設定を確認）。";
          if (m.includes("HTTP 500")) msg = "サーバーエラーです（DB/送料テーブル/ログを確認）。";

          alert(msg);
          setBusy(false);
        }
      });
    }
  });

})();
