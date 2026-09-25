const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const PRODUCTOS_TABLE = process.env.AIRTABLE_PRODUCTOS_TABLE_ID;
const VENTAS_TABLE = process.env.AIRTABLE_VENTAS_TABLE_ID;
const VENTAITEMS_TABLE = process.env.AIRTABLE_VENTAITEMS_TABLE_ID;

if (!TOKEN || !BASE_ID || !PRODUCTOS_TABLE || !VENTAS_TABLE || !VENTAITEMS_TABLE) {
  throw new Error(
    "Faltan variables de Airtable en .env (AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_PRODUCTOS_TABLE_ID, AIRTABLE_VENTAS_TABLE_ID, AIRTABLE_VENTAITEMS_TABLE_ID)."
  );
}

const API_ROOT = `https://api.airtable.com/v0/${BASE_ID}`;

async function airtableFetch(path, options = {}) {
  const resp = await fetch(`${API_ROOT}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await resp.json();
  if (!resp.ok) {
    const message = data.error ? JSON.stringify(data.error) : resp.statusText;
    throw new Error(`Airtable ${resp.status}: ${message}`);
  }
  return data;
}

async function listAllRecords(table, params) {
  const records = [];
  let offset;
  do {
    const qs = new URLSearchParams(params);
    if (offset) qs.set("offset", offset);
    const data = await airtableFetch(`${table}?${qs.toString()}`);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

async function getProducts() {
  const records = await listAllRecords(PRODUCTOS_TABLE, {
    "sort[0][field]": "Rubro",
    "sort[0][direction]": "asc",
    "sort[1][field]": "Name",
    "sort[1][direction]": "asc",
  });
  return records.map((r) => ({
    recordId: r.id,
    id: r.fields.ProductId,
    name: r.fields.Name,
    category: r.fields.Rubro,
    price: r.fields.Price,
    barcode: r.fields.Barcode || null,
  }));
}

async function getProductByCode(products, productId) {
  return products.find((p) => p.id === productId);
}

async function getProductByBarcode(barcode) {
  const products = await getProducts();
  return products.find((p) => p.barcode === barcode) || null;
}

async function createProduct({ barcode, name, category, price }) {
  const existing = await getProductByBarcode(barcode);
  if (existing) {
    const err = new Error(`Ya existe un producto con ese código de barras: ${existing.name}`);
    err.status = 409;
    throw err;
  }

  const data = await airtableFetch(PRODUCTOS_TABLE, {
    method: "POST",
    body: JSON.stringify({
      typecast: true,
      records: [
        {
          fields: {
            Name: name,
            Rubro: category,
            Price: price,
            Barcode: barcode,
            ProductId: barcode,
          },
        },
      ],
    }),
  });
  const r = data.records[0];
  return {
    recordId: r.id,
    id: r.fields.ProductId,
    name: r.fields.Name,
    category: r.fields.Rubro,
    price: r.fields.Price,
    barcode: r.fields.Barcode,
  };
}

async function updateProductPriceByBarcode(barcode, price) {
  const product = await getProductByBarcode(barcode);
  if (!product) {
    const err = new Error("No existe ningún producto con ese código.");
    err.status = 404;
    throw err;
  }
  return updateProductPrice(product.recordId, price);
}

async function updateProductPrice(recordId, price) {
  const data = await airtableFetch(`${PRODUCTOS_TABLE}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: { Price: price } }),
  });
  return {
    recordId: data.id,
    id: data.fields.ProductId,
    name: data.fields.Name,
    category: data.fields.Rubro,
    price: data.fields.Price,
    barcode: data.fields.Barcode || null,
  };
}

async function getTodaySales() {
  // Se filtra por día local en JS: la fórmula de Airtable compara contra UTC y
  // partiría el día del comercio a las 21hs.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const records = (
    await listAllRecords(VENTAS_TABLE, {
      filterByFormula: "IS_AFTER({Fecha}, DATEADD(NOW(), -2, 'days'))",
      "sort[0][field]": "Fecha",
      "sort[0][direction]": "desc",
    })
  ).filter((r) => new Date(r.fields.Fecha) >= startOfDay);

  return records.map((r) => ({
    id: r.fields.Ticket,
    ts: r.fields.Fecha,
    method: r.fields.Method,
    subtotal: r.fields.Subtotal,
    iva: r.fields.IVA,
    total: r.fields.Total,
    received: r.fields.Received,
    items: JSON.parse(r.fields.ItemsJSON || "[]"),
  }));
}

async function getAllSales() {
  const records = await listAllRecords(VENTAS_TABLE, {
    "sort[0][field]": "Fecha",
    "sort[0][direction]": "asc",
  });
  return records.map((r) => ({
    id: r.fields.Ticket,
    ts: r.fields.Fecha,
    method: r.fields.Method,
    subtotal: r.fields.Subtotal,
    iva: r.fields.IVA,
    total: r.fields.Total,
    received: r.fields.Received,
    items: JSON.parse(r.fields.ItemsJSON || "[]"),
  }));
}

async function createSale({ items, method, received }) {
  const products = await getProducts();

  const lines = [];
  for (const item of items) {
    const product = await getProductByCode(products, item.productId);
    const qty = Number(item.qty);
    if (!product || !Number.isInteger(qty) || qty <= 0) {
      const err = new Error(`Item inválido: ${item.productId}`);
      err.status = 400;
      throw err;
    }
    lines.push({
      productId: product.id,
      productRecordId: product.recordId,
      name: product.name,
      unitPrice: product.price,
      qty,
      lineTotal: product.price * qty,
    });
  }

  // Los precios del catálogo son finales: el IVA va discriminado hacia adentro.
  const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const subtotal = Math.round(total / 1.21);
  const iva = total - subtotal;
  const receivedAmount = method === "Efectivo" ? Number(received) || 0 : total;

  if (method === "Efectivo" && receivedAmount < total) {
    const err = new Error("El monto recibido es menor al total.");
    err.status = 400;
    throw err;
  }

  const ts = new Date().toISOString();
  const itemsForJson = lines.map((l) => ({
    productId: l.productId,
    name: l.name,
    unitPrice: l.unitPrice,
    qty: l.qty,
    lineTotal: l.lineTotal,
  }));

  const saleData = await airtableFetch(VENTAS_TABLE, {
    method: "POST",
    body: JSON.stringify({
      records: [
        {
          fields: {
            Fecha: ts,
            Method: method,
            Subtotal: subtotal,
            IVA: iva,
            Total: total,
            Received: receivedAmount,
            ItemsJSON: JSON.stringify(itemsForJson),
          },
        },
      ],
    }),
  });
  const saleRecord = saleData.records[0];

  for (let i = 0; i < lines.length; i += 10) {
    const batch = lines.slice(i, i + 10).map((l) => ({
      fields: {
        Name: `${l.name} x${l.qty}`,
        Venta: [saleRecord.id],
        Producto: [l.productRecordId],
        Qty: l.qty,
        UnitPrice: l.unitPrice,
        LineTotal: l.lineTotal,
      },
    }));
    await airtableFetch(VENTAITEMS_TABLE, {
      method: "POST",
      body: JSON.stringify({ records: batch }),
    });
  }

  return {
    id: saleRecord.fields.Ticket,
    ts,
    method,
    subtotal,
    iva,
    total,
    received: receivedAmount,
    change: method === "Efectivo" ? receivedAmount - total : 0,
    items: itemsForJson,
  };
}

module.exports = {
  getProducts,
  getTodaySales,
  getAllSales,
  createSale,
  getProductByBarcode,
  createProduct,
  updateProductPrice,
  updateProductPriceByBarcode,
};
