import {
  appState,
  contactBy,
  itemBy,
  stockBase,
  txOutstanding,
  paidFor,
  txLines
} from "./core.js";
import { $, esc, fmtDate, fmtDay, money, num, toast } from "./dom.js";
import {
  contactModal,
  expenseModal,
  itemModal,
  loginGoogle,
  transactionModal
} from "./modals.js";

const pageSize = () => Math.max(5, Number(appState.pageSize || 25));
function pageData(key, rows) {
  const size = pageSize();
  const pages = Math.max(1, Math.ceil(rows.length / size));
  appState.pages ||= {};
  const current = Math.min(Math.max(1, Number(appState.pages[key] || 1)), pages);
  appState.pages[key] = current;
  return { rows: rows.slice((current - 1) * size, current * size), current, pages, total: rows.length, start: rows.length ? (current - 1) * size + 1 : 0, end: Math.min(current * size, rows.length) };
}
function paginationMarkup(key, count) {
  const size = pageSize();
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(Math.max(1, Number(appState.pages?.[key] || 1)), pages);
  if (count <= size) return "";
  const start = (current - 1) * size + 1;
  const end = Math.min(current * size, count);
  return `<div class="pagination"><span>${start}–${end} of ${count}</span><div class="pagination-actions"><button class="btn" data-page-key="${key}" data-page-value="${current - 1}" ${current <= 1 ? "disabled" : ""}>Previous</button><span>Page ${current} of ${pages}</span><button class="btn" data-page-key="${key}" data-page-value="${current + 1}" ${current >= pages ? "disabled" : ""}>Next</button></div></div>`;
}
function paged(key, rows) { return pageData(key, rows); }
function wirePagination() {
  $("#app").querySelectorAll("[data-page-key]").forEach(button => {
    button.onclick = () => {
      appState.pages[button.dataset.pageKey] = Number(button.dataset.pageValue);
      render();
    };
  });
}
function preserveInputRender(inputId, renderFn) {
  const input = $("#" + inputId);
  const start = input?.selectionStart;
  const end = input?.selectionEnd;
  renderFn();
  const next = $("#" + inputId);
  if (next) {
    next.focus();
    try { next.setSelectionRange(start, end); } catch { /* number/date input */ }
  }
}

export function render() {
  const names = { ctas: "CTAs", inventory: "Inventory", transactions: "Transactions", credit: "Credit / Debit", pnl: "P & L" };
  if (!Object.prototype.hasOwnProperty.call(names, appState.currentView)) appState.currentView = "ctas";
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === appState.currentView));
  $("#breadcrumb-current").textContent = names[appState.currentView];
  renderProfile();
  if (appState.currentView === "ctas") renderCTAs();
  if (appState.currentView === "inventory") renderInventory();
  if (appState.currentView === "transactions") renderTransactions();
  if (appState.currentView === "credit") renderCredit();
  if (appState.currentView === "pnl") renderPNL();
  wirePagination();
}

function renderProfile() {
  const profile = appState.data.profile;
  if (!profile) {
    $("#profile-area").innerHTML = `<button class="btn primary" id="login-btn">Continue with Google</button>`;
    $("#login-btn").onclick = loginGoogle;
    return;
  }
  $("#profile-area").innerHTML = `<div class="profile"><img class="avatar" src="${esc(profile.avatar_url || "")}" onerror="this.style.display='none'"><div><div class="profile-name">${esc(profile.full_name || profile.email)}</div><button id="profile-btn">Profile / Sign out</button></div></div>`;
  $("#profile-btn").onclick = () => window.StockFlowActions?.profileModal?.();
}

