// admin_segment.js — 丸ごと版（server-line.js の /api/admin/segment/users + /api/admin/push/segment 対応）
// - source: active / chat / liff / all
// - token: Bearer ヘッダ
// - HTMLの要素IDが不足していても落とさず警告表示で終了
(() => {
  const byId = (id) => document.getElementById(id);

  function showMissing(missing) {
    const box = byId("toast");
    if (!box) return;
    box.style.display = "block";
    box.className = "toast warn";
    box.textContent =
      "管理画面のHTMLとJSが一致していません。不足ID: " +
      missing.join(", ") +
      "（admin_segment.html を最新版に差し替えてください）";
  }

  function init() {
    // ===== 必須要素 =====
    // ※HTML側は「kind」をsourceセレクトとして使う運用（idはそのまま kind）
    const idsMust = [
      "token",
      "saveToken",
      "clearToken",
      "kind", // source セレクトに使う（active/chat/liff/all）
      "days",
      "fetchSegment",
      "segmentStat",
      "msgType",
      "msgText",
      "dryRun",
      "sendPush",
      "toast",
      "tbody",
      "count",
      "kindEcho",
      "daysEcho",
      "copyAll",
      "downloadCsv",
    ];

    const missing = idsMust.filter((id) => !byId(id));
    if (missing.length) {
      console.error("Missing elements:", missing);
      showMissing(missing);
      return; // ★落とさず終了
    }

    // ===== DOM =====
    const tokenEl = byId("token");
    const saveTokenBtn = byId("saveToken");
    const clearTokenBtn = byId("clearToken");

    const sourceEl = byId("kind"); // ← idは kind だが中身は source
    const daysEl = byId("days");
    const fetchBtn = byId("fetchSegment");
    const segmentStat = byId("segmentStat");

    const msgTypeEl = byId("msgType");
    const msgTextEl = byId("msgText");

    const dryRunBtn = byId("dryRun");
    const sendBtn = byId("sendPush");

    const toast = byId("toast");

    const tbody = byId("tbody");
    const countEl = byId("count");
    const kindEcho = byId("kindEcho");
    const daysEcho = byId("daysEcho");

    const copyAllBtn = byId("copyAll");
    const downloadCsvBtn = byId("downloadCsv");

    const STORAGE_KEY = "iso_admin_token";

    // 直近抽出結果
    let lastSegment = { source: null, days: null, items: [] };

    // ===== UI util =====
    function showToast(text, type = "ok") {
      toast.style.display = "block";
      toast.textContent = text;
      toast.className = "toast " + (type === "ok" ? "ok" : type === "warn" ? "warn" : "");
    }

    function hideToast() {
      toast.style.display = "none";
      toast.textContent = "";
      toast.className = "toast";
    }

    function getToken() {
      return (tokenEl.value || "").trim();
    }

    function setLoading(isLoading) {
      fetchBtn.disabled = isLoading;
      sendBtn.disabled = isLoading;
      dryRunBtn.disabled = isLoading;
      sourceEl.disabled = isLoading;
      daysEl.disabled = isLoading;
    }

    function authHeaders() {
      const t = getToken();
      return t ? { Authorization: "Bearer " + t } : {};
    }

    function enableExportButtons(enabled) {
      copyAllBtn.disabled = !enabled;
      downloadCsvBtn.disabled = !enabled;
    }

    // ===== API =====
    async function apiGetSegment(source, days) {
      const url = `/api/admin/segment/users?source=${encodeURIComponent(
        source
      )}&days=${encodeURIComponent(days)}`;

      const r = await fetch(url, { headers: { ...authHeaders() } });
      const j = await r.json().catch(() => ({}));

      if (!r.ok || !j.ok) {
        throw new Error(j.error || `HTTP ${r.status}`);
      }

      // 期待形式：{ok:true, days, source, count, items:[...]}
      return j;
    }

    async function apiPushSegment(source, days, message, dryRun = false) {
      const r = await fetch(`/api/admin/push/segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ days, source, message, dryRun }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return j;
    }

    // ===== render =====
    function renderSegment(items) {
      const max = 500;
      const view = (items || []).slice(0, max);

      if (!items || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="small" style="color:#666;padding:12px;">対象が0件でした。</td></tr>`;
        return;
      }

      const esc = (s) =>
        String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

      tbody.innerHTML = view
        .map((uid, i) => `<tr><td class="mono">${i + 1}</td><td class="mono">${esc(uid)}</td></tr>`)
        .join("");

      if (items.length > max) {
        tbody.innerHTML += `<tr><td colspan="2" class="small" style="color:#666;padding:12px;">表示は先頭${max}件まで（全件=${items.length}件）</td></tr>`;
      }
    }

    function makeTextMessage() {
      const type = msgTypeEl.value;
      if (type !== "text") throw new Error("未対応のメッセージ種別です（textのみ対応）");
      const text = (msgTextEl.value || "").trim();
      if (!text) throw new Error("配信テキストが空です");
      return { type: "text", text };
    }

    async function copyAll() {
      const text = (lastSegment.items || []).join("\n");
      await navigator.clipboard.writeText(text);
      showToast("userId をクリップボードにコピーしました", "ok");
    }

    function downloadCsvFile() {
      const rows = [["userId"], ...(lastSegment.items || []).map((u) => [u])];
      const csv = rows
        .map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(","))
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `segment_${String(lastSegment.source || "source")}_days${String(lastSegment.days || "x")}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // ===== init state =====
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) tokenEl.value = saved;

    enableExportButtons(false);

    saveTokenBtn.addEventListener("click", () => {
      const t = getToken();
      if (!t) return showToast("トークンが空です", "warn");
      localStorage.setItem(STORAGE_KEY, t);
      showToast("トークンを保存しました", "ok");
    });

    clearTokenBtn.addEventListener("click", () => {
      tokenEl.value = "";
      localStorage.removeItem(STORAGE_KEY);
      showToast("トークンを消去しました", "ok");
    });

    // ===== 抽出 =====
    fetchBtn.addEventListener("click", async () => {
      hideToast();

      const source = String(sourceEl.value || "active").trim().toLowerCase();
      const days = Math.max(1, Math.min(365, Number(daysEl.value || 30)));

      if (!getToken()) return showToast("管理トークンを入力してください", "warn");

      setLoading(true);
      segmentStat.textContent = "抽出中…";

      try {
        const j = await apiGetSegment(source, days);

        lastSegment = {
          source: j.source || source,
          days: j.days || days,
          items: j.items || [],
        };

        renderSegment(lastSegment.items);

        countEl.textContent = String(j.count ?? lastSegment.items.length);
        kindEcho.textContent = String(lastSegment.source);
        daysEcho.textContent = String(lastSegment.days);

        segmentStat.textContent = `抽出OK（${lastSegment.items.length}件）`;
        enableExportButtons(lastSegment.items.length > 0);

        showToast(`抽出しました：${lastSegment.items.length}件`, "ok");
      } catch (e) {
        segmentStat.textContent = "抽出NG";
        enableExportButtons(false);
        tbody.innerHTML = `<tr><td colspan="2" class="small" style="color:#b91c1c;padding:12px;">抽出に失敗：${String(
          e.message || e
        )}</td></tr>`;
        showToast(`抽出に失敗：${String(e.message || e)}`, "warn");
      } finally {
        setLoading(false);
      }
    });

    // ===== dryRun（プレビュー）=====
    dryRunBtn.addEventListener("click", async () => {
      hideToast();

      const source = String(sourceEl.value || "active").trim().toLowerCase();
      const days = Math.max(1, Math.min(365, Number(daysEl.value || 30)));

      if (!getToken()) return showToast("管理トークンを入力してください", "warn");

      let msg;
      try {
        msg = makeTextMessage();
      } catch (e) {
        return showToast(String(e.message || e), "warn");
      }

      setLoading(true);
      try {
        const j = await apiPushSegment(source, days, msg, true);
        const pv = j.preview || [];
        showToast(`dryRun OK：対象 ${j.target}件 / 先頭プレビュー ${pv.length}件`, "ok");
      } catch (e) {
        showToast(`dryRun 失敗：${String(e.message || e)}`, "warn");
      } finally {
        setLoading(false);
      }
    });

    // ===== 配信 =====
    sendBtn.addEventListener("click", async () => {
      hideToast();

      const source = String(sourceEl.value || "active").trim().toLowerCase();
      const days = Math.max(1, Math.min(365, Number(daysEl.value || 30)));

      if (!getToken()) return showToast("管理トークンを入力してください", "warn");
      if (!lastSegment.items || lastSegment.items.length === 0) {
        return showToast("先に「対象者を抽出」してください", "warn");
      }

      let msg;
      try {
        msg = makeTextMessage();
      } catch (e) {
        return showToast(String(e.message || e), "warn");
      }

      setLoading(true);
      try {
        const j = await apiPushSegment(source, days, msg, false);
        showToast(`配信完了：成功 ${j.pushed} / 失敗 ${j.failed}（対象 ${j.target}）`, "ok");
      } catch (e) {
        showToast(`配信に失敗：${String(e.message || e)}`, "warn");
      } finally {
        setLoading(false);
      }
    });

    // ===== export =====
    copyAllBtn.addEventListener("click", () => {
      if (!lastSegment.items || lastSegment.items.length === 0) return showToast("コピー対象がありません", "warn");
      copyAll().catch((e) => showToast(`コピー失敗：${String(e.message || e)}`, "warn"));
    });

    downloadCsvBtn.addEventListener("click", () => {
      if (!lastSegment.items || lastSegment.items.length === 0) return showToast("CSV対象がありません", "warn");
      downloadCsvFile();
      showToast("CSVをダウンロードしました", "ok");
    });
  }

  // DOMができてから初期化（timing起因のエラー回避）
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
