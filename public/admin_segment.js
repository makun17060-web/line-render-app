// admin_segment.js — 丸ごと版（管理HTMLとDB取得件数を一致させる版）
// - 抽出: GET  /api/admin/segment/users?source=...&days=...
// - 送信: POST /api/admin/segment/send  { userIds:[], message:"..." }
// - count はサーバー応答の count をそのまま表示（=DB取得件数と一致）
// - 表の表示は最大500件（UI都合）
// - Bearer token は localStorage に保存

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    token: $("token"),
    saveToken: $("saveToken"),
    clearToken: $("clearToken"),

    kind: $("kind"),
    days: $("days"),
    fetchSegment: $("fetchSegment"),
    segmentStat: $("segmentStat"),

    msgText: $("msgText"),
    dryRun: $("dryRun"),
    sendPush: $("sendPush"),

    toast: $("toast"),

    kindEcho: $("kindEcho"),
    daysEcho: $("daysEcho"),
    count: $("count"),
    tbody: $("tbody"),

    copyAll: $("copyAll"),
    downloadCsv: $("downloadCsv"),
  };

  // ---- state ----
  let last = {
    source: "active",
    days: 30,
    count: 0,
    userIds: [],
  };

  // ---- token storage ----
  const LS_KEY = "ISOYA_ADMIN_BEARER_TOKEN";

  function getToken() {
    const t = (el.token?.value || "").trim();
    if (t) return t;
    return (localStorage.getItem(LS_KEY) || "").trim();
  }
  function loadTokenToInput() {
    const saved = (localStorage.getItem(LS_KEY) || "").trim();
    if (saved && el.token) el.token.value = saved;
  }

  // ---- ui helpers ----
  function setToast(type, text) {
    if (!el.toast) return;
    el.toast.style.display = "block";
    el.toast.className = `toast ${type === "ok" ? "ok" : "warn"}`;
    el.toast.textContent = text || "";
  }
  function clearToast() {
    if (!el.toast) return;
    el.toast.style.display = "none";
    el.toast.textContent = "";
    el.toast.className = "toast";
  }

  function setBusy(b) {
    if (el.fetchSegment) el.fetchSegment.disabled = !!b;
    if (el.sendPush) el.sendPush.disabled = !!b;
    if (el.dryRun) el.dryRun.disabled = !!b;
  }

  function escapeCsvCell(s) {
    const v = String(s ?? "");
    if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  }

  function renderTable(userIds) {
    const list = Array.isArray(userIds) ? userIds : [];
    const show = list.slice(0, 500);

    if (!el.tbody) return;

    if (show.length === 0) {
      el.tbody.innerHTML = `
        <tr>
          <td colspan="2" class="small" style="color:#666;padding:12px;">
            該当 userId がありません。
          </td>
        </tr>`;
      return;
    }

    el.tbody.innerHTML = show
      .map(
        (uid, i) => `
        <tr>
          <td>${i + 1}</td>
          <td class="mono">${String(uid)}</td>
        </tr>
      `
      )
      .join("");
  }

  function renderStats({ source, days, count, userIds }) {
    if (el.kindEcho) el.kindEcho.textContent = source ?? "-";
    if (el.daysEcho) el.daysEcho.textContent = String(days ?? "-");
    if (el.count) el.count.textContent = String(count ?? 0);

    const ok = Array.isArray(userIds) && userIds.length > 0;
    if (el.copyAll) el.copyAll.disabled = !ok;
    if (el.downloadCsv) el.downloadCsv.disabled = !ok;

    if (el.segmentStat) {
      el.segmentStat.textContent = ok
        ? `抽出OK：${count}件（表示 ${Math.min(500, userIds.length)}件）`
        : "抽出OK：0件";
    }
  }

  // ---- api ----
  async function apiFetchSegment(source, days) {
    const token = getToken();
    if (!token) throw new Error("管理トークン（Bearer）が未設定です");

    const qs = new URLSearchParams();
    qs.set("source", String(source || "active"));
    qs.set("days", String(days || 30));

    const r = await fetch(`/api/admin/segment/users?${qs.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    let j = null;
    try {
      j = await r.json();
    } catch {
      // 非JSONの時はそのまま
      const t = await r.text().catch(() => "");
      throw new Error(`API応答がJSONではありません（HTTP ${r.status}）: ${t.slice(0, 120)}`);
    }

    if (!r.ok || !j?.ok) {
      const msg = j?.error || `HTTP ${r.status}`;
      throw new Error(`抽出APIエラー: ${msg}`);
    }

    // サーバーが返す count/items をそのまま使う（ここが「一致」の肝）
    const items = Array.isArray(j.items) ? j.items : [];
    const count = Number(j.count ?? items.length) || 0;

    // 念のためユニーク化（サーバー側でDISTINCTしていても安全）
    const uniq = Array.from(new Set(items.filter(Boolean)));

    return { source: j.source ?? source, days: j.days ?? days, count, userIds: uniq };
  }

  async function apiSendPush(userIds, message) {
    const token = getToken();
    if (!token) throw new Error("管理トークン（Bearer）が未設定です");
    if (!Array.isArray(userIds) || userIds.length === 0) throw new Error("送信対象が0件です（先に抽出してください）");
    const msg = String(message || "").trim();
    if (!msg) throw new Error("本文が空です");

    const r = await fetch(`/api/admin/segment/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userIds, message: msg }),
    });

    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) {
      const msg2 = j?.error || `HTTP ${r.status}`;
      throw new Error(`送信APIエラー: ${msg2}`);
    }
    return j;
  }

  // ---- events ----
  function onSaveToken() {
    clearToast();
    const t = (el.token?.value || "").trim();
    if (!t) return setToast("warn", "トークンが空です。ADMIN_API_TOKEN を貼り付けてください。");
    localStorage.setItem(LS_KEY, t);
    setToast("ok", "保存しました（localStorage）");
  }

  function onClearToken() {
    clearToast();
    localStorage.removeItem(LS_KEY);
    if (el.token) el.token.value = "";
    setToast("ok", "消去しました");
  }

  async function onFetchSegment() {
    clearToast();
    setBusy(true);
    try {
      const source = String(el.kind?.value || "active").trim();
      const days = Math.min(365, Math.max(1, Number(el.days?.value || 30)));

      const data = await apiFetchSegment(source, days);

      last = { source: data.source, days: data.days, count: data.count, userIds: data.userIds };

      renderStats(last);
      renderTable(last.userIds);

      setToast("ok", `抽出しました：${last.count}件（表示 ${Math.min(500, last.userIds.length)}件）`);
    } catch (e) {
      setToast("warn", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function onDryRun() {
    clearToast();
    const msg = String(el.msgText?.value || "").trim();
    if (!last.userIds.length) return setToast("warn", "まだ抽出していません。先に「対象者を抽出」を押してください。");
    if (!msg) return setToast("warn", "本文が空です。");

    const head = last.userIds.slice(0, 3).join(", ");
    setToast(
      "ok",
      `dryRun OK\n対象: ${last.count}件（現在保持 ${last.userIds.length}件）\n先頭: ${head}${last.userIds.length > 3 ? " ..." : ""}\n本文長: ${msg.length}文字`
    );
  }

  async function onSendPush() {
    clearToast();
    setBusy(true);
    try {
      const msg = String(el.msgText?.value || "").trim();
      if (!msg) throw new Error("本文が空です。");
      if (!last.userIds.length) throw new Error("送信対象が0件です（先に抽出してください）。");

      // ここで最終確認を入れたい場合は confirm() を使っても良いが、
      // 事故を避けるため、最低限の注意文だけ出す
      const ok = window.confirm(`本当に送信しますか？\n対象: ${last.count}件\n本文先頭: ${msg.slice(0, 30)}${msg.length > 30 ? "..." : ""}`);
      if (!ok) {
        setToast("warn", "キャンセルしました。");
        return;
      }

      const result = await apiSendPush(last.userIds, msg);
      setToast("ok", `送信結果: requested=${result.requested} / sent=${result.sent} / failed=${result.failed}`);
    } catch (e) {
      setToast("warn", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCopyAll() {
    clearToast();
    if (!last.userIds.length) return setToast("warn", "コピー対象がありません。");
    const text = last.userIds.join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => setToast("ok", `コピーしました（${last.userIds.length}件）`))
      .catch(() => setToast("warn", "コピーに失敗しました（ブラウザ権限を確認）"));
  }

  function onDownloadCsv() {
    clearToast();
    if (!last.userIds.length) return setToast("warn", "CSV対象がありません。");

    const header = ["userId"];
    const rows = last.userIds.map((uid) => [escapeCsvCell(uid)].join(","));
    const csv = [header.join(","), ...rows].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;

    const ts = new Date();
    const y = ts.getFullYear();
    const m = String(ts.getMonth() + 1).padStart(2, "0");
    const d = String(ts.getDate()).padStart(2, "0");
    a.download = `segment_${last.source}_${last.days}d_${y}${m}${d}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setToast("ok", "CSVをダウンロードしました。");
  }

  // ---- init ----
  function init() {
    loadTokenToInput();

    el.saveToken?.addEventListener("click", onSaveToken);
    el.clearToken?.addEventListener("click", onClearToken);

    el.fetchSegment?.addEventListener("click", onFetchSegment);
    el.dryRun?.addEventListener("click", onDryRun);
    el.sendPush?.addEventListener("click", onSendPush);

    el.copyAll?.addEventListener("click", onCopyAll);
    el.downloadCsv?.addEventListener("click", onDownloadCsv);

    // 初期表示
    renderStats(last);
    renderTable([]);
  }

  init();
})();
