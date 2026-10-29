-- ============================================================================
--  NOVA POS — deshacer una venta cobrada queda solo para el dueño
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  QUÉ FALTABA
--  El 11 bloqueó anular una CUENTA, pero quedaban dos caminos abiertos para
--  hacer desaparecer plata ya registrada:
--    1. El botón "Anular" que aparece al lado de cada pago recibido.
--    2. El botón − sobre los vasos de una cuenta que ya recibió un abono.
--
--  LA REGLA
--  Una vez que hubo plata de por medio, cualquier cambio pasa por el dueño.
--  El ayudante sigue corrigiendo libremente un pedido mal tomado mientras la
--  cuenta no haya recibido ningún pago, que es cuando de verdad se equivoca
--  al anotar. Y siempre puede AGREGAR, que es lo normal mientras el cliente
--  sigue pidiendo.
-- ============================================================================

create or replace function public.guardar_filas(p_tabla text, p_filas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  soy_dueno boolean := public.es_dueno();
begin
  -- La función corre con permisos elevados: la primera línea tiene que ser
  -- comprobar quién llama. Sin esto sería una puerta abierta.
  if not public.habilitado() then
    raise exception 'Acceso desactivado' using errcode = '42501';
  end if;

  if p_filas is null or jsonb_typeof(p_filas) <> 'array' then
    raise exception 'Se esperaba una lista de filas' using errcode = '22023';
  end if;

  -- Solo las tablas del trabajo diario. Inventario, precios y usuarios
  -- siguen pasando por las políticas normales, que el ayudante no supera.
  if p_tabla = 'cuentas' then

    /* Anular una cuenta es exclusivo del dueño. Se compara contra el estado
     * actual: si la cuenta YA estaba anulada, reenviarla no es anular nada y
     * se deja pasar, para que un celular que se sincroniza tarde no choque.
     */
    if not soy_dueno then
      if exists (
        select 1
          from jsonb_populate_recordset(null::public.cuentas, p_filas) nueva
          left join public.cuentas actual on actual.id = nueva.id
         where nueva.deleted
           and coalesce(actual.deleted, false) = false
      ) then
        raise exception 'Solo el dueño puede anular cuentas'
          using errcode = '42501';
      end if;
    end if;

    insert into public.cuentas
    select * from jsonb_populate_recordset(null::public.cuentas, p_filas)
    on conflict (id) do update set
      nombre     = excluded.nombre,
      nota       = excluded.nota,
      estado     = excluded.estado,
      creada_por = excluded.creada_por,
      closed_at  = excluded.closed_at,
      fecha      = excluded.fecha,
      sede_id    = excluded.sede_id,
      deleted    = excluded.deleted;
    get diagnostics n = row_count;

  elsif p_tabla = 'items' then

    /* Quitar o reducir vasos de una cuenta que ya recibió plata es deshacer
     * una venta cobrada. Mientras no haya pagos, el ayudante corrige libre.
     */
    if not soy_dueno then
      if exists (
        select 1
          from jsonb_populate_recordset(null::public.items, p_filas) nueva
          join public.items actual on actual.id = nueva.id
         where (
                 (nueva.deleted and not actual.deleted)
                 or nueva.cantidad < actual.cantidad
               )
           and exists (
             select 1 from public.pagos pg
              where pg.cuenta_id = actual.cuenta_id
                and not pg.deleted
           )
      ) then
        raise exception 'La cuenta ya recibió un pago: solo el dueño puede corregirla'
          using errcode = '42501';
      end if;
    end if;

    insert into public.items
    select * from jsonb_populate_recordset(null::public.items, p_filas)
    on conflict (id) do update set
      cuenta_id    = excluded.cuenta_id,
      producto_id  = excluded.producto_id,
      nombre       = excluded.nombre,
      precio       = excluded.precio,
      cantidad     = excluded.cantidad,
      pagadas      = excluded.pagadas,
      vaso         = excluded.vaso,
      oz           = excluded.oz,
      consume      = excluded.consume,
      consume_cant = excluded.consume_cant,
      vendido_por  = excluded.vendido_por,
      fecha        = excluded.fecha,
      sede_id      = excluded.sede_id,
      deleted      = excluded.deleted;
    get diagnostics n = row_count;

  elsif p_tabla = 'pagos' then

    -- Anular un pago borra plata que ya entró. Nunca el ayudante.
    if not soy_dueno then
      if exists (
        select 1
          from jsonb_populate_recordset(null::public.pagos, p_filas) nueva
          left join public.pagos actual on actual.id = nueva.id
         where nueva.deleted
           and coalesce(actual.deleted, false) = false
      ) then
        raise exception 'Solo el dueño puede anular un pago'
          using errcode = '42501';
      end if;

      -- Tampoco cambiarle el monto a un cobro ya guardado.
      if exists (
        select 1
          from jsonb_populate_recordset(null::public.pagos, p_filas) nueva
          join public.pagos actual on actual.id = nueva.id
         where nueva.monto <> actual.monto
      ) then
        raise exception 'Solo el dueño puede cambiar el monto de un pago'
          using errcode = '42501';
      end if;
    end if;

    insert into public.pagos
    select * from jsonb_populate_recordset(null::public.pagos, p_filas)
    on conflict (id) do update set
      cuenta_id   = excluded.cuenta_id,
      monto       = excluded.monto,
      metodo      = excluded.metodo,
      quien       = excluded.quien,
      nota        = excluded.nota,
      cubre       = excluded.cubre,
      cobrado_por = excluded.cobrado_por,
      fecha       = excluded.fecha,
      sede_id     = excluded.sede_id,
      deleted     = excluded.deleted;
    get diagnostics n = row_count;

  else
    raise exception 'Tabla no permitida: %', p_tabla using errcode = '42501';
  end if;

  return jsonb_build_object('guardadas', n);
end;
$$;

grant execute on function public.guardar_filas(text, jsonb) to authenticated;

-- ----------------------------------------------------- comprobación --------
-- OJO: el editor de Supabase corre todo el script en UNA transacción. Una
-- prueba que termine en rollback deshace también la creación de la función.
-- Por eso acá solo se consulta.

notify pgrst, 'reload schema';

select p.proname as funcion,
       pg_get_function_arguments(p.oid) as parametros
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'guardar_filas';
