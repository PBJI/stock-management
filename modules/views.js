import {
  appState,
  contactBy,
  itemBy,
  stockBase,
  txOutstanding,
  paidFor
} from "./core.js";
import { $, esc, fmtDate, fmtDay, money, num, toast } from "./dom.js";
import {
  contactModal,
  expenseModal,
  itemModal,
  loginGoogle,
  transactionModal
} from "./modals.js";

export function render() {
  const names = {
    ctas: "CTAs",
    inventory: "Inventory",
    transactions: "Transactions",
    credit: "Credit / Debit",
    pnl: "P & L"
  };

  if (!["ctas", "inventory", "transactions", "credit", "pnl"].includes(appState.currentView)) {
    appState.currentView = "ctas";
  }

  document.querySelectorAll(".tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.view === appState.currentView);
  });

  $("#breadcrumb-current").textContent = names[appState.currentView];
  renderProfile();

  if (appState.currentView === "ctas") renderCTAs();
  if (appState.currentView === "inventory") renderInventory();
  if (appState.currentView === "transactions") renderTransactions();
  if (appState.currentView === "credit") renderCredit();
  if (appState.currentView === "pnl") renderPNL();
}

function renderProfile() {
  const profile = appState.data.profile;

  if (!profile) {
    $("#profile-area").innerHTML = `<button class="btn primary" id="login-btn">Continue with Google</button>`;
    $("#login-btn").onclick = loginGoogle;
    return;
  }

  $("#profile-area").innerHTML = `<div class="profile"><img class="avatar" src="${esc(profile.avatar_url || "")}" onerror="this.style.display='none'"><div><div class="profile-name">${esc(profile.full_name || profile.email)}</div><button id="profile-btn">Profile / Sign out</button></div></div>`;
  // app.js wires this callback after imports so views stay presentation-only.
  $("#profile-btn").onclick = () => window.StockFlowActions?.profileModal?.();
}

function renderCTAs() {
  const transactions = [...appState.data.transactions]
    .filter(transaction => !transaction.voided_at)
    .slice(0, 10);

  $("#app").innerHTML = `
      <section class="page-head"><div><h1>CTAs</h1><p>Record the three things that move stock: sold, bought, and made. No dashboard clutter.</p></div></section>
      <section class="cta-grid">
        ${cta("sold", "Sold", "Record a customer sale and collect payment now or later.", "Open Sold")}
        ${cta("bought", "Bought", "Record a supplier purchase, including unpaid amounts.", "Open Bought")}
        ${cta("made", "Made", "Add manufactured stock and capture its production cost.", "Open Made")}
      </section>
      <section class="card"><div class="card-head"><h2>Recent transactions</h2><div class="actions"><button class="btn" id="open-all-tx">View all</button></div></div>${transactionTable(transactions)}</section>`;

  $("#app").querySelectorAll("[data-cta]").forEach(button => {
    button.onclick = () => transactionModal(button.dataset.cta);
  });

  $("#open-all-tx").onclick = () => {
    appState.currentView = "transactions";
    location.hash = "transactions";
    render();
  };
}

function cta(kind, title, text, label) {
  return `<article class="cta-card ${kind}"><h2>${title}</h2><p>${text}</p><button class="btn" data-cta="${kind}">${label} →</button></article>`;
}

function transactionsForList() {
  let transactions = [...appState.data.transactions].filter(transaction => !transaction.voided_at);
  if (appState.currentView === "transactions" && appState.transactionTypeFilter) {
    transactions = transactions.filter(transaction => transaction.type === appState.transactionTypeFilter);
  }
  return transactions;
}

