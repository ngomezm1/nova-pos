-- ============================================================================
--  NOVA POS — anular cuentas queda solo para el dueño
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  Por qué: anular una cuenta se lleva sus ventas y devuelve los vasos al
--  inventario. Es la única acción del día a día que puede hacer desaparecer
--  plata ya registrada sin dejar nada a la vista. El ayudante que abre una
--  cuenta por error le avisa al dueño.
--
--  Esto es el refuerzo del servidor: la app ya esconde el botón, pero
--  esconder un botón no es una regla. Acá sí lo es.
--
--  Lo que el ayudante SIGUE pudiendo hacer: quitar vasos de una cuenta con
--  el botón −, que es como se corrige un pedido mal tomado.
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

    /* Anular una cuenta es exclusivo del dueño. Se compara contra el estado
     * actual: si la cuenta YA estaba anulada, reenviarla no es anular nada y
     * se deja pasar, para que un celular que se sincroniza tarde no choque.
     */
    if not public.es_dueno() then
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
-- prueba que termine en rollback deshace también la creación de la función.
-- Por eso acá solo se consulta.

notify pgrst, 'reload schema';

select p.proname as funcion,
       pg_get_function_arguments(p.oid) as parametros
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'guardar_filas';
