(() => {
  const $ = (id) => document.getElementById(id);

  const tokenEl = $("token");
  const saveTokenBtn = $("saveToken");
  const kindEl = $("kind");
  const daysEl = $("days");
  const loadBtn = $("loadSegment");
  const sendBtn = $("sendSegment");

  const msgTypeEl = $("msgType");
  const textBox = $("textBox");
  const flexBox = $("flexBox");
  const textEl = $("text");
  const flexJsonEl = $("flexJson");

  const countEl = $("count");
  const kindLabelEl = $("kindLabel");
  const daysLabelEl = $("daysLabel");
  const statusEl = $("status");
  const listEl = $("list");
  const reportEl = $("report");

  const copyIdsBtn = $("copyIds");
  const downloadCsvBtn = $("downloadCsv");

  const STORAGE_KEY = "isoya_admin_token";
  let currentIds = [];

  function setStatus(msg, ok = true) {
    statusEl.textContent = msg;
    statusEl.className = ok ? "hint ok" : "hint ng";
  }

  function getToken() {
    const url = new URL(location.href);
    const t = (url.searchParams.get("token") || "").trim();
    if (t) return t;
    return (localStorage.getItem(STORAGE_KEY) || "").trim();
  }

  function setToken(t) {
    localStorage.setItem(STORAGE_KEY, (t || "").trim());
  }

  function renderIds(ids) {
    currentIds = ids || [];
    countEl.textContent = String(currentIds.length);
    listEl.innerHTML = "";
    currentIds.slice(0, 2000).forEach((uid, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mono">${i + 1}</td><td class="mono">${escapeHtml(uid)}</td>`;
      listEl.appendChild(tr);
    });
    if (currentIds.length > 2000) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="2" class="hint">※ 表示は先頭2000件まで（取得自体は全件）</td>`;
      listEl.appendChild(tr);
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function loadSegment() {
    const token = tokenEl.value.trim();
    const kind = kindEl.value;
    const days = String(daysEl.value || "30").trim();

    if (!token) return setStatus("トークンが空です", false);

    setStatus("対象者を取得中…");
    reportEl.textContent = "—";

    const url = `/api/admin/segment/liff-open?kind=${encodeURIComponent(kind)}&days=${encodeURIComponent(days)}&token=${encodeURIComponent(token)}`;

    const r = await fetch(url, { method: "GET" });
    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) {
      setStatus(`取得失敗：${j.error || r.status}`, false);
      renderIds([]);
      return;
    }

    kindLabelEl.textContent = j.kind || kind;
    daysLabelEl.textContent = String(j.days || days);
    renderIds(Array.isArray(j.items) ? j.items : []);
    setStatus(`取得OK（${currentIds.length}件）`);
  }

  function buildMessage() {
    const type = msgTypeEl.value;

    if (type === "text") {
      const t = (textEl.value || "").trim();
      if (!t) throw new Error("本文が空です");
      return { type: "text", text: t };
    }

    // flex
    const raw = (flexJsonEl.value || "").trim();
    if (!raw) throw new Error("Flex JSONが空です");
    let obj;
    try { obj = JSON.parse(raw); } catch { throw new Error("Flex JSONが壊れています"); }
    if (!obj.type) throw new Error("Flex JSONに type がありません");
    return obj;
  }

  async function sendSegment() {
    const token = tokenEl.value.trim();
    const kind = kindEl.value;
    const days = Number(daysEl.value || 30);

    if (!token) return setStatus("トークンが空です", false);

    let message;
    try {
      message = buildMessage();
    } catch (e) {
      return setStatus(`送信できません：${e.message}`, false);
    }

    // 先に対象者を取得してない場合でも送れるが、事故防止で取得推奨
    if (currentIds.length === 0) {
      const yes = confirm("対象者が0件表示です。先に「対象者を取得」しましたか？\nこのまま送信しますか？");
      if (!yes) return;
    } else {
      const yes = confirm(`この条件の対象者へ一括送信します。\n対象：${currentIds.length}件\nよろしいですか？`);
      if (!yes) return;
    }

    setStatus("送信中…");

    const r = await fetch(`/api/admin/push/segment?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, days, message }),
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) {
      setStatus(`送信失敗：${j.error || r.status}`, false);
      reportEl.textContent = JSON.stringify(j, null, 2);
      return;
    }

    setStatus(`送信完了：成功 ${j.pushed} / 失敗 ${j.failed}`);
    reportEl.textContent =
      `kind=${j.kind} days=${j.days}\n` +
      `target=${j.target}\n` +
      `pushed=${j.pushed}\n` +
      `failed=${j.failed}\n` +
      `time=${new Date().toISOString()}`;
  }

  async function copyIds() {
    if (!currentIds.length) return alert("IDがありません（先に対象者を取得してください）");
    const text = currentIds.join("\n");
    await navigator.clipboard.writeText(text);
    alert(`コピーしました（${currentIds.length}件）`);
  }

  function downloadCsv() {
    if (!currentIds.length) return alert("IDがありません（先に対象者を取得してください）");
    const kind = kindEl.value;
    const days = String(daysEl.value || "30");
    const header = "userId\n";
    const body = currentIds.map((x) => `"${String(x).replaceAll('"', '""')}"`).join("\n");
    const csv = header + body;

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `segment_${kind}_${days}days.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 初期化
  function init() {
    const t = getToken();
    tokenEl.value = t;

    // トークン保存
    saveTokenBtn.addEventListener("click", () => {
      setToken(tokenEl.value.trim());
      setStatus("トークンを保存しました");
    });

    // タイプ切替
    msgTypeEl.addEventListener("change", () => {
      const type = msgTypeEl.value;
      textBox.style.display = type === "text" ? "" : "none";
      flexBox.style.display = type === "flex" ? "" : "none";
    });

    loadBtn.addEventListener("click", () => loadSegment().catch((e) => setStatus(String(e.message || e), false)));
    sendBtn.addEventListener("click", () => sendSegment().catch((e) => setStatus(String(e.message || e), false)));

    copyIdsBtn.addEventListener("click", () => copyIds().catch(() => alert("コピーできませんでした")));
    downloadCsvBtn.addEventListener("click", () => downloadCsv());

    setStatus("準備OK");
  }

  init();
})();
