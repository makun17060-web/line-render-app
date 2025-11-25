// /public/products.js
// ONLINE LIFF入口。商品を選んで confirm.html へ。

(async function(){
  const grid = document.getElementById("productGrid");
  const toConfirmBtn = document.getElementById("toConfirmBtn");
  const statusMsg = document.getElementById("statusMsg");

  let lineUserId = "";
  let lineUserName = "";

  async function initLiff(){
    try{
      const confRes = await fetch("/api/liff/config?kind=online", { cache:"no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if(!liffId) throw new Error("no liffId online");

      await liff.init({ liffId });
      if(!liff.isLoggedIn()){ liff.login(); return false; }

      const prof = await liff.getProfile();
      lineUserId = prof.userId;
      lineUserName = prof.displayName;
      return true;
    }catch(e){
      console.log(e);
      statusMsg.textContent = "LIFF初期化に失敗。LINEアプリから開いてください。";
      return false;
    }
  }

  const ok = await initLiff();
  if(!ok) return;

  async function fetchProducts(){
    try{
      const res = await fetch("/api/products", { cache:"no-store" });
      const data = await res.json();
      return Array.isArray(data?.products) ? data.products : [];
    }catch(e){
      return [];
    }
  }

  const products = await fetchProducts();
  statusMsg.textContent = products.length ? "" : "商品がありません。";

  const cart = [];

  function render(){
    grid.innerHTML = "";
    products.forEach((p)=>{
      const card = document.createElement("div");
      card.className = "card";

      const img = document.createElement("img");
      img.className = "img";
      img.src = p.image || "";
      img.alt = p.name;

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.name;

      const price = document.createElement("div");
      price.className = "price";
      price.textContent = `価格：${p.price}円`;

      const qtyRow = document.createElement("div");
      qtyRow.className = "qtyRow";
      const minus = document.createElement("button");
      minus.textContent = "-";
      const plus = document.createElement("button");
      plus.textContent = "+";
      const qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.min = "1";
      qtyInput.max = "99";
      qtyInput.value = "1";

      minus.onclick = ()=> qtyInput.value = String(Math.max(1, Number(qtyInput.value||1)-1));
      plus.onclick  = ()=> qtyInput.value = String(Math.min(99, Number(qtyInput.value||1)+1));

      qtyRow.append(minus, qtyInput, plus);

      const addBtn = document.createElement("button");
      addBtn.className = "addBtn";
      addBtn.textContent = "カートに入れる";
      addBtn.onclick = ()=>{
        const q = Math.max(1, Math.min(99, Number(qtyInput.value||1)));
        const exist = cart.find(x=>x.id===p.id);
        if(exist) exist.qty += q;
        else cart.push({ id:p.id, name:p.name, price:p.price, qty:q, image:p.image||"" });
        statusMsg.textContent = `カートに追加：${p.name} x ${q}`;
      };

      card.append(img, name, price, qtyRow, addBtn);
      grid.appendChild(card);
    });
  }
  render();

  toConfirmBtn.onclick = ()=>{
    if(cart.length===0){
      statusMsg.textContent="先に商品をカートに入れてください。";
      return;
    }
    const order = {
      items: cart,
      lineUserId,
      lineUserName,
      from: "online"
    };
    sessionStorage.setItem("currentOrder", JSON.stringify(order));
    location.href = "/public/confirm.html";
  };
})();
