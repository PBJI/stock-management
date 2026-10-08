export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const money = n => `₹${Number(n || 0).toLocaleString("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})}`;

export const num = n => Number.isFinite(Number(n)) ? Number(n) : 0;

export const id = (prefix = "id") => `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : Date.now() + "_" + Math.random().toString(36).slice(2)}`;

export const nowISO = () => new Date().toISOString();
export const todayISO = () => new Date().toISOString().slice(0, 16);

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

export const fmtDate = s => s
  ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
  : "—";

export const fmtDay = s => s
  ? new Date(s).toLocaleDateString("en-IN", { dateStyle: "medium" })
  : "—";

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function toast(message, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toast-stack").appendChild(el);
  setTimeout(() => el.remove(), 3400);
}
