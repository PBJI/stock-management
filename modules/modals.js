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
	txLines,
	recordMultiItemTransaction,
	recordReturnLine,
	recordInventoryTransaction,
	updateInventoryTransaction,
	recordPayment,
	recordReturn,
	voidTransaction,
	update,
	refreshApp,
} from "./core.js";
import { $, clone, esc, fmtDate, money, num, todayISO, toast } from "./dom.js";
import { openSaleBillModal } from "./bills.js";

export function openModal(title, body, { wide = false, onClose } = {}) {
	const root = $("#modal-root");
	root.innerHTML = `<div class="modal-backdrop" data-backdrop><div class="modal ${
		wide ? "wide" : ""
	}" role="dialog" aria-modal="true"><div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close>×</button></div><div class="modal-content">${body}</div></div></div>`;

	const close = () => {
		root.innerHTML = "";
		onClose?.();
	};

	// Attach the same close behavior to BOTH the header close button and every
	// footer Cancel/Close button. The old implementation only wired the first match.
	root.querySelectorAll("[data-close]").forEach((button) => {
		button.addEventListener("click", close);
	});

	$("[data-backdrop]", root).addEventListener("click", (event) => {
		if (event.target.dataset.backdrop) close();
	});

	return root;
}

export function transactionModal(type, existing = null) {
	const isMade = type === "made";
	const existingLines = existing ? txLines(existing.id) : [];
	if (existingLines.length > 1) {
		toast("For now, multi-item transactions cannot be edited in place. Void it and record it again to keep stock history accurate.", "error");
		return;
	}
	const contacts = appState.data.contacts.filter((contact) => contact.kind === (type === "sold" ? "customer" : "supplier"));
	const initialPaid = existing ? paidFor(existing.id) : 0;
	let lines = existingLines.length
		? existingLines.map((line) => ({
				item_id: line.item_id,
				quantity: line.quantity,
				unit: line.unit,
				unit_price: line.unit_price,
		  }))
		: [{ item_id: "", quantity: 1, unit_price: 0, unit: "" }];
	let materials = (existing && isMade ? (appState.data.productionMaterials || []).filter((row) => row.transaction_id === existing.id) : []).map((row) => ({
		item_id: row.item_id,
		quantity: row.quantity,
		unit: row.unit,
	}));
	let contactResults = [];
	let contactSearchTimer = null;
	let contactThrottleTimer = null;
	let lastContactSearchAt = 0;

	const itemOptions = (selectedId) =>
		`<option value="">Select product</option>${appState.data.inventory
			.map(
				(inventoryItem) =>
					`<option value="${esc(inventoryItem.id)}" ${selectedId === inventoryItem.id ? "selected" : ""}>${esc(inventoryItem.name)} · stock ${stockBase(inventoryItem)} ${esc(
						inventoryItem.base_unit || "unit"
					)}</option>`
			)
			.join("")}`;
	const unitOptionsMarkup = (itemId, selectedUnit) => {
		const selectedItem = itemBy(itemId);
		const units = selectedItem ? unitOptions(selectedItem) : [{ name: "unit", multiplier: 1 }];
		return units.map((unit) => `<option value="${esc(unit.name)}" ${selectedUnit === unit.name ? "selected" : ""}>${esc(unit.name)} × ${unit.multiplier}</option>`).join("");
	};
	const drawLines = () => {
		const host = $("#tx-lines", root);
		if (!host) return;
		host.innerHTML = lines
			.map(
				(line, index) => `
      <div class="tx-line-row" data-line-row="${index}">
        <div class="field tx-line-product"><label>Product ${index + 1}</label><select data-line-index="${index}" data-line-key="item_id" required>${itemOptions(line.item_id)}</select></div>
        <div class="field"><label>Quantity</label><input data-line-index="${index}" data-line-key="quantity" type="number" min="0.000001" step="any" value="${esc(
					String(line.quantity ?? 1)
				)}" required></div>
        <div class="field"><label>Unit</label><select data-line-index="${index}" data-line-key="unit">${unitOptionsMarkup(line.item_id, line.unit)}</select></div>
        <div class="field"><label>${
					isMade ? "Production cost / unit" : "Price / unit"
				}</label><input data-line-index="${index}" data-line-key="unit_price" type="number" min="0" step="0.01" value="${esc(String(line.unit_price ?? 0))}" required></div>
        <div class="tx-line-total"><small>Line total</small><strong data-line-total="${index}">${money(num(line.quantity) * num(line.unit_price))}</strong></div>
        <button class="btn danger tx-remove-line" type="button" data-remove-line="${index}" ${lines.length === 1 ? "disabled" : ""} aria-label="Remove product line">Remove</button>
      </div>`
			)
			.join("");
	};
	const drawMaterials = () => {
		const host = $("#made-material-lines", root);
		if (!host) return;
		host.innerHTML =
			materials
				.map(
					(line, index) => `
      <div class="tx-material-row" data-material-row="${index}">
        <div class="field"><label>Material ${index + 1}</label><select data-material-index="${index}" data-material-key="item_id" required>${itemOptions(line.item_id)}</select></div>
        <div class="field"><label>Quantity used</label><input data-material-index="${index}" data-material-key="quantity" type="number" min="0.000001" step="any" value="${esc(
						String(line.quantity ?? 1)
					)}" required></div>
        <div class="field"><label>Unit</label><select data-material-index="${index}" data-material-key="unit">${unitOptionsMarkup(line.item_id, line.unit)}</select></div>
        <button class="btn danger" type="button" data-remove-material="${index}">Remove</button>
      </div>`
				)
				.join("") || `<div class="help">No materials tracked. You can still record finished goods and enter production cost per unit.</div>`;
	};

	const body = `
    <form id="tx-form">
      <div class="form-grid">
        <div class="field"><label>Type</label><input class="readonly" value="${isMade ? "Made" : type === "sold" ? "Sold" : "Bought"}" readonly></div>
        <div class="field"><label>Reference</label><input id="tx-ref" value="${esc(existing?.reference || `TX-${Date.now().toString(36).toUpperCase()}`)}" required></div>
        ${
					isMade
						? `<div class="field full"><label>Finished products</label><span class="help">Enter a cost per finished unit that includes the materials and any other production costs you want counted.</span></div>`
						: `
          <div class="field full contact-autocomplete-field">
            <label>${type === "sold" ? "Customer" : "Supplier"}</label>
            <input id="tx-contact-search" type="search" placeholder="Search ${
							type === "sold" ? "customers" : "suppliers"
						} by name or phone…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="tx-contact-suggestions" value="${esc(
								existing ? contactBy(existing.contact_id)?.name || "" : ""
						  )}" required>
            <input id="tx-contact" type="hidden" value="${esc(existing?.contact_id || "")}">
            <div id="tx-contact-suggestions" class="autocomplete-options" role="listbox" hidden></div>
            <span class="help">Type at least 2 characters. Suggestions are delayed and throttled to avoid excessive search work.</span>
          </div>`
				}
      </div>
      <div class="tx-lines-toolbar"><strong>${isMade ? "Finished products" : "Items"}</strong><button class="btn" type="button" id="tx-add-line">+ Add item</button></div>
      <div id="tx-lines" class="tx-lines"></div>
      ${
				isMade
					? `<section class="made-materials-box"><div class="tx-lines-toolbar"><strong>Materials used (optional)</strong><button class="btn" type="button" id="made-add-material">+ Add material</button></div><div id="made-material-lines"></div><p class="help">Materials are deducted from stock when saved. Cost per finished unit above should include these materials; material cost is not added a second time.</p></section>`
					: `
        <div class="form-grid tx-extra-fields"><div class="field"><label>Amount paid now</label><input id="tx-paid" type="number" min="0" step="0.01" value="${initialPaid}" ${
							existing ? "disabled" : ""
					  }><span class="help">Additional payments can be recorded later from Credit / Debit.</span></div>
        <div class="field"><label>Payment method</label><select id="tx-method"><option value="">Not specified</option><option>cash</option><option>upi</option><option>bank transfer</option><option>card</option><option>other</option></select></div></div>`
			}
      <div class="form-grid tx-extra-fields"><div class="field"><label>Date / time</label><input id="tx-date" type="datetime-local" value="${
				existing ? new Date(existing.occurred_at).toISOString().slice(0, 16) : todayISO()
			}" required></div></div>
      <div id="tx-summary" class="summary-box"></div>
      <div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">${
				existing ? "Save changes" : `Record ${isMade ? "Made" : type === "sold" ? "Sold" : "Bought"}`
			}</button></div>
    </form>`;

	const root = openModal(`${existing ? "Edit " : "Record "}${isMade ? "Made" : type === "sold" ? "Sold" : "Bought"}`, body, { wide: true });
	const summary = $("#tx-summary", root);
	const contactSearchEl = $("#tx-contact-search", root);
	const contactHiddenEl = $("#tx-contact", root);

	function calculate() {
		let total = 0;
		lines.forEach((line, index) => {
			const rowTotal = Math.round(num(line.quantity) * num(line.unit_price) * 100) / 100;
			total += rowTotal;
			const totalEl = $(`[data-line-total="${index}"]`, root);
			if (totalEl) totalEl.textContent = money(rowTotal);
		});
		total = Math.round(total * 100) / 100;
		const paid = num($("#tx-paid", root)?.value);
		const outstanding = Math.max(0, total - paid);
		summary.innerHTML = `<div><small>${isMade ? "Total production cost" : "Bill total"}</small><strong>${money(total)}</strong></div><div><small>${
			isMade ? "Finished product lines" : "Items"
		}</small><strong>${lines.length}</strong></div><div><small>${isMade ? "Materials tracked" : "Outstanding"}</small><strong>${isMade ? materials.length : money(outstanding)}</strong></div>`;
	}

	function chooseContact(contact) {
		contactHiddenEl.value = contact.id;
		contactSearchEl.value = contact.name;
		$("#tx-contact-suggestions", root).hidden = true;
		contactSearchEl.setAttribute("aria-expanded", "false");
	}

	function renderContactSuggestions(results) {
		const host = $("#tx-contact-suggestions", root);
		if (!host) return;
		contactResults = results;
		host.innerHTML = results.length
			? results
					.map(
						(contact, index) =>
							`<button type="button" role="option" aria-selected="false" class="autocomplete-option" data-contact-pick="${esc(contact.id)}" data-contact-index="${index}"><strong>${esc(
								contact.name
							)}</strong><small>${esc(contact.phone || contact.email || (contact.kind === "customer" ? "Customer" : "Supplier"))}</small></button>`
					)
					.join("")
			: `<div class="autocomplete-empty">No matching ${type === "sold" ? "customers" : "suppliers"}.</div>`;
		host.hidden = !String(contactSearchEl.value || "").trim();
		contactSearchEl.setAttribute("aria-expanded", String(!host.hidden));
	}

	async function runContactSearch(query) {
		if (query.length < 2) {
			renderContactSuggestions([]);
			return;
		}
		const now = Date.now();
		const delay = Math.max(0, 400 - (now - lastContactSearchAt));
		if (delay > 0) {
			clearTimeout(contactThrottleTimer);
			contactThrottleTimer = setTimeout(() => runContactSearch(query), delay);
			return;
		}
		lastContactSearchAt = Date.now();
		let results;
		if (appState.remote && appState.supabase && appState.session) {
			try {
				const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
				const [names, phones] = await Promise.all([
					appState.supabase
						.from("contacts")
						.select("id,name,phone,email,kind")
						.eq("user_id", appState.session.user.id)
						.eq("kind", type === "sold" ? "customer" : "supplier")
						.ilike("name", pattern)
						.limit(8),
					appState.supabase
						.from("contacts")
						.select("id,name,phone,email,kind")
						.eq("user_id", appState.session.user.id)
						.eq("kind", type === "sold" ? "customer" : "supplier")
						.ilike("phone", pattern)
						.limit(8),
				]);
				if (names.error) throw names.error;
				if (phones.error) throw phones.error;
				const map = new Map([...(names.data || []), ...(phones.data || [])].map((contact) => [contact.id, contact]));
				results = [...map.values()].slice(0, 8);
			} catch {
				results = contacts
					.filter((contact) =>
						[contact.name, contact.phone, contact.email].some((value) =>
							String(value || "")
								.toLowerCase()
								.includes(query)
						)
					)
					.slice(0, 8);
			}
		} else {
			results = contacts
				.filter((contact) =>
					[contact.name, contact.phone, contact.email].some((value) =>
						String(value || "")
							.toLowerCase()
							.includes(query)
					)
				)
				.slice(0, 8);
		}
		// Ignore stale asynchronous results when the user has typed further.
		if (contactSearchEl.value.trim().toLowerCase() !== query) return;
		renderContactSuggestions(results);
	}

	drawLines();
	drawMaterials();
	calculate();

	$("#tx-add-line", root).onclick = () => {
		if (lines.length >= 50) {
			toast("A transaction can contain at most 50 item lines.", "error");
			return;
		}
		lines.push({ item_id: "", quantity: 1, unit_price: 0, unit: "" });
		drawLines();
		calculate();
	};
	$("#made-add-material", root)?.addEventListener("click", () => {
		if (materials.length >= 50) {
			toast("A production record can track at most 50 material rows.", "error");
			return;
		}
		materials.push({ item_id: "", quantity: 1, unit: "" });
		drawMaterials();
	});

	root.addEventListener("click", (event) => {
		const removeLine = event.target.closest("[data-remove-line]");
		if (removeLine) {
			if (lines.length > 1) lines.splice(Number(removeLine.dataset.removeLine), 1);
			drawLines();
			calculate();
			return;
		}
		const removeMaterial = event.target.closest("[data-remove-material]");
		if (removeMaterial) {
			materials.splice(Number(removeMaterial.dataset.removeMaterial), 1);
			drawMaterials();
			return;
		}
		const pick = event.target.closest("[data-contact-pick]");
		if (pick) {
			const contact = contactResults.find((row) => row.id === pick.dataset.contactPick);
			if (contact) chooseContact(contact);
		}
	});

	root.addEventListener("change", (event) => {
		const target = event.target;
		if (target.dataset.lineIndex !== undefined) {
			const index = Number(target.dataset.lineIndex);
			const key = target.dataset.lineKey;
			if (!lines[index]) return;
			lines[index][key] = key === "item_id" || key === "unit" ? target.value : num(target.value);
			if (key === "item_id") {
				const selected = itemBy(target.value);
				lines[index].unit = selected?.base_unit || "";
				if (type === "sold") lines[index].unit_price = selected?.retail_price ?? 0;
				if (type === "bought") lines[index].unit_price = selected?.wholesale_price ?? 0;
				drawLines();
			}
			calculate();
		}
		if (target.dataset.materialIndex !== undefined) {
			const index = Number(target.dataset.materialIndex);
			const key = target.dataset.materialKey;
			if (!materials[index]) return;
			materials[index][key] = key === "item_id" || key === "unit" ? target.value : num(target.value);
			if (key === "item_id") {
				materials[index].unit = itemBy(target.value)?.base_unit || "";
				drawMaterials();
			}
		}
	});
	root.addEventListener("input", (event) => {
		const target = event.target;
		if (target.dataset.lineIndex !== undefined) {
			const index = Number(target.dataset.lineIndex);
			const key = target.dataset.lineKey;
			if (lines[index] && ["quantity", "unit_price"].includes(key)) {
				lines[index][key] = num(target.value);
				calculate();
			}
		}
		if (target.dataset.materialIndex !== undefined) {
			const index = Number(target.dataset.materialIndex);
			const key = target.dataset.materialKey;
			if (materials[index] && key === "quantity") materials[index][key] = num(target.value);
		}
	});

	if (contactSearchEl && contactHiddenEl) {
		contactSearchEl.addEventListener("input", () => {
			contactHiddenEl.value = "";
			clearTimeout(contactSearchTimer);
			clearTimeout(contactThrottleTimer);
			const query = contactSearchEl.value.trim().toLowerCase();
			if (query.length < 2) {
				renderContactSuggestions([]);
				return;
			}
			contactSearchTimer = setTimeout(() => runContactSearch(query), 280);
		});
		contactSearchEl.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				$("#tx-contact-suggestions", root).hidden = true;
				contactSearchEl.setAttribute("aria-expanded", "false");
			}
			if (event.key === "Enter" && !contactHiddenEl.value && contactResults.length) {
				event.preventDefault();
				chooseContact(contactResults[0]);
			}
		});
		contactSearchEl.addEventListener("blur", () =>
			setTimeout(() => {
				const list = $("#tx-contact-suggestions", root);
				if (list && !list.contains(document.activeElement)) list.hidden = true;
			}, 120)
		);
	}
	$("#tx-paid", root)?.addEventListener("input", calculate);

	$("#tx-form", root).onsubmit = async (event) => {
		event.preventDefault();
		try {
			if (!isMade && !contactHiddenEl?.value) throw Error(`Choose a ${type === "sold" ? "customer" : "supplier"} from the suggestions.`);
			const validLines = lines.map((line) => {
				const item = itemBy(line.item_id);
				if (!item) throw Error("Select a product for every line.");
				const quantity = num(line.quantity);
				const unitPrice = num(line.unit_price);
				const unit = line.unit || item.base_unit;
				if (quantity <= 0 || unitPrice < 0) throw Error("Each item needs a positive quantity and non-negative price/cost.");
				return { item_id: item.id, quantity, unit, unit_price: unitPrice };
			});
			const validMaterials = isMade
				? materials.map((material) => {
						const item = itemBy(material.item_id);
						if (!item) throw Error("Select a material for every material row, or remove the empty row.");
						const quantity = num(material.quantity);
						if (quantity <= 0) throw Error("Material quantities must be positive.");
						return { item_id: item.id, quantity, unit: material.unit || item.base_unit };
				  })
				: [];
			if (isMade) {
				const outputs = new Set(validLines.map((line) => line.item_id));
				if (validMaterials.some((material) => outputs.has(material.item_id))) throw Error("A product cannot also be a consumed material in the same production record.");
				const materialTotals = new Map();
				validMaterials.forEach((material) => {
					const item = itemBy(material.item_id);
					const base = material.quantity * unitMultiplier(item, material.unit);
					materialTotals.set(item.id, (materialTotals.get(item.id) || 0) + base);
				});
				for (const [itemId, amount] of materialTotals) if (stockBase(itemBy(itemId)) + 0.000001 < amount) throw Error(`Not enough stock for material ${itemBy(itemId).name}.`);
			}
			if (type === "sold") {
				const requested = new Map();
				validLines.forEach((line) => {
					const item = itemBy(line.item_id);
					requested.set(item.id, (requested.get(item.id) || 0) + line.quantity * unitMultiplier(item, line.unit));
				});
				for (const [itemId, amount] of requested) if (stockBase(itemBy(itemId)) + 0.000001 < amount) throw Error(`Not enough stock for ${itemBy(itemId).name}.`);
			}
			const total = Math.round(validLines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0) * 100) / 100;
			const paid = isMade ? 0 : num($("#tx-paid", root)?.value);
			if (!isMade && (paid < 0 || paid > total)) throw Error("Initial payment must be between zero and the bill total.");

			if (existing) {
				if (txPayments(existing.id).length) throw Error("This transaction has payments. Use payment settlement/voiding instead of editing its financial total.");
				const line = validLines[0];
				const selectedItem = itemBy(line.item_id);
				const multiplier = unitMultiplier(selectedItem, line.unit);
				await updateInventoryTransaction({
					transaction_id: existing.id,
					reference: $("#tx-ref", root).value.trim(),
					type,
					item_id: selectedItem.id,
					contact_id: isMade ? null : contactHiddenEl.value,
					quantity: line.quantity,
					unit: line.unit,
					base_quantity: line.quantity * multiplier,
					unit_price: line.unit_price,
					total_amount: total,
					cost_total: isMade ? total : estimateCOGS(selectedItem, line.quantity * multiplier),
					occurred_at: new Date($("#tx-date", root).value).toISOString(),
				});
				toast("Transaction updated.", "ok");
			} else {
				await recordMultiItemTransaction({
					reference: $("#tx-ref", root).value.trim(),
					type,
					contact_id: isMade ? null : contactHiddenEl.value,
					lines: validLines,
					materials: validMaterials,
					occurred_at: new Date($("#tx-date", root).value).toISOString(),
					initial_payment: paid,
					payment_method: isMade ? null : $("#tx-method", root)?.value || null,
				});
				toast(isMade ? "Production recorded; stock updated." : "Transaction recorded.", "ok");
			}
			$("#modal-root").innerHTML = "";
			await refreshApp();
		} catch (error) {
			toast(error.message || "Could not save transaction.", "error");
		}
	};
}

