# NOVA POS

Punto de venta para **NOVA — Granizados, Cócteles y Micheladas** (Medellín).

Funciona como app en el celular, sin costo de licencia y sin servidor propio.

## Qué hace

- **Cuentas por nombre.** Como no hay mesas, cada cliente es un nombre ("Andrés", "Gorra roja"). Se ve en vivo cuánto debe cada uno.
- **Pagos parciales.** Si abona $20.000 de $67.000, la cuenta sigue abierta con el saldo restante. Nada se borra.
- **Dividir la cuenta.** Se marca qué vasos se lleva cada persona y la app cobra exactamente eso; el resto sigue debiéndose.
- **Varias sedes.** Al abrir la app se elige dónde se está registrando. Cada sede lleva sus cuentas y su propio inventario, y se pueden comparar en el resumen.
- **Inventario de vasos, por sede.** Icopor en 8, 12, 16 y 24 oz, y el vaso plástico de las micheladas, que es uno solo y no lleva tamaño. Cada venta descuenta el vaso de su sede, con alerta cuando se está acabando. Se pueden trasladar vasos de una sede a otra.
- **Resumen diario.** Recaudado, por cobrar, ticket promedio, cómo pagaron, qué se vendió, cuántos vasos salieron y quién debe. Se descarga en Excel.
- **Dos celulares en vivo.** El tuyo y el del ayudante ven las mismas cuentas al instante.
- **Roles.** El ayudante solo vende. No ve inventario ni los totales del negocio, y no puede cambiar precios.
- **Sin señal igual funciona.** Si se cae internet, sigue vendiendo en el celular y sincroniza cuando vuelve.

El día contable corta a las **5 de la mañana**: lo que vendas a la 1 am cuenta para la noche anterior.

Vienen creadas **Sede Principal** y **Sede Exterior**. Se renombran o se agregan más en Ajustes → Sedes.

---

## Puesta en marcha

Son tres partes. Calculá una hora la primera vez.

### Parte 1 — Base de datos (Supabase, gratis)

