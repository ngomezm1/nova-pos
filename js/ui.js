/* NOVA POS — interfaz. Render completo en cada cambio: el volumen de datos de un
 * turno de ventas es chico y así nunca queda una pantalla desfasada del dato real.
 */
(function (global) {
  'use strict';

  var S = NOVA.store;
  var C = NOVA.cloud;

  var vista = { pantalla: 'cuentas', cuentaId: null, fechaResumen: null, verCerradas: false };
  var app, hojaAbierta = null;

  /* ---------- utilidades de DOM ---------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function $(sel, raiz) { return (raiz || document).querySelector(sel); }
  function $$(sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2300);
  }

  function hora(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
  }

  function haceRato(iso) {
    if (!iso) return '';
    var min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return 'hace ' + min + ' min';
    var h = Math.floor(min / 60);
    if (h < 24) return 'hace ' + h + ' h';
    return 'hace ' + Math.floor(h / 24) + ' d';
  }

  function fechaLarga(f) {
    var p = f.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function plural(n, uno, varios) {
    return n + ' ' + (n === 1 ? uno : varios);
  }

  function iniciales(nombre) {
    var p = (nombre || '?').trim().split(/\s+/);
    return ((p[0] || '')[0] + (p.length > 1 ? (p[1] || '')[0] : '')).toUpperCase();
  }

  /* ---------- hoja modal ---------- */

  function abrirHoja(html, alMontar) {
    cerrarHoja();
    var velo = document.createElement('div');
    velo.className = 'velo';
    velo.innerHTML = '<div class="hoja"><div class="hoja__agarre"></div>' + html + '</div>';
    velo.addEventListener('click', function (e) { if (e.target === velo) cerrarHoja(); });
    document.body.appendChild(velo);
    document.body.style.overflow = 'hidden';
    hojaAbierta = velo;
    if (alMontar) alMontar($('.hoja', velo), velo);
    return velo;
  }

  function cerrarHoja() {
    if (hojaAbierta) { hojaAbierta.remove(); hojaAbierta = null; }
    document.body.style.overflow = '';
  }

  function confirmar(titulo, texto, textoBoton, claseBoton) {
    return new Promise(function (resolve) {
      abrirHoja(
        '<h2>' + esc(titulo) + '</h2><p class="sub">' + esc(texto) + '</p>' +
        '<div class="fila-btn mt">' +
          '<button class="btn btn--fantasma" data-no>Cancelar</button>' +
          '<button class="btn ' + (claseBoton || 'btn--primario') + '" data-si>' + esc(textoBoton || 'Confirmar') + '</button>' +
        '</div>',
        function (h) {
          $('[data-no]', h).onclick = function () { cerrarHoja(); resolve(false); };
          $('[data-si]', h).onclick = function () { cerrarHoja(); resolve(true); };
        }
      );
    });
  }

  /* ---------- iconos ---------- */

  var ICO = {
    cuentas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    caja: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3"/><path d="M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M10 12h4"/></svg>',
    grafico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
    ajustes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    atras: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'
  };

  /* =========================================================
     LOGIN
     ========================================================= */

  function pantallaLogin(mensaje, tipoMensaje) {
    document.body.innerHTML =
      '<div class="login">' +
        '<img src="assets/logo.jpg" alt="NOVA">' +
        '<h1>NOVA POS</h1>' +
        '<p class="lema">Granizados · Cócteles · Micheladas<br>Medellín</p>' +
        (mensaje ? '<div class="aviso aviso--' + (tipoMensaje || 'error') + '">' + esc(mensaje) + '</div>' : '') +
        '<form id="fLogin">' +
          '<div class="campo"><label>Correo</label>' +
            '<input type="email" id="email" autocomplete="username" required inputmode="email" placeholder="tu@correo.com"></div>' +
          '<div class="campo"><label>Contraseña</label>' +
            '<input type="password" id="pass" autocomplete="current-password" required placeholder="••••••••"></div>' +
          '<button class="btn btn--primario btn--bloque" type="submit" id="bEntrar">Entrar</button>' +
        '</form>' +
        '<button class="btn btn--fantasma btn--chico mt-lg" id="bReconfig">Cambiar conexión del servidor</button>' +
      '</div>';

    $('#fLogin').onsubmit = function (e) {
      e.preventDefault();
      var b = $('#bEntrar');
      b.disabled = true; b.textContent = 'Entrando…';
      C.entrar($('#email').value, $('#pass').value)
        .then(function () { arrancarApp(); })
        .catch(function (err) { pantallaLogin(err.message, 'error'); });
    };

    $('#bReconfig').onclick = function () {
      confirmar('¿Desconectar del servidor?',
        'La app vuelve a modo local en este celular. Los datos que ya se subieron al servidor no se borran.',
        'Desconectar', 'btn--peligro')
        .then(function (ok) {
          if (!ok) return;
          C.borrarCfg();
          S.limpiarTodo();
          location.reload();
        });
    };
  }

  /* =========================================================
     ARMADO GENERAL
     ========================================================= */

  function arrancarApp() {
    S.sembrar();
    document.body.innerHTML =
      '<div id="app">' +
        '<header class="cabecera"></header>' +
        '<main id="main"></main>' +
      '</div>' +
      '<nav class="nav" id="nav"></nav>';
    app = $('#app');
    render();
  }

  function pestanas() {
    var t = [{ id: 'cuentas', txt: 'Cuentas', ico: ICO.cuentas }];
    if (NOVA.sesion.esDueno()) {
      t.push({ id: 'inventario', txt: 'Inventario', ico: ICO.caja });
      t.push({ id: 'resumen', txt: 'Resumen', ico: ICO.grafico });
    } else {
      t.push({ id: 'resumen', txt: 'Mi turno', ico: ICO.grafico });
    }
    t.push({ id: 'ajustes', txt: 'Ajustes', ico: ICO.ajustes });
    return t;
  }

  function render() {
    if (!app) return;
    renderCabecera();
    renderNav();

    var m = $('#main');
    m.innerHTML = '';
    $$('.fab').forEach(function (f) { f.remove(); });

    if (vista.pantalla === 'cuenta' && vista.cuentaId) {
      var c = S.buscar('cuentas', vista.cuentaId);
      if (!c || c.deleted) { vista.pantalla = 'cuentas'; vista.cuentaId = null; return render(); }
      pantallaCuenta(m, c);
      return;
    }

    switch (vista.pantalla) {
      case 'inventario': pantallaInventario(m); break;
      case 'resumen':    pantallaResumen(m); break;
      case 'ajustes':    pantallaAjustes(m); break;
      default:           pantallaCuentas(m);
    }
  }

  function renderCabecera() {
    var h = $('.cabecera');
    var abiertas = S.cuentasAbiertas().filter(function (c) { return S.saldoCuenta(c.id) > 0; });
    var porCobrar = abiertas.reduce(function (s, c) { return s + S.saldoCuenta(c.id); }, 0);

    if (vista.pantalla === 'cuenta') {
      var c = S.buscar('cuentas', vista.cuentaId) || {};
      h.innerHTML =
        '<button class="btn btn--fantasma btn--chico" id="bAtras" style="min-height:40px;width:40px;padding:0">' + ICO.atras + '</button>' +
        '<div class="cabecera__txt"><h1>' + esc(c.nombre || '') + '</h1>' +
        '<p>Abierta ' + haceRato(c.created_at) + (c.creada_por ? ' · ' + esc(c.creada_por) : '') + '</p></div>';
      $('#bAtras').onclick = function () { vista.pantalla = 'cuentas'; vista.cuentaId = null; render(); };
      return;
    }

    h.innerHTML =
      '<img class="cabecera__logo" src="assets/logo.jpg" alt="NOVA">' +
      '<div class="cabecera__txt"><h1>NOVA POS</h1>' +
      '<p>' + (C.configurado()
        ? esc(NOVA.sesion.nombre()) + ' · ' + (NOVA.sesion.esDueno() ? 'Dueño' : 'Ayudante')
        : 'Solo este celular') +
        (porCobrar > 0 ? ' · por cobrar ' + S.money(porCobrar) : '') +
      '</p></div>' +
      badgeSync();
  }

  function badgeSync() {
    if (!C.configurado()) return '<span class="sync" title="Modo local"><span class="punto"></span>Local</span>';
    var e = C.estado();
    var txt = { conectado: 'En línea', conectando: 'Conectando', offline: 'Sin red', error: 'Error', local: 'Local' }[e] || e;
    if (e === 'conectado' && S.hayPendientesDeSync()) txt = 'Subiendo…';
    return '<span class="sync ' + e + '" title="' + esc(C.error() || txt) + '"><span class="punto"></span>' + txt + '</span>';
  }

  function renderNav() {
    var n = $('#nav');
    var pendientes = S.cuentasAbiertas().filter(function (c) { return S.saldoCuenta(c.id) > 0; }).length;
    var activa = vista.pantalla === 'cuenta' ? 'cuentas' : vista.pantalla;

    n.innerHTML = pestanas().map(function (t) {
      var globo = t.id === 'cuentas' && pendientes ? '<span class="globo">' + pendientes + '</span>' : '';
      return '<button data-tab="' + t.id + '" class="' + (activa === t.id ? 'on' : '') + '">' +
             t.ico + globo + '<span>' + t.txt + '</span></button>';
    }).join('');

    $$('button', n).forEach(function (b) {
      b.onclick = function () {
        vista.pantalla = b.dataset.tab;
        vista.cuentaId = null;
        window.scrollTo(0, 0);
        render();
      };
    });
  }

  /* =========================================================
     CUENTAS
     ========================================================= */

  function pantallaCuentas(m) {
    var abiertas = S.cuentasAbiertas();
    var hoy = S.diaNegocio();

    if (!abiertas.length) {
      m.innerHTML =
        '<div class="vacio mt-lg"><span class="emoji">🛸</span>' +
        '<strong>No hay cuentas abiertas</strong>' +
        '<p>Tocá <b>Nueva cuenta</b> y escribí el nombre<br>de quien está pidiendo.</p></div>';
    } else {
      var conSaldo = abiertas.filter(function (c) { return S.saldoCuenta(c.id) > 0; });
      var enCero = abiertas.filter(function (c) { return S.saldoCuenta(c.id) <= 0; });

      m.innerHTML =
        (conSaldo.length ? '<div class="titulo-seccion">Deben (' + conSaldo.length + ')</div>' +
          conSaldo.map(filaCuenta).join('') : '') +
        (enCero.length ? '<div class="titulo-seccion">Al día (' + enCero.length + ')</div>' +
          enCero.map(filaCuenta).join('') : '');
    }

    var cerradas = S.cuentasCerradas(hoy);
    if (cerradas.length) {
      m.innerHTML +=
        '<div class="titulo-seccion">Cerradas hoy (' + cerradas.length + ')</div>' +
        '<button class="btn btn--fantasma btn--bloque btn--chico" id="bVerCerradas">' +
          (vista.verCerradas ? 'Ocultar'
            : (cerradas.length === 1 ? 'Ver la cuenta cerrada hoy'
                                     : 'Ver las ' + cerradas.length + ' cuentas cerradas hoy')) + '</button>' +
        (vista.verCerradas ? '<div class="mt">' + cerradas.map(filaCuenta).join('') + '</div>' : '');
    }

    $$('[data-cuenta]', m).forEach(function (el) {
      el.onclick = function () {
        vista.pantalla = 'cuenta';
        vista.cuentaId = el.dataset.cuenta;
        window.scrollTo(0, 0);
        render();
      };
    });

    if ($('#bVerCerradas')) {
      $('#bVerCerradas').onclick = function () { vista.verCerradas = !vista.verCerradas; render(); };
    }

    var fab = document.createElement('button');
    fab.className = 'fab';
    fab.innerHTML = '<span style="font-size:22px;line-height:1">+</span> Nueva cuenta';
    fab.onclick = nuevaCuenta;
    document.body.appendChild(fab);
  }

  function filaCuenta(c) {
    var saldo = S.saldoCuenta(c.id);
    var total = S.totalCuenta(c.id);
    var pagado = S.pagadoCuenta(c.id);
    var items = S.itemsDe(c.id);
    var nVasos = items.reduce(function (s, i) { return s + i.cantidad; }, 0);

    var meta = nVasos ? plural(nVasos, 'vaso', 'vasos') : 'Sin pedidos';
    // Si ya abonó, ese dato vale más que la hora: es lo que define cuánto falta.
    meta += pagado > 0 && saldo > 0
      ? ' · abonó ' + S.money(pagado)
      : ' · ' + haceRato(c.created_at);
    if (c.estado === 'cerrada') meta = 'Cerrada ' + hora(c.closed_at) + ' · ' + S.money(total);

    return '<button class="cuenta' + (saldo <= 0 ? ' cuenta--saldada' : '') + '" data-cuenta="' + c.id + '">' +
      '<span class="cuenta__ini">' + esc(iniciales(c.nombre)) + '</span>' +
      '<span class="cuenta__cuerpo">' +
        '<span class="cuenta__nombre">' + esc(c.nombre) + '</span>' +
        '<span class="cuenta__meta">' + esc(meta) + '</span>' +
      '</span>' +
      '<span class="cuenta__saldo' + (saldo <= 0 ? ' ok' : '') + '">' +
        (saldo > 0 ? S.money(saldo) : '✓') +
        '<small>' + (saldo > 0 ? 'debe' : 'al día') + '</small>' +
      '</span></button>';
  }

  function nuevaCuenta() {
    abrirHoja(
      '<h2>Nueva cuenta</h2><p class="sub">Un nombre que reconozcas: el del cliente, o algo como “Gorra roja”.</p>' +
      '<div class="campo"><label>Nombre</label>' +
        '<input id="nNombre" autocomplete="off" autocapitalize="words" placeholder="Ej: Andrés" maxlength="40"></div>' +
      '<div class="campo"><label>Nota (opcional)</label>' +
        '<input id="nNota" autocomplete="off" placeholder="Ej: mesa de la esquina, grupo de 4"></div>' +
      '<button class="btn btn--primario btn--bloque" id="bCrear">Abrir cuenta</button>',
      function (h) {
        var inp = $('#nNombre', h);
        setTimeout(function () { inp.focus(); }, 120);
        function crear() {
          var c = S.crearCuenta(inp.value, $('#nNota', h).value);
          if (!c) { inp.focus(); return toast('Escribí un nombre'); }
          cerrarHoja();
          vista.pantalla = 'cuenta';
          vista.cuentaId = c.id;
          window.scrollTo(0, 0);
          render();
        }
        $('#bCrear', h).onclick = crear;
        inp.onkeydown = function (e) { if (e.key === 'Enter') crear(); };
      }
    );
  }

  /* =========================================================
     DETALLE DE CUENTA
     ========================================================= */

  function pantallaCuenta(m, c) {
    var items = S.itemsDe(c.id);
    var pagos = S.pagosDe(c.id);
    var total = S.totalCuenta(c.id);
    var pagado = S.pagadoCuenta(c.id);
    var saldo = total - pagado;

    var html =
      '<div class="saldo-hero">' +
        '<div class="rotulo">' + (saldo > 0 ? 'Debe' : 'Cuenta al día') + '</div>' +
        '<div class="monto' + (saldo <= 0 ? ' ok' : '') + '">' + S.money(Math.max(0, saldo)) + '</div>' +
        (pagado > 0
          ? '<div class="desglose">Consumo ' + S.money(total) + ' · abonado ' + S.money(pagado) + '</div>'
          : (total > 0 ? '<div class="desglose">' + items.reduce(function (s, i) { return s + i.cantidad; }, 0) + ' vasos</div>' : '')) +
      '</div>';

    if (total > 0) {
      html += '<div class="fila-btn">';
      if (saldo > 0) {
        html += '<button class="btn btn--exito" id="bCobrar">Cobrar</button>';
        if (items.length > 1 || items.some(function (i) { return i.cantidad > 1; })) {
          html += '<button class="btn" id="bDividir">Dividir</button>';
        }
      } else if (c.estado === 'abierta') {
        html += '<button class="btn btn--exito" id="bCerrar">Cerrar cuenta</button>';
      } else {
        html += '<button class="btn btn--fantasma" id="bReabrir">Reabrir cuenta</button>';
      }
      html += '</div>';
    }

    if (items.length) {
      html += '<div class="titulo-seccion">Consumo</div><div class="tarjeta">' +
        items.map(function (i) {
          var pag = i.pagadas || 0;
          var etiqueta = pag >= i.cantidad
            ? ' <span class="etiqueta etiqueta--pagado">pagado</span>'
            : (pag > 0 ? ' <span class="etiqueta etiqueta--parcial">' + pag + ' de ' + i.cantidad + ' pagos</span>' : '');
          return '<div class="item">' +
            '<div class="pasos">' +
              '<button data-menos="' + i.id + '"' + (i.cantidad <= pag ? ' disabled' : '') + '>−</button>' +
              '<span class="n">' + i.cantidad + '</span>' +
              '<button data-mas="' + i.id + '">+</button>' +
            '</div>' +
            '<div class="item__cuerpo">' +
              '<div class="item__nombre">' + esc(i.nombre) + etiqueta + '</div>' +
              '<div class="item__meta">' + S.money(i.precio) + ' c/u · ' + hora(i.created_at) +
                (i.vendido_por ? ' · ' + esc(i.vendido_por) : '') + '</div>' +
            '</div>' +
            '<div class="item__total">' + S.money(i.precio * i.cantidad) + '</div>' +
          '</div>';
        }).join('') +
        '<div class="item" style="border-top:1px solid var(--linea);padding-top:13px;margin-top:4px">' +
          '<div class="item__cuerpo"><b>Total consumo</b></div>' +
          '<div class="item__total" style="font-size:18px">' + S.money(total) + '</div>' +
        '</div>' +
      '</div>';
    }

    if (pagos.length) {
      html += '<div class="titulo-seccion">Pagos recibidos</div><div class="tarjeta">' +
        pagos.map(function (p) {
          return '<div class="item">' +
            '<div class="item__cuerpo">' +
              '<div class="item__nombre">' + S.money(p.monto) + ' · ' + esc(p.metodo) + '</div>' +
              '<div class="item__meta">' + hora(p.created_at) +
                (p.quien ? ' · pagó ' + esc(p.quien) : '') +
                ((p.cubre && p.cubre.length) ? ' · por ítems' : '') +
                (p.nota ? ' · ' + esc(p.nota) : '') + '</div>' +
            '</div>' +
            '<button class="btn btn--chico btn--peligro btn--fantasma" data-anular="' + p.id + '">Anular</button>' +
          '</div>';
        }).join('') + '</div>';
    }

    // Grilla de productos, agrupada por categoría.
    html += '<div class="titulo-seccion">Agregar al pedido</div>';
    var prods = S.productosActivos();
    var cats = [
      { id: 'cremoso', txt: 'Granizados cremosos' },
      { id: 'original', txt: 'Granizados originales' },
      { id: 'michelada', txt: 'Micheladas' },
      { id: 'coctel', txt: 'Cócteles' },
      { id: 'otro', txt: 'Otros' }
    ];
    cats.forEach(function (cat) {
      var lista = prods.filter(function (p) { return (p.categoria || 'otro') === cat.id; });
      if (!lista.length) return;
      html += '<div class="grupo-prod"><div class="chico" style="margin:0 2px 7px">' + cat.txt + '</div>' +
        '<div class="grilla">' + lista.map(function (p) {
          return '<button class="prod" data-prod="' + p.id + '">' +
            (p.oz ? '<div class="prod__oz">' + p.oz + ' oz</div>' : '<div class="prod__oz" style="font-size:15px">' + esc(p.nombre) + '</div>') +
            (p.oz ? '<div class="prod__nombre">' + esc(p.nombre.replace(/\s*\d+\s*oz$/i, '')) + '</div>' : '') +
            '<div class="prod__precio' + (p.precio > 0 ? '' : ' sin') + '">' +
              (p.precio > 0 ? S.money(p.precio) : 'Definí el precio') + '</div>' +
            (p.vaso ? '<div class="prod__eco">' + (p.vaso === 'icopor' ? 'icopor' : 'plást.') + '</div>' : '') +
          '</button>';
        }).join('') + '</div></div>';
    });

    html += '<div class="titulo-seccion">Opciones</div>' +
      '<button class="btn btn--fantasma btn--bloque btn--chico" id="bRenombrar">Cambiar nombre o nota</button>' +
      (pagos.length === 0
        ? '<button class="btn btn--fantasma btn--peligro btn--bloque btn--chico mt">Anular cuenta completa</button>'.replace('<button', '<button id="bAnularCuenta"')
        : '');

    m.innerHTML = html;

    /* --- eventos --- */

    $$('[data-prod]', m).forEach(function (b) {
      b.onclick = function () {
        var p = S.buscar('productos', b.dataset.prod);
        if (p && !p.precio) {
          if (!NOVA.sesion.esDueno()) return toast('Ese producto no tiene precio. Avisale al dueño.');
          return editarProducto(p);
        }
        S.agregarItem(c.id, b.dataset.prod, 1);
        toast(p.nombre + ' agregado');
      };
    });

    $$('[data-mas]', m).forEach(function (b) {
      b.onclick = function () {
        var i = S.buscar('items', b.dataset.mas);
        S.cambiarCantidad(i.id, i.cantidad + 1);
      };
    });

    $$('[data-menos]', m).forEach(function (b) {
      b.onclick = function () {
        var i = S.buscar('items', b.dataset.menos);
        if (!S.cambiarCantidad(i.id, i.cantidad - 1)) toast('Esa unidad ya está pagada');
      };
    });

    $$('[data-anular]', m).forEach(function (b) {
      b.onclick = function () {
        confirmar('¿Anular este pago?', 'El monto vuelve a quedar como deuda de la cuenta.', 'Anular pago', 'btn--peligro')
          .then(function (ok) { if (ok) { S.anularPago(b.dataset.anular); toast('Pago anulado'); } });
      };
    });

    if ($('#bCobrar')) $('#bCobrar').onclick = function () { hojaCobrar(c, saldo); };
    if ($('#bDividir')) $('#bDividir').onclick = function () { hojaDividir(c); };
    if ($('#bCerrar')) $('#bCerrar').onclick = function () {
      S.cerrarCuenta(c.id);
      toast('Cuenta cerrada');
      vista.pantalla = 'cuentas'; vista.cuentaId = null; render();
    };
    if ($('#bReabrir')) $('#bReabrir').onclick = function () { S.reabrirCuenta(c.id); toast('Cuenta reabierta'); };

    if ($('#bRenombrar')) $('#bRenombrar').onclick = function () {
      abrirHoja(
        '<h2>Editar cuenta</h2>' +
        '<div class="campo"><label>Nombre</label><input id="eN" value="' + esc(c.nombre) + '" maxlength="40"></div>' +
        '<div class="campo"><label>Nota</label><input id="eNota" value="' + esc(c.nota || '') + '"></div>' +
        '<button class="btn btn--primario btn--bloque" id="bG">Guardar</button>',
        function (h) {
          $('#bG', h).onclick = function () {
            S.renombrarCuenta(c.id, $('#eN', h).value, $('#eNota', h).value);
            cerrarHoja(); toast('Guardado');
          };
        }
      );
    };

    if ($('#bAnularCuenta')) $('#bAnularCuenta').onclick = function () {
      confirmar('¿Anular la cuenta completa?',
        'Se borra la cuenta y los vasos vuelven al inventario. Solo se puede si no tiene pagos registrados.',
        'Anular cuenta', 'btn--peligro')
        .then(function (ok) {
          if (!ok) return;
          if (S.cancelarCuenta(c.id)) {
            toast('Cuenta anulada');
            vista.pantalla = 'cuentas'; vista.cuentaId = null; render();
          } else {
            toast('No se puede: la cuenta ya tiene pagos');
          }
        });
    };
  }

  /* ---------- cobrar ---------- */

  function hojaCobrar(c, saldo) {
    var metodoSel = S.METODOS[0];

    abrirHoja(
      '<h2>Cobrar a ' + esc(c.nombre) + '</h2>' +
      '<p class="sub">Debe ' + S.money(saldo) + '. Podés cobrar todo o solo una parte; lo que quede sigue en la cuenta.</p>' +
      '<div class="campo campo--dinero"><label>Monto que recibís</label>' +
        '<input id="pMonto" type="number" inputmode="numeric" min="1" step="500" value="' + saldo + '"></div>' +
      '<div class="atajos">' +
        '<button data-set="' + saldo + '">Todo</button>' +
        '<button data-set="' + Math.round(saldo / 2 / 500) * 500 + '">Mitad</button>' +
        '<button data-add="10000">+10 mil</button>' +
        '<button data-add="20000">+20 mil</button>' +
        '<button data-add="50000">+50 mil</button>' +
      '</div>' +
      '<div class="campo mt"><label>Método de pago</label>' +
        '<div class="metodos">' + S.METODOS.map(function (mm, idx) {
          return '<button data-met="' + esc(mm) + '"' + (idx === 0 ? ' class="on"' : '') + '>' + mm + '</button>';
        }).join('') + '</div></div>' +
      '<div class="campo"><label>¿Quién paga? (opcional)</label>' +
        '<input id="pQuien" placeholder="Ej: el amigo de la gorra" autocomplete="off"></div>' +
      '<div id="pAviso"></div>' +
      '<button class="btn btn--exito btn--bloque" id="bPagar">Registrar pago</button>',
      function (h) {
        var inp = $('#pMonto', h);

        function refrescar() {
          var v = Number(inp.value) || 0;
          var av = $('#pAviso', h);
          if (v > saldo) {
            av.innerHTML = '<div class="aviso aviso--info">Recibís ' + S.money(v) +
              ' y debe ' + S.money(saldo) + '. <b>Devolvé ' + S.money(v - saldo) + '</b> de cambio. ' +
              'Se registra el pago por ' + S.money(saldo) + '.</div>';
          } else if (v > 0 && v < saldo) {
            av.innerHTML = '<div class="aviso aviso--info">Abono parcial. Le queda debiendo <b>' +
              S.money(saldo - v) + '</b> y la cuenta sigue abierta.</div>';
          } else {
            av.innerHTML = '';
          }
        }

        inp.oninput = refrescar;
        refrescar();
        setTimeout(function () { inp.select(); }, 150);

        $$('[data-set]', h).forEach(function (b) {
          b.onclick = function () { inp.value = b.dataset.set; refrescar(); };
        });
        $$('[data-add]', h).forEach(function (b) {
          b.onclick = function () { inp.value = (Number(inp.value) || 0) + Number(b.dataset.add); refrescar(); };
        });
        $$('[data-met]', h).forEach(function (b) {
          b.onclick = function () {
            $$('[data-met]', h).forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            metodoSel = b.dataset.met;
          };
        });

        $('#bPagar', h).onclick = function () {
          var v = Math.min(Number(inp.value) || 0, saldo);
          if (v <= 0) return toast('Escribí un monto');
          S.registrarPago(c.id, { monto: v, metodo: metodoSel, quien: $('#pQuien', h).value });
          cerrarHoja();
          var resto = saldo - v;
          toast(resto > 0 ? 'Abonó ' + S.money(v) + ' · queda ' + S.money(resto) : 'Cuenta saldada 🎉');
          if (resto <= 0) { vista.pantalla = 'cuentas'; vista.cuentaId = null; }
          render();
        };
      }
    );
  }

  /* ---------- dividir por ítems ---------- */

  function hojaDividir(c) {
    var items = S.itemsDe(c.id).filter(function (i) { return i.cantidad > (i.pagadas || 0); });
    if (!items.length) return toast('Ya está todo pagado');

    var sel = {};
    items.forEach(function (i) { sel[i.id] = 0; });
    var metodoSel = S.METODOS[0];

    abrirHoja(
      '<h2>Dividir la cuenta</h2>' +
      '<p class="sub">Marcá qué se lleva esta persona. Lo demás queda debiéndose en la cuenta de ' + esc(c.nombre) + '.</p>' +
      '<div id="dLista"></div>' +
      '<div class="campo mt"><label>Método de pago</label>' +
        '<div class="metodos">' + S.METODOS.map(function (mm, idx) {
          return '<button data-met="' + esc(mm) + '"' + (idx === 0 ? ' class="on"' : '') + '>' + mm + '</button>';
        }).join('') + '</div></div>' +
      '<div class="campo"><label>¿Quién paga? (opcional)</label>' +
        '<input id="dQuien" placeholder="Ej: Juli" autocomplete="off"></div>' +
      '<div class="resumen-seleccion">' +
        '<button class="btn btn--exito btn--bloque" id="bDivPagar" disabled>Seleccioná algo</button>' +
      '</div>',
      function (h) {
        function pintar() {
          $('#dLista', h).innerHTML = items.map(function (i) {
            var disp = i.cantidad - (i.pagadas || 0);
            return '<div class="dividir-item' + (sel[i.id] >= disp ? ' agotado' : '') + '">' +
              '<div class="pasos">' +
                '<button data-dm="' + i.id + '"' + (sel[i.id] <= 0 ? ' disabled' : '') + '>−</button>' +
                '<span class="n">' + sel[i.id] + '</span>' +
                '<button data-dp="' + i.id + '"' + (sel[i.id] >= disp ? ' disabled' : '') + '>+</button>' +
              '</div>' +
              '<div class="dividir-item__cuerpo">' +
                '<div class="item__nombre">' + esc(i.nombre) + '</div>' +
                '<div class="item__meta">' + S.money(i.precio) + ' c/u · quedan ' + disp + '</div>' +
              '</div>' +
              '<div class="item__total">' + S.money(i.precio * sel[i.id]) + '</div>' +
            '</div>';
          }).join('');

          var tot = items.reduce(function (s, i) { return s + i.precio * sel[i.id]; }, 0);
          var b = $('#bDivPagar', h);
          b.disabled = tot <= 0;
          b.textContent = tot > 0 ? 'Cobrar ' + S.money(tot) : 'Seleccioná algo';

          $$('[data-dp]', h).forEach(function (x) {
            x.onclick = function () { sel[x.dataset.dp]++; pintar(); };
          });
          $$('[data-dm]', h).forEach(function (x) {
            x.onclick = function () { sel[x.dataset.dm]--; pintar(); };
          });
        }

        pintar();

        $$('[data-met]', h).forEach(function (b) {
          b.onclick = function () {
            $$('[data-met]', h).forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            metodoSel = b.dataset.met;
          };
        });

        $('#bDivPagar', h).onclick = function () {
          var cubre = Object.keys(sel)
            .filter(function (k) { return sel[k] > 0; })
            .map(function (k) { return { item_id: k, cant: sel[k] }; });
          var p = S.registrarPago(c.id, { metodo: metodoSel, quien: $('#dQuien', h).value, cubre: cubre });
          cerrarHoja();
          if (!p) return toast('No se pudo registrar');
          var resto = S.saldoCuenta(c.id);
          toast(resto > 0 ? 'Cobrado ' + S.money(p.monto) + ' · faltan ' + S.money(resto) : 'Cuenta saldada 🎉');
          if (resto <= 0) { vista.pantalla = 'cuentas'; vista.cuentaId = null; }
          render();
        };
      }
    );
  }

  /* =========================================================
     INVENTARIO  (solo dueño)
     ========================================================= */

  function pantallaInventario(m) {
    if (!NOVA.sesion.esDueno()) {
      m.innerHTML = '<div class="vacio"><span class="emoji">🔒</span><strong>Sección del dueño</strong>' +
        '<p>Tu usuario no tiene acceso al inventario.</p></div>';
      return;
    }

    var inv = S.inventario();
    var alertas = S.alertasStock();
    var res = S.resumen();

    var html = '';

    if (alertas.length) {
      html += '<div class="aviso aviso--error">⚠ Se está acabando: ' +
        alertas.map(function (i) {
          return esc(S.etiquetaVaso(i.tipo, i.oz)) + ' (' + (i.stock || 0) + ')';
        }).join(' · ') + '</div>';
    }

    ['icopor', 'plastico'].forEach(function (tipo) {
      var lista = inv.filter(function (i) { return i.tipo === tipo; });
      if (!lista.length) return;
      html += '<div class="titulo-seccion">' +
        (tipo === 'icopor' ? 'Vasos de icopor' : 'Vaso plástico · micheladas') + '</div>' +
        '<div class="tarjeta">' + lista.map(function (i) {
          var s = i.stock || 0, min = i.minimo || 0;
          var clase = s <= min ? 'bajo' : (s <= min * 2 ? 'medio' : 'ok');
          var uso = res.vasosUsados[S.claveVaso(i.tipo, i.oz)];
          var usados = uso ? uso.cant : 0;
          return '<div class="stock">' +
            '<div class="stock__oz">' + (S.normOz(i.oz) === null
              ? '<span style="font-size:11px;letter-spacing:.5px">ÚNICO</span>'
              : S.normOz(i.oz) + ' oz') + '</div>' +
            '<div class="stock__cuerpo">' +
              '<div class="stock__cant ' + clase + '">' + s + ' <span style="font-size:12px;font-weight:600;color:var(--texto-3)">en stock</span></div>' +
              '<div class="stock__nota">Alerta bajo ' + min + (usados ? ' · hoy salieron ' + usados : '') + '</div>' +
            '</div>' +
            '<button class="btn btn--chico" data-inv="' + i.id + '">Mover</button>' +
          '</div>';
        }).join('') + '</div>';
    });

    html += '<div class="titulo-seccion">Movimientos de hoy</div>';
    var movs = S.movimientosDe(S.diaNegocio());
    html += movs.length
      ? '<div class="tarjeta"><ul class="lista-simple">' + movs.slice(0, 40).map(function (mv) {
          var signo = mv.delta > 0 ? '+' : '';
          var color = mv.delta > 0 ? 'var(--lima)' : 'var(--texto-2)';
          return '<li><span>' + esc(S.etiquetaVaso(mv.tipo_vaso, mv.oz)) +
            '<br><span class="chico">' + esc(mv.motivo) + (mv.nota ? ' · ' + esc(mv.nota) : '') + ' · ' + hora(mv.created_at) + '</span></span>' +
            '<b style="color:' + color + '">' + signo + mv.delta + '</b></li>';
        }).join('') + '</ul></div>'
      : '<div class="tarjeta chico centro">Todavía no hay movimientos hoy.</div>';

    m.innerHTML = html;

    $$('[data-inv]', m).forEach(function (b) {
      b.onclick = function () { hojaMoverStock(S.buscar('inventario', b.dataset.inv)); };
    });
  }

  function hojaMoverStock(i) {
    var nombre = S.etiquetaVaso(i.tipo, i.oz);
    abrirHoja(
      '<h2>' + esc(nombre) + '</h2><p class="sub">Hay ' + (i.stock || 0) + ' en stock.</p>' +
      '<div class="campo"><label>Entrada por compra</label>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="mEnt" type="number" inputmode="numeric" min="1" placeholder="Cuántos llegaron">' +
          '<button class="btn btn--exito" id="bEnt" style="flex:none;padding:0 18px">Sumar</button>' +
        '</div></div>' +
      '<div class="campo"><label>Conteo físico (corrige el total)</label>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="mCon" type="number" inputmode="numeric" min="0" placeholder="Cuántos contaste">' +
          '<button class="btn" id="bCon" style="flex:none;padding:0 18px">Fijar</button>' +
        '</div>' +
        '<div class="ayuda">Usalo cuando el número de la app no coincide con lo que ves.</div></div>' +
      '<div class="campo"><label>Dañados o perdidos</label>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="mMer" type="number" inputmode="numeric" min="1" placeholder="Cuántos">' +
          '<button class="btn btn--peligro" id="bMer" style="flex:none;padding:0 18px">Restar</button>' +
        '</div></div>' +
      '<div class="campo"><label>Avisarme cuando queden menos de</label>' +
        '<input id="mMin" type="number" inputmode="numeric" min="0" value="' + (i.minimo || 0) + '"></div>' +
      '<button class="btn btn--primario btn--bloque" id="bCerrarH">Listo</button>',
      function (h) {
        $('#bEnt', h).onclick = function () {
          var n = Number($('#mEnt', h).value) || 0;
          if (n <= 0) return toast('Escribí cuántos llegaron');
          S.registrarEntrada(i.tipo, i.oz, n, 'Compra');
          cerrarHoja(); toast('+' + n + ' ' + nombre);
        };
        $('#bCon', h).onclick = function () {
          var v = $('#mCon', h).value;
          if (v === '') return toast('Escribí cuántos contaste');
          S.ajustarStock(i.tipo, i.oz, Number(v), 'Conteo físico');
          cerrarHoja(); toast('Stock ajustado a ' + v);
        };
        $('#bMer', h).onclick = function () {
          var n = Number($('#mMer', h).value) || 0;
          if (n <= 0) return toast('Escribí cuántos');
          S.registrarMerma(i.tipo, i.oz, n, 'Dañados o perdidos');
          cerrarHoja(); toast('−' + n + ' por merma');
        };
        $('#bCerrarH', h).onclick = function () {
          var min = Number($('#mMin', h).value);
          if (min !== (i.minimo || 0)) S.fijarMinimo(i.id, min);
          cerrarHoja();
        };
      }
    );
  }

  /* =========================================================
     RESUMEN
     ========================================================= */

  function pantallaResumen(m) {
    var dueno = NOVA.sesion.esDueno();
    var fechas = S.fechasConMovimiento();
    var f = vista.fechaResumen || S.diaNegocio();
    if (fechas.indexOf(f) === -1) f = fechas[0] || S.diaNegocio();
    var r = S.resumen(f);
    var esHoy = f === S.diaNegocio();

    var html = '';

    if (dueno) {
      html += '<div class="campo"><label>Día</label><select id="selFecha">' +
        fechas.map(function (x) {
          return '<option value="' + x + '"' + (x === f ? ' selected' : '') + '>' +
            (x === S.diaNegocio() ? 'Hoy · ' : '') + fechaLarga(x) + '</option>';
        }).join('') + '</select></div>';
    } else {
      html += '<div class="titulo-seccion">' + (esHoy ? 'Mi turno de hoy' : fechaLarga(f)) + '</div>';
    }

    html += '<div class="metricas">' +
      '<div class="metrica"><div class="rot">Recaudado</div>' +
        '<div class="val verde">' + S.money(r.recaudado) + '</div>' +
        '<div class="nota">' + plural(r.transacciones, 'pago', 'pagos') + '</div></div>' +
      '<div class="metrica"><div class="rot">Por cobrar</div>' +
        '<div class="val ambar">' + S.money(r.porCobrar) + '</div>' +
        '<div class="nota">' + plural(r.pendientes.length, 'cuenta debiendo', 'cuentas debiendo') + '</div></div>';

    if (dueno) {
      html += '<div class="metrica"><div class="rot">Vendido</div>' +
          '<div class="val cyan">' + S.money(r.vendido) + '</div>' +
          '<div class="nota">' + plural(r.clientes, 'cliente', 'clientes') + '</div></div>' +
        '<div class="metrica"><div class="rot">Ticket promedio</div>' +
          '<div class="val">' + S.money(r.ticketPromedio) + '</div>' +
          '<div class="nota">por cliente</div></div>';
    }
    html += '</div>';

    // Lo que está pasando ahora mismo, incluido lo que vende el ayudante
    // desde su celular: llega por realtime y repinta esta lista sola.
    var eventos = S.actividad(f, 18);
    if (eventos.length) {
      html += '<div class="titulo-seccion">' +
        (esHoy ? '<span class="vivo"></span> Pasando ahora' : 'Movimiento del día') + '</div>' +
        '<div class="tarjeta">' + eventos.map(function (e) {
          return '<div class="evento evento--' + e.tipo + '">' +
            '<div class="evento__hora">' + hora(e.cuando) + '</div>' +
            '<div class="evento__cuerpo">' +
              '<div class="item__nombre">' + esc(e.cliente) + '</div>' +
              '<div class="item__meta">' + esc(e.detalle) +
                (e.quien ? ' · ' + esc(e.quien) : '') + '</div>' +
            '</div>' +
            '<div class="item__total" style="color:' +
              (e.tipo === 'pago' ? 'var(--lima)' : 'var(--texto-2)') + '">' +
              (e.tipo === 'pago' ? '+' : '') + S.money(e.monto) + '</div>' +
          '</div>';
        }).join('') + '</div>';
    }

    var metodos = Object.keys(r.porMetodo);
    if (metodos.length) {
      var maxM = Math.max.apply(null, metodos.map(function (k) { return r.porMetodo[k]; }));
      html += '<div class="titulo-seccion">Cómo pagaron</div><div class="tarjeta">' +
        metodos.sort(function (a, b) { return r.porMetodo[b] - r.porMetodo[a]; }).map(function (k) {
          return '<div class="barra"><div class="barra__top"><b>' + esc(k) + '</b>' +
            '<span>' + S.money(r.porMetodo[k]) + '</span></div>' +
            '<div class="barra__riel"><div class="barra__val" style="width:' +
              Math.max(6, r.porMetodo[k] / maxM * 100) + '%"></div></div></div>';
        }).join('') + '</div>';
    }

    if (dueno && r.porProducto.length) {
      var maxP = r.porProducto[0].total;
      html += '<div class="titulo-seccion">Qué se vendió</div><div class="tarjeta">' +
        r.porProducto.map(function (p) {
          return '<div class="barra"><div class="barra__top"><b>' + esc(p.nombre) + ' × ' + p.cant + '</b>' +
            '<span>' + S.money(p.total) + '</span></div>' +
            '<div class="barra__riel"><div class="barra__val" style="width:' +
              Math.max(6, p.total / maxP * 100) + '%"></div></div></div>';
        }).join('') + '</div>';
    }

    if (dueno) {
      var vk = Object.keys(r.vasosUsados);
      if (vk.length) {
        html += '<div class="titulo-seccion">Vasos que salieron</div><div class="tarjeta"><ul class="lista-simple">' +
          vk.sort().map(function (k) {
            return '<li><span>' + esc(r.vasosUsados[k].etiqueta) + '</span><b>' + r.vasosUsados[k].cant + '</b></li>';
          }).join('') + '</ul></div>';
      }

      var vend = Object.keys(r.porVendedor);
      if (vend.length > 1) {
        html += '<div class="titulo-seccion">Quién cobró</div><div class="tarjeta"><ul class="lista-simple">' +
          vend.sort(function (a, b) { return r.porVendedor[b] - r.porVendedor[a]; }).map(function (k) {
            return '<li><span>' + esc(k) + '</span><b>' + S.money(r.porVendedor[k]) + '</b></li>';
          }).join('') + '</ul></div>';
      }
    }

    if (r.pendientes.length) {
      html += '<div class="titulo-seccion">Quién debe ahora</div><div class="tarjeta"><ul class="lista-simple">' +
        r.pendientes.map(function (x) {
          return '<li><span>' + esc(x.cuenta.nombre) + '<br><span class="chico">desde ' + haceRato(x.cuenta.created_at) + '</span></span>' +
            '<b style="color:var(--ambar)">' + S.money(x.saldo) + '</b></li>';
        }).join('') + '</ul></div>';
    }

    if (dueno) {
      html += '<button class="btn btn--fantasma btn--bloque mt" id="bCSV">Descargar este día en Excel (CSV)</button>';
    }

    if (r.recaudado === 0 && r.vendido === 0) {
      html = html.split('<div class="titulo-seccion">Cómo pagaron')[0] +
        '<div class="vacio"><span class="emoji">🌙</span><strong>Sin ventas todavía</strong>' +
        '<p>Cuando cobres la primera cuenta<br>aparece acá el resumen.</p></div>';
    }

    m.innerHTML = html;

    if ($('#selFecha')) {
      $('#selFecha').onchange = function () { vista.fechaResumen = this.value; render(); };
    }
    if ($('#bCSV')) $('#bCSV').onclick = function () { descargarCSV(f); };
  }

  function descargarCSV(fecha) {
    var filas = [['Hora', 'Cliente', 'Producto', 'Cantidad', 'Precio unitario', 'Total', 'Vendió']];
    S.vivos('items').filter(function (i) { return i.fecha === fecha; }).forEach(function (i) {
      var c = S.buscar('cuentas', i.cuenta_id);
      filas.push([hora(i.created_at), c ? c.nombre : '', i.nombre, i.cantidad, i.precio, i.precio * i.cantidad, i.vendido_por || '']);
    });
    filas.push([]);
    filas.push(['Hora', 'Cliente', 'Pago', 'Método', 'Quién pagó', 'Cobró']);
    S.vivos('pagos').filter(function (p) { return p.fecha === fecha; }).forEach(function (p) {
      var c = S.buscar('cuentas', p.cuenta_id);
      filas.push([hora(p.created_at), c ? c.nombre : '', p.monto, p.metodo, p.quien || '', p.cobrado_por || '']);
    });

    var csv = filas.map(function (f) {
      return f.map(function (v) {
        v = String(v === undefined ? '' : v);
        return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(';');
    }).join('\r\n');

    descargar('nova-ventas-' + fecha + '.csv', '﻿' + csv, 'text/csv;charset=utf-8');
    toast('Descargado');
  }

  function descargar(nombre, contenido, tipo) {
    var blob = new Blob([contenido], { type: tipo || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* =========================================================
     AJUSTES
     ========================================================= */

  function pantallaAjustes(m) {
    var dueno = NOVA.sesion.esDueno();
    var cfg = C.cfg();

    var html =
      '<div class="tarjeta">' +
        '<div style="display:flex;align-items:center;gap:13px">' +
          '<span class="cuenta__ini">' + esc(iniciales(NOVA.sesion.nombre())) + '</span>' +
          '<div style="flex:1"><div style="font-weight:700">' + esc(NOVA.sesion.nombre()) + '</div>' +
          '<div class="chico">' + (dueno ? 'Dueño · acceso total' : 'Ayudante · solo ventas') + '</div></div>' +
        '</div>' +
        '<div class="mt">' + badgeSync() +
          (C.error() ? '<div class="chico" style="color:var(--rojo);margin-top:6px">' + esc(C.error()) + '</div>' : '') +
        '</div>' +
      '</div>';

    if (dueno) {
      html += '<div class="titulo-seccion">Productos y precios</div>' +
        '<div class="tarjeta"><ul class="lista-simple">' +
          S.productos().map(function (p) {
            return '<li data-prodedit="' + p.id + '" style="cursor:pointer">' +
              '<span>' + esc(p.nombre) +
                (p.activo === false ? ' <span class="etiqueta etiqueta--aviso">oculto</span>' : '') +
                '<br><span class="chico">' + (p.vaso ? esc(S.etiquetaVaso(p.vaso, p.oz)) : 'sin vaso') + '</span></span>' +
              '<b style="color:' + (p.precio ? 'var(--lima)' : 'var(--rojo)') + '">' +
                (p.precio ? S.money(p.precio) : 'sin precio') + '</b></li>';
          }).join('') + '</ul>' +
          '<button class="btn btn--fantasma btn--bloque btn--chico mt" id="bNuevoProd">+ Agregar producto</button>' +
        '</div>';
    }

    html += '<div class="titulo-seccion">Sincronización entre celulares</div><div class="tarjeta">';
    if (!cfg) {
      html += '<p class="chico mb0">Ahora mismo los datos viven solo en este celular. ' +
        'Conectá el servidor para que vos y tu ayudante vean las mismas cuentas en vivo.</p>' +
        '<button class="btn btn--primario btn--bloque mt" id="bConectar">Conectar servidor</button>';
    } else {
      html += '<ul class="lista-simple"><li><span>Servidor</span><b class="chico">' + esc(cfg.url.replace('https://', '')) + '</b></li>' +
        '<li><span>Estado</span><b class="chico">' + (C.activo() ? 'sesión activa' : 'sin sesión') + '</b></li></ul>' +
        '<div class="fila-btn mt">' +
          '<button class="btn btn--chico" id="bSync">Sincronizar ahora</button>' +
          '<button class="btn btn--chico btn--peligro btn--fantasma" id="bSalir">Cerrar sesión</button>' +
        '</div>';
    }
    html += '</div>';

    if (dueno && cfg && C.activo()) {
      html += '<div class="titulo-seccion">Usuarios</div>' +
        '<div class="tarjeta" id="cUsuarios"><p class="chico mb0">Cargando…</p></div>';
    }

    if (dueno) {
      html += '<div class="titulo-seccion">Respaldo</div><div class="tarjeta">' +
        '<p class="chico">Guardá una copia cada tanto. Si perdés el celular, la restaurás acá.</p>' +
        '<div class="fila-btn mt">' +
          '<button class="btn btn--chico" id="bExport">Descargar respaldo</button>' +
          '<button class="btn btn--chico btn--fantasma" id="bImport">Restaurar</button>' +
        '</div>' +
        '<input type="file" id="fImport" accept="application/json,.json" hidden>' +
      '</div>';
    }

    html += '<div class="titulo-seccion">La app</div><div class="tarjeta">' +
      '<p class="chico">Para tenerla como app: abrí el menú del navegador y tocá <b>“Agregar a pantalla de inicio”</b>.</p>' +
      '<ul class="lista-simple mt"><li><span>Versión</span><b class="chico">1.0</b></li>' +
      '<li><span>Cuentas guardadas</span><b class="chico">' + S.cuentas().length + '</b></li></ul>' +
      (dueno ? '<button class="btn btn--fantasma btn--peligro btn--bloque btn--chico mt" id="bBorrarTodo">Borrar todos los datos de este celular</button>' : '') +
      '</div>';

    m.innerHTML = html;

    /* --- eventos --- */

    $$('[data-prodedit]', m).forEach(function (li) {
      li.onclick = function () { editarProducto(S.buscar('productos', li.dataset.prodedit)); };
    });

    if ($('#bNuevoProd')) $('#bNuevoProd').onclick = function () { editarProducto(null); };
    if ($('#bConectar')) $('#bConectar').onclick = hojaConectar;
    if ($('#bSync')) $('#bSync').onclick = function () {
      toast('Sincronizando…');
      C.sincronizar().then(function () { toast('Al día'); render(); });
    };
    if ($('#bSalir')) $('#bSalir').onclick = function () {
      var pend = S.hayPendientesDeSync();
      confirmar('¿Cerrar sesión?',
        pend ? 'OJO: hay datos que todavía no se subieron. Sincronizá antes o se pierden.'
             : 'Los datos del negocio se borran de este celular y quedan en el servidor.',
        'Cerrar sesión', 'btn--peligro')
        .then(function (ok) { if (ok) C.salir(true).then(function () { location.reload(); }); });
    };

    if ($('#bExport')) $('#bExport').onclick = function () {
      descargar('nova-respaldo-' + S.diaNegocio() + '.json', S.exportar());
      toast('Respaldo descargado');
    };
    if ($('#bImport')) $('#bImport').onclick = function () { $('#fImport').click(); };
    if ($('#fImport')) $('#fImport').onchange = function () {
      var f = this.files[0];
      if (!f) return;
      var lector = new FileReader();
      lector.onload = function () {
        try {
          S.importar(lector.result, 'fusionar');
          toast('Respaldo restaurado');
          render();
        } catch (e) { toast(e.message); }
      };
      lector.readAsText(f);
    };

    if ($('#bBorrarTodo')) $('#bBorrarTodo').onclick = function () {
      confirmar('¿Borrar todo?',
        'Se borran cuentas, ventas e inventario de ESTE celular. No se puede deshacer. Descargá un respaldo antes.',
        'Borrar todo', 'btn--peligro')
        .then(function (ok) { if (ok) { S.limpiarTodo(); location.reload(); } });
    };

    if ($('#cUsuarios')) cargarUsuarios();
  }

  function cargarUsuarios() {
    C.listarPerfiles().then(function (lista) {
      var cont = $('#cUsuarios');
      if (!cont) return;
      var yo = NOVA.sesion.usuario();
      cont.innerHTML = '<ul class="lista-simple">' + lista.map(function (p) {
        return '<li><span>' + esc(p.nombre || p.email || 'Sin nombre') +
          (yo && p.id === yo.id ? ' <span class="chico">(vos)</span>' : '') +
          '<br><span class="chico">' + esc(p.email || '') + '</span></span>' +
          '<select data-rol="' + p.id + '" style="min-height:38px;padding:4px 8px;border-radius:9px;background:rgba(0,0,0,.35);border:1px solid var(--linea)">' +
            '<option value="ayudante"' + (p.rol === 'ayudante' ? ' selected' : '') + '>Ayudante</option>' +
            '<option value="dueno"' + (p.rol === 'dueno' ? ' selected' : '') + '>Dueño</option>' +
          '</select></li>';
      }).join('') + '</ul>' +
      '<p class="chico mt">Para agregar un ayudante, creale el usuario en el panel de Supabase ' +
      '(Authentication → Add user) y acá le asignás el rol.</p>';

      $$('[data-rol]', cont).forEach(function (s) {
        s.onchange = function () {
          C.cambiarRol(s.dataset.rol, s.value)
            .then(function () { toast('Rol actualizado'); })
            .catch(function (e) { toast(e.message); cargarUsuarios(); });
        };
      });
    }).catch(function (e) {
      if ($('#cUsuarios')) $('#cUsuarios').innerHTML = '<p class="chico mb0">No se pudo cargar: ' + esc(e.message) + '</p>';
    });
  }

  function editarProducto(p) {
    var nuevo = !p;
    p = p || { nombre: '', categoria: 'otro', oz: 16, precio: 0, vaso: 'plastico', activo: true };
    var cats = [['cremoso', 'Granizado cremoso'], ['original', 'Granizado original'],
                ['michelada', 'Michelada'], ['coctel', 'Coctel'], ['otro', 'Otro']];

    abrirHoja(
      '<h2>' + (nuevo ? 'Nuevo producto' : esc(p.nombre)) + '</h2>' +
      '<div class="campo"><label>Nombre</label><input id="qN" value="' + esc(p.nombre) + '" maxlength="40" placeholder="Ej: Michelada 24 oz"></div>' +
      '<div class="campo campo--dinero"><label>Precio</label>' +
        '<input id="qP" type="number" inputmode="numeric" min="0" step="500" value="' + (p.precio || '') + '" placeholder="0"></div>' +
      '<div class="campo"><label>Categoría</label><select id="qC">' +
        cats.map(function (c) {
          return '<option value="' + c[0] + '"' + (p.categoria === c[0] ? ' selected' : '') + '>' + c[1] + '</option>';
        }).join('') + '</select></div>' +
      '<div class="campo"><label>Vaso que consume</label><select id="qV">' +
        '<option value="">Ninguno</option>' +
        '<option value="icopor"' + (p.vaso === 'icopor' ? ' selected' : '') + '>Icopor</option>' +
        '<option value="plastico"' + (p.vaso === 'plastico' ? ' selected' : '') + '>Plástico</option>' +
      '</select><div class="ayuda">Cada venta descuenta uno de estos del inventario.</div></div>' +
      '<div class="campo" id="campoOz"><label>Tamaño</label><select id="qO">' +
        '<option value="">Sin tamaño</option>' +
        [8, 12, 16, 24].map(function (o) {
          return '<option value="' + o + '"' + (Number(p.oz) === o ? ' selected' : '') + '>' + o + ' oz</option>';
        }).join('') + '</select>' +
        '<div class="ayuda">El vaso plástico es uno solo, así que no lleva tamaño.</div></div>' +
      (!nuevo ? '<div class="campo"><label>Mostrar en la grilla de venta</label><select id="qA">' +
        '<option value="1"' + (p.activo !== false ? ' selected' : '') + '>Sí</option>' +
        '<option value="0"' + (p.activo === false ? ' selected' : '') + '>No, ocultar</option></select></div>' : '') +
      '<button class="btn btn--primario btn--bloque" id="qG">Guardar</button>' +
      (!nuevo ? '<button class="btn btn--fantasma btn--peligro btn--bloque btn--chico mt" id="qD">Eliminar producto</button>' : ''),
      function (h) {
        var selVaso = $('#qV', h), selOz = $('#qO', h);

        // El plástico no tiene tamaños: el selector se apaga para que no
        // quede un producto apuntando a una fila de inventario que no existe.
        function ajustarTamano() {
          var esPlastico = selVaso.value === 'plastico';
          if (esPlastico) selOz.value = '';
          selOz.disabled = esPlastico;
          $('#campoOz', h).style.opacity = esPlastico ? '.45' : '';
        }
        selVaso.onchange = ajustarTamano;
        ajustarTamano();

        $('#qG', h).onclick = function () {
          var nombre = $('#qN', h).value.trim();
          if (!nombre) return toast('Ponele nombre');
          S.guardarProducto({
            id: p.id,
            nombre: nombre,
            precio: Number($('#qP', h).value) || 0,
            categoria: $('#qC', h).value,
            vaso: selVaso.value || null,
            oz: selOz.value === '' ? null : Number(selOz.value),
            activo: $('#qA', h) ? $('#qA', h).value === '1' : true
          });
          cerrarHoja(); toast('Guardado');
        };
        if ($('#qD', h)) $('#qD', h).onclick = function () {
          cerrarHoja();
          confirmar('¿Eliminar ' + p.nombre + '?',
            'Las ventas ya registradas no se tocan. Si solo querés que deje de aparecer, mejor ocultalo.',
            'Eliminar', 'btn--peligro')
            .then(function (ok) { if (ok) { S.eliminarProducto(p.id); toast('Eliminado'); } });
        };
      }
    );
  }

  function hojaConectar() {
    abrirHoja(
      '<h2>Conectar servidor</h2>' +
      '<p class="sub">Pegá los datos de tu proyecto de Supabase. Están en Project Settings → API.</p>' +
      '<div class="campo"><label>Project URL</label>' +
        '<input id="cUrl" placeholder="https://xxxxxxxx.supabase.co" autocapitalize="off" autocomplete="off" spellcheck="false"></div>' +
      '<div class="campo"><label>Clave pública</label>' +
        '<textarea id="cKey" placeholder="sb_publishable_..." autocapitalize="off" spellcheck="false"></textarea>' +
        '<div class="ayuda">La que dice <b>Publishable key</b> (o <b>anon public</b>). ' +
        'Nunca la <b>secret</b> ni la <b>service_role</b>.</div></div>' +
      '<div id="cAviso"></div>' +
      '<button class="btn btn--primario btn--bloque" id="bGuardarCfg">Conectar</button>',
      function (h) {
        $('#bGuardarCfg', h).onclick = function () {
          try {
            C.guardarCfg($('#cUrl', h).value, $('#cKey', h).value);
            cerrarHoja();
            toast('Conectando…');
            location.reload();
          } catch (e) {
            $('#cAviso', h).innerHTML = '<div class="aviso aviso--error">' + esc(e.message) + '</div>';
          }
        };
      }
    );
  }

  /* =========================================================
     ARRANQUE
     ========================================================= */

  var repintarPendiente = false;
  function repintarPronto() {
    if (repintarPendiente) return;
    repintarPendiente = true;
    requestAnimationFrame(function () {
      repintarPendiente = false;
      if (app && document.body.contains(app)) render();
    });
  }

  S.suscribir(repintarPronto);
  C.alCambiar(function () {
    if (!app) return;
    var b = $('.sync');
    if (b) b.outerHTML = badgeSync();
  });

  document.addEventListener('DOMContentLoaded', function () {
    C.iniciar().then(function () {
      if (NOVA.sesion.requiereLogin()) pantallaLogin();
      else arrancarApp();
    });
  });

  global.NOVA.ui = { render: render, toast: toast };
})(window);
