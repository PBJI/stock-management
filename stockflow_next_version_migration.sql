-- StockFlow next-version migration: multi-item transactions + simple manufacturing + multi-line public bills.
-- Run AFTER stockflow_supabase_secure.sql and stockflow_shared_bills.sql.
-- Non-destructive: existing transactions are backfilled as one-line transactions.
-- Review on a backup/staging project before production.

begin;
create extension if not exists pgcrypto;

-- A lightweight audit ledger: every stock-changing transaction/return/production event
-- leaves a signed movement. Existing balances are reconciled into an opening movement.
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id uuid not null,
  movement_type text not null,
  source_type text not null,
  source_id uuid,
  quantity_delta numeric(20,6) not null,
  note text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (item_id,user_id) references public.inventory_items(id,user_id) on delete cascade
);
create index if not exists stock_movements_user_item_date_idx on public.stock_movements(user_id,item_id,occurred_at desc);
create index if not exists stock_movements_user_date_idx on public.stock_movements(user_id,occurred_at desc);
alter table public.stock_movements enable row level security;
drop policy if exists stock_movements_select_own on public.stock_movements;
create policy stock_movements_select_own on public.stock_movements for select to authenticated using (user_id=auth.uid());
revoke insert,update,delete on public.stock_movements from anon,authenticated;
grant select on public.stock_movements to authenticated;

-- 1) Transaction line snapshots. Parent transaction remains the payment/bill header.
create table if not exists public.transaction_lines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid not null,
  line_no integer not null check (line_no > 0),
  item_id uuid not null,
  item_name text not null,
  item_sku text,
  quantity numeric(20,6) not null check (quantity > 0),
  unit text not null check (length(btrim(unit)) > 0),
  base_quantity numeric(20,6) not null check (base_quantity > 0),
  unit_price numeric(20,2) not null check (unit_price >= 0),
  line_total numeric(20,2) not null check (line_total >= 0),
  cost_total numeric(20,2) not null default 0 check (cost_total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,user_id),
  unique (transaction_id,line_no),
  foreign key (transaction_id,user_id) references public.transactions(id,user_id) on delete cascade,
  foreign key (item_id,user_id) references public.inventory_items(id,user_id) on delete restrict,
  check (line_total = round(quantity * unit_price,2))
);
create index if not exists transaction_lines_user_tx_idx on public.transaction_lines(user_id,transaction_id,line_no);
create index if not exists transaction_lines_user_item_idx on public.transaction_lines(user_id,item_id,transaction_id);
alter table public.transaction_lines enable row level security;
drop policy if exists transaction_lines_select_own on public.transaction_lines;
create policy transaction_lines_select_own on public.transaction_lines for select to authenticated using (user_id=auth.uid());
revoke insert,update,delete on public.transaction_lines from anon,authenticated;
grant select on public.transaction_lines to authenticated;
drop trigger if exists transaction_lines_updated_at on public.transaction_lines;
create trigger transaction_lines_updated_at before update on public.transaction_lines
for each row execute function public.set_updated_at();

-- 2) Optional materials consumed by a simple Made transaction. No recipes/BOMs required.
create table if not exists public.production_materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid not null,
  item_id uuid not null,
  item_name text not null,
  quantity numeric(20,6) not null check (quantity > 0),
  unit text not null check (length(btrim(unit)) > 0),
  base_quantity numeric(20,6) not null check (base_quantity > 0),
  created_at timestamptz not null default now(),
  foreign key (transaction_id,user_id) references public.transactions(id,user_id) on delete cascade,
  foreign key (item_id,user_id) references public.inventory_items(id,user_id) on delete restrict
);
create index if not exists production_materials_user_tx_idx on public.production_materials(user_id,transaction_id);
alter table public.production_materials enable row level security;
drop policy if exists production_materials_select_own on public.production_materials;
create policy production_materials_select_own on public.production_materials for select to authenticated using (user_id=auth.uid());
revoke insert,update,delete on public.production_materials from anon,authenticated;
grant select on public.production_materials to authenticated;

-- 3) Link each return to its specific line (legacy one-line returns remain valid).
alter table public.returns add column if not exists transaction_line_id uuid;
do $$ begin
  alter table public.returns add constraint returns_transaction_line_user_fk
    foreign key (transaction_line_id,user_id) references public.transaction_lines(id,user_id) on delete restrict;
exception when duplicate_object then null; end $$;
create index if not exists returns_user_line_idx on public.returns(user_id,transaction_line_id);

-- 4) Backfill every historic transaction as a single line without changing stock or balances.
insert into public.transaction_lines(
  user_id,transaction_id,line_no,item_id,item_name,item_sku,quantity,unit,base_quantity,unit_price,line_total,cost_total
)
select tx.user_id,tx.id,1,tx.item_id,coalesce(i.name,'Item'),i.sku,tx.quantity,tx.unit,tx.base_quantity,
       tx.unit_price,tx.total_amount,tx.cost_total
from public.transactions tx
join public.inventory_items i on i.id=tx.item_id and i.user_id=tx.user_id
where not exists (select 1 from public.transaction_lines tl where tl.transaction_id=tx.id and tl.user_id=tx.user_id);

-- Map prior one-item returns to their new line, preserving historic return data.
update public.returns r set transaction_line_id=tl.id
from public.transaction_lines tl
where r.transaction_line_id is null
  and tl.transaction_id=r.original_transaction_id
  and tl.user_id=r.user_id
  and tl.item_id=r.item_id
  and tl.line_no=1;

