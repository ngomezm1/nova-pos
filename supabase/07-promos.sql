-- ============================================================================
--  NOVA POS — promociones 2x1
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  Qué cambia: una venta podía descontar una sola unidad del inventario. Un
--  2x1 se cobra una vez pero entrega dos vasos, así que sin esto el stock
--  quedaría con un vaso de más por cada promoción vendida.
-- ============================================================================

alter table public.productos add column if not exists consume_cant int not null default 1;
alter table public.productos add column if not exists base_id uuid;
alter table public.items     add column if not exists consume_cant int not null default 1;

alter table public.productos drop constraint if exists productos_consume_cant_check;
alter table public.productos
  add constraint productos_consume_cant_check check (consume_cant between 1 and 20);

alter table public.items drop constraint if exists items_consume_cant_check;
alter table public.items
  add constraint items_consume_cant_check check (consume_cant between 1 and 20);

-- ------------------------------ el trigger multiplica por consume_cant -----

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
  /* Cantidad "efectiva" = unidades vendidas × lo que descuenta cada una.
   * Una línea borrada cuenta como cero.
   */
  if TG_OP = 'INSERT' then
    clave_ant := null; cant_ant := 0; sede_ant := null;
  else
    clave_ant := coalesce(OLD.consume, public.clave_vaso(OLD.vaso, OLD.oz));
    sede_ant  := OLD.sede_id;
    cant_ant  := case when OLD.deleted then 0
                      else OLD.cantidad * greatest(coalesce(OLD.consume_cant, 1), 1) end;
  end if;

  if TG_OP = 'DELETE' then
    clave_nue := null; cant_nue := 0; sede_nue := null;
  else
    clave_nue := coalesce(NEW.consume, public.clave_vaso(NEW.vaso, NEW.oz));
    sede_nue  := NEW.sede_id;
    cant_nue  := case when NEW.deleted then 0
                      else NEW.cantidad * greatest(coalesce(NEW.consume_cant, 1), 1) end;
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

-- ----------------------------------------------------- comprobación --------
-- Los 2x1 los crea la app desde Ajustes → Promoción 2x1. Acá solo se ve si
-- ya existen y qué descuentan.

select p.nombre,
       p.precio,
       p.consume_cant as descuenta_unidades,
       case when p.activo then 'en la grilla' else 'apagado' end as estado
  from public.productos p
 where not p.deleted
   and (p.categoria = 'promo' or p.consume_cant > 1)
 order by p.orden;
