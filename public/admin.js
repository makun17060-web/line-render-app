  // ------- util -------
  const $  = (sel) => document.querySelector(sel);
  const out = (el, data, show=true) => { el.hidden = !show; el.textContent = (typeof data === 'string') ? data : JSON.stringify(data, null, 2); };
  const hdr = () => ({ 'Authorization': 'Bearer ' + (($('#token').value || '').trim()), 'Content-Type': 'application/json' });
  const yen = (n) => Number(n||0).toLocaleString('ja-JP') + '円';

  // ------- token persist -------
  const LS_KEY = 'ADMIN_API_TOKEN';
  const saved = localStorage.getItem(LS_KEY) || '';
  if (saved) $('#token').value = saved;
  $('#btnSaveToken').onclick = () => {
    const v = ($('#token').value || '').trim();
    if (!v) { alert('ADMIN_API_TOKEN を入力してください'); return; }
    localStorage.setItem(LS_KEY, v);
    alert('保存しました（このブラウザに記憶）');
  };

  // ------- ping / health -------
  $('#btnPing').onclick = async () => {
    $('#pingRes').textContent = '確認中…';
    try {
      const r = await fetch('/api/admin/ping', { headers: hdr() });
      const j = await r.json();
      $('#pingRes').textContent = (j.ok ? 'OK' : `NG: ${j.error||'unknown'}`);
      $('#pingRes').className = 'pill ' + (j.ok ? 'ok' : 'ng');
    } catch (e) {
      $('#pingRes').textContent = 'ERR';
      $('#pingRes').className = 'pill ng';
    }
  };
  $('#btnHealth').onclick = async () => {
    try { const r = await fetch('/api/health'); const j = await r.json(); out($('#healthOut'), j, true); }
    catch (e) { out($('#healthOut'), String(e), true); }
  };

  // ------- products → flex -------
  let products = [];
  let chunkMode = false;
  $('#btnChunkOn').onclick = () => {
    chunkMode = !chunkMode;
    $('#chunkStatus').textContent = chunkMode ? 'ON' : 'OFF';
  };

  $('#btnLoadProducts').onclick = async () => {
    try {
      const r = await fetch('/api/admin/products', { headers: hdr() });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      products = j.items || [];
      $('#prodCount').textContent = `${products.length} 件`;
      $('#prodCount').className = 'pill';
    } catch (e) {
      $('#prodCount').textContent = '取得失敗';
      $('#prodCount').className = 'pill ng';
      alert('商品取得に失敗: ' + e);
    }
  };

  function buildBubbles(list, hideIdsCsv) {
    const hide = (hideIdsCsv||'').split(',').map(s=>s.trim()).filter(Boolean);
    const visible = list.filter(p => !hide.includes(p.id));
    const bubbles = visible.map(p => ({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: p.name, weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size: 'sm', wrap: true },
          p.desc ? { type: 'text', text: p.desc, size: 'sm', wrap: true } : { type: 'box', layout: 'vertical', contents: [] }
        ]
      },
      footer: { type: 'box', layout: 'horizontal', spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', action: { type: 'postback', label: '数量を選ぶ', data: `order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
        ]
      }
    }));
    // 最後に「その他（自由入力）」
    bubbles.push({
      type:'bubble',
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:'その他（自由入力）', weight:'bold', size:'md' },
        { type:'text', text:'商品名と個数だけ入力します。価格入力は不要です。', size:'sm', wrap:true }
      ]},
      footer:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'button', style:'primary', action:{ type:'postback', label:'商品名を入力する', data:'other_start' } },
        { type:'button', style:'secondary', action:{ type:'postback', label:'← 戻る', data:'order_back' } }
      ]}
    });
    return bubbles;
  }

  function buildFlexMessages(list, altText, hideIdsCsv) {
    const bubbles = buildBubbles(list, hideIdsCsv);
    if (!chunkMode) {
      return [{
        type:'flex',
        altText: (altText||'商品一覧').slice(0,400),
        contents: bubbles.length===1 ? bubbles[0] : { type:'carousel', contents: bubbles }
      }];
    }
    // 分割（安全に10バブルずつ）
    const msgs = [];
    const chunkSize = 10;
    for (let i=0;i<bubbles.length;i+=chunkSize) {
      msgs.push({
        type:'flex',
        altText: ((altText||'商品一覧') + ` (${Math.floor(i/chunkSize)+1})`).slice(0,400),
        contents: { type:'carousel', contents: bubbles.slice(i, i+chunkSize) }
      });
    }
    return msgs;
  }

  let lastFlexMsgs = [];
  $('#btnBuildFlex').onclick = () => {
    if (!products.length) { alert('先に商品を読み込んでください'); return; }
    const altText = ($('#altText').value || '商品一覧');
    const hideCsv = ($('#hideIds').value || '');
    lastFlexMsgs = buildFlexMessages(products, altText, hideCsv);
    out($('#flexPreview'), lastFlexMsgs.length===1 ? lastFlexMsgs[0] : lastFlexMsgs, true);
  };

  // ------- send flex -------
  $('#btnSendFlex').onclick = async () => {
    try {
      if (!lastFlexMsgs.length) { alert('先に「Flex 生成（プレビュー）」を押してください'); return; }
      const ids = ($('#userIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
      // セグメント送信は 1メッセージずつ送る
      if (ids.length) {
        let sent = 0, failed = 0;
        for (const msg of lastFlexMsgs) {
          const r = await fetch('/api/admin/segment/send-flex', { method:'POST', headers: hdr(),
            body: JSON.stringify({ userIds: ids, altText: msg.altText, contents: msg.contents })
          });
          const j = await r.json();
          if (j.ok) sent += j.sent||ids.length; else failed += (j.failed||ids.length);
        }
        $('#sendFlexRes').textContent = failed ? `部分成功 sent:${sent} failed:${failed}` : `OK sent:${sent}`;
        $('#sendFlexRes').className = 'pill ' + (failed ? 'ng' : 'ok');
      } else {
        // ブロードキャスト：分割メッセージを順に送る
        for (const msg of lastFlexMsgs) {
          const r = await fetch('/api/admin/broadcast-flex', { method:'POST', headers: hdr(),
            body: JSON.stringify({ altText: msg.altText, contents: msg.contents })
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error||'broadcast failed');
        }
        $('#sendFlexRes').textContent = 'OK broadcast';
        $('#sendFlexRes').className = 'pill ok';
      }
    } catch (e) {
      $('#sendFlexRes').textContent = 'ERR';
      $('#sendFlexRes').className = 'pill ng';
      alert('配信エラー: ' + e);
    }
  };

  // ------- テキストを送る（簡易Flex） -------
  $('#btnSendText').onclick = async () => {
    const msg = ($('#textMessage').value||'').trim();
    if (!msg) { alert('本文が空です'); return; }
    const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const flex = {
      type:'flex',
      altText: 'お知らせ',
      contents: { type:'bubble', body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'text', text: msg, wrap: true }
      ]}}
    };
    try {
      if (ids.length) {
        const r = await fetch('/api/admin/segment/send-flex', { method:'POST', headers: hdr(),
          body: JSON.stringify({ userIds: ids, altText: flex.altText, contents: flex.contents })
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error||'failed');
        $('#sendTextRes').textContent = 'OK';
        $('#sendTextRes').className = 'pill ok';
      } else {
        const r = await fetch('/api/admin/broadcast-flex', { method:'POST', headers: hdr(), body: JSON.stringify(flex) });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error||'failed');
        $('#sendTextRes').textContent = 'OK broadcast';
        $('#sendTextRes').className = 'pill ok';
      }
    } catch (e) {
      $('#sendTextRes').textContent = 'ERR';
      $('#sendTextRes').className = 'pill ng';
      alert('送信エラー: ' + e);
    }
  };

  // ------- userId 収集（アクティブユーザー） -------
  let lastUsers = [];
  $('#btnActiveUsers').onclick = async () => {
    try {
      const r = await fetch('/api/admin/active-chatters?list=true', { headers: hdr() });
      const j = await r.json();
      lastUsers = Array.isArray(j.users) ? j.users : [];
      $('#usersCount').textContent = `${lastUsers.length} ユーザー`;
      out($('#usersOut'), j, true);
    } catch (e) {
      out($('#usersOut'), String(e), true);
    }
  };
  $('#btnFillToUserIds').onclick = () => {
    if (!lastUsers.length) { alert('先に「直近のアクティブユーザー取得」を押してください'); return; }
    $('#userIds').value = lastUsers.join(',');
  };

  // ------- messages log tail -------
  let auto = false, timer = null;
  async function loadLog() {
    try {
      const r = await fetch('/api/admin/messages?limit=200', { headers: hdr() });
      const j = await r.json();
      out($('#logOut'), j, true);
    } catch (e) {
      out($('#logOut'), '取得失敗: ' + e, true);
    }
  }
  $('#btnLoadLog').onclick = loadLog;
  $('#btnAutoRefresh').onclick = () => {
    auto = !auto;
    $('#autoStatus').textContent = auto ? 'ON' : 'OFF';
    if (auto) { loadLog(); timer = setInterval(loadLog, 10000); }
    else { clearInterval(timer); timer = null; }
  };
})();
JS
