(async function(){
  const $ = (id)=>document.getElementById(id);
  const logEl = $("log");
  const log = (m)=>{
    const t = new Date().toLocaleString();
    logEl.textContent = `[${t}] ${m}\n` + logEl.textContent;
  };

  // タブ切替
  document.querySelectorAll(".tab").forEach(tab=>{
    tab.addEventListener("click", ()=>{
      document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
      tab.classList.add("active");

      const name = tab.dataset.tab;
      $("tab-seg").classList.toggle("hide", name!=="seg");
      $("tab-manual").classList.toggle("hide", name!=="manual");
    });
  });

  // メッセージ種類切替（セグメント）
  $("messageType").addEventListener("change", ()=>{
    const isFlex = $("messageType").value === "flex";
    $("textAreaWrap").classList.toggle("hide", isFlex);
    $("flexAreaWrap").classList.toggle("hide", !isFlex);
  });

  // メッセージ種類切替（手動）
  $("manualMessageType").addEventListener("change", ()=>{
    const isFlex = $("manualMessageType").value === "flex";
    $("manualTextWrap").classList.toggle("hide", isFlex);
    $("manualFlexWrap").classList.toggle("hide", !isFlex);
  });

  const api = (path)=>{
    const base = ($("apiBase").value||"").trim();
    return base ? base.replace(/\/$/, "") + path : path;
  };

  const ENDPOINTS = {
    preview:  "/api/admin/segment/preview",
    sendText: "/api/admin/segment/send",
    sendFlex: "/api/admin/segment/send-flex",
  };

  // token を URL に付与
  const withToken = (path)=>{
    const tok = $("adminToken").value.trim();
    return api(path) + "?token=" + encodeURIComponent(tok);
  };

  // UI → server.js の type 名に変換
  function uiSegmentToType(uiVal){
    switch(uiVal){
      case "text_senders":  return "textSenders";
      case "purchasers":    return "orders";
      case "addresses":     return "addresses";
      case "survey":        return "survey";
      default: return "orders";
    }
  }

  // 日付: yyyy-mm-dd → yyyymmdd
  function ymd(dateStr){
    return dateStr ? dateStr.replaceAll("-", "") : "";
  }

  // ▼ 対象数プレビュー
  $("previewBtn").addEventListener("click", async ()=>{
    const token = $("adminToken").value.trim();
    if(!token){ alert("管理トークンを入力してください"); return; }

    const type = uiSegmentToType($("segmentType").value);

    const payload = {
      type,
      limit: 50000,
    };

    const d = ymd($("fromDate").value);
    if(d) payload.date = d;

    log("preview start: "+JSON.stringify(payload));

    try{
      const res = await fetch(withToken(ENDPOINTS.preview),{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify(payload)
      });
      const data = await res.json();

      if(!res.ok || !data.ok){
        log("preview NG: "+JSON.stringify(data));
        $("previewResult").textContent = "対象数：取得失敗";
        alert("対象数プレビューに失敗しました。");
        return;
      }

      const count = data.total ?? (data.userIds?.length ?? 0);
      $("previewResult").textContent = `対象数：${count}人`;
      log("preview OK: "+JSON.stringify({type:data.type, total:count}));

    }catch(e){
      log("preview ERR: "+e);
      alert("通信エラー。");
    }
  });

  // ▼ セグメント配信
  $("sendBtn").addEventListener("click", ()=>sendSegment(false));
  $("dryRunBtn").addEventListener("click", ()=>sendSegment(true));

  async function sendSegment(dryRun){
    const token = $("adminToken").value.trim();
    if(!token){ alert("管理トークンを入力してください"); return; }

    // Step1: preview で対象取得
    const type = uiSegmentToType($("segmentType").value);
    const payloadPreview = { type, limit:50000 };
    const d = ymd($("fromDate").value);
    if(d) payloadPreview.date = d;

    log("send step1 preview: "+JSON.stringify(payloadPreview));

    let preview;
    try{
      const pres = await fetch(withToken(ENDPOINTS.preview),{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify(payloadPreview)
      });
      preview = await pres.json();
      if(!pres.ok || !preview.ok) throw new Error("previewFailed");
    }catch(e){
      log("send preview ERR: "+e);
      alert("対象抽出に失敗しました。");
      return;
    }