function transactionTable(transactions) {
  if (!transactions.length) return `<div class="empty">No transactions yet. Use Sold, Bought or Made above.</div>`;

  return `<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Type</th><th>Item</th><th>Party</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Date</th><th></th></tr></thead><tbody>
      ${transactions.map(transaction => {
        const party = contactBy(transaction.contact_id)?.name || "—";
        const item = itemBy(transaction.item_id);
        const outstanding = txOutstanding(transaction);
        const paid = paidFor(transaction.id);
        return `<tr>
          <td data-label="Reference"><strong>${esc(transaction.reference)}</strong></td>
          <td data-label="Type"><span class="badge ${transaction.type === "sold" ? "pink" : "blue"}">${esc(transaction.type)}</span></td>
          <td data-label="Item">${esc(item?.name || "Deleted item")}</td>
          <td data-label="Party">${esc(party)}</td>
          <td data-label="Total" class="money">${money(transaction.total_amount)}</td>
          <td data-label="Paid" class="money">${money(paid)}</td>
          <td data-label="Outstanding" class="money">${money(outstanding)}</td>
          <td data-label="Date">${fmtDate(transaction.occurred_at)}</td>
          <td data-label="Action"><button class="btn ghost" data-view-tx="${transaction.id}">Open</button></td>
        </tr>`;
      }).join("")}</tbody></table></div>`;
}

function renderInventory() {
  let items = [...appState.data.inventory];
  if (appState.inventoryFilter) {
    const query = appState.inventoryFilter.toLowerCase();
    items = items.filter(item => item.name.toLowerCase().includes(query) || String(item.sku || "").toLowerCase().includes(query));
  }

  $("#app").innerHTML = `
      <section class="page-head"><div><h1>Inventory</h1><p>Keep stock simple: one base unit, optional packaging conversions, reference prices, and a current quantity.</p></div><div class="actions"><button class="btn pink" id="add-item">+ Add item</button></div></section>
      <section class="card"><div class="card-head"><h2>Items</h2><div class="filters"><input id="inventory-filter" placeholder="Filter items..." value="${esc(appState.inventoryFilter)}"></div></div>${inventoryTable(items)}</section>`;

  $("#add-item").onclick = () => itemModal();
  $("#inventory-filter").oninput = event => {
    appState.inventoryFilter = event.target.value;
    renderInventory();
  };
}

function inventoryTable(items) {
  if (!items.length) return `<div class="empty">No inventory items yet.</div>`;

  return `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Stock</th><th>Base unit</th><th>Retail ref.</th><th>Wholesale ref.</th><th>Conversions</th><th></th></tr></thead><tbody>
      ${items.map(item => `<tr>
        <td data-label="Item">
          <div class="item-cell">
            ${item.photos?.[0] ? `<button class="thumb-button" data-preview-item="${item.id}" title="Preview photos"><img class="thumb" src="${esc(item.photos[0])}" alt="${esc(item.name)}"></button>` : `<div class="thumb"></div>`}
            <div><div class="item-name">${esc(item.name)}</div><div class="muted">${esc(item.sku || "")}</div></div>
          </div>
        </td>
        <td data-label="Stock" class="money">${stockBase(item).toLocaleString("en-IN")}</td>
        <td data-label="Base unit">${esc(item.base_unit || "unit")}</td>
        <td data-label="Retail ref." class="money">${money(item.retail_price)}</td>
        <td data-label="Wholesale ref." class="money">${money(item.wholesale_price)}</td>
        <td data-label="Conversions">${(item.conversions || []).length}</td>
        <td data-label="Actions" class="row-actions">
          ${item.photos?.length ? `<button class="btn ghost" data-preview-item="${item.id}">View photos</button>` : ""}
          <button class="btn ghost" data-edit-item="${item.id}">Edit</button>
          <button class="btn danger" data-delete-item="${item.id}">Delete</button>
        </td>
      </tr>`).join("")}</tbody></table></div>`;
}

function renderTransactions() {
  $("#app").innerHTML = `
      <section class="page-head"><div><h1>Transactions</h1><p>Historical prices are kept on each transaction. Payments are separate records, so partial settlement stays auditable.</p></div><div class="actions"><button class="btn pink" id="new-sale">+ Sold</button><button class="btn" id="new-buy">+ Bought</button><button class="btn" id="new-made">+ Made</button></div></section>
      <section class="card"><div class="card-head"><h2>Transaction history</h2><div class="filters"><select id="tx-type"><option value="" ${appState.transactionTypeFilter === "" ? "selected" : ""}>All types</option><option value="sold" ${appState.transactionTypeFilter === "sold" ? "selected" : ""}>sold</option><option value="bought" ${appState.transactionTypeFilter === "bought" ? "selected" : ""}>bought</option><option value="made" ${appState.transactionTypeFilter === "made" ? "selected" : ""}>made</option></select></div></div>${transactionTable(transactionsForList())}</section>`;

  $("#new-sale").onclick = () => transactionModal("sold");
  $("#new-buy").onclick = () => transactionModal("bought");
  $("#new-made").onclick = () => transactionModal("made");

  $("#tx-type").onchange = event => {
    appState.transactionTypeFilter = event.target.value;
    renderTransactions();
  };
}

