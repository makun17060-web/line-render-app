// public/liff-address.js

// ★ サーバー（line-render-app-1）のベースURL
//   同じドメインなので相対パスでOK
const API_BASE = "";

// 画面要素
const statusEl   = document.getElementById("statusMsg");
const saveBtn    = document.getElementById("saveBtn");
const backBtn    = document.getElementById("backBtn");

const postalEl     = document.getElementById("postal");
const prefEl       = document.getElementById("prefecture");
const cityEl       = document.getElementById("city");
const addr1El      = document.getElementById("address1");
const addr2El      = document.getElementById("address2");
const nameEl       = document.getElementById("name");
const phoneEl      = document.getElementById("phone");

let currentUserId = "";

function setStatus(msg, isError = true) {
  statusEl.textContent = msg || "";
  statusEl.style.color = isError ? "#d00" : "#0a7b19";
}

async function initLiff() {
  try {
    // 1) サーバーから LIFF ID を取得
    const cfgRes = await fetch("/api/liff/config");
    const cfg = await cfgRes.json();
    const liffId = cfg.liffId;
    if (!liffId) {
      setStatus("LIFF設定が取得できませんでした。（/api/liff/config が空）");
      return;
    }

    // 2) LIFF 初期化
    await liff.init({ liffId });

    // 3) ログインしていなければログイン
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    // 4) プロフィールから userId 取得
    const prof = await liff.getProfile();
    currentUserId = prof.userId;
    console.log("LIFF userId:", currentUserId);

    // 5) 既存住所の取得（あれば）
    await loadExistingAddress();
  } catch (e) {
    console.error("initLiff error:", e);
    setStatus("LIFF初期化中にエラーが発生しました。", true);
  }
}

async function loadExistingAddress() {
  try {
    if (!currentUserId) return;

    const url = `/api/liff/address/me?userId=${encodeURIComponent(
      currentUserId
    )}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("address/me response not ok:", res.status);
      return;
    }
    const data = await res.json();
    if (!data || !data.ok || !data.address) {
      return;
    }

    const a = data.address;

    postalEl.value = a.postal || a.zip || "";
    prefEl.value = a.prefecture || a.pref || "";
    cityEl.value = a.city || "";
    addr1El.value = a.address1 || a.addr1 || "";
    addr2El.value = a.address2 || a.addr2 || "";
    nameEl.value = a.name || "";
    phoneEl.value = a.phone || a.tel || "";

    setStatus("以前保存した住所を読み込みました。必要なら修正して保存してください。", false);
  } catch (e) {
    console.warn("loadExistingAddress error:", e);
  }
}

function collectAddress() {
  const postal = postalEl.value.trim();
  const pref   = prefEl.value.trim();
  const city   = cityEl.value.trim();
  const a1     = addr1El.value.trim();
  const a2     = addr2El.value.trim();
  const name   = nameEl.value.trim();
  const phone  = phoneEl.value.trim();

  return {
    postal,
    prefecture: pref,
    city,
    address1: a1,
    address2: a2,
    name,
    phone,
  };
}

async function saveAddress() {
  try {
    if (!currentUserId) {
      setStatus("LINEユーザー情報が取得できていません。もう一度開き直してください。");
      return;
    }

    const addr = collectAddress();

    if (!addr.postal || !addr.prefecture || !addr.city || !addr.address1) {
      setStatus("郵便番号・都道府県・市区町村・番地は必須です。", true);
      return;
    }
    if (!addr.name) {
      setStatus("お名前を入力してください。", true);
      return;
    }

    saveBtn.disabled = true;
    setStatus("住所を保存中です…", false);

    const res = await fetch(`${API_BASE}/api/liff/address`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: currentUserId,
        address: addr,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) {
      setStatus("住所を保存しました。確認画面に戻ります。", false);

      // 戻り先の指定があれば考慮（例：?from=confirm）
      const params = new URLSearchParams(location.search);
      const from = params.get("from") || "";
      if (from) {
        // 確認画面側で window.history.back() 前提ならそのまま閉じるだけでもOK
        setTimeout(() => {
          liff.closeWindow();
        }, 800);
      } else {
        setTimeout(() => {
          liff.closeWindow();
        }, 800);
      }
    } else {
      setStatus("住所の保存に失敗しました。時間をおいてもう一度お試しください。", true);
    }
  } catch (e) {
    console.error("saveAddress error:", e);
    setStatus("通信エラーで保存できませんでした。電波状況をご確認ください。", true);
  } finally {
    saveBtn.disabled = false;
  }
}

function backToConfirm() {
  // LIFF のウィンドウを閉じて、元の画面（確認画面）に戻す
  liff.closeWindow();
}

// 初期化
document.addEventListener("DOMContentLoaded", () => {
  setStatus("");
  saveBtn.addEventListener("click", saveAddress);
  backBtn.addEventListener("click", backToConfirm);
  initLiff();
});
