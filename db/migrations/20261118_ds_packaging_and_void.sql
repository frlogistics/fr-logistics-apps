-- ════════════════════════════════════════════════════════════════════════════
-- 20261118_ds_packaging_and_void.sql
-- FR-Logistics · DropShipments — packaging suggestion, confirmation and billing,
-- plus "void order" (status = cancelled).
--
-- Applied to Supabase (project rijbschnchjiuggrhfrx) on 2026-11-18 as migration
-- `ds_packaging_and_void`. Kept here as the record of what is in production.
-- Parts 1-7 are the packaging design of 17-nov; parts 8-10 were added 18-nov so
-- both changes ship in one migration and one deploy.
--
-- Decisions by Jose (17-nov-2026):
--   * Packaging is HYBRID by default ("standard" tier): polymailer when the
--     product tolerates it, cardboard box when it is fragile, rigid or liquid.
--   * Shop World is the special case ("vip" tier): always a box, all-in rate.
--     VIP is the offer for future clients.
--   * Standard tier: when an order ships in a box, the client pays a surcharge
--     of 120% of the cost of ALL the packaging material (box + bubble + tape +
--     filler). VIP pays nothing extra for the kit; the Large / XL size
--     surcharges (DS_BOX_LARGE / DS_BOX_XL) stay VIP-only.
--   * The system is run by FR: it never depends on data the client must send.
--
-- Nothing here changes an existing rate or invoice. The standard-tier surcharge
-- only starts billing when dropship_client_configs.pack_surcharge_from is set
-- (it is NULL for LN Store until Jose notifies the client).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Packaging catalog ────────────────────────────────────────────────────
create table if not exists public.ds_packaging_types (
  code          text primary key,
  kind          text not null check (kind in ('box','poly','special')),
  label         text not null,
  inner_l       numeric,
  inner_w       numeric,
  inner_h       numeric,
  supplier      text,
  supplier_code text,
  unit_cost     numeric not null default 0 check (unit_cost >= 0),
  extras_cost   numeric not null default 0 check (extras_cost >= 0),
  markup        numeric not null default 1.20 check (markup >= 1),
  kit_cost      numeric generated always as (unit_cost + extras_cost) stored,
  surcharge     numeric generated always as (round((unit_cost + extras_cost) * markup, 2)) stored,
  size_tier     text not null default 'standard' check (size_tier in ('standard','large','xl')),
  active        boolean not null default true,
  sort_order    integer not null default 100,
  notes         text,
  updated_at    timestamptz not null default now()
);

comment on table public.ds_packaging_types is
  'DropShipments packaging catalog (CAJA 1..6, POLY 1..3). unit_cost = box/mailer, extras_cost = bubble + tape + filler for that size. surcharge = kit_cost x markup, billed to standard-tier clients when an order ships in a box.';

insert into public.ds_packaging_types
  (code, kind, label, inner_l, inner_w, inner_h, supplier, supplier_code, unit_cost, extras_cost, size_tier, sort_order, notes)
values
  ('C1','box','CAJA 1',  9,  7,  5,'TotalPack','CB2007',0.32,0.33,'standard',10,'Frascos, perfumes, accesorios chicos. extras_cost estimado (burbuja 3/16" ~2 ft + cinta).'),
  ('C2','box','CAJA 2', 12,  9,  6,'TotalPack','CB2016',0.66,0.44,'standard',20,'Muñecos, electrónica chica. extras_cost estimado (~3 ft de burbuja).'),
  ('C3','box','CAJA 3', 12, 10,  8,'TotalPack','CB2018',0.69,0.61,'standard',30,'Juguetes en caja mediana, peluches. extras_cost estimado (~4 ft).'),
  ('C4','box','CAJA 4', 15, 12,  6,'TotalPack','CB2032',0.98,0.61,'standard',40,'Placas madre, Lego planos, tablets. extras_cost estimado (~4 ft).'),
  ('C5','box','CAJA 5', 16, 12, 10,'TotalPack','CB2185',0.99,0.88,'standard',50,'Juegos de mesa, Lego grandes. extras_cost estimado (~6 ft).'),
  ('C6','box','CAJA 6', 18, 12, 12,'TotalPack','CB2044',1.50,1.16,'large',   60,'Feeders, sets grandes. Rango Grande. extras_cost estimado (~8 ft).'),
  ('P1','poly','POLY 1',13, 10, null,null,null,0,0,'standard',110,'Polymailer chico. MEDIDA POR CONFIRMAR con el inventario real.'),
  ('P2','poly','POLY 2',19, 14.5,null,null,null,0,0,'standard',120,'Polymailer mediano. MEDIDA POR CONFIRMAR con el inventario real.'),
  ('P3','poly','POLY 3',24, 19, null,null,null,0,0,'standard',130,'Polymailer grande. MEDIDA POR CONFIRMAR con el inventario real.'),
  ('XL','special','CAJA XL',null,null,null,null,null,0,0,'xl',200,'No cabe en CAJA 6: caja fuera de catálogo. Sin recargo automático de kit; el costo se cotiza.'),
  ('OTHER','special','OTRO',null,null,null,null,null,0,0,'standard',210,'Empaque no listado (reuso de la caja original, sobre, etc.). Sin recargo.')