function renderCredit() {
  const credits = {};
  const debits = {};

  appState.data.transactions
    .filter(transaction => !transaction.voided_at && (transaction.type === "sold" || transaction.type === "bought"))
    .forEach(transaction => {
      const contact = contactBy(transaction.contact_id);
      if (!contact) return;

      const outstanding = txOutstanding(transaction);
      if (!outstanding) return;

      const map = transaction.type === "sold" ? credits : debits;
      map[contact.id] = (map[contact.id] || 0) + outstanding;
    });

  $("#app").innerHTML = `
      <section class="page-head"><div><h1>Credit / Debit</h1><p>Credit is money customers owe you. Debit is money you owe suppliers. Payments here settle existing balances; they do not create new sales or purchases.</p></div><div class="actions"><button class="btn pink" id="add-contact">+ Contact</button></div></section>
      <div class="split">
        <section class="card">
          <div class="card-head">
            <h2>Credit — customers owe you</h2>
            <div class="filters"><input id="credit-search" type="search" placeholder="Search customers..." autocomplete="off"></div>
          </div>
          <div class="card-body"><div id="credit-list">${balanceCards(credits, "customer", "credit")}</div></div>
        </section>
        <section class="card">
          <div class="card-head">
            <h2>Debit — you owe suppliers</h2>
            <div class="filters"><input id="debit-search" type="search" placeholder="Search suppliers..." autocomplete="off"></div>
          </div>
          <div class="card-body"><div id="debit-list">${balanceCards(debits, "supplier", "debit")}</div></div>
        </section>
      </div>
      <section class="card" style="margin-top:16px"><div class="card-head"><h2>Contacts</h2></div><div class="card-body"><div class="contact-list">${appState.data.contacts.map(contact => `<div class="contact-card"><strong>${esc(contact.name)}</strong><small>${esc(contact.kind)} · ${esc(contact.phone || contact.email || "No contact detail")}</small><div style="margin-top:8px" class="inline"><button class="btn" data-contact="${contact.id}">Open</button></div></div>`).join("") || `<div class="empty">No contacts yet.</div>`}</div></div></section>`;

  $("#add-contact").onclick = () => contactModal();

  $("#credit-search").oninput = event => {
    $("#credit-list").innerHTML = balanceCards(credits, "customer", "credit", event.target.value);
  };

  $("#debit-search").oninput = event => {
    $("#debit-list").innerHTML = balanceCards(debits, "supplier", "debit", event.target.value);
  };

  $("#app").querySelectorAll("[data-contact]").forEach(button => {
    button.onclick = () => contactModal(button.dataset.contact);
  });
}

function balanceCards(map, kind, type, search = "") {
  const query = search.trim().toLowerCase();

  const rows = Object.entries(map)
    .map(([contactId, balance]) => ({ contact: contactBy(contactId), balance }))
    .filter(row => row.contact)
    .filter(row => {
      if (!query) return true;
      return [row.contact.name, row.contact.phone, row.contact.email]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(query));
    });

  if (!rows.length) return `<div class="empty">No matching ${type} balances.</div>`;

  return rows.map(row => `<div class="contact-card" style="margin-bottom:10px"><strong>${esc(row.contact.name)}</strong><div class="money" style="font-size:20px;margin:5px 0">${money(row.balance)}</div><small>${kind} · ${esc(row.contact.phone || row.contact.email || "No contact detail")} · outstanding across ${appState.data.transactions.filter(transaction => transaction.contact_id === row.contact.id && !transaction.voided_at).length} transaction(s)</small><div style="margin-top:8px"><button class="btn pink" data-settle="${row.contact.id}" data-settle-type="${type}">Record payment</button></div></div>`).join("");
}

