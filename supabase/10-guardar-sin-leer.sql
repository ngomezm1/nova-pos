-- ============================================================================
--  NOVA POS — guardar sin necesidad de poder leer
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  EL PROBLEMA
--  Para guardar un cambio sobre una fila existente, PostgreSQL primero
--  necesita LEERLA. El ayudante no puede leer cuentas cerradas de días
--  anteriores — esa es justamente la regla que esconde el historial — así que
--  al cobrar una deuda vieja, la cuenta pasa a "cerrada" y el servidor le
--  rechaza guardar ese cobro:
--
--    ERROR 42501: new row violates row-level security policy for table "cuentas"
--
--  Dar permiso de escritura (como hizo el 08) no alcanza: el bloqueo viene
--  por el lado de la lectura. Y abrirle la lectura destruiría la privacidad
--  del historial, que es lo que se quiere conservar.
--
--  LA SOLUCIÓN
--  Las ventas se guardan a través de esta función, que corre con permisos
--  propios y aplica sus propias reglas. El ayudante sigue sin poder LEER el
--  historial, pero puede GUARDAR lo que registró. Las dos cosas dejan de
--  estar atadas.
-- ============================================================================

create or replace function public.guardar_filas(p_tabla text, p_filas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
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
-- prueba que termine en rollback deshace también la creación de la función,
-- y queda la ilusión de que funcionó. Por eso acá solo se consulta.

notify pgrst, 'reload schema';

select p.proname as funcion,
       pg_get_function_arguments(p.oid) as parametros
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'guardar_filas';
