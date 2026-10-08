# StockFlow — database schema design

This document is the database design for the StockFlow single-page application. It intentionally does **not** contain the requested `.sql` initializer. The SQL file can be generated later from this design.

## Design goals

- Supabase Auth with Google.
- Every business record is owned by exactly one authenticated user.
- Row Level Security (RLS) is enabled on every user-owned table.
- Financial history is append-oriented: payments are separate rows and financial transactions are voided/reversed rather than casually deleted.
- Foreign keys protect historical integrity.
- Inventory stock is stored in the item's **base unit**.
- Packaging/sub-unit conversions translate user-entered quantities into base-unit quantities.
- Historical transaction prices are stored on the transaction and never read back from current inventory reference prices.
- Credit = outstanding amount on sales.
- Debit = outstanding amount on purchases.
- Made = production transaction that increases stock but does not create receivables/payables.
- Returns remain linked to their source transaction.
- P&L can be recalculated from source records.

---

## 1. `profiles`

One profile per Supabase Auth user.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | References `auth.users.id`, cascade on auth deletion |
| `email` | text | Copied from auth |
| `full_name` | text | Google profile name |
| `avatar_url` | text nullable | Google avatar |
| `created_at` | timestamptz | Default now |
| `updated_at` | timestamptz | Default now |

**RLS:** user can select/update only their own `id`; insert is limited to their own auth UID.

---

## 2. `inventory_items`

One row per sellable/manufacturable item.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK profiles | Owner |
| `name` | text | Required |
| `sku` | text nullable | Optional |
| `base_unit` | text | `piece`, `kg`, `litre`, etc. |
| `current_stock_base` | numeric | Current available stock in base units; must be >= 0 |
| `retail_price` | numeric | Current reference price only |
| `wholesale_price` | numeric | Current reference price only |
| `average_cost_base` | numeric | Weighted-average cost per base unit |
| `photos` | jsonb | Maximum four URL strings |
| `conversions` | jsonb | Example: `[{"name":"packet","multiplier":10}]` |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Unit rule

A conversion means:

`1 selected unit = multiplier base units`

Example:

- base unit = `piece`
- conversion = `packet × 10`
- entering `3 packets` changes stock by `30 pieces`.

The database should validate conversion multipliers as positive numbers. The frontend should also validate them, but database rules remain authoritative.

### Deletion

An item referenced by any historical transaction/return must not be physically deleted.

Recommended database implementation:

- `transactions.item_id -> inventory_items.id ON DELETE RESTRICT`
- `returns.item_id -> inventory_items.id ON DELETE RESTRICT`

The frontend may hide the delete action after use, but the FK restriction is the real protection.

---

## 3. `contacts`

Customers and suppliers are deliberately separate entities from auth users.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK profiles | Owner |
| `name` | text | Required |
| `kind` | text | `customer` or `supplier` |
| `phone` | text nullable | |
| `email` | text nullable | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

Recommended check:

`kind IN ('customer','supplier')`

Historical contacts should not be deleted while referenced.

Recommended:

- `transactions.contact_id -> contacts.id ON DELETE RESTRICT`
- `returns.contact_id -> contacts.id ON DELETE RESTRICT`

If a business needs to stop using a contact, prefer an `archived_at` field rather than deleting it.

---

## 4. `transactions`

The authoritative business event for Sold, Bought, and Made.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK profiles | Owner |
| `reference` | text | Unique per user |
| `type` | text | `sold`, `bought`, `made` |
| `item_id` | uuid FK inventory_items | Required |
| `contact_id` | uuid FK contacts nullable | Required for sold/bought, null for made |
| `quantity` | numeric | Quantity in selected UI unit |
| `unit` | text | Unit used in the transaction |
| `base_quantity` | numeric | Converted quantity in base units |
| `unit_price` | numeric | Actual historical transaction price |
| `total_amount` | numeric | `quantity * unit_price` |
| `cost_total` | numeric | Inventory cost / production cost used by P&L |
| `occurred_at` | timestamptz | Transaction date/time |
| `voided_at` | timestamptz nullable | Safe reversal marker |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Core constraints

- `quantity > 0`
- `base_quantity > 0`
- `unit_price >= 0`
- `total_amount >= 0`
- `cost_total >= 0`
- `type IN ('sold','bought','made')`
- `reference` unique within `user_id`.

Business constraint:

- `sold` and `bought` require a contact.
- `made` must not have a contact.
- `made` must increase inventory.
- `bought` must increase inventory.
- `sold` must decrease inventory.
- Negative inventory is prohibited.

The database should implement stock-changing operations in a transaction / RPC so concurrent sales cannot both consume the same last stock.

---

## 5. `transaction_payments`

Payments are separate from transactions so one transaction can have many payments.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK profiles | Owner |
| `transaction_id` | uuid FK transactions | Source transaction |
| `amount` | numeric | Must be > 0 |
| `method` | text nullable | cash, upi, bank transfer, card, other |
| `paid_at` | timestamptz | |
| `created_at` | timestamptz | |

### Financial invariant

For every active transaction:

`SUM(transaction_payments.amount) <= transactions.total_amount`

This must be enforced server-side. A trigger or transactional RPC is preferable to trusting an RLS policy alone.

A payment must never be allowed to exceed the remaining outstanding amount.

The UI calculates:

`Outstanding = Total - SUM(Payments)`

Settled:

`Outstanding = 0`

---

## 6. Credit / Debit

No independent `credit` or `debit` payment-status column is required.

The balance is derived:

### Sale

`Credit = Sale Total - Sum of Payments`

### Purchase

`Debit = Purchase Total - Sum of Payments`

