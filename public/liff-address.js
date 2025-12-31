"use strict";

/**
 * liff-address.js
 * - LIFFで userId を取得
 * - DBから住所を取得してフォームへ反映（任意）
 * - 保存ボタンで DBへ保存（任意）
 * - orderDraft に address/userId/name を入れて confirm.html へ
 */

const $ = (id) => document.getElementById(id);

const postalEl = $("postal");
const prefEl = $("prefecture");
const cityEl = $("city");
const addr1El = $("address1");
const addr2El = $("address2");
const nameEl = $("name");
const phoneEl = $("phone");

const saveBtn = $("saveBtn");
const backBtn = $("backBtn");
const statusEl = $("statusMsg");

function setStatus(msg = "") { if (statusEl) statusEl.textContent = msg; }
function safeJsonParse(s){ try { return JSON.parse(s); } catch { return null; } }

function readOrder() {
  const keys = ["orderDraft","currentOrder","order","confirm_normalized_order"];
  for (const k of keys) {
    const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
    if (!raw) continue;
    const obj = safeJsonParse(raw);
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}
function saveOrder(order) {
  sessionStorage.setItem("orderDraft", JSON.stringify(order));
  sessionStorage.setItem("order", JSON.stringify(order));
  sessionStorage.setItem("currentOrder", JSON.stringify(order));
  sessionStorage.setItem("confirm_normalized_order", JSON.stringify(order));
  localStorage.setItem("order", JSON.stringify(order));
}

function readForm() {
  return {
    postal: String(postalEl?.value || "").trim(),
    prefecture: String(prefEl?.value || "").trim(),
    city: String(cityEl?.value || "").trim(),
    address1: String(addr1El?.value || "").trim(),
    address2: String(addr2El?.value || "").trim(),
    name: String(nameEl?.value || "").trim(),
    phone: String(phoneEl?.value || "").trim(),
  };
}
function fillForm(a) {
  const x = a || {};
  if (postalEl) postalEl.value = x.postal || "";
  if (prefEl) prefEl.value = x.prefecture || "";
  if (cityEl) cityEl.value = x.city || "";
  if (addr1El) addr1El.value = x.address1 || "";
  if (addr2El) addr2El.value = x.address2 || "";
  if (nameEl) nameEl.value = x.name || "";
  if (phoneEl) phoneEl.value = x.phone || "";
}

async function fetchJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

(async function main() {
  try {
    setStatus("LIFFを初期化しています…");
    const LIFF_ID = (window.LIFF_ID || "2008406620-G5j1gjzM").trim();
    await liff.init({ liffId: LIFF_ID });

    if (!liff.isInClient()) {
      setStatus("LIFF外ブラウザです。LINEアプリ内から開いてください。");
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    const prof = await liff.getProfile();
    const userId = prof?.userId;
    if (!userId) throw new Error("userId を取得できません");

    // DBから既存住所取得（失敗しても続行）
    try {
      const r = await fetchJson("/api/address/get", { userId });
      if (r.address) fillForm(r.address);
    } catch (e) {
      console.warn("[liff-address] address get skipped:", e?.message || e);
    }

    setStatus("");

    if (backBtn) backBtn.addEventListener("click", () => history.back());

    if (saveBtn) saveBtn.addEventListener("click", async () => {
      try {
        saveBtn.disabled = true;
        setStatus("住所を保存しています…");

        const addr = readForm();
        if (!addr.postal || !addr.prefecture || !addr.city || !addr.address1 || !addr.name || !addr.phone) {
          setStatus("必須項目が未入力です。");
          saveBtn.disabled = false;
          return;
        }

        // DBへ保存（失敗しても続行）
        try {
          await fetchJson("/api/address/save", { userId, address: addr });
        } catch (e) {
          console.warn("[liff-address] address save failed (continue):", e?.message || e);
        }

        // orderDraftへ反映（超重要）
        const order = readOrder();
        if (!order) {
          setStatus("注文情報が見つかりません。商品一覧からやり直してください。");
          saveBtn.disabled = false;
          return;
        }

        order.address = addr;
        order.lineUserId = userId;
        order.lineUserName = prof?.displayName || "";

        saveOrder(order);

        setStatus("保存しました。確認画面へ移動します…");
        location.href = "./confirm.html";
      } catch (e) {
        setStatus("エラー:\n" + (e?.message || String(e)));
        if (saveBtn) saveBtn.disabled = false;
      }
    });

  } catch (e) {
    setStatus("初期化エラー:\n" + (e?.message || String(e)));
    if (saveBtn) saveBtn.disabled = true;
  }
})();
