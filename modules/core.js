import { $, clone, id, num, toast } from "./dom.js";

export const LS = {
  config: "stockflow.supabase.config.v1",
  local: "stockflow.local.data.v1"
};

const TABLES = {
  inventory: "inventory_items",
  inventory_items: "inventory_items",
  payments: "transaction_payments",
  transaction_payments: "transaction_payments",
  transactions: "transactions",
  contacts: "contacts",
  expenses: "expenses",
  returns: "returns",
  transactionLines: "transaction_lines",
  transaction_lines: "transaction_lines",
  productionMaterials: "production_materials",
  production_materials: "production_materials",
  profiles: "profiles"
};

export const DEFAULT = {
  inventory: [],
  contacts: [],
  transactions: [],
  payments: [],
  expenses: [],
  returns: [],
  transactionLines: [],
  productionMaterials: [],
  profile: null
};

function remoteTable(table) {
  return TABLES[table] || table;
}

function loadLocal() {
  try {
    const data = { ...clone(DEFAULT), ...(JSON.parse(localStorage.getItem(LS.local) || "{}")) };
    data.transactionLines ||= [];
    data.productionMaterials ||= [];
    // Local-mode migration: older saves had only one item on the transaction header.
    for (const tx of data.transactions || []) {
      if (data.transactionLines.some(line => line.transaction_id === tx.id)) continue;
      const item = (data.inventory || []).find(row => row.id === tx.item_id);
      data.transactionLines.push({
        id: `${tx.id}-line-1`, transaction_id: tx.id, line_no: 1, item_id: tx.item_id,
        item_name: item?.name || "Item", item_sku: item?.sku || null, quantity: tx.quantity,
        unit: tx.unit || item?.base_unit || "unit", base_quantity: tx.base_quantity,
        unit_price: tx.unit_price, line_total: tx.total_amount, cost_total: tx.cost_total || 0
      });
    }
    return data;
  } catch {
    return clone(DEFAULT);
  }
}

export function saveLocal() {
  localStorage.setItem(LS.local, JSON.stringify(appState.data));
}

export function reloadLocal() {
  appState.data = loadLocal();
}

export const appState = {
  data: loadLocal(),
  supabase: null,
  session: null,
  remote: false,
  currentView: location.hash.replace("#", "") || "ctas",
  transactionTypeFilter: "",
  transactionSearch: "",
  inventoryFilter: "",
  contactSearch: "",
  creditSearch: "",
  debitSearch: "",
  expenseSearch: "",
  pnlStart: "",
  pnlEnd: "",
  pageSize: 25,
  pages: { inventory: 1, transactions: 1, contacts: 1, credit: 1, debit: 1, expenses: 1 },
  refresh: null
};

export function getConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(LS.config) || "null");
    if (stored?.url && stored?.key) return stored;
    return {
      key: "sb_publishable_tznBtVHYGs50DEiRDiMcuQ_doK8j4jT",
      url: "https://evkgpqxnefxlnzgrvxqk.supabase.co"
    };
  } catch {
    return null;
  }
}

export function setModeBadge() {
  const badge = $("#mode-badge");
  if (!badge) return;
  badge.textContent = appState.remote ? "Supabase mode" : "Local mode";
  badge.className = `mode-badge ${appState.remote ? "remote" : "local"}`;
}

export async function initSupabase() {
  const cfg = getConfig();
  if (!cfg?.url || !cfg?.key || !window.supabase?.createClient) return;

  try {
    appState.supabase = window.supabase.createClient(cfg.url, cfg.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });

    const { data: sessionData, error: sessionError } = await appState.supabase.auth.getSession();
    if (sessionError) throw sessionError;

    appState.session = sessionData.session;
    appState.remote = !!appState.session;

    appState.supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      appState.session = nextSession;
      appState.remote = !!nextSession;
      setModeBadge();

      if (nextSession) await ensureProfile();
      await loadRemote();
      if (appState.refresh) await appState.refresh();
    });

    setModeBadge();
    if (appState.session) {
      await ensureProfile();
      await loadRemote();
    }
  } catch (error) {
    console.error(error);
    toast(error.message || "Supabase connection failed.", "error");
    appState.supabase = null;
    appState.remote = false;
    setModeBadge();
  }
}

