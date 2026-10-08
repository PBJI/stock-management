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

## Database setup

1. In Supabase SQL Editor, reset the development `public` schema if it contains the failed previous attempt:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;
```

2. Run `stockflow_supabase_secure.sql` completely from the first line.
3. Serve this folder over HTTP (for example with VS Code Live Server or `python -m http.server`) rather than opening the HTML with `file://`.
4. Sign in with Supabase Auth.

## Storage

The SQL creates a private `inventory-images` bucket. Storage paths must start with the authenticated user's UUID, for example:

`<user-id>/product.webp`

The current supplied UI still supports pasted image URLs in the inventory form. The Storage bucket and quota are available for direct Storage uploads, but the current UI does not automatically migrate pasted external URLs into Storage.