-- Backfill historical movements once. These source_type labels are migration-specific,
-- so rerunning this migration does not duplicate the history rows.
insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
select tl.user_id,tl.item_id,tx.type::text,'migration_transaction',tx.id,
       case when tx.type='sold' then -sum(tl.base_quantity) else sum(tl.base_quantity) end,
       tx.occurred_at,'Backfilled from existing transaction lines'
from public.transaction_lines tl join public.transactions tx on tx.id=tl.transaction_id and tx.user_id=tl.user_id
group by tl.user_id,tl.item_id,tx.type,tx.id,tx.voided_at,tx.occurred_at
having not exists (select 1 from public.stock_movements sm where sm.source_type='migration_transaction' and sm.source_id=tx.id and sm.item_id=tl.item_id);
insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
select tl.user_id,tl.item_id,'void_reversal','migration_void',tx.id,
       case when tx.type='sold' then sum(tl.base_quantity) else -sum(tl.base_quantity) end,
       tx.voided_at,'Backfilled reversal for a voided transaction'
from public.transaction_lines tl join public.transactions tx on tx.id=tl.transaction_id and tx.user_id=tl.user_id
where tx.voided_at is not null
group by tl.user_id,tl.item_id,tx.id,tx.type,tx.voided_at
having not exists (select 1 from public.stock_movements sm where sm.source_type='migration_void' and sm.source_id=tx.id and sm.item_id=tl.item_id);
insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
select r.user_id,r.item_id,r.kind::text,'migration_return',r.id,
       case when r.kind='customer_return' then r.base_quantity else -r.base_quantity end,
       r.occurred_at,'Backfilled from existing return'
from public.returns r
where not exists (select 1 from public.stock_movements sm where sm.source_type='migration_return' and sm.source_id=r.id and sm.item_id=r.item_id);
insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
select r.user_id,r.item_id,'return_void_reversal','migration_return_void',r.id,
       case when r.kind='customer_return' then -r.base_quantity else r.base_quantity end,
       r.voided_at,'Backfilled reversal for a voided return'
from public.returns r where r.voided_at is not null
and not exists (select 1 from public.stock_movements sm where sm.source_type='migration_return_void' and sm.source_id=r.id and sm.item_id=r.item_id);

-- Reconcile the current on-hand quantity to the migrated movement history.
-- The opening movement balances prior opening stock and any legacy manual adjustments.
insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
select i.user_id,i.id,'opening_balance','opening_balance',null,
       i.current_stock_base - coalesce(active.net_delta,0),
       coalesce((select min(tx.occurred_at)-interval '1 second' from public.transactions tx where tx.user_id=i.user_id and tx.item_id=i.id),i.created_at),
       'Reconciled opening balance at migration'
from public.inventory_items i
left join (
  select user_id,item_id,sum(delta) net_delta from (
    select tl.user_id,tl.item_id,case when tx.type='sold' then -tl.base_quantity else tl.base_quantity end delta
    from public.transaction_lines tl join public.transactions tx on tx.id=tl.transaction_id and tx.user_id=tl.user_id where tx.voided_at is null
    union all
    select pm.user_id,pm.item_id,-pm.base_quantity from public.production_materials pm join public.transactions tx on tx.id=pm.transaction_id and tx.user_id=pm.user_id where tx.voided_at is null
    union all
    select r.user_id,r.item_id,case when r.kind='customer_return' then r.base_quantity else -r.base_quantity end from public.returns r where r.voided_at is null
  ) movements group by user_id,item_id
) active on active.user_id=i.user_id and active.item_id=i.id
where abs(i.current_stock_base - coalesce(active.net_delta,0)) > 0.000001
  and not exists (select 1 from public.stock_movements sm where sm.source_type='opening_balance' and sm.user_id=i.user_id and sm.item_id=i.id);

-- Legacy app clients may still insert/update a single-line transaction. Keep its child line synced.
create or replace function public.sync_legacy_transaction_line()
returns trigger language plpgsql security definer set search_path=public as $$
declare n integer; item_name_value text; item_sku_value text;
begin
  if tg_op='INSERT' then
    select name,sku into item_name_value,item_sku_value from public.inventory_items where id=new.item_id and user_id=new.user_id;
    insert into public.transaction_lines(user_id,transaction_id,line_no,item_id,item_name,item_sku,quantity,unit,base_quantity,unit_price,line_total,cost_total)
    values(new.user_id,new.id,1,new.item_id,coalesce(item_name_value,'Item'),item_sku_value,new.quantity,new.unit,new.base_quantity,new.unit_price,new.total_amount,new.cost_total)
    on conflict (transaction_id,line_no) do nothing;
    return new;
  end if;
  select count(*) into n from public.transaction_lines where transaction_id=new.id and user_id=new.user_id;
  if n=1 then
    select name,sku into item_name_value,item_sku_value from public.inventory_items where id=new.item_id and user_id=new.user_id;
    update public.transaction_lines set item_id=new.item_id,item_name=coalesce(item_name_value,'Item'),item_sku=item_sku_value,
      quantity=new.quantity,unit=new.unit,base_quantity=new.base_quantity,unit_price=new.unit_price,
      line_total=new.total_amount,cost_total=new.cost_total,updated_at=now()
    where transaction_id=new.id and user_id=new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists sync_legacy_transaction_line on public.transactions;
create trigger sync_legacy_transaction_line after insert or update of item_id,quantity,unit,base_quantity,unit_price,total_amount,cost_total on public.transactions
for each row execute function public.sync_legacy_transaction_line();

