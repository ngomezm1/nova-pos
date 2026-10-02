-- ============================================================================
--  NOVA POS — cada producto elige qué descuenta
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  Qué cambia: el descuento por venta estaba atado a vaso+oz, así que un
--  insumo creado desde la app no podía asociarse a ningún producto. Ahora el
--  producto apunta a una línea de inventario cualquiera, por su clave.
-- ============================================================================

alter table public.productos add column if not exists consume text;
alter table public.items     add column if not exists consume text;

-- Lo que ya existía apuntaba a un vaso: se le calcula su clave.
update public.productos
   set consume = public.clave_vaso(vaso, oz)
 where consume is null and vaso is not null;

update public.items
   set consume = public.clave_vaso(vaso, oz)
 where consume is null and vaso is not null;

create index if not exists items_consume_idx on public.items (consume);

-- --------------------------------- descuento por clave de inventario -------

/* Mueve stock de la línea `p_clave` en la sede `p_sede`. Si esa sede todavía
 * no tiene esa línea, se crea copiando nombre y unidad de otra sede; si no
 * existe en ninguna, solo puede ser un vaso y se deduce de la clave.
 */
create or replace function public.aplicar_stock_clave(
  p_sede uuid, p_clave text, p_delta int,
  p_motivo text, p_cuenta uuid, p_nota text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo   text;
  v_oz     int;
  v_nombre text;
  v_unidad text;
  v_partes text[];
begin
  if p_sede is null or p_clave is null or p_delta = 0 then return; end if;

  select tipo, oz, nombre, unidad
    into v_tipo, v_oz, v_nombre, v_unidad
    from public.inventario
   where clave = p_clave and not deleted
   limit 1;

  if v_tipo is null then
    -- Sin antecedentes en ninguna sede: solo puede ser un vaso.
    v_partes := string_to_array(p_clave, '-');
    if array_length(v_partes, 1) <> 2
       or v_partes[1] not in ('icopor', 'plastico') then
      return;
    end if;
    v_tipo := v_partes[1];
    v_oz := case when v_partes[2] = 'unico' then null else v_partes[2]::int end;
  end if;

  insert into public.inventario (sede_id, clave, tipo, oz, nombre, unidad, stock)
  values (p_sede, p_clave, v_tipo, v_oz, v_nombre, v_unidad, p_delta)
  on conflict (sede_id, clave)
  do update set stock = public.inventario.stock + p_delta;

  insert into public.movimientos
    (sede_id, clave, nombre, tipo_vaso, oz, delta, motivo, cuenta_id, nota)
  values
    (p_sede, p_clave, coalesce(v_nombre, v_tipo), v_tipo, v_oz,
     p_delta, p_motivo, p_cuenta, coalesce(p_nota, ''));
end;
$$;

create or replace function public.mover_inventario_por_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  clave_ant text; cant_ant int; sede_ant uuid;
  clave_nue text; cant_nue int; sede_nue uuid;
begin
  -- Cantidad "efectiva": una línea borrada cuenta como cero.
  if TG_OP = 'INSERT' then
    clave_ant := null; cant_ant := 0; sede_ant := null;
  else
    clave_ant := coalesce(OLD.consume, public.clave_vaso(OLD.vaso, OLD.oz));
    sede_ant  := OLD.sede_id;
    cant_ant  := case when OLD.deleted then 0 else OLD.cantidad end;
  end if;

  if TG_OP = 'DELETE' then
    clave_nue := null; cant_nue := 0; sede_nue := null;
  else
    clave_nue := coalesce(NEW.consume, public.clave_vaso(NEW.vaso, NEW.oz));
    sede_nue  := NEW.sede_id;
    cant_nue  := case when NEW.deleted then 0 else NEW.cantidad end;
  end if;

  -- Si cambió lo que consume o la sede, se devuelve lo viejo entero y se
  -- descuenta lo nuevo donde corresponde.
  if clave_ant is distinct from clave_nue or sede_ant is distinct from sede_nue then
    if clave_ant is not null and cant_ant <> 0 then
      perform public.aplicar_stock_clave(sede_ant, clave_ant, cant_ant, 'devolucion',
                                         coalesce(OLD.cuenta_id, NEW.cuenta_id), OLD.nombre);
    end if;
    if clave_nue is not null and cant_nue <> 0 then
      perform public.aplicar_stock_clave(sede_nue, clave_nue, -cant_nue, 'venta',
                                         NEW.cuenta_id, NEW.nombre);
    end if;

  elsif clave_nue is not null and cant_nue <> cant_ant then
    perform public.aplicar_stock_clave(
      sede_nue, clave_nue, -(cant_nue - cant_ant),
      case when cant_nue > cant_ant then 'venta' else 'devolucion' end,
      coalesce(NEW.cuenta_id, OLD.cuenta_id),
      coalesce(NEW.nombre, OLD.nombre));
  end if;

  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists tg_stock_items on public.items;
create trigger tg_stock_items
  after insert or update or delete on public.items
  for each row execute function public.mover_inventario_por_item();

-- La versión anterior queda huérfana: se elimina para que nadie la llame.
drop function if exists public.aplicar_stock(uuid, text, int, int, text, uuid, text);

-- ----------------------------------------------------- comprobación --------

select p.nombre as producto,
       coalesce(i.nombre, i.tipo || ' ' || coalesce(i.oz::text || ' oz', ''), '— no descuenta nada')
         as descuenta
  from public.productos p
  left join lateral (
    select distinct on (clave) nombre, tipo, oz
      from public.inventario
     where clave = p.consume and not deleted
  ) i on true
 where not p.deleted and p.activo
 order by p.orden;
