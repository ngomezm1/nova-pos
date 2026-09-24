# -*- coding: utf-8 -*-
"""Genera Guia-instalacion-iPhone.pdf: una pagina A4 para mandar por WhatsApp.

Se regenera con:  python tools/guia-pdf.py
Requiere reportlab (pip install reportlab).
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(BASE, 'Guia-instalacion-iPhone.pdf')
LOGO = os.path.join(BASE, 'assets', 'logo.jpg')

W, H = A4

FONDO   = HexColor('#06021a')
PANEL   = HexColor('#140a38')
LINEA   = HexColor('#3a2a6b')
CYAN    = HexColor('#2fe4ff')
MAGENTA = HexColor('#ff3ad0')
VIOLETA = HexColor('#a855f7')
LIMA    = HexColor('#6bff9e')
AMBAR   = HexColor('#ffcc4d')
TEXTO   = HexColor('#f2ecff')
TEXTO2  = HexColor('#c3b5ea')
TEXTO3  = HexColor('#8b7ab8')

MARGEN = 46


def fondo(c):
    """Fondo oscuro con un par de halos, al tono del logo."""
    c.setFillColor(FONDO)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    for cx, cy, radio, color, capas in [
        (W * 0.10, H * 1.02, 250, MAGENTA, 16),
        (W * 0.95, H * 0.92, 210, CYAN, 16),
        (W * 0.50, -40, 260, VIOLETA, 16),
    ]:
        for i in range(capas, 0, -1):
            c.setFillColor(color)
            c.setFillAlpha(0.016)
            c.circle(cx, cy, radio * i / capas, fill=1, stroke=0)
    c.setFillAlpha(1)


def estrellas(c):
    # Solo en los margenes: una estrella sobre una linea de texto se lee
    # como un caracter suelto y parece un error de tipeo.
    puntos = [(0.035, 0.80), (0.965, 0.88), (0.03, 0.62), (0.97, 0.55),
              (0.04, 0.40), (0.96, 0.30), (0.03, 0.16), (0.965, 0.22),
              (0.05, 0.93), (0.95, 0.47), (0.035, 0.07), (0.96, 0.10)]
    c.setFillColor(HexColor('#ffffff'))
    for x, y in puntos:
        c.setFillAlpha(0.30)
        c.circle(W * x, H * y, 0.9, fill=1, stroke=0)
    c.setFillAlpha(1)


def panel(c, x, y, ancho, alto, radio=12, borde=LINEA, relleno=PANEL, alfa=0.55):
    c.setFillColor(relleno)
    c.setFillAlpha(alfa)
    c.setStrokeColor(borde)
    c.setLineWidth(0.9)
    c.roundRect(x, y, ancho, alto, radio, fill=1, stroke=1)
    c.setFillAlpha(1)


def texto(c, x, y, s, fuente='Helvetica', tam=10, color=TEXTO2):
    c.setFont(fuente, tam)
    c.setFillColor(color)
    c.drawString(x, y, s)


def envolver(c, s, fuente, tam, ancho):
    """Corta el texto en lineas que quepan en `ancho`."""
    c.setFont(fuente, tam)
    palabras, lineas, actual = s.split(), [], ''
    for p in palabras:
        prueba = (actual + ' ' + p).strip()
        if c.stringWidth(prueba, fuente, tam) <= ancho:
            actual = prueba
        else:
            if actual:
                lineas.append(actual)
            actual = p
    if actual:
        lineas.append(actual)
    return lineas


def paso(c, n, y, titulo, cuerpo, resalta=None):
    """Un paso numerado. Devuelve la y donde termina."""
    x = MARGEN
    d = 30                       # diametro del circulo del numero

    c.setFillColor(VIOLETA if n % 2 else CYAN)
    c.circle(x + d / 2, y - d / 2, d / 2, fill=1, stroke=0)
    c.setFont('Helvetica-Bold', 15)
    c.setFillColor(HexColor('#0a0320'))
    c.drawCentredString(x + d / 2, y - d / 2 - 5, str(n))

    tx = x + d + 13
    ancho = W - tx - MARGEN

    c.setFont('Helvetica-Bold', 14)
    c.setFillColor(TEXTO)
    c.drawString(tx, y - 12, titulo)

    yy = y - 31
    for linea in envolver(c, cuerpo, 'Helvetica', 10.8, ancho):
        texto(c, tx, yy, linea, 'Helvetica', 10.8, TEXTO2)
        yy -= 15

    if resalta:
        yy -= 3
        for linea in envolver(c, resalta, 'Helvetica-Bold', 10.2, ancho):
            texto(c, tx, yy, linea, 'Helvetica-Bold', 10.2, AMBAR)
            yy -= 13.5

    return yy


# ----------------------------------------------------------------- dibujo ---

c = canvas.Canvas(SALIDA, pagesize=A4)
c.setTitle('Instalar NOVA POS en iPhone')
c.setAuthor('NOVA')
c.setSubject('Guía de instalación')

fondo(c)
estrellas(c)

# ---- cabecera ----
y = H - MARGEN - 58
c.drawImage(ImageReader(LOGO), MARGEN, y, width=58, height=58,
            mask='auto', preserveAspectRatio=True)

c.setFont('Helvetica-Bold', 21)
c.setFillColor(TEXTO)
c.drawString(MARGEN + 72, y + 34, 'Instalar NOVA POS')

c.setFont('Helvetica-Bold', 21)
c.setFillColor(CYAN)
c.drawString(MARGEN + 72, y + 12, 'en iPhone')

c.setFont('Helvetica', 9.5)
c.setFillColor(TEXTO3)
c.drawRightString(W - MARGEN, y + 16, '4 pasos  ·  5 minutos')

# linea divisoria
y -= 20
c.setStrokeColor(LINEA)
c.setLineWidth(1)
c.line(MARGEN, y, W - MARGEN, y)

# ---- aviso inicial ----
y -= 46
panel(c, MARGEN, y, W - 2 * MARGEN, 34, radio=10,
      borde=HexColor('#2fe4ff'), relleno=HexColor('#0e2a38'), alfa=0.5)
texto(c, MARGEN + 14, y + 20, 'Usá SAFARI, no Chrome.', 'Helvetica-Bold', 10.5, CYAN)
texto(c, MARGEN + 14, y + 7,
      'En iPhone, Chrome no puede instalar la app. Safari es el ícono de la brújula azul.',
      'Helvetica', 9.5, TEXTO2)

# ---- pasos ----
y -= 22

y = paso(c, 1, y, 'Abrí el link en Safari', '')
c.setFont('Helvetica-Bold', 13)
c.setFillColor(CYAN)
c.drawString(MARGEN + 43, y, 'ngomezm1.github.io/nova-pos')
y -= 6

y = paso(c, 2, y - 18, 'Tocá Compartir',
         'Arriba a la derecha hay una cajita con una flecha hacia arriba. Esa es.')

y = paso(c, 3, y - 18, 'Añadir a pantalla de inicio',
         'Tocá "Ver más" y buscá esa opción en la lista. '
         'Si sale "Abrir como app web", dejalo activado. '
         'Tocá Añadir y el ícono queda en tu celular.')

y = paso(c, 4, y - 18, 'Abrí la app desde el ícono nuevo',
         'Ya no uses Safari: entrá por el ícono de NOVA que quedó en tu pantalla. '
         'Adentro: Ajustes  >  Conectar servidor  >  pegá los dos datos  >  Conectar. '
         'Después iniciá sesión y elegí tu sede.')

# ---- caja de datos ----
y -= 26
alto_caja = 121
panel(c, MARGEN, y - alto_caja, W - 2 * MARGEN, alto_caja, radio=12)

cy = y - 24
texto(c, MARGEN + 16, cy, 'LOS DATOS PARA ENTRAR', 'Helvetica-Bold', 9.5, TEXTO3)
cy -= 23

for etiqueta in ['Servidor', 'Clave', 'Tu correo', 'Tu contraseña']:
    texto(c, MARGEN + 16, cy, etiqueta, 'Helvetica-Bold', 10, TEXTO2)
    c.setStrokeColor(LINEA)
    c.setLineWidth(0.8)
    c.line(MARGEN + 118, cy - 3, W - MARGEN - 16, cy - 3)
    cy -= 21

y -= alto_caja + 18
texto(c, MARGEN, y, 'Estos cuatro datos te los manda Nicolás por WhatsApp.',
      'Helvetica-Oblique', 10, TEXTO3)

# ---- si algo falla ----
y -= 34
texto(c, MARGEN, y, 'SI ALGO NO SALE', 'Helvetica-Bold', 9.5, TEXTO3)
y -= 22

problemas = [
    ('No veo la cajita arriba a la derecha',
     'Puede estar abajo al centro: depende de tu Safari.'),
    ('No encuentro "Añadir a pantalla de inicio"',
     'Estás en Chrome. Abrí el link en Safari.'),
    ('"Esa clave no parece la correcta"',
     'Se copió incompleta. Pedila de nuevo y pegala entera.'),
    ('Arriba dice "Sin red"',
     'Seguí vendiendo igual: se sincroniza solo cuando vuelva la señal.'),
]

for titulo, sol in problemas:
    c.setFillColor(MAGENTA)
    c.circle(MARGEN + 3, y + 3.2, 2, fill=1, stroke=0)
    texto(c, MARGEN + 13, y, titulo, 'Helvetica-Bold', 9.8, TEXTO)
    ancho_t = c.stringWidth(titulo, 'Helvetica-Bold', 9.8)
    texto(c, MARGEN + 13 + ancho_t + 7, y, sol, 'Helvetica', 9.8, TEXTO3)
    y -= 19

# Comprobacion: el contenido no puede invadir el pie.
LIMITE = MARGEN + 30
if y < LIMITE:
    print('AVISO: el contenido se pasa', round(LIMITE - y, 1), 'pt sobre el pie')
else:
    print('Holgura hasta el pie:', round(y - LIMITE, 1), 'pt')

# ---- pie ----
c.setStrokeColor(LINEA)
c.setLineWidth(1)
c.line(MARGEN, MARGEN + 16, W - MARGEN, MARGEN + 16)
c.setFont('Helvetica', 8.5)
c.setFillColor(TEXTO3)
c.drawString(MARGEN, MARGEN + 4, 'NOVA  ·  Granizados, Cócteles y Micheladas  ·  Medellín')
c.setFillColor(LIMA)
c.drawRightString(W - MARGEN, MARGEN + 4, 'Guía completa: ngomezm1.github.io/nova-pos/guia.html')

c.showPage()
c.save()

print('PDF generado:', SALIDA)
print('Tamano:', round(os.path.getsize(SALIDA) / 1024, 1), 'KB')