-- 5) Replace average-cost calculation so it includes every Bought/Made line, not just the header's first item.
create or replace function public.recalculate_average_cost(p_item_id uuid,p_user_id uuid)
returns numeric language plpgsql security definer set search_path=public as $$
declare qty numeric; cost numeric; avg_cost numeric;
begin
  select coalesce(sum(tl.base_quantity),0),coalesce(sum(tl.cost_total),0)
    into qty,cost
  from public.transaction_lines tl join public.transactions tx on tx.id=tl.transaction_id and tx.user_id=tl.user_id
  where tl.item_id=p_item_id and tl.user_id=p_user_id and tx.voided_at is null and tx.type in ('bought','made');
  avg_cost:=case when qty>0 then cost/qty else 0 end;
  update public.inventory_items set average_cost_base=greatest(avg_cost,0),updated_at=now()
  where id=p_item_id and user_id=p_user_id;
  return avg_cost;
end $$;

-- 6) Atomic operation for multi-item Sold/Bought/Made. Lines = [{item_id,quantity,unit,unit_price}].
--    Made line unit_price is the total production cost per finished unit (include materials/labour as appropriate).
--    Materials = [{item_id,quantity,unit}], optional for Made only. The DB validates conversions and stock.
create or replace function public.record_multi_item_transaction(
  p_reference text,
  p_type public.transaction_type,
  p_contact_id uuid,
  p_lines jsonb,
  p_materials jsonb default '[]'::jsonb,
  p_occurred_at timestamptz default now(),
  p_initial_payment numeric default 0,
  p_payment_method public.payment_method default null,
  p_payment_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare
  uid uuid:=auth.uid(); tx public.transactions%rowtype; row_value jsonb; mat_value jsonb;
  inv public.inventory_items%rowtype; first_item_id uuid; first_quantity numeric; first_unit text; first_base numeric; first_price numeric;
  qty numeric; mult numeric; base_qty numeric; price numeric; line_total numeric; line_cost numeric;
  grand_total numeric:=0; grand_cost numeric:=0; paid numeric:=coalesce(p_initial_payment,0); line_no integer:=0;
  current_stock numeric; material_ids uuid[]:='{}'; output_ids uuid[]:='{}'; amount_delta numeric;
  first_line_item_id uuid; first_line_quantity numeric; first_line_unit text; first_line_base numeric; first_line_price numeric;
  header_quantity numeric; header_unit text; header_base numeric; header_price numeric;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform public.enforce_rate_limit(120,60);
  if p_reference is null or length(btrim(p_reference))=0 then raise exception 'Reference is required'; end if;
  if p_type not in ('sold','bought','made') then raise exception 'Unsupported transaction type'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)<1 or jsonb_array_length(p_lines)>50 then raise exception 'Add between 1 and 50 product lines'; end if;
  if p_materials is null then p_materials:='[]'::jsonb; end if;
  if jsonb_typeof(p_materials)<>'array' or jsonb_array_length(p_materials)>50 then raise exception 'Materials must be a list of up to 50 rows'; end if;
  if p_type in ('sold','bought') and p_contact_id is null then raise exception 'Select a customer/supplier'; end if;
  if p_type in ('sold','bought') and not exists (
    select 1 from public.contacts c
    where c.id=p_contact_id and c.user_id=uid
      and c.kind=case when p_type='sold' then 'customer'::public.contact_kind else 'supplier'::public.contact_kind end
  ) then raise exception 'Select a valid customer or supplier'; end if;
  if p_type='made' and p_contact_id is not null then raise exception 'Made transactions cannot have a contact'; end if;
  if p_type<>'made' and jsonb_array_length(p_materials)>0 then raise exception 'Materials are only available for Made transactions'; end if;
  if p_type='made' and p_initial_payment<>0 then raise exception 'Made transactions cannot have payments'; end if;
  if paid<0 then raise exception 'Initial payment cannot be negative'; end if;

  -- Lock every touched inventory record in stable order to avoid competing sale/production races.
  perform 1 from public.inventory_items i
   where i.user_id=uid and i.id in (
     select (x->>'item_id')::uuid from jsonb_array_elements(p_lines) x
     union select (x->>'item_id')::uuid from jsonb_array_elements(p_materials) x
   ) order by i.id for update;

  -- Validate and price output/product lines.
  for row_value in select value from jsonb_array_elements(p_lines) loop
    qty:=coalesce((row_value->>'quantity')::numeric,0);
    price:=round(coalesce((row_value->>'unit_price')::numeric,-1),2);
    if qty<=0 or price<0 then raise exception 'Every line needs a positive quantity and non-negative price/cost'; end if;
    begin first_item_id:=(row_value->>'item_id')::uuid; exception when others then raise exception 'Every line needs a valid product'; end;
    select * into inv from public.inventory_items where id=first_item_id and user_id=uid;
    if not found then raise exception 'A selected product was not found'; end if;
    first_unit:=coalesce(nullif(btrim(row_value->>'unit'),''),inv.base_unit);
    mult:=case when lower(btrim(first_unit))=lower(btrim(inv.base_unit)) then 1 else coalesce((select (c->>'multiplier')::numeric from jsonb_array_elements(inv.conversions) c where lower(btrim(c->>'name'))=lower(btrim(first_unit)) limit 1),-1) end;
    if mult<=0 then raise exception 'Unit % is not configured for %',first_unit,inv.name; end if;
    base_qty:=qty*mult;
    line_total:=round(qty*price,2);
    if p_type='sold' then line_cost:=round(inv.average_cost_base*base_qty,2); else line_cost:=line_total; end if;
    grand_total:=grand_total+line_total; grand_cost:=grand_cost+line_cost;
    line_no:=line_no+1;
    if line_no=1 then
      first_line_item_id:=inv.id; first_line_quantity:=qty; first_line_unit:=first_unit; first_line_base:=base_qty; first_line_price:=price;
    end if;
    output_ids:=array_append(output_ids,inv.id);
  end loop;

  if p_type='made' and jsonb_array_length(p_materials)>0 then
    for mat_value in select value from jsonb_array_elements(p_materials) loop
      qty:=coalesce((mat_value->>'quantity')::numeric,0);
      if qty<=0 then raise exception 'Material quantities must be positive'; end if;
      first_item_id:=(mat_value->>'item_id')::uuid;
      if first_item_id=any(output_ids) then raise exception 'A product cannot be both an output and a consumed material in the same production record'; end if;
      select * into inv from public.inventory_items where id=first_item_id and user_id=uid;
      if not found then raise exception 'A selected material was not found'; end if;
      first_unit:=coalesce(nullif(btrim(mat_value->>'unit'),''),inv.base_unit);
      mult:=case when lower(btrim(first_unit))=lower(btrim(inv.base_unit)) then 1 else coalesce((select (c->>'multiplier')::numeric from jsonb_array_elements(inv.conversions) c where lower(btrim(c->>'name'))=lower(btrim(first_unit)) limit 1),-1) end;
      if mult<=0 then raise exception 'Unit % is not configured for material %',first_unit,inv.name; end if;
      base_qty:=qty*mult;
      material_ids:=array_append(material_ids,inv.id);
    end loop;
    -- Validate combined quantity for repeated material rows, not each row in isolation.
    for inv in select i.* from public.inventory_items i where i.user_id=uid and i.id=any(material_ids) order by i.id loop
      select i.current_stock_base - coalesce((
        select sum((x->>'quantity')::numeric * case
          when lower(btrim(coalesce(nullif(btrim(x->>'unit'),''),i.base_unit)))=lower(btrim(i.base_unit)) then 1
          else coalesce((select (c->>'multiplier')::numeric from jsonb_array_elements(i.conversions) c where lower(btrim(c->>'name'))=lower(btrim(coalesce(nullif(btrim(x->>'unit'),''),i.base_unit))) limit 1),1)
        end) from jsonb_array_elements(p_materials) x where (x->>'item_id')::uuid=i.id
      ),0) into current_stock from public.inventory_items i where i.id=inv.id and i.user_id=uid;
      if current_stock < -0.000001 then raise exception 'Not enough combined material stock for %',inv.name; end if;
    end loop;
  end if;

  if p_type='sold' then
    for inv in select i.* from public.inventory_items i where i.user_id=uid and i.id=any(output_ids) order by i.id loop
      select i.current_stock_base - coalesce(sum((x->>'quantity')::numeric * case when lower(btrim(coalesce(nullif(btrim(x->>'unit'),''),i.base_unit)))=lower(btrim(i.base_unit)) then 1 else coalesce((select (c->>'multiplier')::numeric from jsonb_array_elements(i.conversions) c where lower(btrim(c->>'name'))=lower(btrim(coalesce(nullif(btrim(x->>'unit'),''),i.base_unit))) limit 1),1) end),0)
        into current_stock from public.inventory_items i cross join jsonb_array_elements(p_lines) x
       where i.id=inv.id and i.user_id=uid and (x->>'item_id')::uuid=i.id
       group by i.current_stock_base;
      if current_stock < -0.000001 then raise exception 'Not enough stock for %',inv.name; end if;
    end loop;
  end if;
  if p_type in ('sold','bought') and paid>grand_total then raise exception 'Initial payment exceeds bill total'; end if;

  -- Single-line headers keep legacy columns accurate. Multi-line headers hold bill totals;
  -- child transaction_lines are authoritative for item-level stock and costing.
  if jsonb_array_length(p_lines)=1 then
    header_quantity:=first_line_quantity; header_unit:=first_line_unit; header_base:=first_line_base; header_price:=first_line_price;
  else
    header_quantity:=1; header_unit:='transaction'; header_base:=1; header_price:=round(grand_total,2);
  end if;
  -- The stock ledger trigger is skipped for this multi-line operation; exact movements
  -- are written explicitly below from every line and consumed-material row.
  perform set_config('stockflow.skip_stock_ledger','on',true);
  insert into public.transactions(user_id,reference,type,item_id,contact_id,quantity,unit,base_quantity,unit_price,total_amount,cost_total,occurred_at)
  values(uid,btrim(p_reference),p_type,first_line_item_id,p_contact_id,header_quantity,header_unit,header_base,header_price,round(grand_total,2),round(grand_cost,2),coalesce(p_occurred_at,now()))
  returning * into tx;
  -- The transaction trigger seeded a compatibility line; replace it with the supplied lines.
  delete from public.transaction_lines where transaction_id=tx.id and user_id=uid;
  line_no:=0;
  for row_value in select value from jsonb_array_elements(p_lines) loop
    qty:=(row_value->>'quantity')::numeric; price:=round((row_value->>'unit_price')::numeric,2); first_item_id:=(row_value->>'item_id')::uuid;
    select * into inv from public.inventory_items where id=first_item_id and user_id=uid;
    first_unit:=coalesce(nullif(btrim(row_value->>'unit'),''),inv.base_unit);
    mult:=case when lower(btrim(first_unit))=lower(btrim(inv.base_unit)) then 1 else coalesce((select (c->>'multiplier')::numeric from jsonb_array_elements(inv.conversions) c where lower(btrim(c->>'name'))=lower(btrim(first_unit)) limit 1),-1) end;
    base_qty:=qty*mult; line_total:=round(qty*price,2);
    if p_type='sold' then line_cost:=round(inv.average_cost_base*base_qty,2); else line_cost:=line_total; end if;
    line_no:=line_no+1;
    insert into public.transaction_lines(user_id,transaction_id,line_no,item_id,item_name,item_sku,quantity,unit,base_quantity,unit_price,line_total,cost_total)
    values(uid,tx.id,line_no,inv.id,inv.name,inv.sku,qty,first_unit,base_qty,price,line_total,line_cost);
    if p_type='sold' then update public.inventory_items set current_stock_base=current_stock_base-base_qty,updated_at=now() where id=inv.id and user_id=uid;
    else update public.inventory_items set current_stock_base=current_stock_base+base_qty,updated_at=now() where id=inv.id and user_id=uid; end if;
  end loop;

  if p_type='made' then
    for mat_value in select value from jsonb_array_elements(p_materials) loop
      qty:=(mat_value->>'quantity')::numeric; first_item_id:=(mat_value->>'item_id')::uuid;
      select * into inv from public.inventory_items where id=first_item_id and user_id=uid;
      first_unit:=coalesce(nullif(btrim(mat_value->>'unit'),''),inv.base_unit);
      mult:=case when lower(btrim(first_unit))=lower(btrim(inv.base_unit)) then 1 else coalesce((select (c->>'multiplier')::numeric from jsonb_array_elements(inv.conversions) c where lower(btrim(c->>'name'))=lower(btrim(first_unit)) limit 1),-1) end;
      base_qty:=qty*mult;
      insert into public.production_materials(user_id,transaction_id,item_id,item_name,quantity,unit,base_quantity)
      values(uid,tx.id,inv.id,inv.name,qty,first_unit,base_qty);
      update public.inventory_items set current_stock_base=current_stock_base-base_qty,updated_at=now() where id=inv.id and user_id=uid;
    end loop;
  end if;

  if paid>0 then
    insert into public.transaction_payments(user_id,transaction_id,amount,method,paid_at)
    values(uid,tx.id,paid,p_payment_method,coalesce(p_payment_at,p_occurred_at,now()));
  end if;
  for first_item_id in select distinct tl.item_id from public.transaction_lines tl where tl.transaction_id=tx.id and tl.user_id=uid and p_type in ('bought','made') loop
    perform public.recalculate_average_cost(first_item_id,uid);
  end loop;

  insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
  select uid,tl.item_id,p_type::text,'transaction',tx.id,
         case when p_type='sold' then -sum(tl.base_quantity) else sum(tl.base_quantity) end,
         tx.occurred_at,'Recorded from multi-item transaction'
  from public.transaction_lines tl where tl.transaction_id=tx.id and tl.user_id=uid
  group by tl.item_id;
  if p_type='made' then
    insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
    select uid,pm.item_id,'material_consumed','production_material',tx.id,-sum(pm.base_quantity),tx.occurred_at,'Materials consumed during production'
    from public.production_materials pm where pm.transaction_id=tx.id and pm.user_id=uid
    group by pm.item_id;
  end if;
  perform set_config('stockflow.skip_stock_ledger','off',true);
  return jsonb_build_object('transaction_id',tx.id,'reference',tx.reference,'type',tx.type,'total_amount',tx.total_amount,'cost_total',tx.cost_total);
