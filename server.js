            });
            return;
          }

          const sentTo = [];
          for (let i = 0; i < count && idx < total; i++, idx++) {
            const uid = userIds[idx];
            try {
              await client.pushMessage(uid, {
                type: "text",
                text: message,
              });
              sentTo.push(uid);
            } catch (e) {
              console.error(
                "notify-next push error:",
                e?.response?.data || e
              );
            }
          }
          state[pid].idx = idx;
          state[pid].updatedAt = new Date().toISOString();
          writeNotifyState(state);

          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: `送信：${sentTo.length}件\n進捗：${idx}/${total}`,
          });
          return;
        }

        if (t === "予約連絡停止") {
          const state = readNotifyState();
          const pid = state.__lastPid || "";
          if (pid && state[pid]) {
            delete state[pid];
          }
          writeNotifyState(state);
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: `予約連絡を停止しました。（${pid || "未指定"}）`,
          });
          return;
        }
      }

      if (t === "直接注文") {
        await client.replyMessage(ev.replyToken, productsFlex(readProducts()));
        return;
      }
      if (t === "アンケート") {
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: "アンケート機能は準備中です。",
        });
        return;
      }

      await client.replyMessage(ev.replyToken, {
        type: "text",
        text:
          "「直接注文」と送ると、商品一覧が表示されます。\n久助は「久助 2」のように、商品名＋半角個数でご入力ください。",
      });
      return;
    }

    if (ev.type === "postback") {
      const d = ev.postback?.data || "";

      if (d === "other_start") {
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = { await: "otherName" };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: "その他の商品名を入力してください。",
        });
        return;
      }

      if (d === "order_back") {
        await client.replyMessage(ev.replyToken, productsFlex(readProducts()));
        return;
      }

      if (d.startsWith("order_qty")) {
        const q = parse(d.replace(/^order_qty\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        await client.replyMessage(ev.replyToken, qtyFlex(id, qty));
        return;
      }

      if (d.startsWith("order_method")) {
        const q = parse(d.replace(/^order_method\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      if (d.startsWith("order_region")) {
        const q = parse(d.replace(/^order_region\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        await client.replyMessage(ev.replyToken, regionFlex(id, qty));
        return;
      }

      if (d.startsWith("order_payment")) {
        const q = parse(d.replace(/^order_payment\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        const method = q.method || "delivery";
        const region = q.region || "";
        await client.replyMessage(
          ev.replyToken,
          paymentFlex(id, qty, method, region)
        );
        return;
      }

      if (d.startsWith("order_confirm_view")) {
        const q = parse(d.replace(/^order_confirm_view\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        const method = q.method || "delivery";
        const region = q.region || "";
        const payment = q.payment || "cod";
        const pickupName = q.pickupName || "";

        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = {
            id,
            name: decodeURIComponent(encName || "その他"),
            price: Number(priceStr || 0),
          };
        } else {
          const products = readProducts();
          product = products.find((p) => p.id === id);
        }

        if (!product) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "商品情報が取得できませんでした。",
          });
          return;
        }

        await client.replyMessage(
          ev.replyToken,
          confirmFlex(product, qty, method, region, payment, LIFF_ID, {
            pickupName,
          })
        );
        return;
      }

      if (d.startsWith("order_confirm?")) {
        const q = parse(d.replace(/^order_confirm\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        const method = q.method || "delivery";
        const region = q.region || "";
        const payment = q.payment || "cod";
        const pickupName = q.pickupName || "";
        const uid = ev.source?.userId || "";

        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = {
            id,
            name: decodeURIComponent(encName || "その他"),
            price: Number(priceStr || 0),
          };
        } else {
          const products = readProducts();
          product = products.find((p) => p.id === id);
        }

        if (!product) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "商品が見つかりませんでした。",
          });
          return;
        }

        let productForLog = { ...product };
        if (String(id).startsWith("other:")) {
          productForLog = {
            id,
            name: product.name,
            price: product.price,
          };
        }

        try {
          const addrBook = readAddresses();
          const addr = addrBook[uid] || null;

          const regionFee =
            method === "delivery" ? SHIPPING_BY_REGION[region] || 0 : 0;
          const codFee = payment === "cod" ? COD_FEE : 0;
          const subtotal = Number(product.price) * Number(qty);
          const total = subtotal + regionFee + codFee;

          const orderRecord = {
            ts: new Date().toISOString(),
            userId: uid,
            productId: product.id,
            productName: product.name,
            price: product.price,
            qty,
            method,
            region,
            payment,
            regionFee,
            codFee,
            subtotal,
            total,
            pickupName,
            address: addr,
          };

          fs.appendFileSync(
            ORDERS_LOG,
            JSON.stringify(orderRecord) + "\n",
            "utf8"
          );

          const orderTextLines = [
            `商品：${product.name}`,
            `数量：${qty}個`,
            `受取方法：${
              method === "pickup"
                ? "店頭受取（送料0円）"
                : `宅配（${region}：${yen(regionFee)}）`
            }`,
            `支払い：${
              payment === "cod"
                ? `代金引換（+${yen(COD_FEE)})`
                : payment === "bank"
                ? "銀行振込"
                : "現金（店頭）"
            }`,
            `小計：${yen(subtotal)}`,
            `送料：${yen(regionFee)}`,
            `代引き手数料：${yen(codFee)}`,
            `合計：${yen(total)}`,
          ];

          if (method === "pickup" && pickupName) {
            orderTextLines.push(`お名前：${pickupName}`);
          }

          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "ご注文を受け付けました。\n" + orderTextLines.join("\n"),
          });

          const adminMsg =
            "【新規注文】\n" +
            orderTextLines.join("\n") +
            (addr
              ? `\n\n住所情報：\n${addr.postal || ""} ${
                  addr.prefecture || ""
                }${addr.city || ""}${addr.address1 || ""} ${
                  addr.address2 || ""
                }\n氏名：${addr.name || ""}\nTEL：${
                  addr.phone || ""
                }`
              : method === "pickup"
              ? `\n\n店頭受取：お名前=${pickupName || "未入力"}`
              : "\n\n住所情報：未登録");

          if (ADMIN_USER_ID) {
            await client.pushMessage(ADMIN_USER_ID, {
              type: "text",
              text: adminMsg,
            });
          }

          if (
            method === "pickup" &&
            product.id === "kusuke-250"
          ) {
            try {
              const r = addStock(
                "kusuke-250",
                -qty,
                "line-pickup"
              );
              await maybeLowStockAlert(
                "kusuke-250",
                product.name,
                r.after
              );
            } catch (e) {
              console.error("pickup stock error:", e);
            }
          }

          if (
            method === "delivery" &&
            product.id === "kusuke-250"
          ) {
            try {
              const r = addStock(
                "kusuke-250",
                -qty,
                "line-delivery"
              );
              await maybeLowStockAlert(
                "kusuke-250",
                product.name,
                r.after
              );
            } catch (e) {
              console.error("delivery stock error:", e);
            }
          }
        } catch (e) {
          console.error("order_confirm error:", e);
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "注文処理中にエラーが発生しました。時間をおいて再度お試しください。",
          });
        }
        return;
      }

      if (d.startsWith("order_pickup_name?")) {
        const q = parse(d.replace(/^order_pickup_name\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = {
          await: "pickupName",
          temp: { id, qty },
        };
        writeSessions(sessions);

        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: "店頭受取のご注文ですね。注文者のお名前を入力してください。",
        });
        return;
      }

      if (d.startsWith("order_reserve?")) {
        const q = parse(d.replace(/^order_reserve\?/, ""));
        const id = q.id || "";
        const qty = Number(q.qty || 1);
        const uid = ev.source?.userId || "";
        const rec = {
          ts: new Date().toISOString(),
          userId: uid,
          productId: id,
          qty,
        };
        fs.appendFileSync(
          RESERVATIONS_LOG,
          JSON.stringify(rec) + "\n",
          "utf8"
        );
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text:
            "ご予約を受け付けました。入荷次第、LINEでご案内いたします。",
        });
        return;
      }

      if (d === "order_cancel") {
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: "ご注文をキャンセルしました。",
        });
        return;
      }

      await client.replyMessage(ev.replyToken, {
        type: "text",
        text: "操作がうまく認識できませんでした。もう一度お試しください。",
      });
      return;
    }
  } catch (e) {
    console.error("handleEvent error:", e);
  }
}

// ====== ヘルスチェック ======
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ====== サーバー起動 ======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
