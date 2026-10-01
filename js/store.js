/* NOVA POS — capa de datos local-first
 * Todo vive en localStorage y se marca como "sucio" para que cloud.js lo suba a Supabase.
 * Cada registro: { id, updated_at, deleted }  -> merge por last-write-wins.
 */
(function (global) {
  'use strict';

  var LS = 'nova.v1.';
  var SEDE_KEY = 'nova.sede';
  var TABLAS = ['sedes', 'productos', 'cuentas', 'items', 'pagos', 'inventario', 'movimientos'];

  // Tablas que un ayudante nunca descarga ni sube. El servidor además se lo prohíbe.
  var TABLAS_SOLO_DUENO = ['inventario', 'movimientos'];

  var state = {};
  var listeners = [];

  /* ---------- utilidades ---------- */

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function now() { return new Date().toISOString(); }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // Fecha "de negocio": el día contable corta a las 5am, no a medianoche,
  // porque la venta de la madrugada pertenece a la noche anterior.
  function diaNegocio(iso) {
    var d = iso ? new Date(iso) : new Date();
    var t = new Date(d.getTime() - 5 * 3600 * 1000);
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }

  function money(n) {
    n = Math.round(Number(n) || 0);
    return '$' + n.toLocaleString('es-CO');
  }

  /* ---------- persistencia ---------- */

  function leerTabla(t) {
    try {
      var raw = localStorage.getItem(LS + t);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('No se pudo leer ' + t, e);
      return [];
    }
  }

  function guardarTabla(t) {
    try {
      localStorage.setItem(LS + t, JSON.stringify(state[t]));
    } catch (e) {
      console.error('No se pudo guardar ' + t, e);
      alert('Sin espacio para guardar. Exportá un respaldo desde Ajustes.');
    }
  }

  function cargar() {
    TABLAS.forEach(function (t) { state[t] = leerTabla(t); });
  }

  function emitir() {
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  function commit(tablas) {
    (tablas || TABLAS).forEach(guardarTabla);
    emitir();
    if (global.NOVA && global.NOVA.cloud) global.NOVA.cloud.agendarPush();
  }

  // El inventario lo mueve el cliente solo en modo local. Con Supabase conectado,
  // lo mueve un trigger en la base de datos: así el ayudante descuenta stock
  // sin tener ningún permiso sobre la tabla de inventario.
  function inventarioLocal() {
    return !(global.NOVA && global.NOVA.cloud && global.NOVA.cloud.activo());
  }

  /* ---------- CRUD genérico ---------- */

  function insertar(tabla, obj) {
    obj.id = obj.id || uid();
    obj.updated_at = now();
    obj.deleted = false;
    obj._dirty = true;
    state[tabla].push(obj);
    return obj;
  }

  function actualizar(tabla, id, cambios) {
    var row = buscar(tabla, id);
    if (!row) return null;
    Object.keys(cambios).forEach(function (k) { row[k] = cambios[k]; });
    row.updated_at = now();
    row._dirty = true;
    return row;
  }

  function borrar(tabla, id) {
    return actualizar(tabla, id, { deleted: true });
  }

  function buscar(tabla, id) {
    var a = state[tabla] || [];
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }

  function vivos(tabla) {
    return (state[tabla] || []).filter(function (r) { return !r.deleted; });
  }

  /* ---------- catálogo inicial ---------- */

  var CATALOGO_BASE = [
    // Granizados cremosos — vaso de icopor
    { nombre: 'Cremoso 8 oz',  categoria: 'cremoso',  oz: 8,  precio: 13000, vaso: 'icopor',   orden: 1 },
    { nombre: 'Cremoso 12 oz', categoria: 'cremoso',  oz: 12, precio: 17000, vaso: 'icopor',   orden: 2 },
    { nombre: 'Cremoso 16 oz', categoria: 'cremoso',  oz: 16, precio: 22000, vaso: 'icopor',   orden: 3 },
    { nombre: 'Cremoso 24 oz', categoria: 'cremoso',  oz: 24, precio: 30000, vaso: 'icopor',   orden: 4 },
    // Granizados originales — vaso de icopor
    { nombre: 'Original 8 oz',  categoria: 'original', oz: 8,  precio: 11000, vaso: 'icopor',  orden: 5 },
    { nombre: 'Original 12 oz', categoria: 'original', oz: 12, precio: 13000, vaso: 'icopor',  orden: 6 },
    { nombre: 'Original 16 oz', categoria: 'original', oz: 16, precio: 17000, vaso: 'icopor',  orden: 7 },
    { nombre: 'Original 24 oz', categoria: 'original', oz: 24, precio: 23000, vaso: 'icopor',  orden: 8 },
    // Michelada — vaso plástico, de un solo tipo y sin tamaños.
    { nombre: 'Michelada', categoria: 'michelada', oz: null, precio: 12000, vaso: 'plastico', orden: 9 }
  ];

  var VASOS = [
    { tipo: 'icopor',   oz: 8  }, { tipo: 'icopor',   oz: 12 },
    { tipo: 'icopor',   oz: 16 }, { tipo: 'icopor',   oz: 24 },
    { tipo: 'plastico', oz: null }
  ];

  var NOMBRE_VASO = { icopor: 'Icopor', plastico: 'Plástico' };

  // El vaso plástico es uno solo: no lleva onzas. Estas tres funciones son el
  // único lugar donde se decide cómo se nombra y se compara un vaso sin tamaño.
  function normOz(oz) {
    return (oz === null || oz === undefined || oz === '') ? null : Number(oz);
  }

  function claveVaso(tipo, oz) {
    return tipo + '-' + (normOz(oz) === null ? 'unico' : normOz(oz));
  }

  function etiquetaVaso(tipo, oz) {
    var n = NOMBRE_VASO[tipo] || tipo;
    return normOz(oz) === null ? n : n + ' ' + normOz(oz) + ' oz';
  }

  /* Cada fila de inventario se identifica por su clave. Los vasos la derivan
   * de tipo+oz, como siempre; los insumos traen una propia, igual en todas las
   * sedes, para que "Limones" en una sede y en la otra sean el mismo insumo
   * con dos conteos.
   */
  function claveDe(fila) {
    return fila.clave || claveVaso(fila.tipo, fila.oz);
  }

  function etiquetaDe(fila) {
    return fila.nombre || etiquetaVaso(fila.tipo, fila.oz);
  }

  // Unidades de medida de los insumos. 'unidad' sirve para lo que se cuenta
  // de a uno: limones, pitillos, cervezas.
  var UNIDADES = ['unidad', 'paquete', 'bolsa', 'botella', 'caja', 'libra', 'kilo', 'litro'];

  // Reconstruye un vaso a partir de su clave, para poder crear su fila en una
  // sede que todavia no lo tenga.
  function vasoDesdeClave(clave) {
    var p = String(clave || '').split('-');
    if (p.length !== 2 || (p[0] !== 'icopor' && p[0] !== 'plastico')) return null;
    return { tipo: p[0], oz: p[1] === 'unico' ? null : Number(p[1]) };
  }

  var SEDES_BASE = ['Sede Principal', 'Sede Exterior'];

  function sembrar() {
    // Con Supabase conectado el catálogo y el inventario ya existen en el servidor
    // y llegan por sincronización. Sembrarlos acá crearía duplicados en cero.
    if (global.NOVA && global.NOVA.cloud && global.NOVA.cloud.configurado()) return;

    var cambio = [];
    if (vivos('sedes').length === 0) {
      SEDES_BASE.forEach(function (n, i) {
        insertar('sedes', { nombre: n, orden: i + 1, activa: true });
      });
      cambio.push('sedes');
    }
    if (vivos('productos').length === 0) {
      CATALOGO_BASE.forEach(function (p) {
        insertar('productos', {
          nombre: p.nombre, categoria: p.categoria, oz: p.oz,
          precio: p.precio, vaso: p.vaso, orden: p.orden, activo: true
        });
      });
      cambio.push('productos');
    }
    // El ayudante no siembra inventario: no le pertenece esa tabla.
    // Cada sede lleva su propio conteo de vasos.
    if (esDueno() && vivos('inventario').length === 0) {
      sedes().forEach(function (s) {
        VASOS.forEach(function (v) {
          insertar('inventario', {
            sede_id: s.id, clave: claveVaso(v.tipo, v.oz),
            tipo: v.tipo, oz: v.oz, stock: 0, minimo: 20
          });
        });
      });
      cambio.push('inventario');
    }
    if (cambio.length) commit(cambio);
  }

  function esDueno() {
    return !(global.NOVA && global.NOVA.sesion) || global.NOVA.sesion.esDueno();
  }

  // Quién registró el movimiento. En modo local no hay varios usuarios,
  // así que firmar cada venta con un nombre solo ensucia la pantalla.
  function quien() {
    if (!(global.NOVA && global.NOVA.cloud && global.NOVA.cloud.configurado())) return '';
    return global.NOVA.sesion ? global.NOVA.sesion.nombre() : '';
  }

  /* ---------- sedes ---------- */

  /* La sede es del dispositivo, no del usuario: el mismo ayudante puede estar
   * hoy en una sede y mañana en otra, y el celular es el que está parado en un
   * lugar. Por eso vive en localStorage y no viaja en la sincronización.
   */

  function sedes() {
    return vivos('sedes').sort(function (a, b) { return (a.orden || 0) - (b.orden || 0); });
  }

  function sedesActivas() {
    return sedes().filter(function (s) { return s.activa !== false; });
  }

  function sedeActual() {
    var id = localStorage.getItem(SEDE_KEY);
    if (!id) return null;
    var s = buscar('sedes', id);
    // Si la sede se borró o se desactivó, hay que volver a elegir.
    return (s && !s.deleted && s.activa !== false) ? s : null;
  }

  function fijarSede(id) {
    var s = buscar('sedes', id);
    if (!s || s.deleted) return false;
    localStorage.setItem(SEDE_KEY, id);
    emitir();
    return true;
  }

  function olvidarSede() {
    localStorage.removeItem(SEDE_KEY);
    emitir();
  }

  function nombreSede(id) {
    var s = buscar('sedes', id);
    return s ? s.nombre : 'Sin sede';
  }

  function guardarSede(datos) {
    if (datos.id) {
      actualizar('sedes', datos.id, datos);
    } else {
      var max = sedes().reduce(function (m, s) { return Math.max(m, s.orden || 0); }, 0);
      datos.orden = max + 1;
      datos.activa = true;
      var nueva = insertar('sedes', datos);

      // Una sede nueva arranca con todo el inventario en cero: los vasos y
      // tambien los insumos que ya se usan en las otras sedes.
      VASOS.forEach(function (v) {
        insertar('inventario', {
          sede_id: nueva.id, clave: claveVaso(v.tipo, v.oz),
          tipo: v.tipo, oz: v.oz, stock: 0, minimo: 20
        });
      });

      var vistos = {};
      vivos('inventario')
        .filter(function (i) { return i.tipo === 'insumo'; })
        .forEach(function (i) {
          var k = claveDe(i);
          if (vistos[k]) return;
          vistos[k] = true;
          insertar('inventario', {
            sede_id: nueva.id, clave: k, tipo: 'insumo', oz: null,
            nombre: i.nombre, unidad: i.unidad, stock: 0, minimo: i.minimo || 0
          });
        });
    }
    commit(['sedes', 'inventario']);
  }

  /* ---------- productos ---------- */

  function productos() {
    return vivos('productos').sort(function (a, b) { return (a.orden || 0) - (b.orden || 0); });
  }

  function productosActivos() {
    return productos().filter(function (p) { return p.activo !== false; });
  }

  function guardarProducto(datos) {
    // El vaso plástico no tiene tamaño: se guarda sin onzas para que empate
    // con su única fila de inventario.
    datos.oz = datos.vaso === 'plastico' ? null : normOz(datos.oz);
    if (datos.id) {
      actualizar('productos', datos.id, datos);
    } else {
      var max = productos().reduce(function (m, p) { return Math.max(m, p.orden || 0); }, 0);
      datos.orden = max + 1;
      datos.activo = true;
      insertar('productos', datos);
    }
    commit(['productos']);
  }

  function eliminarProducto(id) {
    borrar('productos', id);
    commit(['productos']);
  }

  /* ---------- inventario ---------- */

  var ORDEN_TIPO = { icopor: 0, plastico: 1, insumo: 2 };

  // Sin sedeId devuelve el inventario de todas las sedes.
  function inventario(sedeId) {
    return vivos('inventario')
      .filter(function (i) { return !sedeId || i.sede_id === sedeId; })
      .sort(function (a, b) {
        var ta = ORDEN_TIPO[a.tipo] === undefined ? 9 : ORDEN_TIPO[a.tipo];
        var tb = ORDEN_TIPO[b.tipo] === undefined ? 9 : ORDEN_TIPO[b.tipo];
        if (ta !== tb) return ta - tb;
        if (a.tipo === 'insumo') return (a.nombre || '').localeCompare(b.nombre || '');
        return (normOz(a.oz) || 0) - (normOz(b.oz) || 0);
      });
  }

  function vasos(sedeId) {
    return inventario(sedeId).filter(function (i) { return i.tipo !== 'insumo'; });
  }

  function insumos(sedeId) {
    return inventario(sedeId).filter(function (i) { return i.tipo === 'insumo'; });
  }

  function stockDe(clave, sedeId) {
    var a = vivos('inventario').filter(function (i) {
      return i.sede_id === sedeId && claveDe(i) === clave;
    });
    return a.length ? a[0] : null;
  }

  // Cualquier fila con esa clave, sin importar la sede. Sirve para copiar el
  // nombre y la unidad cuando hay que crearla en otra.
  function gemelaDe(clave) {
    return vivos('inventario').filter(function (i) { return claveDe(i) === clave; })[0] || null;
  }

  /* Todo movimiento de stock pertenece a una sede. Sin sede no se toca nada:
   * es preferible no mover inventario a moverlo en el lugar equivocado.
   */
  function filaStock(sedeId, clave) {
    var inv = stockDe(clave, sedeId);
    if (inv) return inv;

    // Si existe en otra sede se copia de ahi; si no, solo puede ser un vaso.
    var gemela = gemelaDe(clave);
    var base = gemela
      ? { tipo: gemela.tipo, oz: gemela.oz, nombre: gemela.nombre || null,
          unidad: gemela.unidad || null, minimo: gemela.minimo }
      : vasoDesdeClave(clave);
    if (!base) return null;

    return insertar('inventario', {
      sede_id: sedeId, clave: clave, tipo: base.tipo, oz: normOz(base.oz),
      nombre: base.nombre || null, unidad: base.unidad || null,
      stock: 0, minimo: base.minimo === undefined ? 20 : base.minimo
    });
  }

  function anotarMovimiento(sedeId, clave, delta, motivo, refCuenta, nota) {
    var fila = stockDe(clave, sedeId);
    insertar('movimientos', {
      sede_id: sedeId, clave: clave,
      nombre: fila ? etiquetaDe(fila) : clave,
      tipo_vaso: fila ? fila.tipo : 'insumo',
      oz: fila ? normOz(fila.oz) : null,
      delta: delta, motivo: motivo || 'ajuste',
      cuenta_id: refCuenta || null, nota: nota || '',
      fecha: diaNegocio(), created_at: now()
    });
  }

  // delta negativo = salida (venta), positivo = entrada (compra/devolución)
  function moverStock(sedeId, clave, delta, motivo, refCuenta, nota) {
    if (!sedeId || !clave || !delta || !inventarioLocal()) return;
    var inv = filaStock(sedeId, clave);
    if (!inv) return;
    actualizar('inventario', inv.id, { stock: (inv.stock || 0) + delta });
    anotarMovimiento(sedeId, clave, delta, motivo, refCuenta, nota);
  }

  function registrarEntrada(sedeId, clave, cantidad, nota) {
    if (!sedeId) return;
    var inv = filaStock(sedeId, clave);
    var n = Math.abs(Number(cantidad) || 0);
    if (!inv || !n) return;
    actualizar('inventario', inv.id, { stock: (inv.stock || 0) + n });
    anotarMovimiento(sedeId, clave, n, 'compra', null, nota);
    commit(['inventario', 'movimientos']);
  }

  function ajustarStock(sedeId, clave, nuevoValor, nota) {
    if (!sedeId) return;
    var inv = filaStock(sedeId, clave);
    if (!inv) return;
    var delta = Number(nuevoValor) - (inv.stock || 0);
    if (delta === 0) return;
    actualizar('inventario', inv.id, { stock: Number(nuevoValor) });
    anotarMovimiento(sedeId, clave, delta, 'ajuste', null, nota || 'Conteo físico');
    commit(['inventario', 'movimientos']);
  }

  function registrarMerma(sedeId, clave, cantidad, nota) {
    if (!sedeId) return;
    var inv = stockDe(clave, sedeId);
    var n = Math.abs(Number(cantidad) || 0);
    if (!inv || !n) return;
    actualizar('inventario', inv.id, { stock: (inv.stock || 0) - n });
    anotarMovimiento(sedeId, clave, -n, 'merma', null, nota);
    commit(['inventario', 'movimientos']);
  }

  /* ---------- insumos ---------- */

  /* Un insumo nace en TODAS las sedes a la vez, cada una con su propio conteo
   * en cero. Si naciera solo donde se creó, la otra sede no podría registrar
   * sus compras y el insumo parecería inexistente allá.
   */
  function crearInsumo(datos) {
    var nombre = (datos.nombre || '').trim();
    if (!nombre) return null;

    var clave = 'insumo-' + uid();
    var unidad = datos.unidad || 'unidad';
    var minimo = Number(datos.minimo) || 0;

    sedesActivas().forEach(function (sd) {
      insertar('inventario', {
        sede_id: sd.id, clave: clave, tipo: 'insumo', oz: null,
        nombre: nombre, unidad: unidad, stock: 0, minimo: minimo
      });
    });

    commit(['inventario']);
    return clave;
  }

  // El nombre y la unidad son del insumo, no de la sede: cambian en todas.
  function guardarInsumo(clave, datos) {
    vivos('inventario')
      .filter(function (i) { return claveDe(i) === clave; })
      .forEach(function (i) {
        actualizar('inventario', i.id, {
          nombre: (datos.nombre || i.nombre || '').trim(),
          unidad: datos.unidad || i.unidad || 'unidad'
        });
      });
    commit(['inventario']);
  }

  function eliminarInsumo(clave) {
    vivos('inventario')
      .filter(function (i) { return claveDe(i) === clave && i.tipo === 'insumo'; })
      .forEach(function (i) { borrar('inventario', i.id); });
    commit(['inventario']);
  }

  /* Qué productos siguen usando ese vaso. Borrar un vaso que todavía se vende
   * no sirve de nada: la próxima venta lo crea de nuevo, y mientras tanto el
   * descuento queda sin fila donde anotarse.
   */
  function productosQueUsan(clave) {
    return productosActivos().filter(function (p) {
      return p.vaso && claveVaso(p.vaso, p.oz) === clave;
    });
  }

  /* Borra una línea de inventario en TODAS las sedes. Los movimientos ya
   * registrados no se tocan: son historia y deben seguir cuadrando.
   */
  function eliminarLinea(clave) {
    if (productosQueUsan(clave).length) return false;
    var filas = vivos('inventario').filter(function (i) { return claveDe(i) === clave; });
    if (!filas.length) return false;
    filas.forEach(function (i) { borrar('inventario', i.id); });
    commit(['inventario']);
    return true;
  }

  // Traslado entre sedes: sale de una y entra a la otra en un solo gesto,
  // que es como realmente se mueven los vasos entre locales.
  function trasladar(desdeSede, haciaSede, clave, cantidad) {
    var n = Math.abs(Number(cantidad) || 0);
    if (!desdeSede || !haciaSede || desdeSede === haciaSede || !n) return false;

    var origen = filaStock(desdeSede, clave);
    var destino = filaStock(haciaSede, clave);
    if (!origen || !destino) return false;

    actualizar('inventario', origen.id, { stock: (origen.stock || 0) - n });
    anotarMovimiento(desdeSede, clave, -n, 'traslado', null, 'Hacia ' + nombreSede(haciaSede));

    actualizar('inventario', destino.id, { stock: (destino.stock || 0) + n });
    anotarMovimiento(haciaSede, clave, n, 'traslado', null, 'Desde ' + nombreSede(desdeSede));

    commit(['inventario', 'movimientos']);
    return true;
  }

  function fijarMinimo(invId, minimo) {
    actualizar('inventario', invId, { minimo: Number(minimo) || 0 });
    commit(['inventario']);
  }

  function alertasStock(sedeId) {
    return inventario(sedeId).filter(function (i) { return (i.stock || 0) <= (i.minimo || 0); });
  }

  function movimientosDe(fecha, sedeId) {
    return vivos('movimientos')
      .filter(function (m) {
        return (!fecha || m.fecha === fecha) && (!sedeId || m.sede_id === sedeId);
      })
      .sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
  }

  /* ---------- cuentas ---------- */

  function cuentas() { return vivos('cuentas'); }

  function cuentasAbiertas(sedeId) {
    return cuentas()
      .filter(function (c) {
        return c.estado === 'abierta' && (!sedeId || c.sede_id === sedeId);
      })
      .sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
  }

  function cuentasCerradas(fecha, sedeId) {
    return cuentas()
      .filter(function (c) {
        return c.estado === 'cerrada'
          && (!fecha || c.fecha === fecha)
          && (!sedeId || c.sede_id === sedeId);
      })
      .sort(function (a, b) { return (b.closed_at || '').localeCompare(a.closed_at || ''); });
  }

  function crearCuenta(nombre, nota, sedeId) {
    nombre = (nombre || '').trim();
    var sede = sedeId || (sedeActual() && sedeActual().id);
    if (!nombre || !sede) return null;
    var c = insertar('cuentas', {
      nombre: nombre, nota: nota || '', estado: 'abierta',
      sede_id: sede, creada_por: quien(),
      created_at: now(), closed_at: null, fecha: diaNegocio()
    });
    commit(['cuentas']);
    return c;
  }

  function renombrarCuenta(id, nombre, nota) {
    var cambios = { nombre: (nombre || '').trim() };
    if (nota !== undefined) cambios.nota = nota;
    actualizar('cuentas', id, cambios);
    commit(['cuentas']);
  }

  function cerrarCuenta(id) {
    if (saldoCuenta(id) > 0) return false;
    actualizar('cuentas', id, { estado: 'cerrada', closed_at: now() });
    commit(['cuentas']);
    return true;
  }

  function reabrirCuenta(id) {
    actualizar('cuentas', id, { estado: 'abierta', closed_at: null });
    commit(['cuentas']);
  }

  // Cancelar devuelve los vasos al inventario. Solo si no tiene pagos.
  function cancelarCuenta(id) {
    if (pagosDe(id).length > 0) return false;
    itemsDe(id).forEach(function (it) {
      if (it.vaso) moverStock(it.sede_id, claveVaso(it.vaso, it.oz), it.cantidad, 'devolucion', id, 'Cuenta cancelada');
      borrar('items', it.id);
    });
    borrar('cuentas', id);
    commit();
    return true;
  }

  /* ---------- items ---------- */

  function itemsDe(cuentaId) {
    return vivos('items')
      .filter(function (i) { return i.cuenta_id === cuentaId; })
      .sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
  }

  function agregarItem(cuentaId, productoId, cantidad) {
    var p = buscar('productos', productoId);
    var cuenta = buscar('cuentas', cuentaId);
    if (!p || !cuenta) return null;
    cantidad = Math.max(1, Number(cantidad) || 1);

    // Si ya hay una línea igual sin pagar, se acumula en vez de duplicar.
    var existente = itemsDe(cuentaId).filter(function (i) {
      return i.producto_id === productoId && (i.pagadas || 0) === 0 && i.precio === p.precio;
    })[0];

    var it;
    if (existente) {
      it = actualizar('items', existente.id, { cantidad: existente.cantidad + cantidad });
    } else {
      it = insertar('items', {
        cuenta_id: cuentaId, producto_id: productoId, nombre: p.nombre,
        precio: p.precio, cantidad: cantidad, pagadas: 0,
        vaso: p.vaso || null, oz: p.oz || null,
        sede_id: cuenta.sede_id,
        vendido_por: quien(),
        created_at: now(), fecha: diaNegocio()
      });
    }
    if (p.vaso) moverStock(cuenta.sede_id, claveVaso(p.vaso, p.oz), -cantidad, 'venta', cuentaId, p.nombre);
    commit();
    return it;
  }

  // Cambia la cantidad de una línea. No se puede bajar de lo ya pagado.
  function cambiarCantidad(itemId, nuevaCantidad) {
    var it = buscar('items', itemId);
    if (!it) return false;
    nuevaCantidad = Math.max(0, Number(nuevaCantidad) || 0);
    if (nuevaCantidad < (it.pagadas || 0)) return false;

    var delta = nuevaCantidad - it.cantidad;
    if (it.vaso && delta !== 0) {
      moverStock(it.sede_id, claveVaso(it.vaso, it.oz), -delta,
                 delta < 0 ? 'devolucion' : 'venta', it.cuenta_id, it.nombre);
    }
    if (nuevaCantidad === 0) borrar('items', itemId);
    else actualizar('items', itemId, { cantidad: nuevaCantidad });
    commit();
    return true;
  }

  function quitarItem(itemId) { return cambiarCantidad(itemId, 0); }

  /* ---------- pagos ---------- */

  // Dos opciones y nada más: nombrar bancos en la pantalla de cobro solo
  // genera dudas a la hora de marcar el pago.
  var METODOS = ['Efectivo', 'Transferencia'];

  function pagosDe(cuentaId) {
    return vivos('pagos')
      .filter(function (p) { return p.cuenta_id === cuentaId; })
      .sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
  }

  function totalCuenta(id) {
    return itemsDe(id).reduce(function (s, i) { return s + i.precio * i.cantidad; }, 0);
  }

  function pagadoCuenta(id) {
    return pagosDe(id).reduce(function (s, p) { return s + (p.monto || 0); }, 0);
  }

  function saldoCuenta(id) {
    return totalCuenta(id) - pagadoCuenta(id);
  }

  /* Registra un pago.
   * opts = { monto, metodo, quien, nota, cubre: [{item_id, cant}] }
   * Si viene `cubre`, el monto se calcula de los ítems y esas unidades quedan marcadas
   * como pagadas — así se ve quién pagó qué cuando dividen la cuenta.
   */
  function registrarPago(cuentaId, opts) {
    opts = opts || {};
    var cubre = opts.cubre || [];
    var monto = Number(opts.monto) || 0;

    if (cubre.length) {
      monto = 0;
      cubre.forEach(function (c) {
        var it = buscar('items', c.item_id);
        if (!it) { c.cant = 0; return; }
        var disp = it.cantidad - (it.pagadas || 0);
        c.cant = Math.min(Math.max(0, Number(c.cant) || 0), disp);
        monto += it.precio * c.cant;
      });
      cubre = cubre.filter(function (c) { return c.cant > 0; });
      if (!cubre.length) return null;
    }

    if (monto <= 0) return null;

    var cuenta = buscar('cuentas', cuentaId);
    var pago = insertar('pagos', {
      cuenta_id: cuentaId, monto: monto,
      sede_id: cuenta ? cuenta.sede_id : null,
      metodo: opts.metodo || 'Efectivo',
      quien: (opts.quien || '').trim(),
      nota: opts.nota || '',
      cubre: cubre,
      cobrado_por: quien(),
      created_at: now(), fecha: diaNegocio()
    });

    cubre.forEach(function (c) {
      var it = buscar('items', c.item_id);
      if (it) actualizar('items', it.id, { pagadas: (it.pagadas || 0) + c.cant });
    });

    // Si quedó saldada, se cierra sola.
    if (saldoCuenta(cuentaId) <= 0) {
      actualizar('cuentas', cuentaId, { estado: 'cerrada', closed_at: now() });
    }
    commit();
    return pago;
  }

  function anularPago(pagoId) {
    var p = buscar('pagos', pagoId);
    if (!p) return false;
    (p.cubre || []).forEach(function (c) {
      var it = buscar('items', c.item_id);
      if (it) actualizar('items', it.id, { pagadas: Math.max(0, (it.pagadas || 0) - c.cant) });
    });
    borrar('pagos', pagoId);
    var c = buscar('cuentas', p.cuenta_id);
    if (c && c.estado === 'cerrada') actualizar('cuentas', c.id, { estado: 'abierta', closed_at: null });
    commit();
    return true;
  }

  /* ---------- resumen del día ---------- */

  // sedeId vacío = consolidado de todas las sedes.
  function resumen(fecha, sedeId) {
    fecha = fecha || diaNegocio();

    var itemsDia = vivos('items').filter(function (i) {
      return i.fecha === fecha && (!sedeId || i.sede_id === sedeId);
    });
    var pagosDia = vivos('pagos').filter(function (p) {
      return p.fecha === fecha && (!sedeId || p.sede_id === sedeId);
    });

    var vendido = itemsDia.reduce(function (s, i) { return s + i.precio * i.cantidad; }, 0);
    var recaudado = pagosDia.reduce(function (s, p) { return s + p.monto; }, 0);

    var porMetodo = {};
    pagosDia.forEach(function (p) {
      porMetodo[p.metodo] = (porMetodo[p.metodo] || 0) + p.monto;
    });

    var porProducto = {};
    itemsDia.forEach(function (i) {
      if (!porProducto[i.nombre]) porProducto[i.nombre] = { nombre: i.nombre, cant: 0, total: 0 };
      porProducto[i.nombre].cant += i.cantidad;
      porProducto[i.nombre].total += i.precio * i.cantidad;
    });

    var porVendedor = {};
    pagosDia.forEach(function (p) {
      var k = p.cobrado_por || 'Sin registrar';
      porVendedor[k] = (porVendedor[k] || 0) + p.monto;
    });

    var vasosUsados = {};
    itemsDia.forEach(function (i) {
      if (!i.vaso) return;
      var k = claveVaso(i.vaso, i.oz);
      if (!vasosUsados[k]) vasosUsados[k] = { etiqueta: etiquetaVaso(i.vaso, i.oz), cant: 0 };
      vasosUsados[k].cant += i.cantidad;
    });

    // Deuda viva: todo lo que sigue sin pagarse, sin importar el día en que se pidió.
    var pendientes = cuentasAbiertas(sedeId)
      .map(function (c) { return { cuenta: c, saldo: saldoCuenta(c.id) }; })
      .filter(function (x) { return x.saldo > 0; })
      .sort(function (a, b) { return b.saldo - a.saldo; });

    var clientes = {};
    itemsDia.forEach(function (i) { clientes[i.cuenta_id] = true; });

    // Comparar sedes es la razón de ser de tener varias: siempre va el desglose.
    var porSede = {};
    sedes().forEach(function (sd) {
      porSede[sd.id] = { nombre: sd.nombre, vendido: 0, recaudado: 0 };
    });
    itemsDia.forEach(function (i) {
      if (porSede[i.sede_id]) porSede[i.sede_id].vendido += i.precio * i.cantidad;
    });
    pagosDia.forEach(function (p) {
      if (porSede[p.sede_id]) porSede[p.sede_id].recaudado += p.monto;
    });

    return {
      fecha: fecha,
      sedeId: sedeId || null,
      porSede: Object.keys(porSede)
        .map(function (k) { return porSede[k]; })
        .filter(function (x) { return x.vendido || x.recaudado; })
        .sort(function (a, b) { return b.recaudado - a.recaudado; }),
      vendido: vendido,
      recaudado: recaudado,
      porCobrar: pendientes.reduce(function (s, x) { return s + x.saldo; }, 0),
      transacciones: pagosDia.length,
      clientes: Object.keys(clientes).length,
      ticketPromedio: Object.keys(clientes).length ? Math.round(vendido / Object.keys(clientes).length) : 0,
      porMetodo: porMetodo,
      porVendedor: porVendedor,
      porProducto: Object.keys(porProducto)
        .map(function (k) { return porProducto[k]; })
        .sort(function (a, b) { return b.total - a.total; }),
      vasosUsados: vasosUsados,
      pendientes: pendientes
    };
  }

  /* Línea de tiempo del día: ventas y cobros mezclados, lo más nuevo primero.
   * Es lo que el dueño mira cuando no está parado en el mostrador.
   */
  function actividad(fecha, limite, sedeId) {
    fecha = fecha || diaNegocio();
    var eventos = [];
    var delTurno = function (r) {
      return r.fecha === fecha && (!sedeId || r.sede_id === sedeId);
    };

    vivos('items').filter(delTurno).forEach(function (i) {
      var c = buscar('cuentas', i.cuenta_id);
      eventos.push({
        tipo: 'venta',
        cuando: i.created_at,
        cliente: c ? c.nombre : 'Sin cuenta',
        detalle: i.cantidad + ' × ' + i.nombre,
        monto: i.precio * i.cantidad,
        quien: i.vendido_por || '',
        sede: nombreSede(i.sede_id)
      });
    });

    vivos('pagos').filter(delTurno).forEach(function (p) {
      var c = buscar('cuentas', p.cuenta_id);
      eventos.push({
        tipo: 'pago',
        cuando: p.created_at,
        cliente: c ? c.nombre : 'Sin cuenta',
        detalle: 'Pagó en ' + p.metodo.toLowerCase() + (p.quien ? ' · ' + p.quien : ''),
        monto: p.monto,
        quien: p.cobrado_por || '',
        sede: nombreSede(p.sede_id)
      });
    });

    eventos.sort(function (a, b) { return (b.cuando || '').localeCompare(a.cuando || ''); });
    return limite ? eventos.slice(0, limite) : eventos;
  }

  function fechasConMovimiento() {
    var set = {};
    vivos('items').forEach(function (i) { if (i.fecha) set[i.fecha] = true; });
    vivos('pagos').forEach(function (p) { if (p.fecha) set[p.fecha] = true; });
    var hoy = diaNegocio();
    set[hoy] = true;
    return Object.keys(set).sort().reverse();
  }

  /* ---------- respaldo ---------- */

  function exportar() {
    var out = { _app: 'NOVA POS', _version: 1, _exportado: now() };
    TABLAS.forEach(function (t) { out[t] = state[t]; });
    return JSON.stringify(out, null, 2);
  }

  function importar(json, modo) {
    var data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || data._app !== 'NOVA POS') throw new Error('El archivo no es un respaldo de NOVA POS.');
    TABLAS.forEach(function (t) {
      if (!Array.isArray(data[t])) return;
      if (modo === 'reemplazar') {
        state[t] = data[t].map(function (r) { r._dirty = true; return r; });
      } else {
        data[t].forEach(function (r) { fusionar(t, r); });
      }
    });
    commit();
  }

  // Usado por importar y por la sincronización: gana el que tenga updated_at más nuevo.
  function fusionar(tabla, remoto) {
    if (!state[tabla]) return false;
    var local = buscar(tabla, remoto.id);
    if (!local) { state[tabla].push(remoto); return true; }
    if ((remoto.updated_at || '') > (local.updated_at || '')) {
      state[tabla][state[tabla].indexOf(local)] = remoto;
      return true;
    }
    return false;
  }

  function sucios(tabla) {
    return (state[tabla] || []).filter(function (r) { return r._dirty; });
  }

  function limpiarSucios(tabla, ids) {
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    (state[tabla] || []).forEach(function (r) { if (set[r.id]) delete r._dirty; });
    guardarTabla(tabla);
  }

  function aplicarRemotos(tabla, filas) {
    var hubo = false;
    filas.forEach(function (f) { if (fusionar(tabla, f)) hubo = true; });
    if (hubo) { guardarTabla(tabla); emitir(); }
    return hubo;
  }

  /* ---------- reconciliacion con el servidor ---------- */

  /* Quita filas locales sin avisarle al servidor. A diferencia de borrar(),
   * no las marca como borradas: desaparecen de este celular y punto, porque
   * son copias de algo que ya existe alla con otro id.
   */
  function descartarLocal(tabla, ids) {
    var fuera = {};
    ids.forEach(function (id) { fuera[id] = true; });
    state[tabla] = (state[tabla] || []).filter(function (r) { return !fuera[r.id]; });
    guardarTabla(tabla);
  }

  // Dónde se guarda una referencia a cada tabla, para repuntarla al id bueno.
  var REFERENCIAS = {
    productos: [['items', 'producto_id']],
    sedes: [['cuentas', 'sede_id'], ['items', 'sede_id'], ['pagos', 'sede_id'],
            ['inventario', 'sede_id'], ['movimientos', 'sede_id']]
  };

  /* Junta las filas de `tabla` que comparten nombre y deja una sola: gana la
   * que vino del servidor, porque es la que el resto de los celulares ya
   * conoce. Las referencias se repuntan a ella.
   */
  function reconciliarPorNombre(tabla) {
    var grupos = {};
    (state[tabla] || []).forEach(function (r) {
      if (r.deleted) return;
      var k = (r.nombre || '').trim().toLowerCase();
      if (!k) return;
      (grupos[k] = grupos[k] || []).push(r);
    });

    var mapa = {}, sobran = [];
    Object.keys(grupos).forEach(function (k) {
      var g = grupos[k];
      if (g.length < 2) return;
      // La fila ya subida no tiene marca de pendiente: esa es la del servidor.
      var bueno = g.filter(function (r) { return !r._dirty; })[0] || g[0];
      g.forEach(function (r) {
        if (r.id === bueno.id) return;
        mapa[r.id] = bueno.id;
        sobran.push(r.id);
      });
    });

    if (!sobran.length) return 0;

    (REFERENCIAS[tabla] || []).forEach(function (par) {
      var otra = par[0], campo = par[1];
      (state[otra] || []).forEach(function (r) {
        if (mapa[r[campo]]) { r[campo] = mapa[r[campo]]; r._dirty = true; }
        });
      guardarTabla(otra);
    });

    // La sede elegida en este celular puede ser una de las descartadas.
    if (tabla === 'sedes') {
      var actual = localStorage.getItem(SEDE_KEY);
      if (actual && mapa[actual]) localStorage.setItem(SEDE_KEY, mapa[actual]);
    }

    descartarLocal(tabla, sobran);
    return sobran.length;
  }

  /* El inventario no se identifica por nombre sino por (sede, clave), que es
   * justo la unicidad que impone el servidor.
   */
  function reconciliarInventario() {
    var grupos = {};
    (state.inventario || []).forEach(function (r) {
      if (r.deleted || !r.sede_id) return;
      var k = r.sede_id + '|' + claveDe(r);
      (grupos[k] = grupos[k] || []).push(r);
    });

    var sobran = [];
    Object.keys(grupos).forEach(function (k) {
      var g = grupos[k];
      if (g.length < 2) return;
      var bueno = g.filter(function (r) { return !r._dirty; })[0] || g[0];

      g.forEach(function (r) {
        if (r.id === bueno.id) return;
        // Si se contó stock en el celular antes de conectar, ese número es el
        // real: la fila del servidor viene en cero y hay que conservarlo.
        if ((r.stock || 0) !== 0 && (bueno.stock || 0) === 0) {
          actualizar('inventario', bueno.id, { stock: r.stock, minimo: r.minimo });
        }
        sobran.push(r.id);
      });
    });

    if (!sobran.length) return 0;
    descartarLocal('inventario', sobran);
    return sobran.length;
  }

  /* Se corre al sincronizar. Devuelve cuántas filas se limpiaron. */
  function reconciliar() {
    var n = reconciliarPorNombre('productos') + reconciliarPorNombre('sedes');
    n += reconciliarInventario();

    // Inventario y movimientos de antes de que existieran las sedes: sin sede
    // no se pueden ubicar, y el servidor ya tiene las filas buenas.
    ['inventario', 'movimientos'].forEach(function (t) {
      var huerfanas = (state[t] || [])
        .filter(function (r) { return !r.sede_id; })
        .map(function (r) { return r.id; });
      if (huerfanas.length) {
        descartarLocal(t, huerfanas);
        n += huerfanas.length;
      }
    });

    if (n) emitir();
    return n;
  }

  function hayPendientesDeSync() {
    return TABLAS.some(function (t) { return sucios(t).length > 0; });
  }

  /* En el celular del ayudante no debe quedar historial. El servidor ya deja de
   * entregárselo, pero lo que bajó cuando era "hoy" sigue en su teléfono: esto
   * lo borra. Se conserva lo del turno actual, las cuentas que sigan abiertas
   * (tiene que poder cobrarlas) y lo que todavía no se haya subido.
   */
  function purgarHistorial() {
    var hoy = diaNegocio();
    var cuentasVivas = {};

    state.cuentas = (state.cuentas || []).filter(function (c) {
      var delTurno = (c.fecha || '') >= hoy || c.estado === 'abierta';
      if (delTurno || c._dirty) { cuentasVivas[c.id] = true; return true; }
      return false;
    });

    ['items', 'pagos'].forEach(function (t) {
      state[t] = (state[t] || []).filter(function (r) {
        return r._dirty || (r.fecha || '') >= hoy || cuentasVivas[r.cuenta_id];
      });
    });

    ['cuentas', 'items', 'pagos'].forEach(guardarTabla);
    emitir();
  }

  // Al cerrar sesión un ayudante no debe dejar datos del negocio en ese celular.
  function limpiarTodo() {
    TABLAS.forEach(function (t) {
      state[t] = [];
      localStorage.removeItem(LS + t);
    });
    emitir();
  }

  /* ---------- API pública ---------- */

  cargar();

  global.NOVA = global.NOVA || {};
  global.NOVA.store = {
    TABLAS: TABLAS, TABLAS_SOLO_DUENO: TABLAS_SOLO_DUENO,
    VASOS: VASOS, METODOS: METODOS, NOMBRE_VASO: NOMBRE_VASO, UNIDADES: UNIDADES,
    normOz: normOz, claveVaso: claveVaso, etiquetaVaso: etiquetaVaso,
    claveDe: claveDe, etiquetaDe: etiquetaDe,
    uid: uid, now: now, money: money, diaNegocio: diaNegocio,
    suscribir: function (fn) { listeners.push(fn); },
    recargar: function () { cargar(); emitir(); },
    sembrar: sembrar,
    raw: function (t) { return state[t]; },
    vivos: vivos, buscar: buscar,

    productos: productos, productosActivos: productosActivos,
    guardarProducto: guardarProducto, eliminarProducto: eliminarProducto,

    sedes: sedes, sedesActivas: sedesActivas, sedeActual: sedeActual,
    fijarSede: fijarSede, olvidarSede: olvidarSede, nombreSede: nombreSede,
    guardarSede: guardarSede,

    inventario: inventario, vasos: vasos, insumos: insumos, stockDe: stockDe,
    registrarEntrada: registrarEntrada,
    ajustarStock: ajustarStock, registrarMerma: registrarMerma,
    crearInsumo: crearInsumo, guardarInsumo: guardarInsumo, eliminarInsumo: eliminarInsumo,
    eliminarLinea: eliminarLinea, productosQueUsan: productosQueUsan,
    trasladar: trasladar,
    fijarMinimo: fijarMinimo, alertasStock: alertasStock, movimientosDe: movimientosDe,

    cuentas: cuentas, cuentasAbiertas: cuentasAbiertas, cuentasCerradas: cuentasCerradas,
    crearCuenta: crearCuenta, renombrarCuenta: renombrarCuenta, cerrarCuenta: cerrarCuenta,
    reabrirCuenta: reabrirCuenta, cancelarCuenta: cancelarCuenta,

    itemsDe: itemsDe, agregarItem: agregarItem,
    cambiarCantidad: cambiarCantidad, quitarItem: quitarItem,

    pagosDe: pagosDe, registrarPago: registrarPago, anularPago: anularPago,
    totalCuenta: totalCuenta, pagadoCuenta: pagadoCuenta, saldoCuenta: saldoCuenta,

    resumen: resumen, actividad: actividad, fechasConMovimiento: fechasConMovimiento,
    exportar: exportar, importar: importar,
    limpiarTodo: limpiarTodo, purgarHistorial: purgarHistorial,

    sucios: sucios, limpiarSucios: limpiarSucios, aplicarRemotos: aplicarRemotos,
    reconciliar: reconciliar, descartarLocal: descartarLocal,
    hayPendientesDeSync: hayPendientesDeSync
  };
})(window);