end $$;
revoke all on function public.record_multi_item_transaction(text,public.transaction_type,uuid,jsonb,jsonb,timestamptz,numeric,public.payment_method,timestamptz) from public,anon;
grant execute on function public.record_multi_item_transaction(text,public.transaction_type,uuid,jsonb,jsonb,timestamptz,numeric,public.payment_method,timestamptz) to authenticated;

-- 7) Line-aware return validation. Legacy rows with no transaction_line_id keep the old rules.
create or replace function public.validate_return()
returns trigger language plpgsql security definer set search_path=public as $$
declare tx public.transactions%rowtype; tl public.transaction_lines%rowtype; returned_qty numeric; expected_kind public.return_kind; max_amount numeric; max_cost numeric; max_base numeric; max_qty numeric;
begin
  select * into tx from public.transactions where id=new.original_transaction_id and user_id=new.user_id for update;
  if not found then raise exception 'Original transaction not found'; end if;
  if tx.voided_at is not null then raise exception 'Cannot return a voided transaction'; end if;
  if new.transaction_line_id is not null then
    select * into tl from public.transaction_lines where id=new.transaction_line_id and user_id=new.user_id and transaction_id=tx.id;
    if not found then raise exception 'Original transaction line not found'; end if;
    if tl.item_id<>new.item_id then raise exception 'Return item must match the selected transaction line'; end if;
    max_qty:=tl.quantity; max_base:=tl.base_quantity; max_amount:=tl.line_total; max_cost:=tl.cost_total;
    select coalesce(sum(base_quantity),0) into returned_qty from public.returns where transaction_line_id=tl.id and user_id=new.user_id and voided_at is null and id<>new.id;
  else
    if tx.item_id<>new.item_id then raise exception 'Return item must match original transaction'; end if;
    max_qty:=tx.quantity; max_base:=tx.base_quantity; max_amount:=tx.total_amount; max_cost:=tx.cost_total;
    select coalesce(sum(base_quantity),0) into returned_qty from public.returns where original_transaction_id=tx.id and user_id=new.user_id and voided_at is null and id<>new.id and transaction_line_id is null;
  end if;
  if tx.contact_id is distinct from new.contact_id then raise exception 'Return contact must match original transaction'; end if;
  expected_kind:=case when tx.type='sold' then 'customer_return'::public.return_kind when tx.type='bought' then 'supplier_return'::public.return_kind else null end;
  if expected_kind is null or new.kind<>expected_kind then raise exception 'Return type does not match original transaction'; end if;
  if new.quantity<=0 or new.base_quantity<=0 then raise exception 'Return quantity must be positive'; end if;
  if returned_qty+new.base_quantity>max_base+0.000001 then raise exception 'Return quantity exceeds the remaining quantity for this line'; end if;
  if new.amount>max_amount*(new.base_quantity/max_base)+0.01 then raise exception 'Return amount exceeds the value of the returned portion'; end if;
  if new.amount_cost>max_cost*(new.base_quantity/max_base)+0.01 then raise exception 'Return cost adjustment exceeds returned portion COGS'; end if;
  if new.refund_amount>new.amount+0.01 or new.balance_adjustment>new.amount+0.01 then raise exception 'Refund/balance adjustment cannot exceed return amount'; end if;
  return new;