on conflict (code) do nothing;

-- ── 2. Tier per client ──────────────────────────────────────────────────────
alter table public.dropship_client_configs
  add column if not exists packaging_tier text not null default 'standard'
    check (packaging_tier in ('standard','vip')),
  add column if not exists pack_surcharge_from date;

comment on column public.dropship_client_configs.packaging_tier is
  'standard = hybrid (poly when the product allows, box otherwise, kit surcharge on boxes). vip = always box, kit included in the flat rate.';
comment on column public.dropship_client_configs.pack_surcharge_from is
  'First ship date (Miami) on which the standard-tier kit surcharge is billed. NULL = not billed yet.';

update public.dropship_client_configs set packaging_tier = 'vip' where client_code = 'SW';

-- ── 3. Product memory (owned by FR) ─────────────────────────────────────────
create table if not exists public.ds_product_dims (
  id              uuid primary key default gen_random_uuid(),
  product_key     text not null unique,
  canonical_key   text,
  title           text,
  brand           text,
  model           text,
  asin            text,
  upc             text,
  units           integer not null default 1,
  l_in            numeric,
  w_in            numeric,
  h_in            numeric,
  weight_lb       numeric,
  fragile         boolean,
  liquid          boolean,
  poly_ok         boolean,
  source          text not null default 'ai_web',
  source_urls     jsonb,
  confidence      numeric,
  raw             jsonb,
  confirmed_pack  text references public.ds_packaging_types(code),
  confirmed_count integer not null default 0,
  confirmed_at    timestamptz,
  confirmed_by    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_ds_product_dims_canonical on public.ds_product_dims (canonical_key);

comment on table public.ds_product_dims is
  'One row per product description seen in dropshipments.content. Dimensions come from the AI lookup; confirmed_pack is what the operator actually used. canonical_key groups different spellings of the same product.';

-- ── 4. Per-order packaging fields ───────────────────────────────────────────
alter table public.dropshipments
  add column if not exists pack_suggested    text references public.ds_packaging_types(code),
  add column if not exists pack_status       text check (pack_status in ('queued','ready','measure','failed')),
  add column if not exists pack_confidence   numeric,
  add column if not exists pack_info         jsonb,
  add column if not exists pack_product_id   uuid references public.ds_product_dims(id) on delete set null,
  add column if not exists pack_used         text references public.ds_packaging_types(code),
  add column if not exists pack_confirmed_at timestamptz,
  add column if not exists pack_confirmed_by text;

create index if not exists idx_dropshipments_pack_todo
  on public.dropshipments (created_at)
  where pack_status is null and status in ('pending','received','labeled');

-- ── 5. RLS: service_role only (anon key travels in the portal JS) ───────────
alter table public.ds_packaging_types enable row level security;
alter table public.ds_product_dims    enable row level security;
drop policy if exists ds_packaging_types_service_only on public.ds_packaging_types;
create policy ds_packaging_types_service_only on public.ds_packaging_types for all to service_role using (true) with check (true);
drop policy if exists ds_product_dims_service_only on public.ds_product_dims;
create policy ds_product_dims_service_only on public.ds_product_dims for all to service_role using (true) with check (true);
revoke all on public.ds_packaging_types from anon, authenticated;
revoke all on public.ds_product_dims    from anon, authenticated;

-- ── 6. Functions ────────────────────────────────────────────────────────────

-- Normalised key for a free-text product description.
create or replace function public.ds_product_key(p text)
returns text language sql immutable set search_path to 'public' as $$
  select nullif(trim(regexp_replace(
           regexp_replace(
             regexp_replace(
               translate(lower(coalesce(p,'')),
                         'áàâãäéèêëíìîïóòôõöúùûüñç',
                         'aaaaaeeeeiiiiooooouuuunc'),
               '\s*-?\s*1\s*unidad\s*$', '', 'i'),
             '[^a-z0-9]+', ' ', 'g'),
           '\s+', ' ', 'g')), '');
$$;

-- Smallest packaging that fits. Dimensions in inches, any order.
--   poly  : standard tier only, product tolerates a mailer, not fragile/liquid.
--           A flat mailer W x L holds an l>=w>=h object when
--           L >= l + h + 1 and W >= w + h + 1.
--   box   : padding per axis 1" (2" if fragile or liquid).
--   none  : 'XL' (bigger than CAJA 6).
create or replace function public.ds_pick_packaging(
  p_l numeric, p_w numeric, p_h numeric,
  p_fragile boolean, p_liquid boolean, p_poly_ok boolean, p_tier text)
