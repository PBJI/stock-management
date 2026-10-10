import {
  appState,
  contactBy,
  getConfig,
  itemBy,
  paidFor,
  txOutstanding,
  txLines
} from "./core.js";
import { $, esc, fmtDate, money, toast } from "./dom.js";


function openBillModal(title, body, { wide = false } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop" data-backdrop><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true"><div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close>×</button></div><div class="modal-content">${body}</div></div></div>`;
  const close = () => { root.innerHTML = ""; };
  root.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", close));
  $("[data-backdrop]", root).addEventListener("click", event => {
    if (event.target.dataset.backdrop) close();
  });
  return root;
}

function billStatus(paid, due) {
  if (due <= 0.005) return "Settled";
  if (paid <= 0.005) return "Unpaid";
  return "Partially paid";
}

export function buildLocalBillSnapshot(transaction) {
  const contact = contactBy(transaction.contact_id);
  const paid = Math.max(0, paidFor(transaction.id));
  const due = Math.max(0, txOutstanding(transaction));
  const lines = txLines(transaction.id).map(line => ({
    item_name: line.item_name || itemBy(line.item_id)?.name || "Item",
    item_sku: line.item_sku || itemBy(line.item_id)?.sku || null,
    quantity: Number(line.quantity || 0),
    unit: line.unit || itemBy(line.item_id)?.base_unit || "unit",
    unit_price: Number(line.unit_price || 0),
    line_total: Number(line.line_total ?? line.total_amount ?? 0)
  }));
  return {
    bill_reference: transaction.reference,
    bill_date: transaction.occurred_at,
    generated_at: new Date().toISOString(),
    seller_name: appState.data.profile?.full_name || "StockFlow seller",
    customer_name: contact?.name || "Customer",
    lines,
    item_name: lines[0]?.item_name || "Item",
    item_sku: lines[0]?.item_sku || null,
    quantity: lines[0]?.quantity || 0,
    unit: lines[0]?.unit || "unit",
    unit_price: lines[0]?.unit_price || 0,
    line_total: lines[0]?.line_total || 0,
    total_amount: Number(transaction.total_amount || 0),
    amount_paid: paid,
    balance_due: due,
    currency: "INR",
    payment_status: billStatus(paid, due)
  };
}

function billMarkup(snapshot) {
  const lines = Array.isArray(snapshot.lines) && snapshot.lines.length ? snapshot.lines : [{
    item_name: snapshot.item_name || "Item", item_sku: snapshot.item_sku, quantity: snapshot.quantity,
    unit: snapshot.unit, unit_price: snapshot.unit_price, line_total: snapshot.line_total ?? snapshot.total_amount
  }];
  return `<article class="sale-bill-card" id="sale-bill-card">
    <div class="sale-bill-brand"><div class="sale-bill-mark">SF</div><div><div class="sale-bill-seller">${esc(snapshot.seller_name || "StockFlow seller")}</div><div class="sale-bill-muted">StockFlow · Sales bill</div></div></div>
    <div class="sale-bill-title-row"><div><h2>SALES BILL</h2><div class="sale-bill-muted">Bill no. ${esc(snapshot.bill_reference || "—")}</div></div><div class="sale-bill-date"><span>Date</span><strong>${esc(fmtDate(snapshot.bill_date))}</strong></div></div>
    <div class="sale-bill-customer"><span class="sale-bill-muted">BILLED TO</span><strong>${esc(snapshot.customer_name || "Customer")}</strong></div>
    <div class="sale-bill-lines"><div class="sale-bill-line sale-bill-line-head"><span>Item / description</span><span>Qty</span><span>Rate</span><span>Amount</span></div>
      ${lines.map(line => `<div class="sale-bill-line"><span><strong>${esc(line.item_name || "Item")}</strong>${line.item_sku ? `<small>SKU: ${esc(line.item_sku)}</small>` : ""}</span><span>${esc(String(line.quantity ?? 0))} ${esc(line.unit || "unit")}</span><span>${esc(money(line.unit_price))}</span><strong>${esc(money(line.line_total ?? 0))}</strong></div>`).join("")}
    </div>
    <div class="sale-bill-totals"><div><span>Total</span><strong>${esc(money(snapshot.total_amount))}</strong></div><div><span>Paid at bill generation</span><strong>${esc(money(snapshot.amount_paid))}</strong></div><div class="sale-bill-balance"><span>Balance due</span><strong>${esc(money(snapshot.balance_due))}</strong></div><div><span>Payment status</span><strong>${esc(snapshot.payment_status || "—")}</strong></div></div>
    <div class="sale-bill-footer">Thank you for your business.<br><span>This bill is a sales record, not a GST/tax invoice. Payment figures reflect the bill snapshot at generation time.</span></div>
  </article>`;
}

function makeBillCanvas(snapshot) {
  const lines = Array.isArray(snapshot.lines) && snapshot.lines.length ? snapshot.lines : [{
    item_name: snapshot.item_name || "Item", item_sku: snapshot.item_sku, quantity: snapshot.quantity,
    unit: snapshot.unit, unit_price: snapshot.unit_price, line_total: snapshot.line_total ?? snapshot.total_amount
  }];
  const w = 1000;
  const margin = 76;
  const tableStart = 500;
  const rowHeight = 64;
  const totalsY = tableStart + 58 + lines.length * rowHeight;
  const height = Math.max(1120, totalsY + 360);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not create the bill image.");

  ctx.fillStyle = "#f5f4f8"; ctx.fillRect(0, 0, w, height);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(38, 38, w - 76, height - 76);
  ctx.strokeStyle = "#e7e3ed"; ctx.lineWidth = 2; ctx.strokeRect(38, 38, w - 76, height - 76);
  const text = (value, x, y, size = 24, weight = 400, color = "#292537", align = "left") => {
    ctx.font = `${weight} ${size}px Arial, sans-serif`; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(String(value ?? ""), x, y);
  };
  const line = y => { ctx.strokeStyle = "#e8e4ee"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(margin, y); ctx.lineTo(w - margin, y); ctx.stroke(); };
  const wrap = (value, x, y, maxWidth, size = 24, weight = 400, color = "#292537", maxLines = 2) => {
    ctx.font = `${weight} ${size}px Arial, sans-serif`;
    const words = String(value ?? "").split(/\s+/); const rows = []; let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && current) { rows.push(current); current = word; if (rows.length >= maxLines - 1) break; }
      else current = candidate;
    }
    if (current && rows.length < maxLines) rows.push(current);
    if (rows.length === maxLines && words.join(" ").length > rows.join(" ").length) rows[rows.length - 1] = `${rows[rows.length - 1].replace(/…$/, "")}…`;
    rows.forEach((row, index) => text(row, x, y + index * (size + 7), size, weight, color));
    return y + Math.max(1, rows.length) * (size + 7);
  };
  const fmt = value => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  ctx.fillStyle = "#f7d3e8"; ctx.beginPath(); ctx.roundRect(margin, 72, 64, 64, 16); ctx.fill();
  text("SF", margin + 32, 113, 27, 700, "#7c285b", "center");
  wrap(snapshot.seller_name || "StockFlow seller", margin + 84, 99, 470, 30, 700, "#292537", 2);
  text("STOCKFLOW · SALES BILL", w - margin, 102, 17, 700, "#9a4778", "right"); line(164);
  text("SALES BILL", margin, 218, 38, 700);
  text(`Bill no. ${snapshot.bill_reference || "—"}`, margin, 260, 21, 400, "#777184");
  text("BILL DATE", w - margin, 204, 16, 700, "#777184", "right");
  text(fmtDate(snapshot.bill_date), w - margin, 238, 20, 600, "#292537", "right");
  line(292); text("BILLED TO", margin, 338, 16, 700, "#777184");
  wrap(snapshot.customer_name || "Customer", margin, 380, 620, 27, 700, "#292537", 2); line(430);
  text("ITEM / DESCRIPTION", margin, 474, 16, 700, "#777184");
  text("QTY", 610, 474, 16, 700, "#777184", "right"); text("RATE", 770, 474, 16, 700, "#777184", "right");
  text("AMOUNT", w - margin, 474, 16, 700, "#777184", "right"); line(496);
  lines.forEach((entry, index) => {
    const y = tableStart + index * rowHeight;
    wrap(entry.item_name || "Item", margin, y, 360, 21, 700, "#292537", 2);
    if (entry.item_sku) text(`SKU: ${entry.item_sku}`, margin, y + 35, 14, 400, "#777184");
    text(`${entry.quantity ?? 0} ${entry.unit || "unit"}`, 610, y + 2, 17, 400, "#292537", "right");
    text(fmt(entry.unit_price), 770, y + 2, 17, 400, "#292537", "right");
    text(fmt(entry.line_total), w - margin, y + 2, 18, 700, "#292537", "right");
    line(y + 35);
  });
  const totalX = w - margin;
  text("Total", 610, totalsY, 21, 600, "#777184"); text(fmt(snapshot.total_amount), totalX, totalsY, 23, 700, "#292537", "right");
  text("Paid at bill generation", 610, totalsY + 48, 19, 400, "#777184"); text(fmt(snapshot.amount_paid), totalX, totalsY + 48, 20, 600, "#292537", "right");
  text("BALANCE DUE", 610, totalsY + 104, 17, 700, "#9a4778"); text(fmt(snapshot.balance_due), totalX, totalsY + 106, 29, 700, "#9a4778", "right");
  text(`Payment status: ${snapshot.payment_status || "—"}`, 610, totalsY + 150, 17, 600, "#777184"); line(totalsY + 190);
  text("Thank you for your business.", margin, totalsY + 236, 22, 700);
  text("This is a sales record, not a GST/tax invoice.", margin, totalsY + 270, 16, 400, "#777184");
  text("Payment figures reflect the bill snapshot at generation time.", margin, totalsY + 296, 16, 400, "#777184");
  text("Generated with StockFlow", w - margin, height - 70, 15, 400, "#9b95a6", "right");
  return canvas;
}

export async function downloadBillAsPng(snapshot) {
  const canvas = makeBillCanvas(snapshot);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error("Could not export the bill image.")), "image/png");
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `stockflow-bill-${String(snapshot.bill_reference || "sale").replace(/[^a-z0-9-_]+/gi, "-")}.png`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function openSaleBillModal(transaction) {
  if (!transaction || transaction.type !== "sold" || transaction.voided_at) {
    toast("Bills are available only for active Sold transactions.", "error");
    return;
  }

  let snapshot = buildLocalBillSnapshot(transaction);
  const root = openBillModal("Sales bill · Share with customer", `
    <p class="help" style="margin:0 0 14px">Generate a public link for this Sold transaction or export a PNG image. Public links work without customer sign-in. Regenerating a link invalidates the previous link.</p>
    <div id="bill-preview-wrap">${billMarkup(snapshot)}</div>
    <div class="form-footer" style="justify-content:flex-start;margin-top:16px;flex-wrap:wrap">
      <button class="btn" type="button" id="bill-download-png">Download bill as PNG</button>
      <button class="btn pink" type="button" id="bill-create-link" ${appState.remote ? "" : "disabled"}>${appState.remote ? "Generate public link" : "Public link requires Supabase"}</button>
      ${appState.remote ? `<button class="btn danger" type="button" id="bill-revoke-link">Revoke public link</button>` : ""}
      <button class="btn" type="button" data-close>Close</button>
    </div>
    <div id="bill-link-result" class="bill-link-result" hidden></div>
    ${!appState.remote ? `<p class="help">PNG export works in local mode. To make customer-shareable links, connect the app to Supabase and run the shared-bills SQL migration.</p>` : `<p class="help">The bill stores a point-in-time snapshot. Refresh the link after editing the sale; recording later payments does not rewrite an already issued bill.</p>`}
  `, { wide: true });

  $("#bill-download-png", root).onclick = async () => {
    try {
      await downloadBillAsPng(snapshot);
      toast("Bill PNG downloaded.", "ok");
    } catch (error) {
      toast(error.message || "Could not export bill image.", "error");
    }
  };

  $("#bill-create-link", root)?.addEventListener("click", async event => {
    const button = event.currentTarget;
    if (!appState.remote || !appState.supabase) return;
    button.disabled = true;
    button.textContent = "Generating…";
    try {
      const { data, error } = await appState.supabase.rpc("create_shared_sale_bill", {
        p_transaction_id: transaction.id
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.token || !result?.snapshot) throw new Error("The server did not return a bill link.");
      snapshot = result.snapshot;
      $("#bill-preview-wrap", root).innerHTML = billMarkup(snapshot);
      const url = new URL(location.href);
      url.searchParams.set("bill", result.token);
      url.hash = "";
      const link = url.toString();
      const resultEl = $("#bill-link-result", root);
      resultEl.hidden = false;
      resultEl.innerHTML = `<div class="field"><label for="bill-public-url">Public bill URL</label><input id="bill-public-url" readonly value="${esc(link)}" spellcheck="false"></div><div class="form-footer" style="justify-content:flex-start"><button class="btn pink" type="button" id="bill-copy-link">Copy link</button><button class="btn" type="button" id="bill-open-link">Open customer view</button></div><p class="help">Anyone with this link can view this bill. Keep it private. The URL contains a random 256-bit token; the database stores only its SHA-256 hash.</p>`;
      $("#bill-copy-link", root).onclick = async () => {
        const input = $("#bill-public-url", root);
        try {
          await navigator.clipboard.writeText(link);
          toast("Bill link copied.", "ok");
        } catch {
          input.focus();
          input.select();
          const copied = document.execCommand("copy");
          toast(copied ? "Bill link copied." : "Select and copy the link manually.", copied ? "ok" : "error");
        }
      };
      $("#bill-open-link", root).onclick = () => window.open(link, "_blank", "noopener,noreferrer");
      toast("Public bill link generated. Any previous link for this sale has been invalidated.", "ok");
    } catch (error) {
      toast(error.message || "Could not generate public bill link.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Generate / refresh public link";
    }
  });

  $("#bill-revoke-link", root)?.addEventListener("click", async event => {
    if (!appState.remote || !appState.supabase) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { data, error } = await appState.supabase.rpc("revoke_shared_sale_bill", {
        p_transaction_id: transaction.id
      });
      if (error) throw error;
      if (data) {
        $("#bill-link-result", root).hidden = true;
        toast("Public bill link revoked.", "ok");
      } else {
        toast("No active public link was found for this sale.");
      }
    } catch (error) {
      toast(error.message || "Could not revoke bill link.", "error");
    } finally {
      button.disabled = false;
    }
  });
}

function publicBillStyles() {
  document.body.classList.add("public-bill-page");
  document.querySelector(".topbar")?.remove();
  document.querySelector(".tabs")?.remove();
  const root = $("#app");
  root.className = "public-bill-shell";
  document.title = "Sales Bill · StockFlow";
  return root;
}

export async function renderPublicSaleBill(token) {
  const root = publicBillStyles();
  root.innerHTML = `<section class="public-bill-state"><div class="sale-bill-mark">SF</div><h1>Loading sales bill…</h1><p>Please wait.</p></section>`;
  if (!/^[a-f0-9]{64}$/i.test(token || "")) {
    root.innerHTML = publicBillError();
    return;
  }

  const cfg = getConfig();
  if (!cfg?.url || !cfg?.key || !window.supabase?.createClient) {
    root.innerHTML = publicBillError("The bill service is not configured.");
    return;
  }

  try {
    const client = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data, error } = await client.rpc("get_shared_sale_bill", { p_token: token });
    if (error) throw error;
    const snapshot = Array.isArray(data) ? data[0] : data;
    if (!snapshot) {
      root.innerHTML = publicBillError();
      return;
    }

    root.innerHTML = `<div class="public-bill-content">${billMarkup(snapshot)}<div class="public-bill-actions"><button class="btn pink" type="button" id="public-bill-download">Download bill as PNG</button><button class="btn" type="button" id="public-bill-print">Print bill</button></div><p class="public-bill-privacy">This is a public, read-only bill link. No account is required.</p></div>`;
    $("#public-bill-download", root).onclick = async () => {
      try {
        await downloadBillAsPng(snapshot);
      } catch (exportError) {
        alert(exportError.message || "Could not export bill image.");
      }
    };
    $("#public-bill-print", root).onclick = () => window.print();
  } catch (error) {
    console.error("Public bill load failed:", error);
    root.innerHTML = publicBillError();
  }
}

function publicBillError(message = "This bill link is invalid, unavailable, or has been revoked.") {
  return `<section class="public-bill-state"><div class="sale-bill-mark">SF</div><h1>Bill unavailable</h1><p>${esc(message)}</p><p class="sale-bill-muted">Ask the seller to generate a new bill link.</p></section>`;
}