export async function ensureProfile() {
  if (!appState.session || !appState.supabase) return;

  const user = appState.session.user;
  const profile = {
    id: user.id,
    email: user.email || "",
    full_name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || "User",
    avatar_url: user.user_metadata?.avatar_url || null
  };

  const { error } = await appState.supabase
    .from("profiles")
    .upsert(profile, { onConflict: "id" });

  if (error) console.warn("Profile upsert:", error.message);
  appState.data.profile = profile;
}

export async function loadRemote() {
  if (!appState.remote || !appState.supabase) return;

  const uid = appState.session.user.id;
  const [inventory, contacts, transactions, payments, expenses, returns, transactionLines, productionMaterials] = await Promise.all([
    appState.supabase.from("inventory_items").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
    appState.supabase.from("contacts").select("*").eq("user_id", uid).order("name"),
    appState.supabase.from("transactions").select("*").eq("user_id", uid).order("occurred_at", { ascending: false }),
    appState.supabase.from("transaction_payments").select("*").eq("user_id", uid).order("paid_at"),
    appState.supabase.from("expenses").select("*").eq("user_id", uid).order("occurred_at", { ascending: false }),
    appState.supabase.from("returns").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
    appState.supabase.from("transaction_lines").select("*").eq("user_id", uid).order("line_no"),
    appState.supabase.from("production_materials").select("*").eq("user_id", uid).order("created_at")
  ]);

  for (const result of [inventory, contacts, transactions, payments, expenses, returns, transactionLines, productionMaterials]) {
    if (result.error) {
      toast(result.error.message, "error");
      return;
    }
  }

  appState.data.inventory = inventory.data || [];
  appState.data.contacts = contacts.data || [];
  appState.data.transactions = transactions.data || [];
  appState.data.payments = payments.data || [];
  appState.data.expenses = expenses.data || [];
  appState.data.returns = returns.data || [];
  appState.data.transactionLines = transactionLines.data || [];
  appState.data.productionMaterials = productionMaterials.data || [];
}