function renderCTAs() {
  const transactions = [...appState.data.transactions].filter(transaction => !transaction.voided_at).slice(0, 10);
  $("#app").innerHTML = `
    <section class="page-head"><div><h1>StockFlow</h1><p>Record what you sell, buy, or manufacture. Keep stock, customer balances, and bills in one place.</p></div></section>
    <section class="cta-grid">
      ${cta("sold", "Sold", "Record a customer sale with one or more items and collect payment now or later.", "Open Sold")}
      ${cta("bought", "Bought", "Record a supplier purchase with multiple products and partial payments.", "Open Bought")}
      ${cta("made", "Made", "Record finished products, optional material use, and production cost.", "Open Made")}
    </section>
    <section class="card"><div class="card-head"><h2>Recent transactions</h2><div class="actions"><button class="btn" id="open-all-tx">View all</button></div></div>${transactionTable(transactions)}</section>`;
  $("#app").querySelectorAll("[data-cta]").forEach(button => button.onclick = () => transactionModal(button.dataset.cta));
  $("#open-all-tx").onclick = () => { appState.currentView = "transactions"; location.hash = "transactions"; render(); };
}
function cta(kind, title, text, label) {
  return `<article class="cta-card ${kind}"><h2>${title}</h2><p>${text}</p><button class="btn" data-cta="${kind}">${label} →</button></article>`;
}

