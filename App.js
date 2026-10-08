/* StockFlow - application entry point. Feature logic is split into ES modules. */
import {
  appState,
  initSupabase,
  loadRemote,
  refreshApp,
  reloadLocal,
  remove,
  setModeBadge,
  txOutstanding
} from "./modules/core.js";
import { $, $$, fmtDate, money, toast } from "./modules/dom.js";
import { render } from "./modules/views.js";
import {
  imagePreviewModal,
  itemModal,
  openModal,
  paymentModal,
  profileModal,
  transactionDetailModal
} from "./modules/modals.js";

window.StockFlowActions = { profileModal };

async function refreshApplication() {
  if (appState.remote) await loadRemote();
  else reloadLocal();
  render();
}

appState.refresh = refreshApplication;

async function deleteItem(itemId) {
  const used = appState.data.transactions.some(transaction => transaction.item_id === itemId);
  if (used) {
    toast("This item is referenced by transaction history and cannot be deleted.", "error");
    return;
  }

  if (!confirm("Delete this inventory item?")) return;

  try {
    await remove("inventory_items", itemId);
    toast("Item deleted.", "ok");
    await refreshApp();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteExpense(expenseId) {
  if (!confirm("Delete this operating expense?")) return;

  try {
    await remove("expenses", expenseId);
    toast("Expense deleted.", "ok");
    await refreshApp();
  } catch (error) {
    toast(error.message, "error");
  }
}

function openContactSettlement(contactId, type) {
  const transactions = appState.data.transactions.filter(transaction =>
    !transaction.voided_at &&
    transaction.contact_id === contactId &&
    txOutstanding(transaction) > 0 &&
    ((type === "credit" && transaction.type === "sold") ||
      (type === "debit" && transaction.type === "bought"))
  );

  const root = openModal(
    "Choose balance to settle",
    `<div class="contact-list">${transactions.map(transaction => `<div class="contact-card"><strong>${transaction.reference}</strong><small>${fmtDate(transaction.occurred_at)} · outstanding</small><div class="money" style="margin:5px 0">${money(txOutstanding(transaction))}</div><button class="btn pink" data-pick-pay="${transaction.id}">Pay this balance</button></div>`).join("")}</div>`
  );

  root.querySelectorAll("[data-pick-pay]").forEach(button => {
    button.onclick = () => {
      $("#modal-root").innerHTML = "";
      paymentModal(button.dataset.pickPay);
    };
  });
}

function wire() {
  $$(".tab").forEach(tab => {
    tab.onclick = () => {
      appState.currentView = tab.dataset.view;
      location.hash = appState.currentView;
      render();
    };
  });

  window.addEventListener("hashchange", () => {
    appState.currentView = location.hash.replace("#", "") || "ctas";
    render();
  });

  // Delegated handlers cover dynamically rendered lists.
  $("#app").addEventListener("click", event => {
    const imagePreview = event.target.closest("[data-preview-item]");
    if (imagePreview) {
      const item = appState.data.inventory.find(item => item.id === imagePreview.dataset.previewItem);
      if (item) imagePreviewModal(item);
      return;
    }

    const itemEdit = event.target.closest("[data-edit-item]");
    if (itemEdit) itemModal(appState.data.inventory.find(item => item.id === itemEdit.dataset.editItem));

    const itemDelete = event.target.closest("[data-delete-item]");
    if (itemDelete) deleteItem(itemDelete.dataset.deleteItem);

    const transaction = event.target.closest("[data-view-tx]");
    if (transaction) transactionDetailModal(transaction.dataset.viewTx);

    const settle = event.target.closest("[data-settle]");
    if (settle) {
      const matching = appState.data.transactions.filter(record =>
        !record.voided_at &&
        record.contact_id === settle.dataset.settle &&
        Number(record.total_amount || 0) > 0 &&
        record.type === (settle.dataset.settleType === "credit" ? "sold" : "bought")
      ).filter(record => {
        const payments = appState.data.payments.filter(payment => payment.transaction_id === record.id).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
        const returns = appState.data.returns.filter(returnRecord => returnRecord.original_transaction_id === record.id && !returnRecord.voided_at).reduce((sum, returnRecord) => sum + Number(returnRecord.balance_adjustment || 0), 0);
        return Math.max(0, Number(record.total_amount || 0) - payments - returns) > 0;
      });

      if (matching.length === 1) paymentModal(matching[0].id);
      else openContactSettlement(settle.dataset.settle, settle.dataset.settleType);
    }

    const expense = event.target.closest("[data-del-exp]");
    if (expense) deleteExpense(expense.dataset.delExp);
  });
}

wire();
initSupabase().finally(() => {
  setModeBadge();
  render();
});
