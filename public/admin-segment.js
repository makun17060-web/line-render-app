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

  // メッセージ形式切替（セグメント）
  $("messageType").addEventListener("change", ()=>{
    const isFlex = $("messageType").value==="flex";
    $("textAreaWrap").classList.toggle("hide", isFlex);
    $("flexAreaWrap").classList.toggle("hide", !isFlex);
  });

  // メッセージ形式切替（手動）
  $("manualMessageType").addEventListener("change", ()=>{
    const isFlex = $("manualMessageType").value==="flex";
    $("manualTextWrap").classList.toggle("hide", isFlex);
    $("manualFlexWrap").classList.toggle("hide", !isFlex);
  });

  const api = (path)=>{
    const base = ($("apiBase").value||"").trim();
    return base ? (base.replace(/\/$/,"")+path) : path;
  };

  // ★あなたの server.js のAPIに合わせてここだけ変えればOK
  const ENDPOINTS = {
    preview: "/api/admin/segment/preview",
    send:    "/api/admin/segment/send",
    manual:  "/api/admin/multicast"
  };

  // 対象数プレビュー
  $("previewBtn").addEventListener("click", async ()=>{
    const adminToken = $("adminToken").value.trim();
    if(!adminToken){ alert("管理トークンを入力してください"); return; }

    const payload = {
      adminToken,
      segmentType: $("segmentType").value,
      from: $("fromDate").value || null,
      to: $("toDate").value || null
    };

    log("preview start: " + JSON.stringify(payload));

    try{
      const res = await fetch(api(ENDPOINTS.preview),{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify(payload)
      });
      const data = await res.json().catch(()=>null);

      if(!res.ok || !data?.ok){
        $("previewResult").innerHTML = `対象数：<span class="ng">取得失敗</span>`;
        log("preview NG: " + res.status + " " + JSON.stringify(data));
        alert("対象数プレビューに失敗。ENDPOINTS.preview を server.js に合わせてください。");
        return;
      }

      $("previewResult").innerHTML = `対象数：<span class="ok">${data.count ?? data.total ?? "?"}人</span>`;
      log("preview OK: " + JSON.stringify(data));
    }catch(e){
      log("preview ERR: " + e);
      alert("通信エラー。URL/Render起動状態を確認してください。");
    }
  });

  // セグメント配信（本番）
  $("sendBtn").addEventListener("click", ()=>sendSegment(false));
  $("dryRunBtn").addEventListener("click", ()=>sendSegment(true));

  async function sendSegment(dryRun){
    const adminToken = $("adminToken").value.trim();
    if(!adminToken){ alert("管理トークンを入力してください"); return; }

    const messageType = $("messageType").value;
    const msg =
      messageType==="text"
        ? { type:"text", text: $("textMessage").value.trim() }
        : (()=> {
            const raw = $("flexJson").value.trim();
            if(!raw) return null;
            try{ return JSON.parse(raw); }catch{ return "INVALID_JSON"; }
          })();

    if(!msg){ alert("メッセージを入力してください"); return; }
    if(msg==="INVALID_JSON"){ alert("Flex JSONが不正です"); return; }

    const payload = {
      adminToken,
      dryRun: !!dryRun,
      sendMode: $("sendMode").value,
      segment: {
        type: $("segmentType").value,
        from: $("fromDate").value || null,
        to: $("toDate").value || null
      },
      message: msg
    };

    log("segment send start: " + JSON.stringify(payload));

    try{
      const res = await fetch(api(ENDPOINTS.send),{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify(payload)
      });
      const data = await res.json().catch(()=>null);

      if(!res.ok || !data?.ok){
        log("segment send NG: " + res.status + " " + JSON.stringify(data));
        alert("セグメント配信に失敗。ENDPOINTS.send を server.js に合わせてください。");
        return;
      }

      log("segment send OK: " + JSON.stringify(data));
      alert(`送信OK！ 対象: ${data.count ?? data.total ?? "?"}人`);
    }catch(e){
      log("segment send ERR: " + e);
      alert("通信エラー。URL/Render起動状態を確認してください。");
    }
  }

  // 手動 multicast
  $("manualSendBtn").addEventListener("click", async ()=>{
    const adminToken = $("adminToken").value.trim();
    if(!adminToken){ alert("管理トークンを入力してください"); return; }

    const ids = $("manualUserIds").value
      .split(/[\n, ]+/)
      .map(s=>s.trim())
      .filter(Boolean);

    if(ids.length===0){ alert("ユーザーIDを入力してください"); return; }

    const t = $("manualMessageType").value;
    const msg =
      t==="text"
        ? { type:"text", text:$("manualText").value.trim() }
        : (()=> {
            const raw = $("manualFlex").value.trim();
            if(!raw) return null;
            try{ return JSON.parse(raw); }catch{ return "INVALID_JSON"; }
          })();

    if(!msg){ alert("メッセージを入力してください"); return; }
    if(msg==="INVALID_JSON"){ alert("Flex JSONが不正です"); return; }

    const payload = { adminToken, userIds: ids, message: msg };

    log("manual send start: " + JSON.stringify(payload));

    try{
      const res = await fetch(api(ENDPOINTS.manual),{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify(payload)
      });
      const data = await res.json().catch(()=>null);

      if(!res.ok || !data?.ok){
        log("manual send NG: " + res.status + " " + JSON.stringify(data));
        alert("指定ユーザー送信に失敗。ENDPOINTS.manual を server.js に合わせてください。");
        return;
      }

      log("manual send OK: " + JSON.stringify(data));
      alert("送信OK！");
    }catch(e){
      log("manual send ERR: " + e);
      alert("通信エラー。URL/Render起動状態を確認してください。");
    }
  });

  log("admin-segment loaded. ENDPOINTS=" + JSON.stringify(ENDPOINTS));
})();