export function transactionDetailModal(txid) {
	const transaction = appState.data.transactions.find((item) => item.id === txid);
	if (!transaction) return;

	const lines = txLines(transaction.id);
	const payments = txPayments(transaction.id);
	const outstanding = txOutstanding(transaction);
	const materials = (appState.data.productionMaterials || []).filter((row) => row.transaction_id === transaction.id);
	const body = `<div class="grid-2">
      <div><div class="note">${esc(transaction.reference)} · ${esc(transaction.type)} · ${transaction.voided_at ? "VOIDED" : txStatus(transaction)}</div>
        <div style="margin-top:12px"><strong>${lines.length === 1 ? esc(lines[0].item_name) : `${lines.length} items`}</strong>
        <div class="tx-detail-lines">${lines
					.map((line) => `<div><span>${esc(line.item_name)} × ${esc(String(line.quantity))} ${esc(line.unit || "unit")}</span><strong>${money(line.line_total)}</strong></div>`)
					.join("")}</div>
        ${
					materials.length
						? `<div class="help" style="margin-top:10px">Materials consumed: ${materials.map((row) => `${esc(row.item_name)} × ${esc(String(row.quantity))} ${esc(row.unit)}`).join(", ")}</div>`
						: ""
				}
      </div></div>
      <div><div class="kpi"><div class="label">${transaction.type === "made" ? "Production cost" : "Bill total"}</div><div class="value">${money(transaction.total_amount)}</div></div>${
		transaction.type !== "made" ? `<div class="kpi" style="margin-top:10px"><div class="label">Outstanding</div><div class="value">${money(outstanding)}</div></div>` : ""
	}</div>
    </div>
    <div style="margin-top:18px"><h3>Payment history</h3>${
			payments.length
				? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th></tr></thead><tbody>${payments
						.map((payment) => `<tr><td>${fmtDate(payment.paid_at)}</td><td class="money">${money(payment.amount)}</td><td>${esc(payment.method || "—")}</td></tr>`)
						.join("")}</tbody></table></div>`
				: `<div class="empty">No payments recorded.</div>`
		}</div>
    <div class="form-footer">${!transaction.voided_at && transaction.type === "sold" ? `<button class="btn pink" id="detail-bill">Bill / Share</button>` : ""}${
		!transaction.voided_at && transaction.type !== "made" && outstanding > 0 ? `<button class="btn pink" id="detail-pay">Record payment</button>` : ""
	}${!transaction.voided_at && transaction.type !== "made" ? `<button class="btn" id="detail-return">Return</button>` : ""}${
		!transaction.voided_at && transaction.type !== "made" && lines.length === 1 ? `<button class="btn" id="detail-edit">Edit</button>` : ""
	}${!transaction.voided_at ? `<button class="btn danger" id="detail-void">Void / reverse</button>` : ""}<button class="btn" data-close>Close</button></div>${
		!transaction.voided_at && lines.length > 1 ? `<p class="help">For a multi-item transaction, correct mistakes by voiding and re-recording it. This preserves line-level stock history.</p>` : ""
	}`;

	const root = openModal("Transaction details", body, { wide: true });
	$("#detail-bill", root)?.addEventListener("click", () => openSaleBillModal(transaction));
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
	const lines = txLines(transaction.id);
	const returnableLines = lines
		.map((line) => {
			const alreadyReturned = appState.data.returns
				.filter(
					(record) =>
						!record.voided_at &&
						record.original_transaction_id === transaction.id &&
						(record.transaction_line_id ? record.transaction_line_id === line.id : line.line_no === 1 && record.item_id === line.item_id)
				)
				.reduce((sum, record) => sum + num(record.base_quantity), 0);
			return { ...line, remainingBase: Math.max(0, num(line.base_quantity) - alreadyReturned) };
		})
		.filter((line) => line.remainingBase > 0.000001);
	if (!returnableLines.length) {
		toast("All item quantities on this transaction have already been returned.", "error");
		return;
	}
	let selectedLine = returnableLines[0];
	let selectedItem = itemBy(selectedLine.item_id);

	const root = openModal(
		transaction.type === "sold" ? "Customer return" : "Supplier return",
		`<form id="return-form">
      <div class="note">${
				transaction.type === "sold" ? "Returned customer stock is added back to inventory." : "Returned supplier stock is removed from inventory."
			} Select the line being returned. The return remains linked to ${esc(transaction.reference)}.</div>
      <div class="form-grid" style="margin-top:14px">
        <div class="field full"><label>Product line</label><select id="r-line">${returnableLines
					.map((line) => `<option value="${esc(line.id)}">${esc(line.item_name)} · ${line.remainingBase} ${esc(itemBy(line.item_id)?.base_unit || line.unit || "unit")} remaining</option>`)
					.join("")}</select></div>
        <div class="field"><label>Remaining returnable quantity</label><input class="readonly" id="r-remaining" readonly></div>
        <div class="field"><label>Return quantity</label><input id="r-qty" type="number" min="0.000001" step="any" required></div>
        <div class="field"><label>Return value</label><input id="r-amount" type="number" min="0" step="0.01" required></div>
        <div class="field"><label>Refund / money returned</label><input id="r-refund" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>Date / time</label><input id="r-date" type="datetime-local" value="${todayISO()}" required></div>
      </div>
      <div class="help" style="margin-top:8px">Return value reduces the original Credit/Debit balance. A refund records money actually returned; it does not create another transaction.</div>
      <div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">Record return</button></div>
    </form>`
	);

	const setSelectedLine = () => {
		selectedLine = returnableLines.find((line) => line.id === $("#r-line", root).value) || returnableLines[0];
		selectedItem = itemBy(selectedLine.item_id);
		const currentReturnQty = selectedLine.remainingBase / unitMultiplier(selectedItem, selectedLine.unit || selectedItem?.base_unit);
		$("#r-remaining", root).value = `${currentReturnQty} ${selectedLine.unit || selectedItem?.base_unit || "unit"}`;
		$("#r-qty", root).max = currentReturnQty;
		$("#r-qty", root).value = "";
		$("#r-amount", root).value = "0.00";
		$("#r-amount", root).max = selectedLine.line_total;
	};
	setSelectedLine();
	$("#r-line", root).onchange = setSelectedLine;
	$("#r-qty", root).oninput = () => {
		const baseQty = num($("#r-qty", root).value) * unitMultiplier(selectedItem, selectedLine.unit || selectedItem?.base_unit);
		const amount = num(selectedLine.line_total) * (baseQty / Math.max(0.000001, num(selectedLine.base_quantity)));
		$("#r-amount", root).value = Math.max(0, Math.min(num(selectedLine.line_total), amount)).toFixed(2);
	};
	$("#return-form", root).onsubmit = async (event) => {
		event.preventDefault();
		try {
			const quantity = num($("#r-qty", root).value);
			const amount = num($("#r-amount", root).value);
			const refund = num($("#r-refund", root).value);
			const baseQuantity = quantity * unitMultiplier(selectedItem, selectedLine.unit || selectedItem?.base_unit);
			if (quantity <= 0 || baseQuantity > selectedLine.remainingBase + 0.000001) throw Error("Return quantity exceeds the remaining returnable quantity.");
			if (amount < 0 || amount > (num(selectedLine.line_total) * baseQuantity) / Math.max(0.000001, num(selectedLine.base_quantity)) + 0.01) throw Error("Return value is invalid.");
			if (refund < 0 || refund > amount + 0.000001) throw Error("Refund cannot exceed the return value.");
			await recordReturnLine({
				transaction_line_id: selectedLine.id,
				original_transaction_id: transaction.id,
				quantity,
				base_quantity: baseQuantity,
				amount,
				amount_cost: num(selectedLine.cost_total) * (baseQuantity / Math.max(0.000001, num(selectedLine.base_quantity))),
				refund_amount: refund,
				balance_adjustment: amount,
				occurred_at: new Date($("#r-date", root).value).toISOString(),
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
	const transaction = appState.data.transactions.find((item) => item.id === txid);
	const outstanding = txOutstanding(transaction);
	if (!transaction || outstanding <= 0) return;

	const root = openModal(
		"Record payment against existing balance",
		`<form id="payment-form">
      <div class="note">${transaction.type === "sold" ? "Customer payment — reduces Credit" : "Supplier payment — reduces Debit"} for <strong>${esc(
			contactBy(transaction.contact_id)?.name || "party"
		)}</strong>. This does not create another transaction.</div>
      <div class="form-grid" style="margin-top:14px"><div class="field"><label>Remaining outstanding</label><input class="readonly" readonly value="${money(
				outstanding
			)}"></div><div class="field"><label>Amount</label><input id="pay-amount" type="number" min="0.01" max="${outstanding}" step="0.01" required></div><div class="field"><label>Payment method</label><select id="pay-method"><option>cash</option><option>upi</option><option>bank transfer</option><option>card</option><option>other</option></select></div><div class="field"><label>Date / time</label><input id="pay-date" type="datetime-local" value="${todayISO()}" required></div></div>
      <div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">Save payment</button></div>
    </form>`
	);

	$("#payment-form", root).onsubmit = async (event) => {
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
				paid_at: new Date($("#pay-date", root).value).toISOString(),
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
      <div class="field full"><label>Photos (maximum 4)</label><input id="item-photos" type="text" placeholder="Paste image URLs separated by commas" value="${esc(
				(existing?.photos || []).join(", ")
			)}"><span class="help">Only the first four URLs are stored; lists show only one thumbnail.</span></div>
      <div class="field full"><label>Sub-unit / packaging conversions</label><div id="conversion-list"></div><button type="button" class="btn" id="add-conv">+ Add conversion</button><span class="help">Example: packet × 10 means 1 packet = 10 base units.</span></div>
    </div><div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">${existing ? "Save item" : "Create item"}</button></div></form>`;

	const root = openModal(existing ? "Edit inventory item" : "Add inventory item", body, { wide: true });
	let conversions = clone(existing?.conversions || []);

	function drawConversions() {
		$("#conversion-list", root).innerHTML =
			conversions
				.map(
					(conversion, index) =>
						`<div class="inline" style="margin:6px 0"><input data-c-name="${index}" value="${esc(
							conversion.name
						)}" placeholder="packet" style="flex:1"><input data-c-mult="${index}" type="number" min="1" step="any" value="${
							conversion.multiplier
						}" style="width:120px"><button type="button" class="btn danger" data-rm-c="${index}">×</button></div>`
				)
				.join("") || `<div class="muted">No conversions.</div>`;
	}

	$("#add-conv", root).onclick = () => {
		conversions.push({ name: "", multiplier: 1 });
		drawConversions();
	};

	root.addEventListener("click", (event) => {
		const button = event.target.closest("[data-rm-c]");
		if (!button) return;
		conversions.splice(Number(button.dataset.rmC), 1);
		drawConversions();
	});

	drawConversions();

	$("#item-form", root).onsubmit = async (event) => {
		event.preventDefault();

		try {
			conversions = conversions
				.map((conversion, index) => ({
					name: $(`[data-c-name="${index}"]`, root).value.trim(),
					multiplier: num($(`[data-c-mult="${index}"]`, root).value),
				}))
				.filter((conversion) => conversion.name && conversion.multiplier > 0);

			const photos = $("#item-photos", root)
				.value.split(",")
				.map((value) => value.trim())
				.filter(Boolean)
				.slice(0, 4);

			const payload = {
				name: $("#item-name", root).value.trim(),
				sku: $("#item-sku", root).value.trim() || null,
				base_unit: $("#item-unit", root).value.trim(),
				retail_price: num($("#item-retail", root).value),
				wholesale_price: num($("#item-wholesale", root).value),
				photos,
				conversions,
			};

			if (!payload.name) throw Error("Name is required.");

			if (existing) {
				await update("inventory_items", existing.id, payload);
			} else {
				await insert("inventory_items", {
					...payload,
					current_stock_base: num($("#item-stock", root).value),
					average_cost_base: 0,
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
      ${photos
				.map(
					(photo, index) => `
        <button class="image-preview-card" type="button" data-preview-src="${esc(photo)}" title="Open image ${index + 1}">
          <img src="${esc(photo)}" alt="${esc(item.name)} photo ${index + 1}" loading="lazy" onerror="this.closest('.image-preview-card').classList.add('image-error')">
        </button>
      `
				)
				.join("")}
    </div>
    <div class="help" style="margin-top:10px">Tap an image to open it larger.</div>`,
		{ wide: true }
	);

	const root = $("#modal-root");
	root.querySelectorAll("[data-preview-src]").forEach((button) => {
		button.addEventListener("click", () => {
			const src = button.dataset.previewSrc;
			if (!src) return;

			openModal(item.name, `<div class="single-image-preview"><img src="${esc(src)}" alt="${esc(item.name)}"></div>`, { wide: true });
		});
	});
}

export function contactModal(existingId = null) {
	const existing = existingId ? contactBy(existingId) : null;
	const root = openModal(
		existing ? "Edit contact" : "Add contact",
		`<form id="contact-form"><div class="form-grid">
      <div class="field"><label>Name</label><input id="c-name" value="${esc(existing?.name || "")}" required autocomplete="name"></div>
      <div class="field"><label>Type</label><select id="c-kind"><option ${existing?.kind === "customer" ? "selected" : ""}>customer</option><option ${
			existing?.kind === "supplier" ? "selected" : ""
		}>supplier</option></select></div>
      <div class="field"><label>Phone</label><input id="c-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" value="${esc(existing?.phone || "")}"></div>
      <div class="field"><label>Email <span class="muted">(optional)</span></label><input id="c-email" type="email" autocomplete="email" placeholder="Optional" value="${esc(
				existing?.email || ""
			)}"></div>
      <div class="field full">
      <button type="button" class="btn" id="pick-phone">
        Import from phone contacts
      </button>
      <span class="help">
        Select one contact to fill the form, or select multiple contacts
        to import them together. Existing phone/email duplicates are skipped.
      </span>
    </div>
    </div><div class="form-footer"><button type="button" class="btn" data-close>Cancel</button><button class="btn pink">Save contact</button></div></form>`
	);

	$("#pick-phone", root).onclick = async () => {
		const contactsApi = navigator.contacts;

		if (!contactsApi?.select) {
			toast("Phone contact selection is unavailable in this browser. Enter the contact manually.", "error");
			return;
		}

		try {
			const picked = await contactsApi.select(["name", "tel", "email"], { multiple: true });

			if (!picked?.length) return;

			const firstValue = (value) => (Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim());

			const selected = picked
				.map((contact) => {
					const phone = firstValue(contact.tel);
					const email = firstValue(contact.email);

					return {
						name: firstValue(contact.name) || phone || email,
						phone,
						email,
					};
				})
				.filter((contact) => contact.name);

			if (!selected.length) {
				toast("No usable contacts were selected.", "error");
				return;
			}

			// One contact: fill the existing form for review.
			if (selected.length === 1) {
				const contact = selected[0];

				$("#c-name", root).value = contact.name;
				$("#c-phone", root).value = contact.phone;
				$("#c-email", root).value = contact.email;

				toast("Contact selected. Review and save it.", "ok");
				return;
			}

			// Multiple contacts: import using the selected contact type.
			const kind = $("#c-kind", root).value;
			const existingContacts = appState.data.contacts || [];

			const contactKey = (contact) => {
				const phone = String(contact.phone || "").replace(/\D/g, "");
				const email = String(contact.email || "")
					.trim()
					.toLowerCase();

				if (phone) return `phone:${phone}`;
				if (email) return `email:${email}`;

				return null;
			};

			const knownKeys = new Set(
				existingContacts
					.filter((contact) => contact.kind === kind)
					.map(contactKey)
					.filter(Boolean)
			);

			const toCreate = [];
			let skipped = 0;

			for (const contact of selected) {
				const key = contactKey(contact);

				if (key && knownKeys.has(key)) {
					skipped++;
					continue;
				}

				toCreate.push({
					...contact,
					kind,
				});

				if (key) knownKeys.add(key);
			}

			if (!toCreate.length) {
				toast("All selected contacts already exist for this type.", "ok");
				return;
			}

			// The database's existing rate limit allows 120 mutations per minute.
			// Keep each import batch below that limit.
			if (toCreate.length > 100) {
				toast("Select up to 100 new contacts per import.", "error");
				return;
			}

			if (appState.remote) {
				if (!appState.session?.user?.id) {
					throw new Error("Sign in before importing contacts.");
				}

				const rows = toCreate.map((contact) => ({
					...contact,
					user_id: appState.session.user.id,
				}));

				const { error } = await appState.supabase.from("contacts").insert(rows);

				if (error) throw error;
			} else {
				const makeId = () => globalThis.crypto?.randomUUID?.() || `contact_${Date.now()}_${Math.random().toString(36).slice(2)}`;

				appState.data.contacts.push(
					...toCreate.map((contact) => ({
						...contact,
						id: makeId(),
					}))
				);

				saveLocal();
			}

			$("#modal-root").innerHTML = "";

			toast(`Imported ${toCreate.length} contact(s).` + (skipped ? ` Skipped ${skipped} duplicate(s).` : ""), "ok");

			await refreshApp();
		} catch (error) {
			if (error?.name !== "AbortError") {
				toast(error.message || "Could not import contacts.", "error");
			}
		}
	};

	$("#contact-form", root).onsubmit = async (event) => {
		event.preventDefault();

		try {
			const payload = {
				name: $("#c-name", root).value.trim(),
				kind: $("#c-kind", root).value,
				phone: $("#c-phone", root).value.trim() || null,
				email: $("#c-email", root).value.trim() || null,
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

	$("#expense-form", root).onsubmit = async (event) => {
		event.preventDefault();

		try {
			await insert("expenses", {
				category: $("#e-cat", root).value,
				amount: num($("#e-amount", root).value),
				description: $("#e-desc", root).value.trim() || null,
				occurred_at: new Date($("#e-date", root).value).toISOString(),
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
		`<div class="grid-2"><div class="card-body"><strong>${esc(profile.full_name || profile.email)}</strong><div class="muted">${esc(
			profile.email
		)}</div><div class="form-footer" style="justify-content:flex-start"><button class="btn danger" id="signout">Sign out</button></div></div><div class="card-body"><strong>Supabase connection</strong><p class="muted">Publishable/anon key is safe to expose in a browser only when RLS is correctly configured.</p><div class="field"><label>Project URL</label><input id="sb-url" value="${esc(
			cfg.url || ""
		)}" placeholder="https://xxxx.supabase.co"></div><div class="field" style="margin-top:9px"><label>Publishable / anon key</label><input id="sb-key" value="${esc(
			cfg.key || ""
		)}" placeholder="eyJ..."></div><div class="form-footer" style="justify-content:flex-start"><button class="btn pink" id="connect-sb">Save & connect</button><button class="btn" id="local-mode">Use local mode</button></div></div></div>`
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
		options: { redirectTo: location.origin + location.pathname },
	});

	if (error) toast(error.message, "error");
}
