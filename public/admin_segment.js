/* public/admin_segment.js
 * 管理：セグメント抽出 & 一括Push（丸ごと版）
 * - 既存：抽出 / 表表示 / 全コピー / CSV / dryRun / 送信
 * - 追加：今日の友だち追加 / 純増（follow_events / unfollow_events をサーバAPIで集計）
 *
 * 必要API：
 *  - GET  /api/admin/segment/users?source=...&days=...         (Bearer)
 *  - POST /api/admin/segment/send                              (Bearer) { userIds, message }
 *  - GET  /api/admin/follow/stats?tz=Asia/Tokyo               (Bearer) -> { ok, today:{follow,unfollow,net} }
 */

(() => {
  "use strict";

  // ====== DOM ======
  const el = (id) => document.getElementById(id);

  const $token = el("token");
  const $saveToken = el("saveToken");
  const $clearToken = el("clearToken");

  const $kind = el("kind");
  const $days = el("days");

  const $fetchSegment = el("fetchSegment");
  const $segmentStat = el("segmentStat");

  const $msgText = el("msgText");
  const $dryRun = el("dryRun");
  const $sendPush = el("sendPush");

  const $toast = el("toast");

  const $kindEcho = el("kindEcho");
  const $daysEcho = el("daysEcho");
  const $count = el("count");

  const $tbody = el("tbody");
  const $copyAll = el("copyAll");
  const $downloadCsv = el("downloadCsv");

  // ★追加 pill
  const $todayFollow = el("todayFollow");
  const $todayNet = el("todayNet");

  // ====== State ======
  const STORE_KEY = "ADMIN_API_TOKEN";
  const MAX_TABLE_ROWS = 500;

  let lastSegment = {
    source: null,
    days: null,
    count: 0,
    returned: 0,
    items: [],
  };

  // ====== Helpers ======
  function getToken() {
    return (localStorage.getItem(STORE_KEY) || "").trim();
  }
  function setToken(tok) {
    localStorage.setItem(STORE_KEY, String(tok || "").trim());
  }
  function clearToken() {
    localStorage.removeItem(STORE_KEY);
  }

  function toast(msg, type = "ok") {
    if (!$toast) return;
    $toast.className = `toast ${type === "warn" ? "warn" : "ok"}`;
    $toast.textContent = msg;
    $toast.style.display = "block";
    setTimeout(() => {
      $toast.style.display = "none";
    }, 3500);
  }

  async function apiFetch(url, options = {}) {
    const tok = getToken();
    if (!tok) throw new Error("管理トークンが未設定です（左で保存してください）");

    const headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${tok}`,
    };

    const res = await fetch(url, { ...options, headers });
    const text = await res.text();

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // JSONでなくてもOK（エラー表示用に残す）
    }

    if (!res.ok) {
      const errMsg =
        (json && (json.error || json.message)) ||
        `${res.status} ${res.statusText}` ||
        "request_failed";
      const e = new Error(errMsg);
      e.status = res.status;
      e.body = text;
      throw e;
    }
    return json;
  }

  function escapeCsv(v) {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadText(filename, content, mime = "text/plain") {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setButtonsEnabled(enabled) {
    $copyAll.disabled = !enabled;
    $downloadCsv.disabled = !enabled;
    $sendPush.disabled = !enabled;
  }

  function renderTable(userIds = []) {
    const ids = Array.isArray(userIds) ? userIds : [];
    const show = ids.slice(0, MAX_TABLE_ROWS);

    if (!$tbody) return;
    $tbody.innerHTML = "";

    if (!show.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 2;
      td.className = "small";
      td.style.color = "#666";
      td.style.padding = "12px";
      td.textContent = "対象者がいません（条件を変えて抽出してください）。";
      tr.appendChild(td);
      $tbody.appendChild(tr);
      return;
    }

    show.forEach((uid, i) => {
      const tr = document.createElement("tr");

      const td1 = document.createElement("td");
      td1.textContent = String(i + 1);
      td1.style.width = "70px";

      const td2 = document.createElement("td");
      td2.textContent = uid;
      td2.style.fontFamily =
        'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace';

      tr.appendChild(td1);
      tr.appendChild(td2);
      $tbody.appendChild(tr);
    });
  }

  function updateStatsUI(seg) {
    $kindEcho.textContent = seg.source ?? "-";
    $daysEcho.textContent = seg.days ?? "-";
    $count.textContent = String(seg.count ?? 0);

    $segmentStat.textContent = `count=${seg.count ?? 0} / returned=${seg.returned ?? 0}`;
  }

  // ====== Follow Stats (★追加) ======
  async function fetchTodayFollowStats() {
    if (!$todayFollow || !$todayNet) return;

    const tok = getToken();
    if (!tok) {
      $todayFollow.textContent = "-";
      $todayNet.textContent = "-";
      return;
    }

    try {
      const j = await apiFetch("/api/admin/follow/stats?tz=Asia%2FTokyo");
      if (!j?.ok) return;

      const follow = Number(j?.today?.follow ?? 0);
      const net = Number(j?.today?.net ?? 0);

      $todayFollow.textContent = String(follow);
      $todayNet.textContent = String(net);
    } catch (e) {
      // サーバ未実装でも管理画面は動かす
      $todayFollow.textContent = "-";
      $todayNet.textContent = "-";
      console.warn("[follow/stats] failed:", e?.message || e);
    }
  }

  // ====== Segment ======
  async function fetchSegment() {
    const source = String($kind.value || "active").trim();
    const days = Number($days.value || 30);

    $fetchSegment.disabled = true;
    setButtonsEnabled(false);
    $segmentStat.textContent = "抽出中…";

    try {
      const qs =
        `source=${encodeURIComponent(source)}` +
        `&days=${encodeURIComponent(days)}`;
      const j = await apiFetch(`/api/admin/segment/users?${qs}`);

      if (!j?.ok) throw new Error("segment_api_failed");

      lastSegment = {
        source: j.source ?? source,
        days: j.days ?? days,
        count: Number(j.count ?? 0),
        returned: Number(j.returned ?? 0),
        items: Array.isArray(j.items) ? j.items.filter(Boolean) : [],
      };

      updateStatsUI(lastSegment);
      renderTable(lastSegment.items);

      const has = lastSegment.items.length > 0;
      setButtonsEnabled(has);
      toast(`抽出しました：${lastSegment.count}人（返却 ${lastSegment.returned}件）`, "ok");
    } catch (e) {
      console.error(e);
      $segmentStat.textContent = "抽出失敗";
      renderTable([]);
      toast(`抽出に失敗：${e.message || e}`, "warn");
    } finally {
      $fetchSegment.disabled = false;
    }
  }

  // ====== Actions ======
  async function copyAllUserIds() {
    try {
      const ids = Array.isArray(lastSegment.items) ? lastSegment.items : [];
      if (!ids.length) return toast("コピー対象がありません", "warn");
      await navigator.clipboard.writeText(ids.join("\n"));
      toast(`userId をコピーしました（${ids.length}件）`, "ok");
    } catch (e) {
      toast("コピーに失敗しました（ブラウザ権限をご確認ください）", "warn");
    }
  }

  function downloadCsv() {
    const ids = Array.isArray(lastSegment.items) ? lastSegment.items : [];
    if (!ids.length) return toast("CSV対象がありません", "warn");

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");

    const filename = `segment_${lastSegment.source || "source"}_${y}${m}${d}_${hh}${mm}.csv`;
    const header = "user_id\n";
    const body = ids.map((x) => escapeCsv(x)).join("\n") + "\n";
    downloadText(filename, header + body, "text/csv");
    toast(`CSVをダウンロードしました（${ids.length}件）`, "ok");
  }

  function dryRun() {
    const ids = Array.isArray(lastSegment.items) ? lastSegment.items : [];
    const msg = String($msgText.value || "").trim();

    if (!ids.length) return toast("先に対象者を抽出してください", "warn");
    if (!msg) return toast("本文が空です", "warn");

    const head = ids.slice(0, 3).join(", ");
    toast(
      `dryRun OK：対象 ${ids.length}件 / 先頭 ${head || "-"} / 本文 ${msg.length}文字`,
      "ok"
    );
  }

  async function sendPush() {
    const ids = Array.isArray(lastSegment.items) ? lastSegment.items : [];
    const msg = String($msgText.value || "").trim();

    if (!ids.length) return toast("先に対象者を抽出してください", "warn");
    if (!msg) return toast("本文を入力してください", "warn");

    const ok = confirm(
      `一括Pushを送信します。\n対象：${ids.length}人\n\n本当に送信しますか？`
    );
    if (!ok) return;

    $sendPush.disabled = true;

    try {
      const j = await apiFetch("/api/admin/segment/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: ids, message: msg }),
      });

      if (!j?.ok) throw new Error(j?.error || "send_failed");

      const sent = Number(j.sent ?? 0);
      const failed = Number(j.failed ?? 0);
      toast(`送信完了：成功 ${sent} / 失敗 ${failed}`, failed ? "warn" : "ok");
    } catch (e) {
      console.error(e);
      toast(`送信失敗：${e.message || e}`, "warn");
    } finally {
      $sendPush.disabled = false;
    }
  }

  // ====== Init ======
  function initTokenUi() {
    const tok = getToken();
    if ($token) $token.value = tok ? tok : "";
  }

  function bind() {
    // token
    $saveToken.addEventListener("click", () => {
      const v = String($token.value || "").trim();
      if (!v) return toast("トークンが空です", "warn");
      setToken(v);
      toast("トークンを保存しました", "ok");
      fetchTodayFollowStats();
    });

    $clearToken.addEventListener("click", () => {
      clearToken();
      if ($token) $token.value = "";
      toast("トークンを消去しました", "ok");
      fetchTodayFollowStats();
    });

    // segment
    $fetchSegment.addEventListener("click", fetchSegment);

    // buttons
    $copyAll.addEventListener("click", copyAllUserIds);
    $downloadCsv.addEventListener("click", downloadCsv);
    $dryRun.addEventListener("click", dryRun);
    $sendPush.addEventListener("click", sendPush);
  }

  function boot() {
    initTokenUi();
    bind();

    // 初期表示
    updateStatsUI(lastSegment);
    renderTable([]);
    setButtonsEnabled(false);
    fetchTodayFollowStats();

    // 60秒ごとに follow stats を更新（トークンがある時だけ）
    setInterval(fetchTodayFollowStats, 60 * 1000);
  }

  boot();
})();
