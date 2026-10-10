# StockFlow — Supabase-aligned build

This build fixes the frontend/database mismatches in the supplied StockFlow files.

## What changed

- `inventory` frontend calls now resolve to `inventory_items`.
- `payments` frontend calls now resolve to `transaction_payments`.
- Sold / Bought / Made uses `record_inventory_transaction()`.
- Transaction editing uses `update_inventory_transaction()`.
- Payments use `record_payment()`.
- Returns use `record_return()`.
- Voiding uses `void_transaction()`.
- Stock-changing financial flows no longer perform separate browser-side stock mutations.
- Inventory CRUD remains owner-scoped and uses `inventory_items`.
- Existing local mode remains available.
- The accompanying SQL is updated so financial table writes are RPC-only, while RLS remains enabled.
- Database rate limiting remains enabled at 120 authenticated mutation operations per 60-second window per user.
- Inventory image Storage bucket remains capped at 5 MiB per object and 50 MiB total per user.
- Sold transactions can generate revocable public bill links and downloadable PNG bill images, including all item lines.
- One Sold/Bought transaction can contain multiple product lines while keeping payments and the bill under one transaction reference.
- Made supports one or more finished products, per-unit production cost, and optional manually entered material consumption (no BOM or batch-management system).
- Search and pagination are available for Inventory, Transactions, contacts, Credit/Debit balances, and operating expenses.
- Sold/Bought contact autocomplete uses a 280 ms debounce, a 400 ms minimum request interval, name/phone lookup, and stale-response protection.
- Stock-changing operations write to a lightweight `stock_movements` audit ledger; current stock remains stored for quick display.
- Mobile header and form action buttons wrap instead of overflowing the viewport.
- Public bill links use a 256-bit random token; only the SHA-256 token hash is stored in Supabase, and public access goes through a narrow RPC returning a bill snapshot.

## Database setup

### If this is a new, empty Supabase project

1. Run `stockflow_supabase_secure.sql`.
2. Run `stockflow_shared_bills.sql`.
3. Run `stockflow_next_version_migration.sql`.

### If you already use the previous StockFlow version

Run **only** `stockflow_next_version_migration.sql` in Supabase SQL Editor. It is additive and backfills each existing transaction as a single line so existing bills, payments, and history remain attached to their original transaction IDs.

**Do not run `DROP SCHEMA public CASCADE` or rerun the base schema against a populated production database.** Take a Supabase backup and test the migration on a staging copy first. The migration depends on the tables/functions from the two earlier SQL scripts being present.

After migration, deploy the updated static app and sign in. New Sold/Bought/Made records then use the multi-item RPC. Do not manually grant anonymous access to `transaction_lines`, `production_materials`, or `stock_movements`; the migration keeps direct writes unavailable to browser clients.

## Storage

The SQL creates a private `inventory-images` bucket. Storage paths must start with the authenticated user's UUID, for example:

`<user-id>/product.webp`

The current supplied UI still supports pasted image URLs in the inventory form. The Storage bucket and quota are available for direct Storage uploads, but the current UI does not automatically migrate pasted external URLs into Storage.

## Public bills

Open a non-voided **Sold** transaction and choose **Bill / Share**. The bill can be downloaded as a PNG, or a customer-shareable URL can be generated from Supabase mode. Anyone with that URL can read the bill snapshot without an account; no direct table access is granted to `anon`. Generating a new link rotates the token and invalidates the previous link. The seller can revoke the active link from the same bill dialog. Editing or voiding the sale automatically invalidates the existing link. Payment and balance figures represent the moment the bill was generated; regenerate the link to issue an updated bill after later payments.

The generated document is a basic sales bill, not a GST/tax invoice. The app currently has no seller address, GSTIN, tax-rate, or tax-breakdown fields to populate.
