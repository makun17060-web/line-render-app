// public/address.js
// address.html 用：住所入力 → localStorage保存 → confirm.htmlへ遷移

(function(){
  const STORAGE_KEY = "isoya_order_v1";

  const form = document.getElementById("addrForm");
  const backBtn = document.getElementById("backBtn");

  if (!form || !backBtn) return;

  function loadOrder(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveOrder(partial){
    const cur = loadOrder();
    const next = { ...cur, ...partial, updatedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  // 既存住所があれば復元
  const o = loadOrder();
  const a = o.address || {};

  const setVal = (id,val)=>{ const el=document.getElementById(id); if(el) el.value=val||""; };
  setVal("lastName", a.lastName);
  setVal("firstName", a.firstName);
  setVal("zip", a.zip);
  setVal("addr1", a.addr1);
  setVal("addr2", a.addr2);
  setVal("tel", a.tel);

  // 戻る
  backBtn.onclick = ()=> {
    location.href = `${location.origin}/public/products.html?v=${Date.now()}`;
  };

  // 次へ
  form.onsubmit = (e)=>{
    e.preventDefault();

    const address = {
      lastName: document.getElementById("lastName").value.trim(),
      firstName: document.getElementById("firstName").value.trim(),
      zip: document.getElementById("zip").value.trim(),
      addr1: document.getElementById("addr1").value.trim(),
      addr2: document.getElementById("addr2").value.trim(),
      tel: document.getElementById("tel").value.trim(),
    };

    saveOrder({ address });

    // confirm.html へ
    location.href = `${location.origin}/public/confirm.html?v=${Date.now()}`;
  };
})();
