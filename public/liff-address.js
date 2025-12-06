// liff-address.js

(function () {
  const statusEl = document.getElementById("statusMsg");
  const saveBtn = document.getElementById("saveBtn");
  const backBtn = document.getElementById("backBtn");

  let currentUserId = "";
  let liffInited = false;

  function setStatus(msg, opts = {}) {
    statusEl.textContent = msg || "";
    statusEl.style.color = opts.error ? "#d00" : "#333";
  }

  function getVal(id) {
    return (document.getElementById(id)?.value || "").trim();
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v || "";
  }

  function normalizePhone(raw) {
    return String(raw || "").replace(/[^\d]/g, ""); // 数字以外削除
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function initLiff() {
    try {
      setStatus("初期化中です…");

      // 1) サーバーから LIFF ID を取得
      const { res: cfgRes, data: cfg } = await fetchJson("/api/liff/config");
      if (!cfgRes.ok || !cfg?.liffId) {
        setStatus("LIFF設定が取得できませんでした。", { error: true });
        console.error("/api/liff/config error:", cfgRes.status, cfg);
        return;
      }

      const liffId = cfg.liffId;
      console.log("[liff-address] liffId =", liffId);

      // 2) LIFF 初期化
      await liff.init({ liffId });
      liffInited = true;

      if (!liff.isLoggedIn()) {
        // LINE アプリ内ならログイン画面へ遷移
        liff.login();
        return;
      }

      // 3) プロフィールから userId 取得
      const prof = await liff.getProfile();
      currentUserId = prof.userId;
      console.log("[liff-address] userId =", currentUserId);

      if (!currentUserId) {
        setStatus(
          "LINEユーザー情報が取得できませんでした。トークルームから開き直してください。",
          { error: true }
        );
        return;
      }

      // 4) 既存の住所があれば読み込み
      await loadExistingAddress(currentUserId);

      setStatus(
        "お届け先情報を入力して「住所を保存して確認画面へ」を押してください。"
      );
    } catch (e) {
      console.error("initLiff error:", e);
      setStatus("初期化中にエラーが発生しました。時間をおいて再度お試しください。", {
        error: true,
      });
    }
  }

  async function loadExistingAddress(userId) {
    try {
      const url = `/api/liff/address/me?userId=${encodeURIComponent(userId)}`;
      const { res, data } = await fetchJson(url);

      if (!res.ok || !data?.ok) {
        console.warn("/api/liff/address/me error:", res.status, data);
        return;
      }

      const addr = data.address || null;
      if (!addr) return;

      // server.js 側のキー:
      // name, phone, postal, prefecture, city, address1, address2
      setVal("postal", addr.postal || "");
      setVal("prefecture", addr.prefecture || "");
      setVal("city", addr.city || "");
      setVal("address1", addr.address1 || "");
      setVal("address2", addr.address2 || "");
      setVal("name", addr.name || "");
      setVal("phone", addr.phone || "");

      setStatus("登録済みの住所を読み込みました。必要に応じて修正してください。");
    } catch (e) {
      console.warn("loadExistingAddress error:", e);
      // 住所が読めないだけなら致命的ではないので、ステータスだけ軽く表示
      setStatus("住所の読み込みに失敗しました。入力して保存してください。");
    }
  }

  function validate() {
    const postal = getVal("postal");
    const prefecture = getVal("prefecture");
    const city = getVal("city");
    const address1 = getVal("address1");
    const name = getVal("name");
    const phoneRaw = getVal("phone");
    const phone = normalizePhone(phoneRaw);

    if (!postal) {
      return { ok: false, msg: "郵便番号を入力してください。" };
    }
    if (!prefecture) {
      return { ok: false, msg: "都道府県を入力してください。" };
    }
    if (!city) {
      return { ok: false, msg: "市区町村を入力してください。" };
    }
    if (!address1) {
      return { ok: false, msg: "番地・建物名を入力してください。" };
    }
    if (!name) {
      return { ok: false, msg: "お名前を入力してください。" };
    }
    if (!phone) {
      return { ok: false, msg: "電話番号を入力してください。" };
    }
    if (!/^\d{9,11}$/.test(phone)) {
      return {
        ok: false,
        msg: "電話番号は数字のみ9〜11桁で入力してください。（ハイフンは不要です）",
      };
    }

    return {
      ok: true,
      address: {
        postal,
        prefecture,
        city,
        address1,
        address2: getVal("address2"),
        name,
        phone,
      },
    };
  }

  async function handleSave() {
    try {
      if (!currentUserId) {
        setStatus(
          "LINEユーザー情報が取得できていません。トークルームからもう一度開き直してください。",
          { error: true }
        );
        return;
      }

      const v = validate();
      if (!v.ok) {
        setStatus(v.msg, { error: true });
        return;
      }

      saveBtn.disabled = true;
      setStatus("住所を保存しています…");

      // server.js の /api/liff/address 仕様に合わせる
      const payload = {
        userId: currentUserId,
        address: v.address,
      };

      const { res, data } = await fetchJson("/api/liff/address", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok || !data?.ok) {
        const msg =
          (data && data.error) ||
          `サーバーエラー（${res.status}）が発生しました。`;
        setStatus("住所の保存に失敗しました：" + msg, { error: true });
        return;
      }

      setStatus("住所を保存しました。確認画面に戻ります。");

      // 少し待ってから LIFF を閉じる
      setTimeout(() => {
        if (window.liff && liffInited && liff.isInClient()) {
          liff.closeWindow();
        } else {
          // ブラウザで直接開いている場合は戻る
          if (history.length > 1) {
            history.back();
          } else {
            // どうしても戻れない場合は何もしない
          }
        }
      }, 600);
    } catch (e) {
      console.error("handleSave error:", e);
      setStatus("通信エラーが発生しました。電波状況をご確認のうえ再度お試しください。", {
        error: true,
      });
    } finally {
      saveBtn.disabled = false;
    }
  }

  function handleBack() {
    if (window.liff && liffInited && liff.isInClient()) {
      liff.closeWindow();
    } else {
      if (history.length > 1) {
        history.back();
      }
    }
  }

  // イベント登録
  saveBtn.addEventListener("click", handleSave);
  backBtn.addEventListener("click", handleBack);

  // DOM 準備後に初期化
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLiff);
  } else {
    initLiff();
  }
})();
