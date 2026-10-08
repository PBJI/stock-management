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
  profiles: "profiles"
};

export const DEFAULT = {
  inventory: [],
  contacts: [],
  transactions: [],
  payments: [],
  expenses: [],
  returns: [],
  profile: null
};

function remoteTable(table) {
  return TABLES[table] || table;
}

function loadLocal() {
  try {
    return {
      ...clone(DEFAULT),
      ...(JSON.parse(localStorage.getItem(LS.local) || "{}"))
    };
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
  inventoryFilter: "",
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
  const [inventory, contacts, transactions, payments, expenses, returns] = await Promise.all([
    appState.supabase.from("inventory_items").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
    appState.supabase.from("contacts").select("*").eq("user_id", uid).order("name"),
    appState.supabase.from("transactions").select("*").eq("user_id", uid).order("occurred_at", { ascending: false }),
    appState.supabase.from("transaction_payments").select("*").eq("user_id", uid).order("paid_at"),
    appState.supabase.from("expenses").select("*").eq("user_id", uid).order("occurred_at", { ascending: false }),
    appState.supabase.from("returns").select("*").eq("user_id", uid).order("created_at", { ascending: false })
  ]);

  for (const result of [inventory, contacts, transactions, payments, expenses, returns]) {
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
  return callRPC("record_inventory_transaction", {
    p_reference: payload.reference,
    p_type: payload.type,
    p_item_id: payload.item_id,
    p_contact_id: payload.contact_id ?? null,
    p_quantity: payload.quantity,
    p_unit: payload.unit,
    p_base_quantity: payload.base_quantity,
    p_unit_price: payload.unit_price,
    p_total_amount: payload.total_amount,
    p_cost_total: payload.cost_total,
    p_occurred_at: payload.occurred_at,
    p_initial_payment: payload.initial_payment ?? 0,
    p_payment_method: payload.payment_method ?? null,
    p_payment_at: payload.payment_at ?? payload.occurred_at ?? null
  });
}

export async function updateInventoryTransaction(payload) {
  return callRPC("update_inventory_transaction", {
    p_transaction_id: payload.transaction_id,
    p_reference: payload.reference,
    p_type: payload.type,
    p_item_id: payload.item_id,
    p_contact_id: payload.contact_id ?? null,
    p_quantity: payload.quantity,
    p_unit: payload.unit,
    p_base_quantity: payload.base_quantity,
    p_unit_price: payload.unit_price,
    p_total_amount: payload.total_amount,
    p_cost_total: payload.cost_total,
    p_occurred_at: payload.occurred_at
  });
}

export async function recordPayment(payload) {
  return callRPC("record_payment", {
    p_transaction_id: payload.transaction_id,
    p_amount: payload.amount,
    p_method: payload.method ?? null,
    p_paid_at: payload.paid_at ?? null
  });
}

export async function recordReturn(payload) {
  return callRPC("record_return", {
    p_original_transaction_id: payload.original_transaction_id,
    p_quantity: payload.quantity,
    p_base_quantity: payload.base_quantity,
    p_amount: payload.amount,
    p_amount_cost: payload.amount_cost,
    p_refund_amount: payload.refund_amount ?? 0,
    p_balance_adjustment: payload.balance_adjustment ?? 0,
    p_occurred_at: payload.occurred_at ?? null
  });
}

export async function voidTransaction(transactionId) {
  return callRPC("void_transaction", {
    p_transaction_id: transactionId
  });
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
  const purchases = appState.data.transactions.filter(
    transaction => transaction.item_id === item.id &&
      !transaction.voided_at &&
      (transaction.type === "bought" || transaction.type === "made")
  );

  let quantity = 0;
  let cost = 0;

  for (const transaction of purchases) {
    quantity += num(transaction.base_quantity);
    cost += num(transaction.cost_total || transaction.total_amount);
  }

  return quantity > 0 ? cost / quantity : num(item.average_cost_base);
}

export function estimateCOGS(item, baseQuantity) {
  return weightedAverageCost(item) * baseQuantity;
}

export async function refreshApp() {
  if (appState.refresh) await appState.refresh();
}
