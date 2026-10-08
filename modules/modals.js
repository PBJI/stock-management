import {
  appState,
  contactBy,
  ensureProfile,
  estimateCOGS,
  getConfig,
  initSupabase,
  insert,
  itemBy,
  paidFor,
  remove,
  saveLocal,
  setModeBadge,
  stockBase,
  txOutstanding,
  txPayments,
  txStatus,
  unitMultiplier,
  unitOptions,
  recordInventoryTransaction,
  updateInventoryTransaction,
  recordPayment,
  recordReturn,
  voidTransaction,
  update,
  refreshApp
} from "./core.js";
import { $, clone, esc, fmtDate, money, num, todayISO, toast } from "./dom.js";

export function openModal(title, body, { wide = false, onClose } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop" data-backdrop><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true"><div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close>×</button></div><div class="modal-content">${body}</div></div></div>`;

  const close = () => {
    root.innerHTML = "";
    onClose?.();
  };

  // Attach the same close behavior to BOTH the header close button and every
  // footer Cancel/Close button. The old implementation only wired the first match.
  root.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", close);
  });

  $("[data-backdrop]", root).addEventListener("click", event => {
    if (event.target.dataset.backdrop) close();
  });

  return root;
}

export function transactionModal(type, existing = null) {
  const isMade = type === "made";
  const item = itemBy(existing?.item_id);
  const contacts = appState.data.contacts.filter(
    contact => isMade || contact.kind === (type === "sold" ? "customer" : "supplier")
  );
  const initialPaid = existing ? paidFor(existing.id) : 0;

  const body = `
      <form id="tx-form">
        <div class="form-grid">
          <div class="field"><label>Type</label><select id="tx-type-input" ${existing ? "disabled" : ""}><option value="sold" ${type === "sold" ? "selected" : ""}>Sold</option><option value="bought" ${type === "bought" ? "selected" : ""}>Bought</option><option value="made" ${isMade ? "selected" : ""}>Made</option></select></div>
          <div class="field"><label>Reference</label><input id="tx-ref" value="${esc(existing?.reference || `TX-${Date.now().toString(36).toUpperCase()}`)}" required></div>
          <div class="field"><label>Product</label><select id="tx-item" required><option value="">Select product</option>${appState.data.inventory.map(inventoryItem => `<option value="${inventoryItem.id}" ${existing?.item_id === inventoryItem.id ? "selected" : ""}>${esc(inventoryItem.name)} · stock ${stockBase(inventoryItem)} ${esc(inventoryItem.base_unit || "unit")}</option>`).join("")}</select></div>
          ${isMade ? `<div></div>` : `
            <div class="field">
              <label>${type === "sold" ? "Customer" : "Supplier"}</label>
              <input
                id="tx-contact-search"
                type="search"
                list="tx-contact-options"
                placeholder="Search ${type === "sold" ? "customer" : "supplier"}..."
                autocomplete="off"
                value="${esc(existing ? contactBy(existing.contact_id)?.name || "" : "")}"
                ${contacts.length ? "required" : ""}
              >
              <datalist id="tx-contact-options">
                ${contacts.map(contact => `<option value="${esc(contact.name)}">`).join("")}
              </datalist>
              <input id="tx-contact" type="hidden" value="${esc(existing?.contact_id || "")}">
              <span class="help">Search by customer/supplier name. Email is not required.</span>
            </div>
          `}
          <div class="field"><label>Quantity</label><input id="tx-qty" type="number" min="0.000001" step="any" value="${existing?.quantity || ""}" required></div>
          <div class="field"><label>Unit</label><select id="tx-unit"></select></div>
          <div class="field"><label>${isMade ? "Production cost / unit" : "Actual price / unit"}</label><input id="tx-price" type="number" min="0" step="0.01" value="${existing?.unit_price ?? ""}" required></div>
          <div class="field"><label>Total</label><input id="tx-total" class="readonly" readonly value="${money(existing?.total_amount || 0)}"></div>
          ${isMade ? `` : `<div class="field"><label>Amount paid now</label><input id="tx-paid" type="number" min="0" step="0.01" value="${initialPaid}" ${existing ? "disabled" : ""}><span class="help">Additional payments are recorded later from Credit / Debit.</span></div>
          <div class="field"><label>Payment method</label><select id="tx-method"><option value="">Not specified</option><option>cash</option><option>upi</option><option>bank transfer</option><option>card</option><option>other</option></select></div>`}
          <div class="field"><label>Date / time</label><input id="tx-date" type="datetime-local" value="${existing ? new Date(existing.occurred_at).toISOString().slice(0, 16) : todayISO()}" required></div>
        </div>
        <div id="tx-summary" class="summary-box"></div>
        <div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">${existing ? "Save changes" : `Record ${isMade ? "Made" : type === "sold" ? "Sold" : "Bought"}`}</button></div>
      </form>`;

  const root = openModal(`${existing ? "Edit " : "Record "}${isMade ? "Made" : type === "sold" ? "Sold" : "Bought"}`, body, { wide: true });
  const itemEl = $("#tx-item", root);
  const unitEl = $("#tx-unit", root);
  const qtyEl = $("#tx-qty", root);
  const priceEl = $("#tx-price", root);
  const totalEl = $("#tx-total", root);
  const paidEl = $("#tx-paid", root);
  const summary = $("#tx-summary", root);
  const contactSearchEl = $("#tx-contact-search", root);
  const contactHiddenEl = $("#tx-contact", root);

  if (contactSearchEl && contactHiddenEl) {
    const syncContact = () => {
      const value = contactSearchEl.value.trim().toLowerCase();
      const match = contacts.find(contact => contact.name.trim().toLowerCase() === value);
      contactHiddenEl.value = match?.id || "";
    };

    contactSearchEl.addEventListener("input", syncContact);
    contactSearchEl.addEventListener("change", syncContact);
  }

  function refreshUnits() {
    const selectedItem = itemBy(itemEl.value);
    const units = selectedItem ? unitOptions(selectedItem) : [{ name: "unit", multiplier: 1 }];
    unitEl.innerHTML = units
      .map(unit => `<option value="${esc(unit.name)}">${esc(unit.name)} × ${unit.multiplier}</option>`)
      .join("");

    if (existing?.unit) unitEl.value = existing.unit;
    calculate();
  }

  function calculate() {
    const total = num(qtyEl.value) * num(priceEl.value);
    totalEl.value = money(total);
    const paid = num(paidEl?.value);
    const outstanding = Math.max(0, total - paid);

    summary.innerHTML = `<div><small>Total</small><strong>${money(total)}</strong></div><div><small>Paid</small><strong>${money(paid)}</strong></div><div><small>${isMade ? "Inventory added" : "Outstanding"}</small><strong>${isMade ? "No receivable/payable" : money(outstanding)}</strong></div>`;
  }

  itemEl.onchange = refreshUnits;
  qtyEl.oninput = calculate;
  priceEl.oninput = calculate;
  if (paidEl) paidEl.oninput = calculate;
  refreshUnits();

  $("#tx-form", root).onsubmit = async event => {
    event.preventDefault();

    try {
      const selectedItem = itemBy(itemEl.value);
      if (!selectedItem) throw Error("Select a product.");

      const quantity = num(qtyEl.value);
      const price = num(priceEl.value);
      const total = Math.round(quantity * price * 100) / 100;
      const unit = unitEl.value;
      const multiplier = unitMultiplier(selectedItem, unit);

      if (!isMade && !contactHiddenEl?.value) {
        throw Error(`Select a ${type === "sold" ? "customer" : "supplier"}.`);
      }

      if (quantity <= 0 || price < 0) throw Error("Quantity and price must be valid.");

      const baseDelta = quantity * multiplier * (isMade || type === "bought" ? 1 : -1);

      if (type === "sold" && !existing && stockBase(selectedItem) + baseDelta < -0.000001) {
        throw Error("Not enough stock.");
      }

      if (existing) {
        if (txPayments(existing.id).length) {
          throw Error("This transaction has payments. Use payment settlement/voiding instead of editing its financial total.");
        }

        await updateInventoryTransaction({
          transaction_id: existing.id,
          reference: $("#tx-ref", root).value.trim(),
          type,
          item_id: selectedItem.id,
          contact_id: isMade ? null : $("#tx-contact", root)?.value || null,
          quantity,
          unit,
          base_quantity: quantity * multiplier,
          unit_price: price,
          total_amount: total,
          cost_total: isMade ? total : estimateCOGS(selectedItem, quantity * multiplier),
          occurred_at: new Date($("#tx-date", root).value).toISOString()
        });
        toast("Transaction updated.", "ok");
      } else {
        const transaction = await recordInventoryTransaction({
          reference: $("#tx-ref", root).value.trim(),
          type,
          item_id: selectedItem.id,
          contact_id: isMade ? null : $("#tx-contact", root).value || null,
          quantity,
          unit,
          base_quantity: quantity * multiplier,
          unit_price: price,
          total_amount: total,
          cost_total: isMade ? total : estimateCOGS(selectedItem, quantity * multiplier),
          occurred_at: new Date($("#tx-date", root).value).toISOString(),
          initial_payment: isMade ? 0 : num(paidEl?.value),
          payment_method: isMade ? null : $("#tx-method", root).value || null
        });

        toast(`${isMade ? "Made" : "Transaction"} recorded.`, "ok");
      }

      $("#modal-root").innerHTML = "";
      await refreshApp();
    } catch (error) {
      toast(error.message || "Could not save transaction.", "error");
    }
  };
}

export function transactionDetailModal(txid) {
  const transaction = appState.data.transactions.find(item => item.id === txid);
  if (!transaction) return;

  const item = itemBy(transaction.item_id);
  const payments = txPayments(transaction.id);
  const outstanding = txOutstanding(transaction);
  const body = `<div class="grid-2">
      <div><div class="note">${esc(transaction.reference)} · ${esc(transaction.type)} · ${transaction.voided_at ? "VOIDED" : txStatus(transaction)}</div><div style="margin-top:12px"><strong>${esc(item?.name || "Unknown item")}</strong><br><span class="muted">${transaction.quantity} ${esc(transaction.unit || item?.base_unit || "unit")} · ${money(transaction.unit_price)} each</span></div></div>
      <div class="kpi"><div class="label">Outstanding</div><div class="value">${money(outstanding)}</div></div>
    </div>
    <div style="margin-top:18px"><h3>Payment history</h3>${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th></tr></thead><tbody>${payments.map(payment => `<tr><td>${fmtDate(payment.paid_at)}</td><td class="money">${money(payment.amount)}</td><td>${esc(payment.method || "—")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No payments recorded.</div>`}</div>
    <div class="form-footer">${!transaction.voided_at && transaction.type !== "made" && outstanding > 0 ? `<button class="btn pink" id="detail-pay">Record payment</button>` : ""}${!transaction.voided_at && transaction.type !== "made" ? `<button class="btn" id="detail-return">Return</button>` : ""}${!transaction.voided_at ? `<button class="btn" id="detail-edit">Edit</button><button class="btn danger" id="detail-void">Void / reverse</button>` : ""}<button class="btn" data-close>Close</button></div>`;

  const root = openModal("Transaction details", body, { wide: true });

  $("#detail-pay", root)?.addEventListener("click", () => {
    $("#modal-root").innerHTML = "";
    paymentModal(transaction.id);
  });

  $("#detail-return", root)?.addEventListener("click", () => {
    $("#modal-root").innerHTML = "";
    returnModal(transaction);
  });

  $("#detail-edit", root)?.addEventListener("click", () => {
    $("#modal-root").innerHTML = "";
    transactionModal(transaction.type, transaction);
  });

  $("#detail-void", root)?.addEventListener("click", async () => {
    if (!confirm("Void this transaction? Its inventory effect will be reversed. This is safer than deleting financial history.")) return;

    try {
      await voidTransaction(transaction.id);
      toast("Transaction voided and inventory reversed.", "ok");
      $("#modal-root").innerHTML = "";
      await refreshApp();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

export function returnModal(transaction) {
  const item = itemBy(transaction.item_id);
  const alreadyReturned = appState.data.returns
    .filter(returnRecord => returnRecord.original_transaction_id === transaction.id && !returnRecord.voided_at)
    .reduce((sum, returnRecord) => sum + num(returnRecord.quantity), 0);
  const remaining = Math.max(0, num(transaction.quantity) - alreadyReturned);
  const maxAmount = Math.max(0, num(transaction.total_amount) * (remaining / Math.max(1, num(transaction.quantity))));
  const kind = transaction.type === "sold" ? "customer_return" : "supplier_return";

  const root = openModal(
    transaction.type === "sold" ? "Customer return" : "Supplier return",
    `<form id="return-form">
      <div class="note">${transaction.type === "sold" ? "Returned customer stock is added back to inventory." : "Returned supplier stock is removed from inventory."} The return stays linked to ${esc(transaction.reference)}.</div>
      <div class="form-grid" style="margin-top:14px">
        <div class="field"><label>Product</label><input class="readonly" readonly value="${esc(item?.name || "Unknown")}"></div>
        <div class="field"><label>Remaining returnable quantity</label><input class="readonly" readonly value="${remaining} ${esc(transaction.unit || item?.base_unit || "unit")}"></div>
        <div class="field"><label>Return quantity</label><input id="r-qty" type="number" min="0.000001" max="${remaining}" step="any" required></div>
        <div class="field"><label>Return value</label><input id="r-amount" type="number" min="0" max="${maxAmount}" step="0.01" required></div>
        <div class="field"><label>Refund / money returned</label><input id="r-refund" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>Date / time</label><input id="r-date" type="datetime-local" value="${todayISO()}" required></div>
      </div>
      <div class="help" style="margin-top:8px">Return value reduces the original Credit/Debit balance. A refund records money actually returned; it does not create a new Sold/Bought transaction.</div>
      <div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">Record return</button></div>
    </form>`
  );

  $("#r-qty", root).oninput = () => {
    const quantity = num($("#r-qty", root).value);
    $("#r-amount", root).value = Math.min(
      maxAmount,
      quantity * (num(transaction.total_amount) / Math.max(1, num(transaction.quantity)))
    ).toFixed(2);
  };

  $("#return-form", root).onsubmit = async event => {
    event.preventDefault();

    try {
      const quantity = num($("#r-qty", root).value);
      const amount = num($("#r-amount", root).value);
      const refund = num($("#r-refund", root).value);

      if (quantity <= 0 || quantity > remaining) {
        throw Error("Return quantity exceeds the remaining returnable quantity.");
      }
      if (amount < 0 || amount > maxAmount + 0.000001) {
        throw Error("Return value is invalid.");
      }
      if (refund > amount + 0.000001) {
        throw Error("Refund cannot exceed the return value.");
      }

      const baseQuantity = quantity * unitMultiplier(item, transaction.unit || item.base_unit);
      await recordReturn({
        original_transaction_id: transaction.id,
        quantity,
        base_quantity: baseQuantity,
        amount,
        refund_amount: refund,
        balance_adjustment: amount,
        amount_cost: num(transaction.cost_total) * (baseQuantity / Math.max(0.000001, num(transaction.base_quantity))),
        occurred_at: new Date($("#r-date", root).value).toISOString()
      });

      toast("Return recorded and inventory adjusted.", "ok");
      $("#modal-root").innerHTML = "";
      await refreshApp();
    } catch (error) {
      toast(error.message, "error");
    }
  };
}

export function paymentModal(txid) {
  const transaction = appState.data.transactions.find(item => item.id === txid);
  const outstanding = txOutstanding(transaction);
  if (!transaction || outstanding <= 0) return;

  const root = openModal(
    "Record payment against existing balance",
    `<form id="payment-form">
      <div class="note">${transaction.type === "sold" ? "Customer payment — reduces Credit" : "Supplier payment — reduces Debit"} for <strong>${esc(contactBy(transaction.contact_id)?.name || "party")}</strong>. This does not create another transaction.</div>
      <div class="form-grid" style="margin-top:14px"><div class="field"><label>Remaining outstanding</label><input class="readonly" readonly value="${money(outstanding)}"></div><div class="field"><label>Amount</label><input id="pay-amount" type="number" min="0.01" max="${outstanding}" step="0.01" required></div><div class="field"><label>Payment method</label><select id="pay-method"><option>cash</option><option>upi</option><option>bank transfer</option><option>card</option><option>other</option></select></div><div class="field"><label>Date / time</label><input id="pay-date" type="datetime-local" value="${todayISO()}" required></div></div>
      <div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">Save payment</button></div>
    </form>`
  );

  $("#payment-form", root).onsubmit = async event => {
    event.preventDefault();

    try {
      const amount = num($("#pay-amount", root).value);
      if (amount <= 0 || amount > outstanding + 0.000001) {
        throw Error("Payment exceeds remaining outstanding.");
      }

      await recordPayment({
        transaction_id: txid,
        amount,
        method: $("#pay-method", root).value,
        paid_at: new Date($("#pay-date", root).value).toISOString()
      });

      toast("Payment recorded.", "ok");
      $("#modal-root").innerHTML = "";
      await refreshApp();
    } catch (error) {
      toast(error.message, "error");
    }
  };
}

export function itemModal(existing = null) {
  const body = `<form id="item-form"><div class="form-grid">
      <div class="field"><label>Name</label><input id="item-name" required value="${esc(existing?.name || "")}"></div>
      <div class="field"><label>SKU / reference</label><input id="item-sku" value="${esc(existing?.sku || "")}"></div>
      <div class="field"><label>Opening stock</label><input id="item-stock" type="number" min="0" step="any" value="${existing ? stockBase(existing) : 0}" ${existing ? "disabled" : ""}></div>
      <div class="field"><label>Base unit</label><input id="item-unit" placeholder="piece, kg, litre..." value="${esc(existing?.base_unit || "piece")}" required></div>
      <div class="field"><label>Retail reference price / base unit</label><input id="item-retail" type="number" min="0" step="0.01" value="${existing?.retail_price ?? 0}"></div>
      <div class="field"><label>Wholesale reference price / base unit</label><input id="item-wholesale" type="number" min="0" step="0.01" value="${existing?.wholesale_price ?? 0}"></div>
      <div class="field full"><label>Photos (maximum 4)</label><input id="item-photos" type="text" placeholder="Paste image URLs separated by commas" value="${esc((existing?.photos || []).join(", "))}"><span class="help">Only the first four URLs are stored; lists show only one thumbnail.</span></div>
      <div class="field full"><label>Sub-unit / packaging conversions</label><div id="conversion-list"></div><button type="button" class="btn" id="add-conv">+ Add conversion</button><span class="help">Example: packet × 10 means 1 packet = 10 base units.</span></div>
    </div><div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">${existing ? "Save item" : "Create item"}</button></div></form>`;

  const root = openModal(existing ? "Edit inventory item" : "Add inventory item", body, { wide: true });
  let conversions = clone(existing?.conversions || []);

  function drawConversions() {
    $("#conversion-list", root).innerHTML = conversions
      .map((conversion, index) => `<div class="inline" style="margin:6px 0"><input data-c-name="${index}" value="${esc(conversion.name)}" placeholder="packet" style="flex:1"><input data-c-mult="${index}" type="number" min="1" step="any" value="${conversion.multiplier}" style="width:120px"><button type="button" class="btn danger" data-rm-c="${index}">×</button></div>`)
      .join("") || `<div class="muted">No conversions.</div>`;
  }

  $("#add-conv", root).onclick = () => {
    conversions.push({ name: "", multiplier: 1 });
    drawConversions();
  };

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-rm-c]");
    if (!button) return;
    conversions.splice(Number(button.dataset.rmC), 1);
    drawConversions();
  });

  drawConversions();

  $("#item-form", root).onsubmit = async event => {
    event.preventDefault();

    try {
      conversions = conversions
        .map((conversion, index) => ({
          name: $(`[data-c-name="${index}"]`, root).value.trim(),
          multiplier: num($(`[data-c-mult="${index}"]`, root).value)
        }))
        .filter(conversion => conversion.name && conversion.multiplier > 0);

      const photos = $("#item-photos", root).value
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
        .slice(0, 4);

      const payload = {
        name: $("#item-name", root).value.trim(),
        sku: $("#item-sku", root).value.trim() || null,
        base_unit: $("#item-unit", root).value.trim(),
        retail_price: num($("#item-retail", root).value),
        wholesale_price: num($("#item-wholesale", root).value),
        photos,
        conversions
      };

      if (!payload.name) throw Error("Name is required.");

      if (existing) {
        await update("inventory_items", existing.id, payload);
      } else {
        await insert("inventory_items", {
          ...payload,
          current_stock_base: num($("#item-stock", root).value),
          average_cost_base: 0
        });
      }

      toast(existing ? "Item updated." : "Item created.", "ok");
      $("#modal-root").innerHTML = "";
      await refreshApp();
    } catch (error) {
      toast(error.message, "error");
    }
  };
}

