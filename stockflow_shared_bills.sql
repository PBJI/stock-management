-- StockFlow: publicly shareable bill links for Sold transactions
-- Run this AFTER stockflow_supabase_secure.sql in Supabase SQL Editor.
-- Public links use 256-bit random bearer tokens. Only SHA-256 hashes are stored.
-- The public RPC returns a limited JSON snapshot; it never grants direct table access.

begin;

create extension if not exists pgcrypto;

create table if not exists public.shared_sale_bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid not null unique,
  token_hash bytea not null unique,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (transaction_id, user_id)
    references public.transactions(id, user_id) on delete cascade
);

create index if not exists shared_sale_bills_user_tx_idx
  on public.shared_sale_bills(user_id, transaction_id);

alter table public.shared_sale_bills enable row level security;
-- Intentionally no RLS policies and no browser table grants. Access goes through RPCs.
revoke all on public.shared_sale_bills from public, anon, authenticated;

create or replace function public.create_shared_sale_bill(p_transaction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid uuid := auth.uid();
  tx public.transactions%rowtype;
  bill_item public.inventory_items%rowtype;
  customer public.contacts%rowtype;
  seller public.profiles%rowtype;
  paid_total numeric(20,2) := 0;
  return_adjustments numeric(20,2) := 0;
  due_total numeric(20,2) := 0;
  raw_token text;
  bill_snapshot jsonb;
  saved_bill_id uuid;
begin
  if uid is null then
    raise exception 'Sign in to generate a bill link';
  end if;

  select * into tx
  from public.transactions
  where id = p_transaction_id and user_id = uid
  for update;

  if not found then
    raise exception 'Sale not found';
  end if;
  if tx.type <> 'sold' then
    raise exception 'Bills can only be generated for Sold transactions';
  end if;
  if tx.voided_at is not null then
    raise exception 'A voided sale cannot have a bill link';
  end if;

  select * into bill_item
  from public.inventory_items
  where id = tx.item_id and user_id = uid;
  if not found then
    raise exception 'Sale item not found';
  end if;

  select * into customer
  from public.contacts
  where id = tx.contact_id and user_id = uid and kind = 'customer';
  if not found then
    raise exception 'Sale customer not found';
  end if;

  select * into seller
  from public.profiles
  where id = uid;

  select coalesce(sum(amount), 0)::numeric(20,2)
    into paid_total
  from public.transaction_payments
  where transaction_id = tx.id and user_id = uid;

  select coalesce(sum(balance_adjustment), 0)::numeric(20,2)
    into return_adjustments
  from public.returns
  where original_transaction_id = tx.id
    and user_id = uid
    and voided_at is null;

  due_total := greatest(0, tx.total_amount - paid_total - return_adjustments)::numeric(20,2);
  raw_token := encode(gen_random_bytes(32), 'hex');

  bill_snapshot := jsonb_build_object(
    'bill_reference', tx.reference,
    'bill_date', tx.occurred_at,
    'generated_at', now(),
    'seller_name', coalesce(nullif(btrim(seller.full_name), ''), 'StockFlow seller'),
    'customer_name', customer.name,
    'item_name', bill_item.name,
    'item_sku', bill_item.sku,
    'quantity', tx.quantity,
    'unit', tx.unit,
    'unit_price', tx.unit_price,
    'line_total', tx.total_amount,
    'total_amount', tx.total_amount,
    'amount_paid', paid_total,
    'balance_due', due_total,
    'currency', 'INR',
    'payment_status', case
      when due_total <= 0.005 then 'Settled'
      when paid_total <= 0.005 then 'Unpaid'
      else 'Partially paid'
    end
  );

  insert into public.shared_sale_bills (
    user_id, transaction_id, token_hash, snapshot, created_at, revoked_at
  ) values (
    uid,
    tx.id,
    digest(convert_to(raw_token, 'UTF8'), 'sha256'),
    bill_snapshot,
    now(),
    null
  )
  on conflict (transaction_id) do update
    set user_id = excluded.user_id,
        token_hash = excluded.token_hash,
        snapshot = excluded.snapshot,
        created_at = excluded.created_at,
        revoked_at = null
  returning id into saved_bill_id;

  -- The clear token is returned once to the authenticated owner, never stored.
  return jsonb_build_object(
    'token', raw_token,
    'snapshot', bill_snapshot,
    'created_at', now()
  );
end;
$$;

create or replace function public.get_shared_sale_bill(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  bill_snapshot jsonb;
begin
  -- A 32-byte token encoded as hex is exactly 64 hex characters.
  if p_token is null or length(p_token) <> 64 or p_token !~ '^[a-fA-F0-9]{64}$' then
    return null;
  end if;

  select snapshot into bill_snapshot
  from public.shared_sale_bills
  where token_hash = digest(convert_to(lower(p_token), 'UTF8'), 'sha256')
    and revoked_at is null
  limit 1;

  return bill_snapshot;
end;
$$;

create or replace function public.revoke_shared_sale_bill(p_transaction_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid uuid := auth.uid();
  affected integer;
begin
  if uid is null then
    raise exception 'Sign in to revoke a bill link';
  end if;

  -- Confirm the sale belongs to the caller and is a Sold transaction.
  perform 1
  from public.transactions
  where id = p_transaction_id and user_id = uid and type = 'sold';
  if not found then
    raise exception 'Sale not found';
  end if;

  update public.shared_sale_bills
  set revoked_at = now()
  where transaction_id = p_transaction_id
    and user_id = uid
    and revoked_at is null;

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

-- Invalidate a shared bill if core sale details change or the transaction is voided.
create or replace function public.invalidate_shared_sale_bill_on_transaction_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if old.type = 'sold' and (
    new.type is distinct from old.type or
    new.reference is distinct from old.reference or
    new.item_id is distinct from old.item_id or
    new.contact_id is distinct from old.contact_id or
    new.quantity is distinct from old.quantity or
    new.unit is distinct from old.unit or
    new.unit_price is distinct from old.unit_price or
    new.total_amount is distinct from old.total_amount or
    new.occurred_at is distinct from old.occurred_at or
    (new.voided_at is distinct from old.voided_at and new.voided_at is not null)
  ) then
    update public.shared_sale_bills
    set revoked_at = coalesce(revoked_at, now())
    where transaction_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists invalidate_shared_sale_bill_on_transaction_change on public.transactions;
create trigger invalidate_shared_sale_bill_on_transaction_change
after update of type, reference, item_id, contact_id, quantity, unit, unit_price, total_amount, occurred_at, voided_at
on public.transactions
for each row execute function public.invalidate_shared_sale_bill_on_transaction_change();

-- Keep the RPCs callable only by the intended roles.
revoke all on function public.create_shared_sale_bill(uuid) from public, anon;
revoke all on function public.get_shared_sale_bill(text) from public;
revoke all on function public.revoke_shared_sale_bill(uuid) from public, anon;
grant execute on function public.create_shared_sale_bill(uuid) to authenticated;
grant execute on function public.get_shared_sale_bill(text) to anon, authenticated;
grant execute on function public.revoke_shared_sale_bill(uuid) to authenticated;

grant usage on schema public to anon, authenticated;

commit;
