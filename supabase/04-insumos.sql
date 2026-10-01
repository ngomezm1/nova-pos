-- ============================================================================
--  NOVA POS — insumos
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  Qué cambia: el inventario deja de ser solo vasos. Ahora se puede contar
--  cualquier cosa — pitillos, hielo, limones, cervezas — con su nombre y su
--  unidad, y cada sede lleva su propio conteo.
--
--  Todo se identifica por `clave`. Los vasos la derivan de tipo+oz, igual que
--  antes; los insumos traen una propia, compartida entre sedes.
-- ============================================================================

alter table public.inventario  add column if not exists clave  text;
alter table public.inventario  add column if not exists nombre text;
alter table public.inventario  add column if not exists unidad text;

alter table public.movimientos add column if not exists clave  text;
alter table public.movimientos add column if not exists nombre text;

-- 'insumo' se suma a los tipos permitidos.
alter table public.inventario  drop constraint if exists inventario_tipo_check;
alter table public.inventario
  add constraint inventario_tipo_check
  check (tipo in ('icopor', 'plastico', 'insumo'));

-- Clave de un vaso: igual que la que calcula la app.
create or replace function public.clave_vaso(p_tipo text, p_oz int)
returns text
language sql
immutable
as $$
  select p_tipo || '-' || coalesce(p_oz::text, 'unico');
$$;

-- Las filas que ya existían son todas vasos: se les calcula su clave.
update public.inventario
   set clave = public.clave_vaso(tipo, oz)
 where clave is null;

update public.movimientos
   set clave = public.clave_vaso(tipo_vaso, oz)
 where clave is null and tipo_vaso in ('icopor', 'plastico');

-- La unicidad pasa a (sede, clave): es lo que distingue dos insumos con el
-- mismo nombre de uno solo repetido.
drop index if exists public.inventario_sede_vaso_uq;

create unique index if not exists inventario_sede_clave_uq
  on public.inventario (sede_id, clave);

create index if not exists movimientos_clave_idx on public.movimientos (clave);

-- ------------------------------- descuento de vasos, ahora por clave -------

create or replace function public.aplicar_stock(
  p_sede uuid, p_tipo text, p_oz int, p_delta int,
  p_motivo text, p_cuenta uuid, p_nota text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clave  text;
  v_nombre text;
begin
  -- p_oz nulo es válido: así es el vaso plástico, que no tiene tamaño.
  -- Sin sede no se mueve nada: mejor no descontar que descontar en el local
  -- equivocado, porque eso descuadra las dos sedes a la vez.
  if p_sede is null or p_tipo is null or p_delta = 0 then return; end if;

  v_clave := public.clave_vaso(p_tipo, p_oz);

  insert into public.inventario (sede_id, clave, tipo, oz, stock)
  values (p_sede, v_clave, p_tipo, p_oz, p_delta)
  on conflict (sede_id, clave)
  do update set stock = public.inventario.stock + p_delta;

  select nombre into v_nombre
    from public.inventario
   where sede_id = p_sede and clave = v_clave;

  insert into public.movimientos
    (sede_id, clave, nombre, tipo_vaso, oz, delta, motivo, cuenta_id, nota)
  values
    (p_sede, v_clave, coalesce(v_nombre, p_tipo), p_tipo, p_oz,
     p_delta, p_motivo, p_cuenta, coalesce(p_nota, ''));
end;
$$;

-- ----------------------------- un insumo existe en todas las sedes ---------
-- Si naciera solo en la sede donde se creó, la otra no podría registrar sus
-- compras y el insumo parecería inexistente allá.

create or replace function public.replicar_insumo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.tipo <> 'insumo' then return NEW; end if;

  insert into public.inventario (sede_id, clave, tipo, oz, nombre, unidad, stock, minimo)
  select s.id, NEW.clave, 'insumo', null, NEW.nombre, NEW.unidad, 0, NEW.minimo
    from public.sedes s
   where not s.deleted
     and s.activa
     and s.id <> NEW.sede_id
  on conflict (sede_id, clave) do nothing;

  return NEW;
end;
$$;

drop trigger if exists tg_replicar_insumo on public.inventario;
create trigger tg_replicar_insumo
  after insert on public.inventario
  for each row execute function public.replicar_insumo();

-- ----------------------------------------------------- comprobación --------

select s.nombre as sede,
       count(*) filter (where i.tipo <> 'insumo') as filas_de_vasos,
       count(*) filter (where i.tipo = 'insumo')  as filas_de_insumos,
       count(*) filter (where i.clave is null)    as sin_clave
  from public.sedes s
  left join public.inventario i on i.sede_id = s.id and not i.deleted
 where not s.deleted
 group by s.nombre
 order by s.nombre;