export function imagePreviewModal(item) {
  if (!item?.photos?.length) {
    toast("This item has no photos.", "error");
    return;
  }

  const photos = item.photos.slice(0, 4);

  openModal(
    `${item.name} — Photos`,
    `<div class="image-preview-grid">
      ${photos.map((photo, index) => `
        <button class="image-preview-card" type="button" data-preview-src="${esc(photo)}" title="Open image ${index + 1}">
          <img src="${esc(photo)}" alt="${esc(item.name)} photo ${index + 1}" loading="lazy" onerror="this.closest('.image-preview-card').classList.add('image-error')">
        </button>
      `).join("")}
    </div>
    <div class="help" style="margin-top:10px">Tap an image to open it larger.</div>` ,
    { wide: true }
  );

  const root = $("#modal-root");
  root.querySelectorAll("[data-preview-src]").forEach(button => {
    button.addEventListener("click", () => {
      const src = button.dataset.previewSrc;
      if (!src) return;

      openModal(
        item.name,
        `<div class="single-image-preview"><img src="${esc(src)}" alt="${esc(item.name)}"></div>`,
        { wide: true }
      );
    });
  });
}

export function contactModal(existingId = null) {
  const existing = existingId ? contactBy(existingId) : null;
  const root = openModal(
    existing ? "Edit contact" : "Add contact",
    `<form id="contact-form"><div class="form-grid">
      <div class="field"><label>Name</label><input id="c-name" value="${esc(existing?.name || "")}" required autocomplete="name"></div>
      <div class="field"><label>Type</label><select id="c-kind"><option ${existing?.kind === "customer" ? "selected" : ""}>customer</option><option ${existing?.kind === "supplier" ? "selected" : ""}>supplier</option></select></div>
      <div class="field"><label>Phone</label><input id="c-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" value="${esc(existing?.phone || "")}"></div>
      <div class="field"><label>Email <span class="muted">(optional)</span></label><input id="c-email" type="email" autocomplete="email" placeholder="Optional" value="${esc(existing?.email || "")}"></div>
      <div class="field full"><button type="button" class="btn" id="pick-phone">Choose from phone contacts</button><span class="help">Phone-only contacts are supported. Email is optional.</span></div>
    </div><div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">Save contact</button></div></form>`
  );

  $("#pick-phone", root).onclick = async () => {
    if (!navigator.contacts?.select) {
      toast("Phone contact selection is not available in this browser. Enter the name and phone manually.", "error");
      return;
    }

    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: false });
      const contact = picked?.[0];
      if (!contact) return;

      const name = Array.isArray(contact.name) ? contact.name[0] : contact.name || "";
      const phone = Array.isArray(contact.tel) ? contact.tel[0] : contact.tel || "";

      if (name) $("#c-name", root).value = name;
      if (phone) $("#c-phone", root).value = phone;
    } catch (error) {
      if (error?.name !== "AbortError") {
        toast("Could not read the selected phone contact.", "error");
      }
    }
  };

  $("#contact-form", root).onsubmit = async event => {
    event.preventDefault();

    try {
      const payload = {
        name: $("#c-name", root).value.trim(),
        kind: $("#c-kind", root).value,
        phone: $("#c-phone", root).value.trim() || null,
        email: $("#c-email", root).value.trim() || null
      };

      if (existing) await update("contacts", existing.id, payload);
      else await insert("contacts", payload);

      toast("Contact saved.", "ok");
      $("#modal-root").innerHTML = "";
      await refreshApp();
    } catch (error) {
      toast(error.message, "error");
    }
  };
}