end $$;
drop trigger if exists validate_return on public.returns;
create trigger validate_return before insert or update on public.returns for each row execute function public.validate_return();

create or replace function public.record_return_line(
  p_transaction_line_id uuid,p_quantity numeric,p_base_quantity numeric,p_amount numeric,p_amount_cost numeric,
  p_refund_amount numeric default 0,p_balance_adjustment numeric default 0,p_occurred_at timestamptz default now()
)
returns public.returns language plpgsql security definer set search_path=public as $$
declare uid uuid:=auth.uid(); tl public.transaction_lines%rowtype; tx public.transactions%rowtype; inv public.inventory_items%rowtype; ret public.returns%rowtype; k public.return_kind; new_stock numeric;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform public.enforce_rate_limit(120,60);
  select * into tl from public.transaction_lines where id=p_transaction_line_id and user_id=uid for update;
  if not found then raise exception 'Transaction line not found'; end if;
  select * into tx from public.transactions where id=tl.transaction_id and user_id=uid for update;
  if not found or tx.voided_at is not null then raise exception 'Original transaction not found or voided'; end if;
  if tx.type not in ('sold','bought') then raise exception 'Only Sold/Bought transactions can be returned'; end if;
  select * into inv from public.inventory_items where id=tl.item_id and user_id=uid for update;
  if p_quantity is null or p_quantity<=0 or p_base_quantity is null or p_base_quantity<=0 then raise exception 'Return quantity must be positive'; end if;
  if abs(p_base_quantity - (p_quantity * (tl.base_quantity / tl.quantity))) > 0.000001 then raise exception 'Return quantity does not match the transaction line unit'; end if;
  if p_amount is null or p_amount<0 or p_amount_cost is null or p_amount_cost<0 then raise exception 'Return amount and cost must be non-negative'; end if;
  k:=case when tx.type='sold' then 'customer_return'::public.return_kind else 'supplier_return'::public.return_kind end;
  insert into public.returns(user_id,original_transaction_id,transaction_line_id,item_id,contact_id,kind,quantity,base_quantity,amount,amount_cost,refund_amount,balance_adjustment,occurred_at)
  values(uid,tx.id,tl.id,tl.item_id,tx.contact_id,k,p_quantity,p_base_quantity,p_amount,p_amount_cost,coalesce(p_refund_amount,0),coalesce(p_balance_adjustment,0),coalesce(p_occurred_at,now())) returning * into ret;
  new_stock:=case when k='customer_return' then inv.current_stock_base+p_base_quantity else inv.current_stock_base-p_base_quantity end;
  if new_stock<0 then raise exception 'Supplier return would make stock negative'; end if;
  update public.inventory_items set current_stock_base=new_stock,updated_at=now() where id=inv.id and user_id=uid;
  return ret;