returns text language plpgsql stable set search_path to 'public' as $$
declare
  d numeric[]; a numeric; b numeric; c numeric; pad numeric; v text;
begin
  if p_l is null or p_w is null or p_h is null or least(p_l, p_w, p_h) <= 0 then
    return null;
  end if;
  select array_agg(x order by x desc) into d from unnest(array[p_l, p_w, p_h]) x;
  a := d[1]; b := d[2]; c := d[3];

  if coalesce(p_tier,'standard') = 'standard'
     and coalesce(p_poly_ok,false)
     and not coalesce(p_fragile,false)
     and not coalesce(p_liquid,false) then
    select t.code into v
      from ds_packaging_types t
     where t.active and t.kind = 'poly'
       and greatest(t.inner_l, t.inner_w) >= a + c + 1
       and least(t.inner_l, t.inner_w)    >= b + c + 1
     order by t.inner_l * t.inner_w asc
     limit 1;
    if v is not null then return v; end if;
  end if;

  pad := case when coalesce(p_fragile,false) or coalesce(p_liquid,false) then 2 else 1 end;

  select t.code into v
    from (
      select pt.code,
             (select array_agg(x order by x desc) from unnest(array[pt.inner_l, pt.inner_w, pt.inner_h]) x) as s,
             pt.inner_l * pt.inner_w * pt.inner_h as vol
        from ds_packaging_types pt
       where pt.active and pt.kind = 'box'
    ) t
   where t.s[1] >= a + pad and t.s[2] >= b + pad and t.s[3] >= c + pad
   order by t.vol asc
   limit 1;

  return coalesce(v, 'XL');
end $$;