export function expenseModal() {
  const root = openModal(
    "Add operating expense",
    `<form id="expense-form"><div class="form-grid"><div class="field"><label>Category</label><select id="e-cat"><option>rent</option><option>electricity</option><option>transport</option><option>salaries</option><option>packaging</option><option>marketing</option><option>other</option></select></div><div class="field"><label>Amount</label><input id="e-amount" type="number" min="0.01" step="0.01" required></div><div class="field full"><label>Description</label><input id="e-desc"></div><div class="field"><label>Date</label><input id="e-date" type="datetime-local" value="${todayISO()}" required></div></div><div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">Save expense</button></div></form>`
  );

  $("#expense-form", root).onsubmit = async event => {
    event.preventDefault();

    try {
      await insert("expenses", {
        category: $("#e-cat", root).value,
        amount: num($("#e-amount", root).value),
        description: $("#e-desc", root).value.trim() || null,
        occurred_at: new Date($("#e-date", root).value).toISOString()
      });

      toast("Expense recorded.", "ok");
      $("#modal-root").innerHTML = "";
      await refreshApp();
    } catch (error) {
      toast(error.message, "error");
    }
  };
}

export function profileModal() {
  const profile = appState.data.profile;
  const cfg = getConfig() || {};
  const root = openModal(
    "Profile & connection",
    `<div class="grid-2"><div class="card-body"><strong>${esc(profile.full_name || profile.email)}</strong><div class="muted">${esc(profile.email)}</div><div class="form-footer" style="justify-content:flex-start"><button class="btn danger" id="signout">Sign out</button></div></div><div class="card-body"><strong>Supabase connection</strong><p class="muted">Publishable/anon key is safe to expose in a browser only when RLS is correctly configured.</p><div class="field"><label>Project URL</label><input id="sb-url" value="${esc(cfg.url || "")}" placeholder="https://xxxx.supabase.co"></div><div class="field" style="margin-top:9px"><label>Publishable / anon key</label><input id="sb-key" value="${esc(cfg.key || "")}" placeholder="eyJ..."></div><div class="form-footer" style="justify-content:flex-start"><button class="btn pink" id="connect-sb">Save & connect</button><button class="btn" id="local-mode">Use local mode</button></div></div></div>`
  );

  $("#signout", root).onclick = async () => {
    if (appState.supabase) await appState.supabase.auth.signOut();
    appState.data.profile = null;
    appState.remote = false;
    appState.session = null;
    setModeBadge();
    $("#modal-root").innerHTML = "";
    await refreshApp();
  };

  $("#connect-sb", root).onclick = async () => {
    const url = $("#sb-url", root).value.trim();
    const key = $("#sb-key", root).value.trim();
    if (!url || !key) {
      toast("Enter both Supabase values.", "error");
      return;
    }

    localStorage.setItem(LS.config, JSON.stringify({ url, key }));
    await initSupabase();
    $("#modal-root").innerHTML = "";

    if (appState.remote) toast("Supabase connected.", "ok");
    else toast("Saved. Sign in with Google to enter Supabase mode.", "ok");
    await refreshApp();
  };

  $("#local-mode", root).onclick = async () => {
    localStorage.removeItem(LS.config);
    appState.supabase = null;
    appState.session = null;
    appState.remote = false;
    appState.data.profile = null;
    setModeBadge();
    $("#modal-root").innerHTML = "";
    await refreshApp();
    toast("Local mode enabled.", "ok");
  };
}

export async function loginGoogle() {
  if (!appState.supabase) {
    toast("Configure Supabase first from Profile / Sign out after connecting, or continue in Local mode.", "error");
    return;
  }

  const { error } = await appState.supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname }
  });

  if (error) toast(error.message, "error");
}
