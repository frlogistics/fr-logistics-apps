-- ════════════════════════════════════════════════════════════════════════════
-- 20261118b_ds_packaging_inventory.sql
-- FR-Logistics · DropShipments — packaging stock (boxes on hand vs boxes used).
-- Applied to Supabase (rijbschnchjiuggrhfrx) on 2026-11-18 as migration
-- `ds_packaging_inventory`.
--
-- Decision of Jose (18-nov-2026): stock starts at ZERO and he loads it from
-- the screen (Dropshipments → Empaques).
--
-- Model
--   ds_packaging_moves   ledger of what a person records:
--       purchase  boxes bought                         (+qty, optional unit cost)
--       adjust    damaged / used for something else    (+/- qty)
--       count     physical count: SETS the level; everything before is ignored
--   Boxes used by shipped dropshipments are NOT ledger rows. The view counts
--   them live from dropshipments.pack_used, so correcting the packaging of an
--   order corrects the stock by itself.
--   A packaging with no moves is "not tracked": on_hand 0, nothing deducted.
--   Tracking starts at the last count, or at the first move if never counted.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.ds_packaging_types
  add column if not exists min_stock integer not null default 0 check (min_stock >= 0);

create table if not exists public.ds_packaging_moves (
  id         bigint generated always as identity primary key,
  pack_code  text not null references public.ds_packaging_types(code),
  kind       text not null check (kind in ('purchase','count','adjust')),
  qty        integer not null,
  unit_cost  numeric check (unit_cost is null or unit_cost >= 0),
  note       text,
  created_by text,
  user_email text,
  created_at timestamptz not null default now(),
  constraint ds_packaging_moves_qty_chk check (
    (kind = 'purchase' and qty > 0) or (kind = 'count' and qty >= 0) or (kind = 'adjust' and qty <> 0))
);
create index if not exists idx_ds_packaging_moves_code on public.ds_packaging_moves (pack_code, created_at desc);

alter table public.ds_packaging_moves enable row level security;
drop policy if exists ds_packaging_moves_service_only on public.ds_packaging_moves;
create policy ds_packaging_moves_service_only on public.ds_packaging_moves for all to service_role using (true) with check (true);
revoke all on public.ds_packaging_moves from anon, authenticated;

create or replace view public.v_ds_packaging_stock with (security_invoker = true) as
with base as (
  select distinct on (pack_code) pack_code, qty, created_at
    from public.ds_packaging_moves where kind = 'count'
   order by pack_code, created_at desc
), firstm as (
  select pack_code, min(created_at) as first_at from public.ds_packaging_moves group by pack_code
), t as (
  select p.code, p.kind, p.label, p.inner_l, p.inner_w, p.inner_h, p.unit_cost, p.kit_cost,
         p.min_stock, p.sort_order,
         b.qty as base_qty, b.created_at as base_at,
         coalesce(b.created_at, f.first_at) as start_at
    from public.ds_packaging_types p
    left join base b on b.pack_code = p.code
    left join firstm f on f.pack_code = p.code
   where p.active and p.kind in ('box','poly')
)
select t.code, t.kind, t.label, t.inner_l, t.inner_w, t.inner_h, t.unit_cost, t.kit_cost,
       t.min_stock, t.sort_order, t.start_at, t.base_at,
       (t.start_at is not null) as tracked,
       coalesce(t.base_qty, 0)
         + coalesce((select sum(m.qty) from public.ds_packaging_moves m
                      where m.pack_code = t.code and m.kind <> 'count'
                        and (t.base_at is null or m.created_at > t.base_at)), 0)::integer
         - coalesce((select count(*) from public.dropshipments d
                      where d.pack_used = t.code and d.status = 'shipped'
                        and t.start_at is not null and d.shipped_at > t.start_at), 0)::integer as on_hand,
       coalesce((select count(*) from public.dropshipments d
                  where d.pack_used = t.code and d.status = 'shipped'
                    and t.start_at is not null and d.shipped_at > t.start_at), 0)::integer as used_since_start,
       (select count(*) from public.dropshipments d
         where d.pack_used = t.code and d.status = 'shipped' and d.shipped_at > now() - interval '7 days')::integer as used_7d,
       (select count(*) from public.dropshipments d
         where d.pack_used = t.code and d.status = 'shipped' and d.shipped_at > now() - interval '30 days')::integer as used_30d
  from t;
revoke all on public.v_ds_packaging_stock from anon, authenticated;
grant select on public.v_ds_packaging_stock to service_role;

-- ── Alerts (migration `ds_packaging_stock_alerts`, same day) ────────────────
-- dropship-pack-stock-alert.js: e-mail when on hand <= min_stock; WhatsApp too
-- when out of stock or 2 days of cover or less. One alert per episode.
alter table public.ds_packaging_types
  add column if not exists low_alerted_at    timestamptz,
  add column if not exists urgent_alerted_at timestamptz;