function renderPNL() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = new Date().toISOString().slice(0, 10);

  const calculate = (from, to) => {
    const begin = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T23:59:59.999`);
    const inRange = date => {
      const value = new Date(date);
      return value >= begin && value <= end;
    };

    const activeTransactions = appState.data.transactions.filter(transaction => !transaction.voided_at && inRange(transaction.occurred_at));
    const sales = activeTransactions.filter(transaction => transaction.type === "sold");
    const revenue = sales.reduce((sum, transaction) => sum + num(transaction.total_amount), 0)
      - appState.data.returns.filter(returnRecord => !returnRecord.voided_at && returnRecord.kind === "customer_return" && inRange(returnRecord.occurred_at)).reduce((sum, returnRecord) => sum + num(returnRecord.amount), 0);
    const cogs = sales.reduce((sum, transaction) => sum + num(transaction.cost_total), 0)
      - appState.data.returns.filter(returnRecord => !returnRecord.voided_at && returnRecord.kind === "customer_return" && inRange(returnRecord.occurred_at)).reduce((sum, returnRecord) => sum + num(returnRecord.amount_cost || 0), 0);
    const madeCost = activeTransactions.filter(transaction => transaction.type === "made").reduce((sum, transaction) => sum + num(transaction.cost_total), 0);
    const opEx = appState.data.expenses.filter(expense => inRange(expense.occurred_at)).reduce((sum, expense) => sum + num(expense.amount), 0);
    const gross = revenue - cogs;
    const net = gross - opEx;
    return { revenue, cogs, madeCost, opEx, gross, net };
  };

  const initial = calculate(startStr, endStr);

  $("#app").innerHTML = `
      <section class="page-head"><div><h1>P &amp; L</h1><p>Revenue minus inventory cost of goods sold and operating expenses. Inventory purchases are not immediately expensed while stock remains on hand.</p></div><div class="actions"><button class="btn pink" id="add-expense">+ Expense</button></div></section>
      <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Report</h2><div class="filters"><input type="date" id="pnl-start" value="${startStr}"><input type="date" id="pnl-end" value="${endStr}"></div></div><div class="card-body"><div id="pnl-kpis" class="grid-3"></div><div class="note" style="margin-top:14px">COGS is taken from the historical <strong>cost_total</strong> snapshot on sales. Customer returns reduce recognized revenue; inventory purchases remain on the balance sheet until their stock is sold.</div></div></section>
      <section class="card"><div class="card-head"><h2>Operating expenses</h2></div>${expenseTable()}</section>`;

  function paint(values) {
    $("#pnl-kpis").innerHTML = `${kpi("Revenue", values.revenue, "positive")}${kpi("COGS", values.cogs)}${kpi("Gross profit", values.gross, values.gross >= 0 ? "positive" : "negative")}${kpi("Production costs", values.madeCost)}${kpi("Operating expenses", values.opEx)}${kpi("Net profit", values.net, values.net >= 0 ? "positive" : "negative")}`;
  }

  paint(initial);
  $("#add-expense").onclick = expenseModal;

  const refreshReport = () => {
    const startValue = $("#pnl-start").value;
    const endValue = $("#pnl-end").value;
    if (startValue && endValue && startValue <= endValue) paint(calculate(startValue, endValue));
    else toast("Choose a valid date range.", "error");
  };

  $("#pnl-start").onchange = refreshReport;
  $("#pnl-end").onchange = refreshReport;
}

function kpi(label, value, cls = "") {
  return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${money(value)}</div></div>`;
}

function expenseTable() {
  if (!appState.data.expenses.length) return `<div class="empty">No operating expenses recorded.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th></th></tr></thead><tbody>${appState.data.expenses.map(expense => `<tr><td data-label="Date">${fmtDay(expense.occurred_at)}</td><td data-label="Category">${esc(expense.category)}</td><td data-label="Description">${esc(expense.description || "")}</td><td data-label="Amount" class="money">${money(expense.amount)}</td><td data-label="Action"><button class="btn danger" data-del-exp="${expense.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
}