-- Billing side of a confirmed packaging. Idempotent; called by the trigger.
--   standard tier + box + surcharge active  -> DS_PACK_<code> at the kit surcharge
--   vip tier + size_tier large / xl         -> DS_BOX_LARGE / DS_BOX_XL at the client rate
--   anything else, or not shipped           -> void the open entry, if any
-- Entries that were already invoiced are never touched.
create or replace function public.ds_sync_pack_charge(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  d   dropshipments%rowtype;
  cfg dropship_client_configs%rowtype;
  pk  ds_packaging_types%rowtype;
  v_client text;
  v_tag    text := '[ds:' || p_id::text || ']';
  v_code   text; v_name text; v_rate numeric; v_date date;
  v_open   bigint; v_billed boolean;
  v_rates  jsonb;
begin
  select * into d from dropshipments where id = p_id;
  if not found then return; end if;
  select * into cfg from dropship_client_configs where client_id = d.client_id;
  select coalesce(nullif(c.company,''), c.name) into v_client from fr_clients c where c.id = d.client_id;

  if d.status = 'shipped' and d.pack_used is not null and cfg.client_id is not null and v_client is not null then
    select * into pk from ds_packaging_types where code = d.pack_used;
    v_date := (coalesce(d.shipped_at, now()) at time zone 'America/New_York')::date;

    if pk.code is not null then
      if cfg.packaging_tier = 'standard' and pk.kind = 'box' and pk.surcharge > 0
         and cfg.pack_surcharge_from is not null and v_date >= cfg.pack_surcharge_from then
        v_code := 'DS_PACK_' || pk.code;
        v_name := 'Packaging Kit — Box ' || pk.code || ' ('
                  || trim(to_char(pk.inner_l,'FM999.#'),'.') || 'x'
                  || trim(to_char(pk.inner_w,'FM999.#'),'.') || 'x'
                  || trim(to_char(pk.inner_h,'FM999.#'),'.') || ' in)';
        v_rate := pk.surcharge;
      elsif cfg.packaging_tier = 'vip' and pk.size_tier in ('large','xl') then
        select to_jsonb(r.*) into v_rates from fr_client_rates r where r.client_name = v_client;
        if v_rates is null then
          select to_jsonb(r.*) into v_rates from fr_client_rates r where r.client_name = 'DEFAULT';
        end if;
        if pk.size_tier = 'large' then
          v_code := 'DS_BOX_LARGE'; v_name := 'Large Box Surcharge (Casillero)';
          v_rate := nullif(v_rates->>'ds_box_large','')::numeric;
        else
          v_code := 'DS_BOX_XL'; v_name := 'Extra Large Box Surcharge (Casillero)';
          v_rate := nullif(v_rates->>'ds_box_xl','')::numeric;
        end if;
        if coalesce(v_rate,0) <= 0 then v_code := null; end if;
      end if;
    end if;
  end if;

  select exists (select 1 from fr_services_log
                  where notes like '%' || v_tag || '%' and status = 'billed') into v_billed;
  select id into v_open from fr_services_log
   where notes like '%' || v_tag || '%' and status = 'logged'
   order by id desc limit 1;

  if v_code is null then
    if v_open is not null then
      update fr_services_log set status = 'voided' where id = v_open;
    end if;
    return;
  end if;

  if v_billed then return; end if;          -- already invoiced: never charge twice

  if v_open is not null then
    update fr_services_log
       set service_code = v_code, service_name = v_name, unit_rate = v_rate,
           service_date = v_date, performed_by = d.pack_confirmed_by
     where id = v_open;
  else
    insert into fr_services_log
      (client_id, client_name, service_code, service_name, quantity, unit, unit_rate,
       service_date, reference_id, performed_by, notes, status, logged_by)
    values
      (d.client_id::text, v_client, v_code, v_name, 1, 'per outbound order', v_rate,
       v_date, coalesce(d.order_id, d.tracking_number), d.pack_confirmed_by,
       'Dropshipment ' || coalesce(d.order_id, d.tracking_number) || ' · ' || coalesce(pk.label, d.pack_used) || ' ' || v_tag,
       'logged', 'dropshipments');
  end if;
end $$;

-- The trigger must never block the floor: a billing hiccup is logged, not raised.
create or replace function public.ds_pack_charge_trg()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  begin
    perform ds_sync_pack_charge(new.id);
  exception when others then
    raise warning 'ds_sync_pack_charge(%) failed: %', new.id, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists trg_ds_pack_charge on public.dropshipments;
create trigger trg_ds_pack_charge
  after update of status, pack_used on public.dropshipments
  for each row
  when (
    (new.status is distinct from old.status and (new.status = 'shipped' or old.status = 'shipped'))
    or (new.pack_used is distinct from old.pack_used and new.status = 'shipped')
  )
  execute function public.ds_pack_charge_trg();

-- Operator confirms the packaging actually used. Writes the order and teaches
-- the product memory, so the next order of the same product is suggested right.
create or replace function public.ds_confirm_pack(p_id uuid, p_code text, p_operator text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  d   dropshipments%rowtype;
  pk  ds_packaging_types%rowtype;
  v_tier text;
  v_key  text;
  v_pid  uuid;
begin
  select * into d from dropshipments where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  select * into pk from ds_packaging_types where code = upper(trim(p_code)) and active;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BAD_PACK');
  end if;
  select packaging_tier into v_tier from dropship_client_configs where client_id = d.client_id;
  if coalesce(v_tier,'standard') = 'vip' and pk.kind = 'poly' then
    return jsonb_build_object('ok', false, 'code', 'VIP_NO_POLY');
  end if;

  v_key := ds_product_key(d.content);
  v_pid := d.pack_product_id;
  if v_pid is null and v_key is not null then
    select id into v_pid from ds_product_dims where product_key = v_key;
    if v_pid is null then
      insert into ds_product_dims (product_key, title, source)
      values (v_key, left(d.content, 200), 'operator')
      on conflict (product_key) do update set updated_at = now()
      returning id into v_pid;
    end if;
  end if;

  if v_pid is not null and pk.code <> 'OTHER' then
    update ds_product_dims
       set confirmed_count = case when confirmed_pack = pk.code then confirmed_count + 1 else 1 end,
           confirmed_pack  = pk.code,
           confirmed_at    = now(),
           confirmed_by    = p_operator,
           updated_at      = now()
     where id = v_pid;
  end if;

  update dropshipments
     set pack_used = pk.code,
         pack_confirmed_at = now(),
         pack_confirmed_by = p_operator,
         pack_product_id = coalesce(pack_product_id, v_pid)
   where id = p_id;

  return jsonb_build_object('ok', true, 'pack_used', pk.code, 'label', pk.label);
end $$;

revoke all on function public.ds_product_key(text) from public, anon, authenticated;
revoke all on function public.ds_pick_packaging(numeric,numeric,numeric,boolean,boolean,boolean,text) from public, anon, authenticated;
revoke all on function public.ds_sync_pack_charge(uuid) from public, anon, authenticated;
revoke all on function public.ds_pack_charge_trg() from public, anon, authenticated;
revoke all on function public.ds_confirm_pack(uuid,text,text) from public, anon, authenticated;
grant execute on function public.ds_product_key(text) to service_role;
grant execute on function public.ds_pick_packaging(numeric,numeric,numeric,boolean,boolean,boolean,text) to service_role;
grant execute on function public.ds_sync_pack_charge(uuid) to service_role;
grant execute on function public.ds_confirm_pack(uuid,text,text) to service_role;

-- ── 7. Service catalog rows for the kit surcharge ───────────────────────────
-- One code per box so the invoice shows which box was used. fixed_rate mirrors
-- ds_packaging_types.surcharge and is kept in step by the trigger below.
insert into public.fr_service_catalog_meta
  (service_code, service_name, unit, rate_column, fixed_rate, category, subcategory, active, sort_order, notes)
select 'DS_PACK_' || p.code,
       'Packaging Kit — Box ' || p.code || ' ('
         || trim(to_char(p.inner_l,'FM999.#'),'.') || 'x'
         || trim(to_char(p.inner_w,'FM999.#'),'.') || 'x'
         || trim(to_char(p.inner_h,'FM999.#'),'.') || ' in)',
       'per outbound order', null, p.surcharge, 'Casillero', 'Packaging', true,
       584 + (row_number() over (order by p.sort_order))::int,
       'Recargo de material de embalaje (caja + burbuja + cinta + relleno) al 120% del costo, para clientes de casillero en nivel Estándar cuando la orden sale en caja. Se registra solo desde el módulo de Dropshipments. No aplica a nivel VIP (incluido en su tarifa).'
  from public.ds_packaging_types p
 where p.kind = 'box'
on conflict (service_code) do nothing;

create or replace function public.ds_packaging_catalog_sync()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.ds_packaging_catalog_sync_after()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.kind = 'box' then
    update fr_service_catalog_meta
       set fixed_rate = new.surcharge, active = new.active
     where service_code = 'DS_PACK_' || new.code;
  end if;
  return new;
end $$;

drop trigger if exists trg_ds_packaging_touch on public.ds_packaging_types;
create trigger trg_ds_packaging_touch before update on public.ds_packaging_types
  for each row execute function public.ds_packaging_catalog_sync();
drop trigger if exists trg_ds_packaging_catalog on public.ds_packaging_types;
create trigger trg_ds_packaging_catalog after update on public.ds_packaging_types
  for each row execute function public.ds_packaging_catalog_sync_after();

revoke all on function public.ds_packaging_catalog_sync() from public, anon, authenticated;
revoke all on function public.ds_packaging_catalog_sync_after() from public, anon, authenticated;

-- ── 8. Suggestion helpers (called by dropship-pack-suggest-background.js) ───
-- The decision lives in the database so it can be tested with plain SQL.

-- Stacks n identical retail packages along their shortest side.
create or replace function public.ds_stack_dims(p_l numeric, p_w numeric, p_h numeric, p_units integer)
returns numeric[] language sql immutable set search_path to 'public' as $$
  select case
    when p_l is null or p_w is null or p_h is null then null
    else (select array[d[1], d[2], d[3] * greatest(coalesce(p_units,1),1)]
            from (select array_agg(x order by x desc) as d from unnest(array[p_l,p_w,p_h]) x) q)
  end;
$$;

-- Step 1: try to answer from FR's own product memory. Returns
--   { done:true,  status, pack }            → nothing else to do
--   { done:false, key, tier, content }      → the caller must look the product up
create or replace function public.ds_pack_from_memory(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  d    dropshipments%rowtype;
  pd   ds_product_dims%rowtype;
  v_tier text;
  v_key  text;
  v_code text;
  v_src  text;
  v_dims numeric[];
begin
  select * into d from dropshipments where id = p_id;
  if not found then return jsonb_build_object('done', true, 'status', 'not_found'); end if;
  if d.status in ('shipped','cancelled') then
    return jsonb_build_object('done', true, 'status', 'skipped');
  end if;

  select coalesce(packaging_tier,'standard') into v_tier
    from dropship_client_configs where client_id = d.client_id;
  v_tier := coalesce(v_tier,'standard');
  v_key  := ds_product_key(d.content);

  if v_key is null then
    update dropshipments
       set pack_status = 'measure', pack_suggested = null, pack_confidence = null,
           pack_info = jsonb_build_object('source','none','why','La orden no trae descripción del producto.')
     where id = p_id;
    return jsonb_build_object('done', true, 'status', 'measure');
  end if;

  select * into pd from ds_product_dims where product_key = v_key;
  if found then
    v_dims := ds_stack_dims(pd.l_in, pd.w_in, pd.h_in, pd.units);
    if pd.confirmed_pack is not null then
      v_code := pd.confirmed_pack; v_src := 'memory_confirmed';
      -- VIP never ships in a mailer: fall back to the measured box.
      if v_tier = 'vip' and exists (select 1 from ds_packaging_types t where t.code = v_code and t.kind = 'poly') then
        v_code := case when v_dims is null then null
                       else ds_pick_packaging(v_dims[1], v_dims[2], v_dims[3], pd.fragile, pd.liquid, false, 'vip') end;
        v_src := 'memory_dims';
      end if;
    elsif v_dims is not null and coalesce(pd.confidence,0) >= 0.6 then
      v_code := ds_pick_packaging(v_dims[1], v_dims[2], v_dims[3], pd.fragile, pd.liquid, pd.poly_ok, v_tier);
      v_src := 'memory_dims';
    end if;

    if v_code is not null then
      update dropshipments
         set pack_suggested = v_code, pack_status = 'ready',
             pack_confidence = case when v_src = 'memory_confirmed' then 0.97 else pd.confidence end,
             pack_product_id = pd.id,
             pack_info = jsonb_build_object(
               'source', v_src, 'title', pd.title, 'units', pd.units,
               'l_in', pd.l_in, 'w_in', pd.w_in, 'h_in', pd.h_in, 'weight_lb', pd.weight_lb,
               'fragile', pd.fragile, 'liquid', pd.liquid, 'poly_ok', pd.poly_ok,
               'confirmed_count', pd.confirmed_count)
       where id = p_id;
      return jsonb_build_object('done', true, 'status', 'ready', 'pack', v_code, 'source', v_src);
    end if;

    -- Looked up recently and nothing usable came back: do not pay for it again.
    if pd.source = 'ai_web' and pd.updated_at > now() - interval '7 days' then
      update dropshipments
         set pack_status = 'measure', pack_suggested = null, pack_product_id = pd.id,
             pack_confidence = pd.confidence,
             pack_info = jsonb_build_object('source','ai_web','title',pd.title,
                           'why','No se encontraron medidas confiables. Medir el producto.')
       where id = p_id;
      return jsonb_build_object('done', true, 'status', 'measure');
    end if;
  end if;

  return jsonb_build_object('done', false, 'key', v_key, 'tier', v_tier, 'content', d.content);
end $$;

-- Step 2: store what the lookup found and turn it into a suggestion.
-- p = { identified, title, brand, model, canonical, units, l_in, w_in, h_in,
--       weight_lb, fragile, liquid, poly_ok, confidence, sources[], why, error }
create or replace function public.ds_pack_save_lookup(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  d     dropshipments%rowtype;
  v_tier text; v_key text; v_canon text; v_pid uuid;
  v_l numeric; v_w numeric; v_h numeric; v_units integer; v_conf numeric;
  v_frag boolean; v_liq boolean; v_poly boolean;
  v_dims numeric[]; v_code text; v_src text := 'ai_web'; v_status text;
  v_twin ds_product_dims%rowtype;
begin
  select * into d from dropshipments where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  select coalesce(packaging_tier,'standard') into v_tier
    from dropship_client_configs where client_id = d.client_id;
  v_tier := coalesce(v_tier,'standard');
  v_key  := ds_product_key(d.content);
  if v_key is null then return jsonb_build_object('ok', false, 'code', 'NO_CONTENT'); end if;

  if p ? 'error' and coalesce(p->>'error','') <> '' then
    update dropshipments
       set pack_status = 'failed',
           pack_info = jsonb_build_object('source','ai_web','error', left(p->>'error', 400))
     where id = p_id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;

  v_l := nullif(p->>'l_in','')::numeric;  v_w := nullif(p->>'w_in','')::numeric;
  v_h := nullif(p->>'h_in','')::numeric;
  v_units := greatest(coalesce(nullif(p->>'units','')::integer, 1), 1);
  v_conf  := least(greatest(coalesce(nullif(p->>'confidence','')::numeric, 0), 0), 1);
  v_frag  := coalesce((p->>'fragile')::boolean, false);
  v_liq   := coalesce((p->>'liquid')::boolean, false);
  v_poly  := coalesce((p->>'poly_ok')::boolean, false);
  v_canon := ds_product_key(p->>'canonical');
  if v_l is not null and (v_l <= 0 or v_l > 120) then v_l := null; end if;
  if v_w is not null and (v_w <= 0 or v_w > 120) then v_w := null; end if;
  if v_h is not null and (v_h <= 0 or v_h > 120) then v_h := null; end if;

  insert into ds_product_dims
    (product_key, canonical_key, title, brand, model, units, l_in, w_in, h_in, weight_lb,
     fragile, liquid, poly_ok, source, source_urls, confidence, raw)
  values
    (v_key, v_canon, left(coalesce(p->>'title', d.content), 200), p->>'brand', p->>'model', v_units,
     v_l, v_w, v_h, nullif(p->>'weight_lb','')::numeric,
     v_frag, v_liq, v_poly, 'ai_web', p->'sources', v_conf, p)
  on conflict (product_key) do update
     set canonical_key = excluded.canonical_key, title = excluded.title, brand = excluded.brand,
         model = excluded.model, units = excluded.units,
         l_in = excluded.l_in, w_in = excluded.w_in, h_in = excluded.h_in,
         weight_lb = excluded.weight_lb, fragile = excluded.fragile, liquid = excluded.liquid,
         poly_ok = excluded.poly_ok, source = 'ai_web', source_urls = excluded.source_urls,
         confidence = excluded.confidence, raw = excluded.raw, updated_at = now()
  returning id into v_pid;

  -- Same product under another spelling, already packed by the operator.
  if v_canon is not null then
    select * into v_twin from ds_product_dims
     where canonical_key = v_canon and id <> v_pid and confirmed_pack is not null and units = v_units
     order by confirmed_count desc, confirmed_at desc nulls last limit 1;
    if found and not (v_tier = 'vip' and exists
         (select 1 from ds_packaging_types t where t.code = v_twin.confirmed_pack and t.kind = 'poly')) then
      v_code := v_twin.confirmed_pack; v_src := 'memory_canonical'; v_conf := greatest(v_conf, 0.9);
    end if;
  end if;

  if v_code is null and v_conf >= 0.6 then
    v_dims := ds_stack_dims(v_l, v_w, v_h, v_units);
    if v_dims is not null then
      v_code := ds_pick_packaging(v_dims[1], v_dims[2], v_dims[3], v_frag, v_liq, v_poly, v_tier);
    end if;
  end if;

  v_status := case when v_code is null then 'measure' else 'ready' end;

  update dropshipments
     set pack_suggested = v_code, pack_status = v_status, pack_confidence = v_conf,
         pack_product_id = v_pid,
         pack_info = jsonb_build_object(
           'source', v_src, 'title', coalesce(p->>'title', d.content), 'units', v_units,
           'l_in', v_l, 'w_in', v_w, 'h_in', v_h, 'weight_lb', nullif(p->>'weight_lb','')::numeric,
           'fragile', v_frag, 'liquid', v_liq, 'poly_ok', v_poly,
           'why', coalesce(p->>'why', case when v_code is null then 'Sin medidas confiables. Medir el producto.' end))
   where id = p_id;

  return jsonb_build_object('ok', true, 'status', v_status, 'pack', v_code, 'source', v_src);
end $$;

revoke all on function public.ds_stack_dims(numeric,numeric,numeric,integer) from public, anon, authenticated;
revoke all on function public.ds_pack_from_memory(uuid) from public, anon, authenticated;
revoke all on function public.ds_pack_save_lookup(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.ds_stack_dims(numeric,numeric,numeric,integer) to service_role;
grant execute on function public.ds_pack_from_memory(uuid) to service_role;
grant execute on function public.ds_pack_save_lookup(uuid,jsonb) to service_role;

-- ── 9. Void order (status = cancelled) ──────────────────────────────────────
-- Requested by Jose 18-nov-2026 after a duplicate order had to be removed by
-- hand. A voided order is KEPT (never deleted) so there is a trail and so the
-- Gmail sync still sees it as already ingested and does not bring it back.
alter table public.dropshipments
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  text,
  add column if not exists cancel_reason text,
  add column if not exists cancel_info   jsonb;

alter table public.dropshipments drop constraint if exists dropshipments_status_check;
alter table public.dropshipments add constraint dropshipments_status_check
  check (status = any (array['pending','received','labeled','shipped','orphan','exception','cancelled']));

-- Rules:
--   * only pending / received / labeled / exception. Shipped orders and orders
--     in a manifest are never voided (undo the ship first); orphans keep their
--     own delete.
--   * the outbound label number is released (unique index) so the client can
--     reuse the same label on a replacement order.
--   * consolidated box: the remaining orders are renumbered ("2 de 3" → "2 de 2").
--   * Inbound billing line (shipments_general): handed to a sibling order of the
--     same box if there is one; otherwise removed, unless it was already
--     invoiced or the caller asks to keep it (the package is physically here).
create or replace function public.ds_void_order(
  p_id uuid, p_reason text, p_operator text, p_user text default null, p_keep_inbound boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  d      dropshipments%rowtype;
  sib    dropshipments%rowtype;
  sg     shipments_general%rowtype;
  v_sibs integer;
  v_line text := 'none';
  v_reason text := trim(coalesce(p_reason,''));
begin
  select * into d from dropshipments where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if d.status = 'cancelled' then return jsonb_build_object('ok', false, 'code', 'ALREADY_CANCELLED'); end if;
  if d.status = 'shipped'   then return jsonb_build_object('ok', false, 'code', 'ALREADY_SHIPPED'); end if;
  if d.status = 'orphan'    then return jsonb_build_object('ok', false, 'code', 'IS_ORPHAN'); end if;
  if d.manifest_id is not null then
    return jsonb_build_object('ok', false, 'code', 'IN_MANIFEST', 'manifest_id', d.manifest_id);
  end if;
  if length(v_reason) < 5 then return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED'); end if;

  select count(*) into v_sibs
    from dropshipments s
   where s.client_id = d.client_id and s.tracking_number = d.tracking_number
     and s.id <> d.id and s.status <> 'cancelled';

  select * into sib
    from dropshipments s
   where s.client_id = d.client_id and s.tracking_number = d.tracking_number
     and s.id <> d.id and s.status <> 'cancelled'
   order by (s.physical_received_at is not null) desc, (s.status = 'shipped') desc, s.created_at
   limit 1;

  select * into sg
    from shipments_general g
   where g.client_id = d.client_id and g.tracking = d.tracking_number
     and g.direction = 'Inbound' and g.type ilike '%Drop%'
   limit 1;

  if sg.id is not null then
    if sib.id is not null then
      if sg.source_id is null or sg.source_id = d.id then
        update shipments_general
           set source_id = sib.id,
               notes = 'Order: ' || coalesce(sib.order_id, '—')
                       || case when coalesce(sib.content,'') <> '' then ' · ' || sib.content else '' end
         where id = sg.id;
        v_line := 'reassigned';
      else
        v_line := 'kept_sibling';
      end if;
    elsif sg.billed_at is not null then
      v_line := 'kept_billed';
    elsif p_keep_inbound then
      v_line := 'kept_by_request';
    else
      delete from shipments_general where id = sg.id;
      v_line := 'removed';
    end if;
  end if;

  update dropshipments s
     set group_seq   = case when coalesce(s.group_total,0) - 1 > 1
                            then case when d.group_seq is not null and s.group_seq > d.group_seq
                                      then s.group_seq - 1 else s.group_seq end
                            else null end,
         group_total = case when coalesce(s.group_total,0) - 1 > 1 then s.group_total - 1 else null end
   where s.client_id = d.client_id and s.tracking_number = d.tracking_number
     and s.id <> d.id and s.status <> 'cancelled'
     and coalesce(s.group_total,0) > 1;

  update dropshipments
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = nullif(trim(coalesce(p_operator,'')), ''),
         cancel_reason = left(v_reason, 500),
         cancel_info = jsonb_build_object(
           'prev_status', d.status, 'outbound_tracking', d.outbound_tracking,
           'group_seq', d.group_seq, 'group_total', d.group_total,
           'user', p_user, 'inbound_line', v_line, 'siblings', v_sibs),
         outbound_tracking = null, group_seq = null, group_total = null
   where id = p_id;

  return jsonb_build_object('ok', true, 'prev_status', d.status, 'inbound_line', v_line,
                            'siblings', v_sibs, 'released_outbound', d.outbound_tracking);
end $$;

revoke all on function public.ds_void_order(uuid,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.ds_void_order(uuid,text,text,text,boolean) to service_role;

-- ── 10. KPI: voided orders are not part of the SLA population ───────────────
create or replace view public.v_kpi_sla with (security_invoker = true) as
 WITH ds AS (
         SELECT d.id,
            d.client_id,
            d.status,
            d.email_received_at,
            d.physical_received_at,
            d.shipped_at,
                CASE
                    WHEN d.shipped_at IS NOT NULL AND d.email_received_at IS NOT NULL THEN EXTRACT(epoch FROM d.shipped_at - d.email_received_at) / 3600.0
                    ELSE NULL::numeric
                END AS tat_hours,
                CASE
                    WHEN d.shipped_at IS NOT NULL AND d.physical_received_at IS NOT NULL THEN EXTRACT(epoch FROM d.shipped_at - d.physical_received_at) / 3600.0
                    ELSE NULL::numeric
                END AS handling_hours,
            COALESCE(cfg.sla_hours, 24) AS sla_hours
           FROM dropshipments d
             LEFT JOIN dropship_client_configs cfg ON cfg.client_id = d.client_id
          WHERE d.email_received_at >= (now() - '30 days'::interval)
            AND d.status <> 'cancelled'::text
        )
 SELECT count(*) FILTER (WHERE tat_hours IS NOT NULL) AS shipped_count,
    round(avg(tat_hours) FILTER (WHERE tat_hours IS NOT NULL), 1) AS avg_tat_hours,
    round(avg(handling_hours) FILTER (WHERE handling_hours IS NOT NULL), 2) AS avg_handling_hours,
    round(100.0 * count(*) FILTER (WHERE tat_hours IS NOT NULL AND tat_hours <= sla_hours::numeric)::numeric / NULLIF(count(*) FILTER (WHERE tat_hours IS NOT NULL), 0)::numeric, 1) AS on_time_pct,
    count(*) FILTER (WHERE tat_hours IS NOT NULL AND tat_hours > sla_hours::numeric) AS breach_count,
    count(*) FILTER (WHERE tat_hours IS NOT NULL AND tat_hours < 18::numeric) AS bucket_under18,
    count(*) FILTER (WHERE tat_hours IS NOT NULL AND tat_hours >= 18::numeric AND tat_hours <= 24::numeric) AS bucket_18_24,
    count(*) FILTER (WHERE tat_hours IS NOT NULL AND tat_hours > 24::numeric) AS bucket_over24,
    round(100.0 * count(*) FILTER (WHERE status = 'orphan'::text)::numeric / NULLIF(count(*), 0)::numeric, 1) AS orphan_pct,
    count(*) FILTER (WHERE status = 'orphan'::text) AS orphan_count
   FROM ds;
