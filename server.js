const path = require("node:path");
const express = require("express");
const airtable = require("./airtable");
const analytics = require("./analytics");
const assistant = require("./assistant");
const lookup = require("./lookup");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Chequeo de vida: no toca Airtable, sirve para que la app sepa si la caja
// sigue alcanzable sin gastar llamadas a la API.
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/products", async (req, res) => {
  try {
    const products = await airtable.getProducts();
    res.json(products.map(({ recordId, ...p }) => p));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "No se pudo leer el catálogo desde Airtable." });
  }
});

app.get("/api/products/barcode/:code", async (req, res) => {
  try {
    const product = await airtable.getProductByBarcode(req.params.code);
    if (!product) return res.status(404).json({ error: "No hay ningún producto con ese código." });
    const { recordId, ...rest } = product;
    res.json(rest);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "No se pudo consultar Airtable." });
  }
});

// Escaneo de un código que no está en el catálogo: se buscan los datos del
// producto afuera para que el comercio sólo tenga que poner el precio.
app.get("/api/products/lookup/:code", async (req, res) => {
  try {
    const products = await airtable.getProducts();
    const known = products.find(
      (p) => p.barcode === req.params.code || p.id === req.params.code
    );
    if (known) {
      const { recordId, ...rest } = known;
      return res.json({ known: true, product: rest });
    }

    const info = await lookup.lookupBarcode(req.params.code);
    if (!info.found) return res.json({ known: false, found: false });

    let category = info.category;
    if (!category) {
      const rubros = [...new Set(products.map((p) => p.category).filter(Boolean))];
      category = await assistant.classifyProduct(info.name, rubros);
    }

    res.json({
      known: false,
      found: true,
      name: info.name,
      category,
      brand: info.brand,
      source: info.source,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "No se pudo consultar el producto." });
  }
});

app.post("/api/products", async (req, res) => {
  const { barcode, name, category, price } = req.body || {};
  if (!barcode || !String(barcode).trim()) {
    return res.status(400).json({ error: "Falta el código de barras." });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Falta el nombre del producto." });
  }
  if (!category || !String(category).trim()) {
    return res.status(400).json({ error: "Falta la categoría." });
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return res.status(400).json({ error: "El precio debe ser un número mayor a 0." });
  }

  try {
    const product = await airtable.createProduct({
      barcode: String(barcode).trim(),
      name: String(name).trim(),
      category: String(category).trim(),
      price: Math.round(priceNum),
    });
    const { recordId, ...rest } = product;
    res.status(201).json(rest);
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(502).json({ error: "No se pudo crear el producto en Airtable." });
  }
});

app.patch("/api/products/barcode/:code", async (req, res) => {
  const priceNum = Number(req.body && req.body.price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return res.status(400).json({ error: "El precio debe ser un número mayor a 0." });
  }
  try {
    const product = await airtable.updateProductPriceByBarcode(req.params.code, Math.round(priceNum));
    const { recordId, ...rest } = product;
    res.json(rest);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error(err);
    res.status(502).json({ error: "No se pudo actualizar el producto en Airtable." });
  }
});

app.get("/api/sales/today", async (req, res) => {
  try {
    const sales = await airtable.getTodaySales();
    const totalVentas = sales.reduce((sum, s) => sum + s.total, 0);
    const summary = {
      totalVentas,
      tickets: sales.length,
      ticketPromedio: sales.length ? Math.round(totalVentas / sales.length) : 0,
    };
    res.json({ summary, sales });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "No se pudo leer las ventas desde Airtable." });
  }
});

app.post("/api/sales", async (req, res) => {
  const { items, method, received } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "El ticket no tiene items." });
  }
  if (!["Efectivo", "Tarjeta", "Transferencia"].includes(method)) {
    return res.status(400).json({ error: "Medio de pago inválido." });
  }

  try {
    const sale = await airtable.createSale({ items, method, received });
    res.status(201).json(sale);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(502).json({ error: "No se pudo registrar la venta en Airtable." });
  }
});

app.get("/api/analytics", async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : null;
  try {
    const data = await analytics.getAnalytics({ days: Number.isFinite(days) ? days : null });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "No se pudo calcular el análisis desde Airtable." });
  }
});

app.post("/api/assistant", async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "Falta el mensaje." });
  }
  try {
    const reply = await assistant.ask(String(message).trim(), Array.isArray(history) ? history : []);
    res.json({ reply });
  } catch (err) {
    if (err.status === 501) return res.status(501).json({ error: err.message });
    console.error(err);
    res.status(502).json({ error: err.message || "No se pudo consultar al asistente." });
  }
});

app.listen(PORT, () => {
  console.log(`Caja — punto de venta escuchando en http://localhost:${PORT}`);
});