function transactionLinesLabel(transaction) {
  const lines = txLines(transaction.id);
  if (!lines.length) return "Item";
  return lines.length === 1 ? lines[0].item_name : `${lines[0].item_name} + ${lines.length - 1} more`;
}
function transactionTable(transactions) {
  if (!transactions.length) return `<div class="empty">No matching transactions.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Type</th><th>Items</th><th>Party</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Date</th><th></th></tr></thead><tbody>
    ${transactions.map(transaction => {
      const party = contactBy(transaction.contact_id)?.name || "—";
      const outstanding = txOutstanding(transaction);
      const paid = paidFor(transaction.id);
      return `<tr><td data-label="Reference"><strong>${esc(transaction.reference)}</strong></td><td data-label="Type"><span class="badge ${transaction.type === "sold" ? "pink" : transaction.type === "made" ? "amber" : "blue"}">${esc(transaction.type)}</span></td><td data-label="Items">${esc(transactionLinesLabel(transaction))}</td><td data-label="Party">${esc(party)}</td><td data-label="Total" class="money">${money(transaction.total_amount)}</td><td data-label="Paid" class="money">${money(paid)}</td><td data-label="Outstanding" class="money">${transaction.type === "made" ? "—" : money(outstanding)}</td><td data-label="Date">${fmtDate(transaction.occurred_at)}</td><td data-label="Action"><button class="btn ghost" data-view-tx="${transaction.id}">Open</button></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function renderInventory() {
  const query = String(appState.inventoryFilter || "").trim().toLowerCase();
  const filtered = [...appState.data.inventory].filter(item => !query || [item.name, item.sku, item.base_unit].some(value => String(value || "").toLowerCase().includes(query)));
  const page = paged("inventory", filtered);
  $("#app").innerHTML = `
    <section class="page-head"><div><h1>Inventory</h1><p>Search stock, edit products, and see current quantities and reference prices.</p></div><div class="actions"><button class="btn pink" id="add-item">+ Add item</button></div></section>
    <section class="card"><div class="card-head"><h2>Items (${filtered.length})</h2><div class="filters"><input id="inventory-filter" type="search" placeholder="Search name, SKU, unit..." value="${esc(appState.inventoryFilter)}" autocomplete="off"></div></div>${inventoryTable(page.rows)}${paginationMarkup("inventory", filtered.length)}</section>`;
  $("#add-item").onclick = () => itemModal();
  $("#inventory-filter").oninput = event => { appState.inventoryFilter = event.target.value; appState.pages.inventory = 1; preserveInputRender("inventory-filter", renderInventory); wirePagination(); };
}
function inventoryTable(items) {
  if (!items.length) return `<div class="empty">No matching inventory items.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Stock</th><th>Base unit</th><th>Retail ref.</th><th>Wholesale ref.</th><th>Conversions</th><th></th></tr></thead><tbody>
    ${items.map(item => `<tr><td data-label="Item"><div class="item-cell">${item.photos?.[0] ? `<button class="thumb-button" data-preview-item="${item.id}" title="Preview photos"><img class="thumb" src="${esc(item.photos[0])}" alt="${esc(item.name)}"></button>` : `<div class="thumb"></div>`}<div><div class="item-name">${esc(item.name)}</div><div class="muted">${esc(item.sku || "")}</div></div></div></td><td data-label="Stock" class="money">${stockBase(item).toLocaleString("en-IN")}</td><td data-label="Base unit">${esc(item.base_unit || "unit")}</td><td data-label="Retail ref." class="money">${money(item.retail_price)}</td><td data-label="Wholesale ref." class="money">${money(item.wholesale_price)}</td><td data-label="Conversions">${(item.conversions || []).length}</td><td data-label="Actions" class="row-actions">${item.photos?.length ? `<button class="btn ghost" data-preview-item="${item.id}">View photos</button>` : ""}<button class="btn ghost" data-edit-item="${item.id}">Edit</button><button class="btn danger" data-delete-item="${item.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
}

function renderTransactions() {
  const query = String(appState.transactionSearch || "").trim().toLowerCase();
  let filtered = [...appState.data.transactions].filter(transaction => !transaction.voided_at);
  if (appState.transactionTypeFilter) filtered = filtered.filter(transaction => transaction.type === appState.transactionTypeFilter);
  if (query) filtered = filtered.filter(transaction => {
    const contact = contactBy(transaction.contact_id);
    const lineNames = txLines(transaction.id).map(line => `${line.item_name} ${line.item_sku || ""}`).join(" ");
    return [transaction.reference, transaction.type, contact?.name, contact?.phone, contact?.email, lineNames].some(value => String(value || "").toLowerCase().includes(query));
  });
  const page = paged("transactions", filtered);
  $("#app").innerHTML = `
    <section class="page-head"><div><h1>Transactions</h1><p>One transaction can contain multiple products. Payments remain linked to the full bill.</p></div><div class="actions"><button class="btn pink" id="new-sale">+ Sold</button><button class="btn" id="new-buy">+ Bought</button><button class="btn" id="new-made">+ Made</button></div></section>
    <section class="card"><div class="card-head"><h2>Transaction history (${filtered.length})</h2><div class="filters"><input id="tx-search" type="search" placeholder="Search ref, item, customer..." value="${esc(appState.transactionSearch)}" autocomplete="off"><select id="tx-type"><option value="" ${appState.transactionTypeFilter === "" ? "selected" : ""}>All types</option><option value="sold" ${appState.transactionTypeFilter === "sold" ? "selected" : ""}>Sold</option><option value="bought" ${appState.transactionTypeFilter === "bought" ? "selected" : ""}>Bought</option><option value="made" ${appState.transactionTypeFilter === "made" ? "selected" : ""}>Made</option></select></div></div>${transactionTable(page.rows)}${paginationMarkup("transactions", filtered.length)}</section>`;
  $("#new-sale").onclick = () => transactionModal("sold");
  $("#new-buy").onclick = () => transactionModal("bought");
  $("#new-made").onclick = () => transactionModal("made");
  $("#tx-type").onchange = event => { appState.transactionTypeFilter = event.target.value; appState.pages.transactions = 1; renderTransactions(); wirePagination(); };
  $("#tx-search").oninput = event => { appState.transactionSearch = event.target.value; appState.pages.transactions = 1; preserveInputRender("tx-search", renderTransactions); wirePagination(); };
}

function renderCredit() {
  const credits = {};
  const debits = {};
  appState.data.transactions.filter(transaction => !transaction.voided_at && ["sold", "bought"].includes(transaction.type)).forEach(transaction => {
    const contact = contactBy(transaction.contact_id);
    if (!contact) return;
    const outstanding = txOutstanding(transaction);
    if (!outstanding) return;
    const map = transaction.type === "sold" ? credits : debits;
    map[contact.id] = (map[contact.id] || 0) + outstanding;
  });

  const contactQuery = String(appState.contactSearch || "").trim().toLowerCase();
  const matchingContacts = [...appState.data.contacts].filter(contact => !contactQuery || [contact.name, contact.phone, contact.email, contact.kind].some(value => String(value || "").toLowerCase().includes(contactQuery)));
  const contactPage = paged("contacts", matchingContacts);
  const creditHtml = balanceCards(credits, "customer", "credit", appState.creditSearch || "", "credit");
  const debitHtml = balanceCards(debits, "supplier", "debit", appState.debitSearch || "", "debit");

  $("#app").innerHTML = `
    <section class="page-head"><div><h1>Credit / Debit</h1><p>Credit is money customers owe you. Debit is money you owe suppliers. Record payments against existing transactions.</p></div><div class="actions"><button class="btn pink" id="add-contact">+ Contact</button></div></section>
    <div class="split">
      <section class="card"><div class="card-head"><h2>Credit — customers owe you</h2><div class="filters"><input id="credit-search" type="search" placeholder="Search customers..." value="${esc(appState.creditSearch || "")}" autocomplete="off"></div></div><div class="card-body"><div id="credit-list">${creditHtml}</div>${paginationMarkup("credit", balanceRows(credits,"customer",appState.creditSearch||"").length)}</div></section>
      <section class="card"><div class="card-head"><h2>Debit — you owe suppliers</h2><div class="filters"><input id="debit-search" type="search" placeholder="Search suppliers..." value="${esc(appState.debitSearch || "")}" autocomplete="off"></div></div><div class="card-body"><div id="debit-list">${debitHtml}</div>${paginationMarkup("debit", balanceRows(debits,"supplier",appState.debitSearch||"").length)}</div></section>
    </div>
    <section class="card" style="margin-top:16px"><div class="card-head"><h2>Contacts (${matchingContacts.length})</h2><div class="filters"><input id="contact-search" type="search" placeholder="Search name, phone, email..." value="${esc(appState.contactSearch || "")}" autocomplete="off"></div></div><div class="card-body"><div class="contact-list">${contactPage.rows.map(contact => `<div class="contact-card"><strong>${esc(contact.name)}</strong><small>${esc(contact.kind)} · ${esc(contact.phone || contact.email || "No contact detail")}</small><div style="margin-top:8px" class="inline"><button class="btn" data-contact="${contact.id}">Open</button></div></div>`).join("") || `<div class="empty">No matching contacts.</div>`}</div>${paginationMarkup("contacts", matchingContacts.length)}</div></section>`;
  $("#add-contact").onclick = () => contactModal();
  $("#credit-search").oninput = event => { appState.creditSearch = event.target.value; appState.pages.credit = 1; preserveInputRender("credit-search", renderCredit); wirePagination(); };
  $("#debit-search").oninput = event => { appState.debitSearch = event.target.value; appState.pages.debit = 1; preserveInputRender("debit-search", renderCredit); wirePagination(); };
  $("#contact-search").oninput = event => { appState.contactSearch = event.target.value; appState.pages.contacts = 1; preserveInputRender("contact-search", renderCredit); wirePagination(); };
  $("#app").querySelectorAll("[data-contact]").forEach(button => button.onclick = () => contactModal(button.dataset.contact));
}
function balanceRows(map, kind, search = "") {
  const query = search.trim().toLowerCase();
  return Object.entries(map).map(([contactId, balance]) => ({ contact: contactBy(contactId), balance })).filter(row => row.contact && row.contact.kind === kind && (!query || [row.contact.name,row.contact.phone,row.contact.email].some(value => String(value || "").toLowerCase().includes(query))));
}
function balanceCards(map, kind, type, search = "", pageKey = "credit") {
  const all = balanceRows(map, kind, search);
  const page = paged(pageKey, all);
  if (!all.length) return `<div class="empty">No matching ${type} balances.</div>`;
  return page.rows.map(row => `<div class="contact-card" style="margin-bottom:10px"><strong>${esc(row.contact.name)}</strong><div class="money" style="font-size:20px;margin:5px 0">${money(row.balance)}</div><small>${kind} · ${esc(row.contact.phone || row.contact.email || "No contact detail")} · outstanding across ${appState.data.transactions.filter(transaction => transaction.contact_id === row.contact.id && !transaction.voided_at).length} transaction(s)</small><div style="margin-top:8px"><button class="btn pink" data-settle="${row.contact.id}" data-settle-type="${type}">Record payment</button></div></div>`).join("");
}

function renderPNL() {
  const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
  const startStr = appState.pnlStart || start.toISOString().slice(0,10); const endStr = appState.pnlEnd || new Date().toISOString().slice(0,10);
  const calculate = (from,to) => {
    const begin = new Date(`${from}T00:00:00`); const end = new Date(`${to}T23:59:59.999`);
    const inRange = date => { const value = new Date(date); return value >= begin && value <= end; };
    const activeTransactions = appState.data.transactions.filter(transaction => !transaction.voided_at && inRange(transaction.occurred_at));
    const sales = activeTransactions.filter(transaction => transaction.type === "sold");
    const customerReturns = appState.data.returns.filter(row => !row.voided_at && row.kind === "customer_return" && inRange(row.occurred_at));
    const revenue = sales.reduce((sum, transaction) => sum + num(transaction.total_amount), 0) - customerReturns.reduce((sum, row) => sum + num(row.amount), 0);
    const cogs = sales.reduce((sum, transaction) => sum + num(transaction.cost_total), 0) - customerReturns.reduce((sum, row) => sum + num(row.amount_cost || 0), 0);
    const madeCost = activeTransactions.filter(transaction => transaction.type === "made").reduce((sum, transaction) => sum + num(transaction.cost_total), 0);
    const opEx = appState.data.expenses.filter(expense => inRange(expense.occurred_at)).reduce((sum, expense) => sum + num(expense.amount), 0);
    const gross = revenue - cogs; const net = gross - opEx;
    return { revenue, cogs, madeCost, opEx, gross, net };
  };
  const initial = calculate(startStr, endStr);
  const query = String(appState.expenseSearch || "").trim().toLowerCase();
  const matchingExpenses = [...appState.data.expenses].filter(expense => !query || [expense.category,expense.description].some(value => String(value || "").toLowerCase().includes(query)));
  const expensePage = paged("expenses", matchingExpenses);
  $("#app").innerHTML = `
    <section class="page-head"><div><h1>P &amp; L</h1><p>Revenue minus sold inventory cost and operating expenses. Inventory purchases remain in stock cost until sold.</p></div><div class="actions"><button class="btn pink" id="add-expense">+ Expense</button></div></section>
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Report</h2><div class="filters"><input type="date" id="pnl-start" value="${startStr}"><input type="date" id="pnl-end" value="${endStr}"></div></div><div class="card-body"><div id="pnl-kpis" class="grid-3"></div><div class="note" style="margin-top:14px">COGS is the historical line-level cost snapshot on sales. Customer returns reduce recognized revenue; purchased stock is not expensed until sold.</div></div></section>
    <section class="card"><div class="card-head"><h2>Operating expenses (${matchingExpenses.length})</h2><div class="filters"><input id="expense-search" type="search" placeholder="Search category, description..." value="${esc(appState.expenseSearch || "")}" autocomplete="off"></div></div>${expenseTable(expensePage.rows)}${paginationMarkup("expenses", matchingExpenses.length)}</section>`;
  const paint = values => { $("#pnl-kpis").innerHTML = `${kpi("Revenue", values.revenue, "positive")}${kpi("COGS", values.cogs)}${kpi("Gross profit", values.gross, values.gross >= 0 ? "positive" : "negative")}${kpi("Production costs", values.madeCost)}${kpi("Operating expenses", values.opEx)}${kpi("Net profit", values.net, values.net >= 0 ? "positive" : "negative")}`; };
  paint(initial); $("#add-expense").onclick = expenseModal;
  const refreshReport = () => { const from = $("#pnl-start").value; const to = $("#pnl-end").value; appState.pnlStart = from; appState.pnlEnd = to; if (from && to && from <= to) paint(calculate(from,to)); else toast("Choose a valid date range.", "error"); };
  $("#pnl-start").onchange = refreshReport; $("#pnl-end").onchange = refreshReport;
  $("#expense-search").oninput = event => { appState.expenseSearch = event.target.value; appState.pages.expenses = 1; preserveInputRender("expense-search", renderPNL); wirePagination(); };
}
function kpi(label,value,cls="") { return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${money(value)}</div></div>`; }
function expenseTable(expenses) {
  if (!expenses.length) return `<div class="empty">No matching operating expenses.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th></th></tr></thead><tbody>${expenses.map(expense => `<tr><td data-label="Date">${fmtDay(expense.occurred_at)}</td><td data-label="Category">${esc(expense.category)}</td><td data-label="Description">${esc(expense.description || "")}</td><td data-label="Amount" class="money">${money(expense.amount)}</td><td data-label="Action"><button class="btn danger" data-del-exp="${expense.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
}