end $$;
revoke all on function public.record_return_line(uuid,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz) from public,anon;
grant execute on function public.record_return_line(uuid,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz) to authenticated;

-- Compatibility wrapper for older app clients: the old return API has no line ID,
-- so it is safe only when the original transaction has exactly one line.
create or replace function public.record_return(
  p_original_transaction_id uuid,p_quantity numeric,p_base_quantity numeric,p_amount numeric,p_amount_cost numeric,
  p_refund_amount numeric default 0,p_balance_adjustment numeric default 0,p_occurred_at timestamptz default now()
)
returns public.returns language plpgsql security definer set search_path=public as $$
declare uid uuid:=auth.uid(); line_count integer; tl public.transaction_lines%rowtype;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  select count(*) into line_count from public.transaction_lines where transaction_id=p_original_transaction_id and user_id=uid;
  if line_count<>1 then raise exception 'This transaction contains multiple items. Return a specific line from Transaction details.'; end if;
  select * into tl from public.transaction_lines where transaction_id=p_original_transaction_id and user_id=uid order by line_no limit 1 for update;
  return public.record_return_line(tl.id,p_quantity,p_base_quantity,p_amount,p_amount_cost,coalesce(p_refund_amount,0),coalesce(p_balance_adjustment,0),coalesce(p_occurred_at,now()));
end $$;
revoke all on function public.record_return(uuid,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz) from public,anon;
grant execute on function public.record_return(uuid,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz) to authenticated;

-- Prevent older single-item edit RPCs from corrupting a multi-line transaction or a
-- Made transaction whose material consumption cannot be edited through the old RPC.
create or replace function public.guard_legacy_transaction_edit()
returns trigger language plpgsql security definer set search_path=public as $$
declare line_count integer; has_materials boolean;
begin
  if current_setting('stockflow.allow_legacy_edit',true)='on' then return new; end if;
  if old.item_id is distinct from new.item_id or old.type is distinct from new.type
     or old.quantity is distinct from new.quantity or old.unit is distinct from new.unit
     or old.base_quantity is distinct from new.base_quantity or old.unit_price is distinct from new.unit_price
     or old.total_amount is distinct from new.total_amount or old.cost_total is distinct from new.cost_total then
    select count(*) into line_count from public.transaction_lines where transaction_id=old.id and user_id=old.user_id;
    select exists(select 1 from public.production_materials where transaction_id=old.id and user_id=old.user_id) into has_materials;
    if line_count>1 then raise exception 'Multi-item transactions cannot be edited in place. Void and recreate the transaction.'; end if;
    if has_materials then raise exception 'Made transactions with material consumption cannot be edited in place. Void and recreate the production record.'; end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_legacy_transaction_edit on public.transactions;
