"use strict";

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
    postal: String(postalEl.value || "").trim(),
    prefecture: String(prefEl.value || "").trim(),
    city: String(cityEl.value || "").trim(),
    address1: String(addr1El.value || "").trim(),
    address2: String(addr2El.value || "").trim(),
    name: String(nameEl.value || "").trim(),
    phone: String(phoneEl.value || "").trim(),
  };
}

function fillForm(a) {
  const x = a || {};
  postalEl.value = x.postal || "";
  prefEl.value = x.prefecture || "";
  cityEl.value = x.city || "";
  addr1El.value = x.address1 || "";
  addr2El.value = x.address2 || "";
  nameEl.value = x.name || "";
  phoneEl.value = x.phone || "";
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
      saveBtn.disabled = true;
      return;
    }
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    const prof = await liff.getProfile();
    const userId = prof?.userId;
    if (!userId) throw new Error("userId を取得できません");

    // 既存住所（DB）読み込み
    try {
      const r = await fetchJson("/api/address/get", { userId });
      if (r.address) {
        fillForm({
          postal: r.address.postal || "",
          prefecture: r.address.prefecture || "",
          city: r.address.city || "",
          address1: r.address.address1 || "",
          address2: r.address.address2 || "",
          name: r.address.name || "",
          phone: r.address.phone || "",
        });
      }
    } catch (e) {
      // DB未設定でも画面は動かす
      console.warn("address get skipped:", e?.message || e);
    }

    setStatus("");

    backBtn.addEventListener("click", () => history.back());

    saveBtn.addEventListener("click", async () => {
      try {
        saveBtn.disabled = true;
        setStatus("住所を保存しています…");

        const addr = readForm();
        if (!addr.postal || !addr.prefecture || !addr.city || !addr.address1 || !addr.name || !addr.phone) {
          setStatus("必須項目が未入力です。");
          saveBtn.disabled = false;
          return;
        }

        // DBへ保存（住所はDBに入ります）
        try {
          await fetchJson("/api/address/save", { userId, address: addr });
        } catch (e) {
          console.warn("address save failed (still continue):", e?.message || e);
        }

        // orderDraftへ反映（ここが今回の超重要ポイント）
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
        saveBtn.disabled = false;
      }
    });

  } catch (e) {
    setStatus("初期化エラー:\n" + (e?.message || String(e)));
    if (saveBtn) saveBtn.disabled = true;
  }
})();
