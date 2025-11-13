// ========== 設定 ==========


tr.append(tdImg, tdId, tdName, tdPrice, tdStock, tdDesc, tdAct);
productsTbody.append(tr);
}
}


// Ping
async function ping(){
pingStatus.textContent = '接続中...';
pingStatus.style.background = '#fff3cd';
try{
const r = await fetch(API.ping, { headers: authHeaders() });
const json = await r.json();
if (json.ok){
pingStatus.textContent = '接続OK';
pingStatus.style.background = '#e7f6ed';
}else{
pingStatus.textContent = '失敗';
pingStatus.style.background = '#fde2e1';
}
}catch(e){
pingStatus.textContent = '失敗';
pingStatus.style.background = '#fde2e1';
}
}


// 保存ボタン
saveTokenBtn?.addEventListener('click', ()=>{
const v = adminTokenEl.value.trim();
if (!v) return alert('管理トークンを入力してください');
localStorage.setItem('ADMIN_TOKEN', v);
ping();
});


pingBtn?.addEventListener('click', ping);
reloadImagesBtn?.addEventListener('click', reloadImages);
reloadProductsBtn?.addEventListener('click', reloadProducts);


// 初期化
(async function init(){
setTokenUIFromStorage();
await ping();
await Promise.all([reloadImages(), reloadProducts()]);
})();