create trigger guard_legacy_transaction_edit before update of item_id,type,quantity,unit,base_quantity,unit_price,total_amount,cost_total on public.transactions
for each row execute function public.guard_legacy_transaction_edit();

-- 8) Void/reverse every line and restore any materials consumed by a Made transaction.
create or replace function public.void_transaction(p_transaction_id uuid)
returns public.transactions language plpgsql security definer set search_path=public as $$
declare uid uuid:=auth.uid(); tx public.transactions%rowtype; stock_row record; new_stock numeric; line_item uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform public.enforce_rate_limit(120,60);
  select * into tx from public.transactions where id=p_transaction_id and user_id=uid for update;
  if not found then raise exception 'Transaction not found'; end if;
  if tx.voided_at is not null then return tx; end if;
  if exists(select 1 from public.transaction_payments where transaction_id=tx.id and user_id=uid) then raise exception 'Transactions with payments cannot be voided directly; reverse/settle payment history first'; end if;
  if exists(select 1 from public.returns where original_transaction_id=tx.id and user_id=uid and voided_at is null) then raise exception 'Transactions with active returns cannot be voided'; end if;
  for stock_row in
    select touched.item_id,sum(touched.delta) delta from (
      select tl.item_id,case when tx.type='sold' then tl.base_quantity else -tl.base_quantity end delta
      from public.transaction_lines tl where tl.transaction_id=tx.id and tl.user_id=uid
      union all
      select pm.item_id,pm.base_quantity from public.production_materials pm where pm.transaction_id=tx.id and pm.user_id=uid
    ) touched group by touched.item_id order by touched.item_id
  loop
    select current_stock_base+stock_row.delta into new_stock from public.inventory_items where id=stock_row.item_id and user_id=uid for update;
    if new_stock< -0.000001 then raise exception 'Voiding this transaction would make stock negative for item %',stock_row.item_id; end if;
    update public.inventory_items set current_stock_base=greatest(new_stock,0),updated_at=now() where id=stock_row.item_id and user_id=uid;
  end loop;
  -- The normal transaction ledger trigger is suppressed; record reversals for all lines below.
  perform set_config('stockflow.skip_stock_ledger','on',true);
  update public.transactions set voided_at=now(),updated_at=now() where id=tx.id and user_id=uid returning * into tx;
  for stock_row in
    select touched.item_id,sum(touched.delta) delta from (
      select tl.item_id,case when tx.type='sold' then tl.base_quantity else -tl.base_quantity end delta
      from public.transaction_lines tl where tl.transaction_id=tx.id and tl.user_id=uid
      union all
      select pm.item_id,pm.base_quantity from public.production_materials pm where pm.transaction_id=tx.id and pm.user_id=uid
    ) touched group by touched.item_id order by touched.item_id
  loop
    insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
    values(uid,stock_row.item_id,'void_reversal','void',tx.id,stock_row.delta,coalesce(tx.voided_at,now()),'Stock reversal for voided transaction');
  end loop;
  perform set_config('stockflow.skip_stock_ledger','off',true);
  if tx.type in ('bought','made') then
    for line_item in select distinct item_id from public.transaction_lines where transaction_id=tx.id and user_id=uid loop
      perform public.recalculate_average_cost(line_item,uid);
    end loop;
  end if;
  return tx;
end $$;
revoke all on function public.void_transaction(uuid) from public,anon;
grant execute on function public.void_transaction(uuid) to authenticated;