export async function insert(table, row) {
  if (appState.remote) {
    const realTable = remoteTable(table);
    const { data, error } = await appState.supabase
      .from(realTable)
      .insert({ ...row, user_id: appState.session.user.id })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  if (!appState.data[table]) throw Error(`Unknown local collection: ${table}`);
  const record = {
    ...row,
    id: row.id || id(table.slice(0, 4))
  };
  appState.data[table].push(record);
  saveLocal();
  return record;
}

export async function update(table, rowId, patch) {
  if (appState.remote) {
    const realTable = remoteTable(table);
    const { data, error } = await appState.supabase
      .from(realTable)
      .update(patch)
      .eq("id", rowId)
      .eq("user_id", appState.session.user.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const records = appState.data[table];
  if (!records) throw Error(`Unknown local collection: ${table}`);
  const index = records.findIndex(record => record.id === rowId);
  if (index < 0) throw Error("Record not found");

  records[index] = { ...records[index], ...patch };
  saveLocal();
  return records[index];
}

export async function remove(table, rowId) {
  if (appState.remote) {
    const realTable = remoteTable(table);
    const { error } = await appState.supabase
      .from(realTable)
      .delete()
      .eq("id", rowId)
      .eq("user_id", appState.session.user.id);

    if (error) throw error;
    return;
  }

  appState.data[table] = appState.data[table].filter(record => record.id !== rowId);
  saveLocal();
}

export async function callRPC(functionName, args) {
  if (!appState.remote || !appState.supabase || !appState.session) {
    throw Error("Sign in to Supabase before using this operation.");
  }

  const { data, error } = await appState.supabase.rpc(functionName, args);
  if (error) throw error;
  return data;
}

export async function recordInventoryTransaction(payload) {
  if (!appState.remote) {
    return recordMultiItemTransaction({
      reference: payload.reference, type: payload.type, contact_id: payload.contact_id ?? null,
      lines: [{ item_id: payload.item_id, quantity: payload.quantity, unit: payload.unit, unit_price: payload.unit_price }],
      materials: [], occurred_at: payload.occurred_at, initial_payment: payload.initial_payment ?? 0,
      payment_method: payload.payment_method ?? null, payment_at: payload.payment_at ?? payload.occurred_at ?? null
    });
  }
  return callRPC("record_inventory_transaction", {
    p_reference: payload.reference, p_type: payload.type, p_item_id: payload.item_id,
    p_contact_id: payload.contact_id ?? null, p_quantity: payload.quantity, p_unit: payload.unit,
    p_base_quantity: payload.base_quantity, p_unit_price: payload.unit_price, p_total_amount: payload.total_amount,
    p_cost_total: payload.cost_total, p_occurred_at: payload.occurred_at,
    p_initial_payment: payload.initial_payment ?? 0, p_payment_method: payload.payment_method ?? null,
    p_payment_at: payload.payment_at ?? payload.occurred_at ?? null
  });
}

export async function updateInventoryTransaction(payload) {
  if (appState.remote) {
    return callRPC("update_inventory_transaction", {
      p_transaction_id: payload.transaction_id, p_reference: payload.reference, p_type: payload.type,
      p_item_id: payload.item_id, p_contact_id: payload.contact_id ?? null, p_quantity: payload.quantity,
      p_unit: payload.unit, p_base_quantity: payload.base_quantity, p_unit_price: payload.unit_price,
      p_total_amount: payload.total_amount, p_cost_total: payload.cost_total, p_occurred_at: payload.occurred_at
    });
  }
  const tx = appState.data.transactions.find(row => row.id === payload.transaction_id);
  if (!tx) throw Error("Transaction not found.");
  if (txPayments(tx.id).length) throw Error("Transactions with payments cannot be edited.");
  if (appState.data.returns.some(row => row.original_transaction_id === tx.id && !row.voided_at)) throw Error("Transactions with returns cannot be edited.");
  const oldLine = txLines(tx.id)[0];
  const oldItem = itemBy(oldLine.item_id); const newItem = itemBy(payload.item_id);
  if (!oldItem || !newItem) throw Error("Inventory item not found.");
  const oldDelta = tx.type === "sold" ? -num(oldLine.base_quantity) : num(oldLine.base_quantity);
  const newDelta = payload.type === "sold" ? -num(payload.base_quantity) : num(payload.base_quantity);
  const oldStockAfterReverse = stockBase(oldItem) - oldDelta;
  if (oldItem.id === newItem.id && oldStockAfterReverse + newDelta < -0.000001) throw Error("Insufficient stock.");
  if (oldItem.id !== newItem.id && stockBase(newItem) + newDelta < -0.000001) throw Error("Insufficient stock for selected item.");
  oldItem.current_stock_base = Math.max(0, oldStockAfterReverse);
  newItem.current_stock_base = Math.max(0, stockBase(newItem) + newDelta);
  Object.assign(tx, { reference: payload.reference, type: payload.type, item_id: payload.item_id, contact_id: payload.contact_id ?? null,
    quantity: payload.quantity, unit: payload.unit, base_quantity: payload.base_quantity, unit_price: payload.unit_price,
    total_amount: payload.total_amount, cost_total: payload.cost_total, occurred_at: payload.occurred_at });
  Object.assign(oldLine, { item_id: newItem.id, item_name: newItem.name, item_sku: newItem.sku || null,
    quantity: payload.quantity, unit: payload.unit, base_quantity: payload.base_quantity, unit_price: payload.unit_price,
    line_total: payload.total_amount, cost_total: payload.cost_total });
  saveLocal(); return tx;
}

export async function recordMultiItemTransaction(payload) {
  if (appState.remote) {
    return callRPC("record_multi_item_transaction", {
      p_reference: payload.reference, p_type: payload.type, p_contact_id: payload.contact_id ?? null,
      p_lines: payload.lines, p_materials: payload.materials || [], p_occurred_at: payload.occurred_at,
      p_initial_payment: payload.initial_payment ?? 0, p_payment_method: payload.payment_method ?? null,
      p_payment_at: payload.payment_at ?? payload.occurred_at ?? null
    });
  }

  const now = payload.occurred_at || new Date().toISOString();
  if (!Array.isArray(payload.lines) || !payload.lines.length) throw Error("Add at least one product line.");
  const lines = payload.lines.map((line, index) => {
    const item = itemBy(line.item_id);
    if (!item) throw Error("A selected product no longer exists.");
    const quantity = num(line.quantity);
    const price = Math.round(num(line.unit_price) * 100) / 100;
    if (quantity <= 0 || price < 0) throw Error("Every line needs a positive quantity and non-negative price/cost.");
    const unit = line.unit || item.base_unit;
    const multiplier = unitMultiplier(item, unit);
    const baseQuantity = quantity * multiplier;
    const total = Math.round(quantity * price * 100) / 100;
    const cost = payload.type === "sold" ? estimateCOGS(item, baseQuantity) : total;
    return { id: id("line"), transaction_id: null, line_no: index + 1, item_id: item.id, item_name: item.name,
      item_sku: item.sku || null, quantity, unit, base_quantity: baseQuantity, unit_price: price,
      line_total: total, cost_total: Math.round(cost * 100) / 100 };
  });
  const total = Math.round(lines.reduce((sum, line) => sum + line.line_total, 0) * 100) / 100;
  const costTotal = Math.round(lines.reduce((sum, line) => sum + line.cost_total, 0) * 100) / 100;
  const paid = num(payload.initial_payment);
  if (paid < 0 || paid > total) throw Error("Initial payment exceeds bill total.");
  if (payload.type === "sold") {
    const requested = new Map();
    lines.forEach(line => requested.set(line.item_id, (requested.get(line.item_id) || 0) + line.base_quantity));
    for (const [itemId, amount] of requested) if (stockBase(itemBy(itemId)) + 0.000001 < amount) throw Error(`Not enough stock for ${itemBy(itemId).name}.`);
  }

  const preparedMaterials = (payload.materials || []).map(material => {
    const item = itemBy(material.item_id);
    if (!item) throw Error("A selected material no longer exists.");
    const quantity = num(material.quantity);
    const unit = material.unit || item.base_unit;
    const baseQuantity = quantity * unitMultiplier(item, unit);
    if (quantity <= 0) throw Error("Material quantities must be positive.");
    return { id: id("mat"), transaction_id: null, item_id: item.id, item_name: item.name, quantity, unit, base_quantity: baseQuantity };
  });
  if (payload.type !== "made" && preparedMaterials.length) throw Error("Only Made transactions can consume materials.");
  const outputIds = new Set(lines.map(line => line.item_id));
  const materialTotals = new Map();
  preparedMaterials.forEach(material => {
    if (outputIds.has(material.item_id)) throw Error("A product cannot also be a consumed material in the same production record.");
    materialTotals.set(material.item_id, (materialTotals.get(material.item_id) || 0) + material.base_quantity);
  });
  for (const [itemId, amount] of materialTotals) if (stockBase(itemBy(itemId)) + 0.000001 < amount) throw Error(`Not enough stock for material ${itemBy(itemId).name}.`);

  const tx = { id: id("tx"), reference: payload.reference, type: payload.type, item_id: lines[0].item_id,
    contact_id: payload.contact_id || null, quantity: 1, unit: "transaction", base_quantity: 1,
    unit_price: total, total_amount: total, cost_total: costTotal, occurred_at: now, voided_at: null };
  appState.data.transactions.push(tx);
  lines.forEach(line => {
    line.transaction_id = tx.id;
    appState.data.transactionLines.push(line);
    const item = itemBy(line.item_id);
    item.current_stock_base = stockBase(item) + (payload.type === "sold" ? -line.base_quantity : line.base_quantity);
  });
  preparedMaterials.forEach(material => {
    material.transaction_id = tx.id;
    appState.data.productionMaterials.push(material);
    const item = itemBy(material.item_id);
    item.current_stock_base = stockBase(item) - material.base_quantity;
  });
  if (paid > 0) appState.data.payments.push({ id: id("pay"), transaction_id: tx.id, amount: paid, method: payload.payment_method || null, paid_at: payload.payment_at || now });
  saveLocal();
  return tx;
}

export async function recordReturnLine(payload) {
  if (appState.remote) {
    return callRPC("record_return_line", {
      p_transaction_line_id: payload.transaction_line_id,
      p_quantity: payload.quantity,
      p_base_quantity: payload.base_quantity,
      p_amount: payload.amount,
      p_amount_cost: payload.amount_cost,
      p_refund_amount: payload.refund_amount ?? 0,
      p_balance_adjustment: payload.balance_adjustment ?? 0,
      p_occurred_at: payload.occurred_at ?? null
    });
  }
  const line = appState.data.transactionLines.find(row => row.id === payload.transaction_line_id);
  if (!line) throw Error("Transaction line not found.");
  const tx = appState.data.transactions.find(row => row.id === line.transaction_id);
  if (!tx || tx.voided_at) throw Error("The original transaction is unavailable.");
  const returned = appState.data.returns.filter(row => row.transaction_line_id === line.id && !row.voided_at).reduce((sum, row) => sum + num(row.base_quantity), 0);
  if (returned + payload.base_quantity > num(line.base_quantity) + 0.000001) throw Error("Return quantity exceeds the line's remaining quantity.");
  const kind = tx.type === "sold" ? "customer_return" : "supplier_return";
  const item = itemBy(line.item_id);
  const nextStock = stockBase(item) + (kind === "customer_return" ? payload.base_quantity : -payload.base_quantity);
  if (nextStock < -0.000001) throw Error("Supplier return would make stock negative.");
  item.current_stock_base = Math.max(0, nextStock);
  const record = { id: id("ret"), transaction_line_id: line.id, original_transaction_id: tx.id, user_id: null, item_id: line.item_id, contact_id: tx.contact_id, kind, quantity: payload.quantity, base_quantity: payload.base_quantity, amount: payload.amount, amount_cost: payload.amount_cost, refund_amount: payload.refund_amount || 0, balance_adjustment: payload.balance_adjustment ?? payload.amount, occurred_at: payload.occurred_at || new Date().toISOString(), voided_at: null };
  appState.data.returns.push(record);
  saveLocal();
  return record;
}

export async function recordPayment(payload) {
  if (appState.remote) return callRPC("record_payment", { p_transaction_id: payload.transaction_id, p_amount: payload.amount, p_method: payload.method ?? null, p_paid_at: payload.paid_at ?? null });
  const tx = appState.data.transactions.find(row => row.id === payload.transaction_id);
  if (!tx || tx.voided_at) throw Error("Transaction not found or voided.");
  if (num(payload.amount) <= 0 || num(payload.amount) > txOutstanding(tx) + 0.000001) throw Error("Payment amount exceeds the outstanding balance.");
  const payment = { id: id("pay"), transaction_id: tx.id, amount: num(payload.amount), method: payload.method ?? null, paid_at: payload.paid_at || new Date().toISOString() };
  appState.data.payments.push(payment); saveLocal(); return payment;
}

export async function recordReturn(payload) {
  if (appState.remote) return callRPC("record_return", { p_original_transaction_id: payload.original_transaction_id, p_quantity: payload.quantity, p_base_quantity: payload.base_quantity, p_amount: payload.amount, p_amount_cost: payload.amount_cost, p_refund_amount: payload.refund_amount ?? 0, p_balance_adjustment: payload.balance_adjustment ?? 0, p_occurred_at: payload.occurred_at ?? null });
  const line = txLines(payload.original_transaction_id)[0];
  return recordReturnLine({ ...payload, transaction_line_id: line.id, balance_adjustment: payload.balance_adjustment ?? payload.amount });
}

export async function voidTransaction(transactionId) {
  if (appState.remote) return callRPC("void_transaction", { p_transaction_id: transactionId });
  const tx = appState.data.transactions.find(row => row.id === transactionId);
  if (!tx) throw Error("Transaction not found.");
  if (appState.data.payments.some(payment => payment.transaction_id === tx.id)) throw Error("Transactions with payments cannot be voided directly; settle or reverse payment history first.");
  if (appState.data.returns.some(row => row.original_transaction_id === tx.id && !row.voided_at)) throw Error("Transactions with active returns cannot be voided.");
  const lines = appState.data.transactionLines.filter(row => row.transaction_id === tx.id);
  const stockDeltas = new Map();
  lines.forEach(line => {
    const delta = tx.type === "sold" ? num(line.base_quantity) : -num(line.base_quantity);
    stockDeltas.set(line.item_id, (stockDeltas.get(line.item_id) || 0) + delta);
  });
  if (tx.type === "made") {
    appState.data.productionMaterials.filter(row => row.transaction_id === tx.id).forEach(material => {
      stockDeltas.set(material.item_id, (stockDeltas.get(material.item_id) || 0) + num(material.base_quantity));
    });
  }
  for (const [itemId, delta] of stockDeltas) {
    const item = itemBy(itemId);
    if (!item) throw Error("An inventory item in this transaction no longer exists.");
    if (stockBase(item) + delta < -0.000001) throw Error(`Voiding this transaction would make stock negative for ${item.name}.`);
  }
  for (const [itemId, delta] of stockDeltas) {
    const item = itemBy(itemId);
    item.current_stock_base = Math.max(0, stockBase(item) + delta);
  }
  tx.voided_at = new Date().toISOString();
  saveLocal();
  return tx;
}

export function itemBy(itemId) {
  return appState.data.inventory.find(item => item.id === itemId);
}

export function contactBy(contactId) {
  return appState.data.contacts.find(contact => contact.id === contactId);
}

export function txPayments(transactionId) {
  return appState.data.payments.filter(payment => payment.transaction_id === transactionId);
}

export function txLines(transactionId) {
  const lines = (appState.data.transactionLines || []).filter(line => line.transaction_id === transactionId);
  if (lines.length) return lines;
  const tx = appState.data.transactions.find(row => row.id === transactionId);
  if (!tx) return [];
  const item = itemBy(tx.item_id);
  return [{ id: `legacy-${tx.id}`, transaction_id: tx.id, line_no: 1, item_id: tx.item_id, item_name: item?.name || "Item", item_sku: item?.sku || null, quantity: tx.quantity, unit: tx.unit, base_quantity: tx.base_quantity, unit_price: tx.unit_price, line_total: tx.total_amount, cost_total: tx.cost_total }];
}

export function paidFor(transactionId) {
  return txPayments(transactionId).reduce((sum, payment) => sum + num(payment.amount), 0);
}

export function returnAdjustments(transactionId) {
  return appState.data.returns
    .filter(returnRecord => returnRecord.original_transaction_id === transactionId && !returnRecord.voided_at)
    .reduce((sum, returnRecord) => sum + num(returnRecord.balance_adjustment), 0);
}

export function txOutstanding(transaction) {
  return Math.max(
    0,
    num(transaction.total_amount) - paidFor(transaction.id) - returnAdjustments(transaction.id)
  );
}

export function txStatus(transaction) {
  const outstanding = txOutstanding(transaction);
  return outstanding <= 0.000001 ? "Settled" : "Outstanding";
}

export function stockBase(item) {
  return num(item.current_stock_base);
}

export function unitOptions(item) {
  const options = [{ name: item.base_unit || "unit", multiplier: 1 }];
  for (const conversion of (item.conversions || [])) {
    options.push({
      name: conversion.name,
      multiplier: num(conversion.multiplier) || 1
    });
  }
  return options;
}

export function unitMultiplier(item, unitName) {
  return unitOptions(item).find(unit => unit.name === unitName)?.multiplier || 1;
}

// Kept for non-financial inventory screens/backward compatibility.
// Financial stock-changing workflows now use atomic RPCs instead.
export async function adjustStock(itemId, deltaBase) {
  const item = itemBy(itemId);
  if (!item) throw Error("Item not found");

  const next = stockBase(item) + num(deltaBase);
  if (next < -0.000001) {
    throw Error(
      `Insufficient stock for ${item.name}. Available: ${stockBase(item)} ${item.base_unit || "unit"}.`
    );
  }

  await update("inventory_items", itemId, { current_stock_base: next });
}

export function weightedAverageCost(item) {
  const lines = (appState.data.transactionLines || []).filter(line => line.item_id === item.id);
  if (!lines.length) return num(item.average_cost_base);
  let quantity = 0;
  let cost = 0;
  for (const line of lines) {
    const tx = appState.data.transactions.find(transaction => transaction.id === line.transaction_id);
    if (!tx || tx.voided_at || !["bought", "made"].includes(tx.type)) continue;
    quantity += num(line.base_quantity);
    cost += num(line.cost_total || line.line_total);
  }
  return quantity > 0 ? cost / quantity : num(item.average_cost_base);
}

export function estimateCOGS(item, baseQuantity) {
  return weightedAverageCost(item) * baseQuantity;
}

export async function refreshApp() {
  if (appState.refresh) await appState.refresh();
}
