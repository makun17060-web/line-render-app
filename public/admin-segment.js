(async function () {

  const $ = (id) => document.getElementById(id);
  const logEl = $("log");

  const log = (m) => {
    const t = new Date().toLocaleString();
    logEl.textContent = `[${t}] ${m}\n` + logEl.textContent;
  };

  // --- タブ切替
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const name = tab.dataset.tab;
      $("tab-seg").classList.toggle("hide", name !== "seg");
      $("tab-manual").classList.toggle("hide", name !== "manual");
    });
  });

  // --- メッセージ形式切替（セグメント）
  $("messageType").addEventListener("change", () => {
    const isFlex = $("messageType").value === "flex";
    $("textAreaWrap").classList.toggle("hide", isFlex);
    $("flexAreaWrap").classList.toggle("hide", !isFlex);
  });

  // --- メッセージ形式切替（手動）
  $("manualMessageType").addEventListener("change", () => {
    const isFlex = $("manualMessageType").value === "flex";
    $("manualTextWrap").classList.toggle("hide", isFlex);
    $("manualFlexWrap").classList.toggle("hide", !isFlex);
  });

  // -------- API base URL
  const api = (path) => {
    const base = ($("apiBase").value || "").trim();
    return base ? base.replace(/\/$/, "") + path : path;
  };

  // -------- ENDPOINTS（あなたの server.js と完全一致）
  const ENDPOINTS = {
    preview: "/api/admin/segment/preview",
    sendText: "/api/admin/segment/send",
    sendFlex: "/api/admin/segment/send-flex",
  };

  // -------- token付与
  const withToken = (path) => {
    const tok = $("adminToken").value.trim();
    return api(path) + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
  };

  // -------- UI選択 → server.js の type に変換
  function uiSegmentToType(v) {
    switch (v) {
      case "all": return "addresses";
      case "text_senders": return "textSenders";
      case "purchasers": return "orders";
      case "reservations": return "orders";
      case "roulette_winners": return "survey";
      default: return v || "orders";
    }
  }

  // -------- 日付変換
  function ymd(val) {
    return val ? val.replaceAll("-", "") : "";
  }

  // ============================
  //  ★ 対象数プレビュー
  // ============================
  $("previewBtn").addEventListener("click", async () => {

    const tok = $("adminToken").value.trim();
    if (!tok) {
      alert("管理トークンを入力してください");
      return;
    }

    const type = uiSegmentToType($("segmentType").value);
    const payload = { type, limit: 50000 };

    const from = ymd($("fromDate").value);
    if (from) payload.date = from;

    log("preview start: " + JSON.stringify(payload));

    try {
      const res = await fetch(withToken(ENDPOINTS.preview), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        log("preview NG: " + res.status + " " + JSON.stringify(data));
        alert("対象数プレビューに失敗しました。");
        return;
      }

      const count = data.total ?? (data.userIds?.length ?? "?");
      $("previewResult").innerHTML = `対象数：${count}人`;
      log("preview OK: " + JSON.stringify({ type: data.type, total: count }));

    } catch (e) {
      log("preview ERR: " + e);
      alert("通信エラー。URL を確認してください。");
    }
  });


  // ============================
  // ★ セグメント送信
  // ============================
  $("sendBtn").addEventListener("click", () => sendSegment(false));
  $("dryRunBtn").addEventListener("click", () => sendSegment(true));

  async function sendSegment(dryRun) {

    const tok = $("adminToken").value.trim();
    if (!tok) {
      alert("管理トークンを入力してください");
      return;
    }

    const type = uiSegmentToType($("segmentType").value);
    const payloadPreview = { type, limit: 50000 };

    const from = ymd($("fromDate").value);
    if (from) payloadPreview.date = from;

    log("send step1 preview: " + JSON.stringify(payloadPreview));

    // ---- preview first
    let preview;
    try {
      const pres = await fetch(withToken(ENDPOINTS.preview), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadPreview)
      });
      preview = await pres.json().catch(() => null);
      if (!pres.ok || !preview?.ok) throw new Error("preview_failed");
    } catch (e) {
      log("send preview ERR: " + e);
      alert("対象抽出に失敗しました。");
      return;
    }

    const userIds = Array.isArray(preview.userIds) ? preview.userIds : [];
    if (userIds.length === 0) {
      alert("対象0人です。");
      return;
    }

    // ---- dry-run only
    if (dryRun) {
      log(`dry-run. targets=${userIds.length}`);
      alert(`dry-run：対象 ${userIds.length}人（配信していません）`);
      return;
    }

    // ---- messageType
    const mt = $("messageType").value;

    // ---- text
    if (mt === "text") {
      const msg = $("textMessage").value.trim();
      if (!msg) {
        alert("テキストを入力してください");
        return;
      }

      const payloadSend = { userIds, message: msg };
      log("send text start: " + userIds.length);

      try {
        const res = await fetch(withToken(ENDPOINTS.sendText), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadSend)
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          log("send text NG: " + JSON.stringify(data));
          alert("テキスト送信に失敗しました");
          return;
        }

        log("send text OK: " + JSON.stringify(data));
        alert(`送信OK！ 対象:${data.requested} / 送信:${data.sent}`);

      } catch (e) {
        log("send text ERR: " + e);
        alert("通信エラー");
      }
      return;
    }

    // ---- Flex
    const raw = $("flexJson").value.trim();
    if (!raw) {
      alert("Flex JSON を入力してください");
      return;
    }

    let flex;
    try {
      flex = JSON.parse(raw);
    } catch {
      alert("Flex JSON が不正です");
      return;
    }

    const altText = flex.altText || flex.alt || "お知らせ";
    const contents = flex.contents;
    if (!contents) {
      alert("Flex JSON に contents が必要です");
      return;
    }

    const payloadSendFlex = { userIds, altText, contents };
    log("send flex start: " + userIds.length);

    try {
      const res = await fetch(withToken(ENDPOINTS.sendFlex), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadSendFlex)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        log("send flex NG: " + JSON.stringify(data));
        alert("Flex送信に失敗しました");
        return;
      }

      log("send flex OK: " + JSON.stringify(data));
      alert(`Flex送信OK！ 対象:${data.requested} / 送信:${data.sent}`);

    } catch (e) {
      log("send flex ERR: " + e);
      alert("通信エラー");
    }
  }

  log("admin-segment loaded.");

})();