-- 9) Public bill snapshot now contains line items. The bill table still stores only a hash + safe snapshot.
create or replace function public.create_shared_sale_bill(p_transaction_id uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare uid uuid:=auth.uid(); tx public.transactions%rowtype; customer public.contacts%rowtype; seller public.profiles%rowtype;
  paid_total numeric(20,2):=0; return_adjustments numeric(20,2):=0; due_total numeric(20,2):=0; raw_token text; bill_snapshot jsonb; lines_json jsonb;
begin
  if uid is null then raise exception 'Sign in to generate a bill link'; end if;
  perform public.enforce_rate_limit(120,60);
  select * into tx from public.transactions where id=p_transaction_id and user_id=uid for update;
  if not found then raise exception 'Sale not found'; end if;
  if tx.type<>'sold' then raise exception 'Bills can only be generated for Sold transactions'; end if;
  if tx.voided_at is not null then raise exception 'A voided sale cannot have a bill link'; end if;
  select * into customer from public.contacts where id=tx.contact_id and user_id=uid and kind='customer';
  if not found then raise exception 'Sale customer not found'; end if;
  select * into seller from public.profiles where id=uid;
  select coalesce(jsonb_agg(jsonb_build_object('item_name',tl.item_name,'item_sku',tl.item_sku,'quantity',tl.quantity,'unit',tl.unit,'unit_price',tl.unit_price,'line_total',tl.line_total) order by tl.line_no),'[]'::jsonb)
    into lines_json from public.transaction_lines tl where tl.transaction_id=tx.id and tl.user_id=uid;
  select coalesce(sum(amount),0)::numeric(20,2) into paid_total from public.transaction_payments where transaction_id=tx.id and user_id=uid;
  select coalesce(sum(balance_adjustment),0)::numeric(20,2) into return_adjustments from public.returns where original_transaction_id=tx.id and user_id=uid and voided_at is null;
  due_total:=greatest(0,tx.total_amount-paid_total-return_adjustments)::numeric(20,2);
  raw_token:=encode(gen_random_bytes(32),'hex');
  bill_snapshot:=jsonb_build_object('bill_reference',tx.reference,'bill_date',tx.occurred_at,'generated_at',now(),
    'seller_name',coalesce(nullif(btrim(seller.full_name),''),'StockFlow seller'),'customer_name',customer.name,'lines',lines_json,
    'total_amount',tx.total_amount,'amount_paid',paid_total,'balance_due',due_total,'currency','INR',
    'payment_status',case when due_total<=0.005 then 'Settled' when paid_total<=0.005 then 'Unpaid' else 'Partially paid' end);
  insert into public.shared_sale_bills(user_id,transaction_id,token_hash,snapshot,created_at,revoked_at)
  values(uid,tx.id,digest(convert_to(raw_token,'UTF8'),'sha256'),bill_snapshot,now(),null)
  on conflict(transaction_id) do update set user_id=excluded.user_id,token_hash=excluded.token_hash,snapshot=excluded.snapshot,created_at=excluded.created_at,revoked_at=null;
  return jsonb_build_object('token',raw_token,'snapshot',bill_snapshot,'created_at',now());
end $$;

-- Invalidate public links whenever any line of a sold bill changes.
create or replace function public.invalidate_shared_bill_on_line_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare txid uuid; uid uuid;
begin
  txid:=coalesce(new.transaction_id,old.transaction_id); uid:=coalesce(new.user_id,old.user_id);
  update public.shared_sale_bills b set revoked_at=coalesce(b.revoked_at,now())
  from public.transactions tx where b.transaction_id=txid and b.user_id=uid and tx.id=b.transaction_id and tx.type='sold' and b.revoked_at is null;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists invalidate_shared_bill_on_line_change on public.transaction_lines;
create trigger invalidate_shared_bill_on_line_change after insert or update or delete on public.transaction_lines
for each row execute function public.invalidate_shared_bill_on_line_change();

-- Stock ledger triggers for legacy single-line RPCs and returns. Multi-line and void RPCs
-- suppress these generic triggers and append exact aggregated movements themselves.
create or replace function public.log_transaction_stock_movement()
returns trigger language plpgsql security definer set search_path=public as $$
declare old_delta numeric; new_delta numeric;
begin
  if current_setting('stockflow.skip_stock_ledger',true)='on' then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='INSERT' then
    new_delta:=case when new.type='sold' then -new.base_quantity else new.base_quantity end;
    insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
    values(new.user_id,new.item_id,new.type::text,'transaction',new.id,new_delta,new.occurred_at,'Stock movement from single-line transaction');
    return new;
  end if;
  old_delta:=case when old.type='sold' then -old.base_quantity else old.base_quantity end;
  new_delta:=case when new.type='sold' then -new.base_quantity else new.base_quantity end;
  if old.item_id is distinct from new.item_id or old.base_quantity is distinct from new.base_quantity or old.type is distinct from new.type then
    insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
    values(old.user_id,old.item_id,'transaction_edit_reversal', 'transaction_edit_reversal',new.id,-old_delta,now(),'Reverse prior transaction stock effect');
    insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
    values(new.user_id,new.item_id,'transaction_edit','transaction_edit',new.id,new_delta,now(),'Apply edited transaction stock effect');
  end if;
  if old.voided_at is null and new.voided_at is not null then
    insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
    values(new.user_id,new.item_id,'void_reversal','transaction_void_trigger',new.id,-new_delta,new.voided_at,'Reverse voided transaction');
  end if;
  return new;
end $$;
drop trigger if exists log_transaction_stock_movement on public.transactions;
create trigger log_transaction_stock_movement after insert or update of type,item_id,base_quantity,voided_at on public.transactions
for each row execute function public.log_transaction_stock_movement();

create or replace function public.log_return_stock_movement()
returns trigger language plpgsql security definer set search_path=public as $$
declare movement numeric;
begin
  if tg_op='INSERT' then
    movement:=case when new.kind='customer_return' then new.base_quantity else -new.base_quantity end;
    if new.voided_at is null then
      insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
      values(new.user_id,new.item_id,new.kind::text,'return',new.id,movement,new.occurred_at,'Stock movement from return');
    end if;
    return new;
  end if;
  if old.voided_at is null and new.voided_at is not null then
    movement:=case when old.kind='customer_return' then -old.base_quantity else old.base_quantity end;
    insert into public.stock_movements(user_id,item_id,movement_type,source_type,source_id,quantity_delta,occurred_at,note)
    values(new.user_id,new.item_id,'return_void_reversal','return_void',new.id,movement,new.voided_at,'Reverse voided return');
  end if;
  return new;
end $$;
drop trigger if exists log_return_stock_movement on public.returns;
create trigger log_return_stock_movement after insert or update of voided_at on public.returns
for each row execute function public.log_return_stock_movement();

-- Function is only for public token access; no direct shared-bill table permissions are added here.
revoke all on function public.create_shared_sale_bill(uuid) from public,anon;
grant execute on function public.create_shared_sale_bill(uuid) to authenticated;
revoke all on function public.record_multi_item_transaction(text,public.transaction_type,uuid,jsonb,jsonb,timestamptz,numeric,public.payment_method,timestamptz) from public,anon;
grant execute on function public.record_multi_item_transaction(text,public.transaction_type,uuid,jsonb,jsonb,timestamptz,numeric,public.payment_method,timestamptz) to authenticated;

commit;
