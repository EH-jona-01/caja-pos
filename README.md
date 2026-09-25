# Caja — Punto de venta

Punto de venta pensado para mostrar en el celular: vender, escanear códigos de barras con la cámara, ver reportes y preguntarle a un asistente sobre las ventas. Todo en una sola app.

Los datos viven en Airtable, así que el comercio puede abrir la base y ver/editar sus productos y ventas sin tocar código.

## Requisitos

- Node.js 22.5+ (probado con v24).
- Una base de Airtable con las tablas `Productos`, `Ventas` y `VentaItems`.
- Opcional: API key de Anthropic para el asistente.

## Configuración

`pos-app/.env` (no se versiona):

```
AIRTABLE_TOKEN=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_PRODUCTOS_TABLE_ID=tbl...
AIRTABLE_VENTAS_TABLE_ID=tbl...
AIRTABLE_VENTAITEMS_TABLE_ID=tbl...
ANTHROPIC_API_KEY=sk-ant-...      # opcional, habilita la pestaña Asistente
ANTHROPIC_MODEL=claude-haiku-4-5-20251001   # opcional
```

## Uso

```bash
npm install
npm start
```

Abrir http://localhost:3000

### Abrirlo desde el celular

La cámara del celular **solo funciona sobre https**. Para una demo:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Devuelve una URL `https://algo.trycloudflare.com` que se abre desde cualquier teléfono.
Desde el celular se puede "Agregar a pantalla de inicio" y queda como una app nativa (PWA).

## Las cuatro pestañas

| Pestaña | Qué hace |
|---|---|
| **Vender** | Catálogo con búsqueda y filtro por rubro. Tocar un producto lo suma al ticket. El ticket se abre como panel inferior: cantidades, medio de pago, vuelto calculado y comprobante al cobrar. |
| **Escanear** | Cámara con lectura de código de barras. En modo *Cargar al ticket* suma el producto a la venta; si el código no existe, ofrece darlo de alta en el momento. En modo *Alta de producto* permite actualizar precios escaneando. También acepta pistola lectora USB/Bluetooth o tipeo manual. |
| **Reportes** | Facturación, tickets, ticket promedio y unidades, cada uno comparado contra el período anterior. Gráficos de evolución, ranking de productos, rubros, medios de pago y horarios fuertes. Lista de productos que no rotan. |
| **Asistente** | Chat que responde sobre las ventas reales (Claude). Recibe como contexto el resumen, la evolución, los rankings y el catálogo completo. |

## Modo offline

Si se corta internet, el comercio sigue vendiendo:

- Un **service worker** cachea la app y el catálogo, así que la pantalla carga sin red.
- Las ventas que no se pueden enviar quedan en una **cola en el dispositivo** (`localStorage`). El comprobante avisa que está pendiente.
- Al volver la conexión se **suben solas** (también se reintenta cada 30 segundos y al tocar el indicador).
- El total de "Hoy" suma las ventas en cola, porque para el mostrador ya son plata cobrada.

No funcionan sin conexión: el alta de productos por código de barras (consulta una base externa) y el asistente.

Probado de punta a punta con `puppeteer-core`: venta online, corte de red, venta offline, recarga de la app sin internet y sincronización al reconectar.

## Detalles de implementación

- **IVA incluido**: los precios del catálogo son finales. El ticket discrimina el neto y el 21% hacia adentro, como se maneja en el mostrador.
- **Totales del lado del servidor**: el backend recalcula precios y totales contra Airtable; nunca confía en lo que manda el navegador.
- **Días locales**: los timestamps se guardan en UTC pero se agrupan por día local, si no las ventas de la tarde caerían en el día siguiente.
- **Lectura de códigos**: usa la `BarcodeDetector` nativa del navegador (Chrome/Edge en Android y escritorio). En Safari/Firefox la pestaña Escanear ofrece el campo manual.

## Estructura

```
pos-app/
  server.js       # rutas Express
  airtable.js     # cliente REST de Airtable
  analytics.js    # métricas, rankings, crecimiento
  assistant.js    # contexto de datos + llamada a Claude
  public/         # app (HTML/CSS/JS sin build)
  .env            # credenciales (ignorado en git)
```

## Endpoints

```
GET    /api/products                  catálogo
GET    /api/products/barcode/:code    buscar por código de barras
POST   /api/products                  alta de producto
PATCH  /api/products/barcode/:code    actualizar precio
POST   /api/sales                     registrar venta
GET    /api/sales/today               ventas del día
GET    /api/analytics?days=N          métricas y rankings
POST   /api/assistant                 pregunta al asistente
```

## Notas

- Es una demo: no tiene login ni manejo de usuarios/cajeros.
- Tarjeta y QR registran el medio de pago, no procesan cobros reales.
- Cada operación pega contra la API de Airtable (límite de 5 req/seg por base).