1. Entrá a [supabase.com](https://supabase.com) y creá una cuenta.
2. **New project.** Ponele nombre `nova-pos`, elegí una contraseña de base de datos y **guardala**. Región: *East US* o *South America (São Paulo)*.
3. Esperá unos 2 minutos a que quede listo.
4. En el menú de la izquierda entrá a **SQL Editor** → **New query**.
5. Corré **en orden** los tres archivos de la carpeta `supabase/`, cada uno en su propia query, esperando *Success* entre uno y otro:
   1. [`schema.sql`](supabase/schema.sql) — tablas, permisos y descuento automático de vasos
   2. [`02-historial-solo-dueno.sql`](supabase/02-historial-solo-dueno.sql) — el ayudante ve solo su turno
   3. [`03-sedes.sql`](supabase/03-sedes.sql) — varias sedes, cada una con su inventario
6. Andá a **Authentication** → **Providers** → **Email** y **desactivá** *Confirm email*. Así los usuarios entran sin tener que confirmar el correo.
7. Andá a **Authentication** → **Users** → **Add user** → *Create new user*.
   - Correo y contraseña **tuyos**. Este primer usuario queda como **dueño** automáticamente.
8. Andá a **Project Settings** → **API** y dejá esa pantalla abierta. Vas a necesitar:
   - **Project URL** (`https://algo.supabase.co`)
   - **anon public** (una clave larga que empieza con `eyJ...`)

> **Ojo:** ahí abajo hay otra clave llamada **service_role**. Esa nunca se pega en la app ni se sube a ningún lado — da acceso total saltándose todos los permisos.

### Parte 2 — Publicar la app (GitHub Pages, gratis)

1. Creá una cuenta en [github.com](https://github.com) si no tenés.
2. Instalá [Git para Windows](https://git-scm.com/download/win) (siguiente, siguiente, finalizar).
3. En GitHub tocá **+** → **New repository**.
   - Nombre: `nova-pos`
   - **Public** (Pages gratis solo funciona en repos públicos)
   - **No** marques nada más. **Create repository**.
4. En esta carpeta, abrí una terminal y corré, cambiando `TU-USUARIO`:

   ```bash
   git remote add origin https://github.com/TU-USUARIO/nova-pos.git
   git branch -M main
   git push -u origin main
   ```

5. En GitHub entrá al repo → **Settings** → **Pages**.
   - *Source*: **Deploy from a branch**
   - *Branch*: **main** y carpeta **/ (root)** → **Save**
6. Esperá 1–2 minutos. Tu app queda en:

   ```
   https://TU-USUARIO.github.io/nova-pos/
   ```

> El código queda público, pero **no contiene ninguna clave**. La conexión al servidor se escribe una vez en cada celular y se guarda solo ahí.

### Parte 3 — Instalar en los celulares

**En el tuyo:**

1. Abrí el link en Chrome.
2. Menú (⋮) → **Agregar a pantalla de inicio**. Queda con el ícono de NOVA.
3. Abrí la app → **Ajustes** → **Conectar servidor**.
4. Pegá la *Project URL* y la clave *anon public* de la Parte 1 → **Conectar**.
5. Iniciá sesión con el correo y contraseña que creaste.
6. La app te pregunta **en qué sede** vas a registrar. Elegí la que corresponda.
7. Andá a **Inventario** y cargá cuántos vasos tenés **en esa sede** (**Mover** → *Entrada por compra*). Arriba cambiás de sede para cargar la otra.
8. Revisá **Ajustes** → **Productos**. Vienen los 8 granizados del menú y la **Michelada a $12.000**. Si vendés algo más, lo agregás ahí.
9. En **Ajustes** → **Sedes** podés renombrarlas o agregar otra.

**En el del ayudante:**

1. Primero creale el usuario: Supabase → **Authentication** → **Users** → **Add user**, con su correo y una contraseña.
   Entra como **ayudante** automáticamente.
2. En su celular: mismo link, agregar a pantalla de inicio, **Conectar servidor** con los mismos dos datos, e inicia sesión con **su** usuario.
   Al entrar elegí **la sede donde va a trabajar**: eso define dónde se registran sus ventas y de qué inventario se descuenta.
3. Él va a ver solo **Cuentas**, **Mi turno** y **Ajustes**. Nada de inventario ni de precios,
   y del historial solo el turno en el que está trabajando.

---

## Cómo se maneja el acceso del ayudante

No es una pantalla escondida: es el servidor el que decide.

- Sus permisos no le alcanzan para leer `inventario` ni `movimientos`. Si intentara consultarlos, la base de datos le devuelve cero filas.
- Tampoco puede crear ni cambiar productos, así que no puede tocar precios.
- **Las ventas sí descuentan vasos**, porque el descuento lo hace un *trigger* dentro de la base de datos, no su celular.
- **El historial es solo tuyo.** Él ve lo de hoy y las cuentas que sigan abiertas de otros días
  (para poder cobrarlas). Lo de días anteriores ya cerrado no le llega, y lo que bajó cuando
  era "hoy" se borra de su celular al día siguiente.
- Nadie puede borrar cuentas, ítems ni pagos: se marcan como anulados y queda el rastro.
- Cuando cierra sesión, los datos del negocio se borran de ese celular.

Modificar la app en su teléfono no le sirve de nada: los permisos viven en el servidor.

---

## Uso diario

| Situación | Qué hacer |
|---|---|
| Abrís el turno | La app pregunta la sede; verificá que sea la correcta |
| Llega un cliente | **Nueva cuenta** → su nombre |
| Pide otro vaso | Abrí su cuenta → tocá el tamaño |
| Se equivocaron de pedido | En la línea, tocá **−** |
| Paga todo | **Cobrar** → *Todo* → método |
| Abona una parte | **Cobrar** → escribí el monto |
| Paga más y hay que dar cambio | Escribí lo que te dio; la app te dice cuánto devolver |
| Cada uno paga lo suyo | **Dividir** → marcá los vasos de esa persona |
| Cierre de la noche | **Resumen** → mirá recaudado y quién quedó debiendo |
| Llegaron vasos nuevos | **Inventario** → **Mover** → *Entrada por compra* |
| El conteo no cuadra | **Inventario** → **Mover** → *Conteo físico* |
| Llevás vasos a la otra sede | **Inventario** → *Trasladar vasos a otra sede* |
| Comparar las dos sedes | **Resumen** → pestaña **Todas** |
| Te movés de local | Tocá **Cambiar** arriba a la derecha |

Cuando el saldo llega a cero, la cuenta se cierra sola.

Una cuenta se queda en la sede donde se abrió. Si cambiás el celular de sede, lo que le agregues a esa cuenta sigue descontando del inventario de su sede original — no del local donde estás parado.

---

## Respaldo

**Ajustes → Descargar respaldo** guarda un archivo con todo. Con Supabase conectado los datos ya están en el servidor, pero el respaldo sirve si querés una copia propia.

## Cuánto cuesta

Nada. El plan gratis de Supabase (500 MB y 50.000 usuarios activos al mes) y GitHub Pages sobran para un negocio de este tamaño.

Lo único: si el proyecto de Supabase pasa **una semana entera sin ninguna actividad**, se pausa y hay que reactivarlo con un clic. Usándolo cada noche no pasa.

## Estructura

```
index.html              pantalla única
css/style.css           tema neón
js/store.js             datos, cuentas, pagos, inventario
js/cloud.js             sesión y sincronización con Supabase
js/ui.js                pantallas
sw.js                   caché para trabajar sin señal
supabase/schema.sql     tablas, permisos y descuento de vasos
supabase/02-*.sql       el ayudante ve solo su turno
supabase/03-sedes.sql   varias sedes con inventario propio
```

Sin build ni dependencias: son archivos que el navegador abre directamente.