This prevents duplicated or conflicting state.

A payment against an existing transaction only inserts into `transaction_payments`. It never creates a new `sold` or `bought` transaction.

For party-level reporting:

- customer balance = sum of outstanding sales
- supplier balance = sum of outstanding purchases

---

## 7. `expenses`

Operating expenses are separate from inventory purchases.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK profiles | Owner |
| `category` | text | rent, electricity, transport, salaries, packaging, marketing, other |
| `description` | text nullable | |
| `amount` | numeric | Must be > 0 |
| `occurred_at` | timestamptz | |
| `created_at` | timestamptz | |

Inventory purchase is **not** automatically an operating expense.

---

## 8. `returns`

Returns support customer and supplier return workflows.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK profiles | Owner |
| `original_transaction_id` | uuid FK transactions | Source |
| `item_id` | uuid FK inventory_items | Returned item |
| `contact_id` | uuid FK contacts | Customer/supplier |
| `kind` | text | `customer_return` or `supplier_return` |
| `quantity` | numeric | Positive returned quantity |
| `base_quantity` | numeric | Converted base quantity |
| `amount` | numeric | Value of returned portion |
| `amount_cost` | numeric | Historical COGS portion reversed for P & L |
| `refund_amount` | numeric | Cash/payment refund if any |
| `balance_adjustment` | numeric | Credit/debit adjustment |
| `occurred_at` | timestamptz | |
| `created_at` | timestamptz | |

### Return inventory effect

- customer return: `+base_quantity`
- supplier return: `-base_quantity`

The sum of returns against an original transaction must never exceed the original quantity.

Returns should be append-only or voidable rather than casually deleted.

---

## 9. Inventory costing / P&L

The initial implementation uses a weighted-average approach.

Maintain:

`weighted average cost = total acquisition/production cost / total acquired base quantity`

For a sale, snapshot the calculated COGS onto the transaction:

`cost_total = base_quantity_sold × weighted_average_cost_at_sale`

This is important because later inventory prices must not change historical P&L.

### P&L

For a date range:

- **Revenue** = recognized sales revenue, net of applicable return adjustments.
- **COGS** = sum of `cost_total` for sales, adjusted for returns.
- **Gross profit** = Revenue - COGS.
- **Operating expenses** = sum of `expenses.amount`.
- **Net profit** = Gross profit - Operating expenses.

Made/production cost is captured separately and becomes part of inventory cost rather than being blindly treated as an operating expense at the moment stock is manufactured.

The report should support:

- monthly range
- custom start/end date

---

## 10. RLS model

Enable RLS on:

- `profiles`
- `inventory_items`
- `contacts`
- `transactions`
- `transaction_payments`
- `expenses`
- `returns`

Every policy must use the authenticated UID.

Canonical ownership expression:

`user_id = auth.uid()`

For `profiles`, the key is:

`id = auth.uid()`

For child records, ownership should be explicit via `user_id`; do not rely only on a client-supplied parent relationship.

### Required operations

For each user-owned table, policies should cover only the operations actually required:

- SELECT own records
- INSERT only with own `user_id`
- UPDATE own records
- DELETE own records only where business rules allow it

Financial records should generally favor:

- insert
- read
- controlled update
- void/reversal

rather than unrestricted delete.

---

## 11. Authoritative database business rules

RLS answers **who** can touch data. It does not by itself answer **whether the operation is financially valid**.

Use constraints, triggers and/or transactional RPC functions for:

1. No negative inventory.
2. No payment above remaining transaction balance.
3. No payment above transaction total.
4. No return above original transaction quantity.
5. No negative quantities.
6. No invalid transaction types.
7. Correct contact requirement for sold/bought/made.
8. Prevent deletion of referenced inventory/contact records.
9. Atomic inventory update + transaction insert.
10. Atomic payment insert + balance check.
11. Atomic transaction void + inventory reversal.
12. Unique transaction reference per user.
13. Maximum four stored photo URLs.
14. Valid positive unit-conversion multipliers.

For high-integrity writes, prefer RPC functions such as conceptually:

- `record_inventory_transaction(...)`
- `record_payment(...)`
- `void_transaction(...)`
- `record_return(...)`

The frontend should call these instead of attempting to emulate multi-step accounting in separate network requests.

---

## 12. Local mode

When Supabase is not configured/authenticated:

- use browser `localStorage`
- do not mix local records into Supabase
- clearly display `Local mode`
- keep local data under a dedicated storage key
- do not fabricate demo data

When Supabase mode is active:

- use authenticated user ID
- load only that user's records
- clearly display `Supabase mode`

---

## 13. Indexes

Recommended indexes:

- `inventory_items(user_id, name)`
- `contacts(user_id, kind, name)`
- `transactions(user_id, occurred_at DESC)`
- `transactions(user_id, contact_id, type)`
- `transactions(user_id, item_id, occurred_at DESC)`
- `transaction_payments(user_id, transaction_id, paid_at)`
- `expenses(user_id, occurred_at DESC)`
- `returns(user_id, original_transaction_id)`

These keep the common single-business views fast without adding unnecessary schema complexity.

---

## 14. Deletion policy summary

| Record | Normal delete? | Preferred behavior |
|---|---|---|
| Inventory item | Only before historical use | DB FK RESTRICT |
| Customer/supplier | Only before historical use | DB FK RESTRICT / archive |
| Sold/Bought/Made transaction | Avoid | Void + reverse effects |
| Payment | Avoid | Append-only; reversal if correction is needed |
| Return | Avoid | Void/reversal |
| Expense | Can be deleted if business allows | Audit trail can be added later |

This keeps historical financial records reconstructable.
