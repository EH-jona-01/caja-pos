// Busca los datos de un producto por código de barras en las bases abiertas
// de Open Food Facts y sus hermanas (cosmética y productos generales).

const SOURCES = [
  "https://world.openfoodfacts.org/api/v2/product/",
  "https://world.openproductsfacts.org/api/v2/product/",
  "https://world.openbeautyfacts.org/api/v2/product/",
];

const FIELDS = "product_name,product_name_es,generic_name,brands,quantity,categories_tags";

// Los tags de categoría vienen en inglés; se mapean a los rubros del comercio.
const RUBRO_KEYWORDS = [
  ["Cigarrillos", ["tobacco", "cigarette", "cigar"]],
  // Las galletitas van antes que Golosinas: si no, "galletitas de chocolate"
  // matchearía con chocolate y caería en el rubro equivocado.
  ["Snacks", ["biscuit", "cookie", "cracker", "wafer"]],
  [
    "Bebidas",
    ["beverage", "drink", "water", "soda", "juice", "beer", "wine", "energy-drink",
     "iced-tea", "soft-drink", "cola", "lemonade", "infusion"],
  ],
  [
    "Golosinas",
    ["candy", "candies", "chocolate", "sweet", "confectionery", "confectioneries",
     "chewing-gum", "bonbon", "lollipop", "caramel", "alfajor", "marshmallow"],
  ],
  [
    "Snacks",
    ["snack", "crisp", "chip", "biscuit", "cookie", "cracker", "nut", "popcorn",
     "cereal-bar", "appetizer", "salty"],
  ],
  [
    "Limpieza",
    ["cleaning", "household", "detergent", "hygiene", "soap", "toilet-paper", "bleach",
     "beauty", "cosmetic", "shampoo", "battery", "batteries"],
  ],
  [
    "Almacén",
    ["grocery", "groceries", "pasta", "rice", "oil", "dairy", "milk", "sugar", "coffee",
     "tea", "yerba", "mate", "bread", "flour", "canned", "sauce", "cereal", "spread",
     "breakfast", "yogurt", "cheese", "egg", "meat", "frozen"],
  ],
];

function classify(tags) {
  const haystack = (tags || []).join(" ").toLowerCase();
  for (const [rubro, keywords] of RUBRO_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k))) return rubro;
  }
  return null;
}

// "Coca-Cola" y "Coca Cola" son la misma marca: se comparan sin guiones ni acentos
// para no terminar con el nombre repetido.
function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function buildName(p) {
  const base = (p.product_name_es || p.product_name || p.generic_name || "").trim();
  if (!base) return null;

  const brand = (p.brands || "").split(",")[0].trim();
  // El "e" suelto del final es la marca de estimación europea, no parte del nombre.
  const quantity = (p.quantity || "").trim().replace(/\s*e$/i, "");

  let name = base;
  if (brand && !normalize(base).includes(normalize(brand))) {
    name = brand + " " + base;
  }
  if (quantity && !normalize(name).includes(normalize(quantity))) {
    name += " " + quantity;
  }
  return name.replace(/\s+/g, " ").trim().slice(0, 80);
}

async function fetchFrom(baseUrl, barcode, signal) {
  const resp = await fetch(`${baseUrl}${encodeURIComponent(barcode)}.json?fields=${FIELDS}`, {
    signal,
    headers: { "User-Agent": "CajaPOS/1.0 (demo punto de venta)" },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.status !== 1 || !data.product) return null;
  return data.product;
}

async function lookupBarcode(barcode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const results = await Promise.allSettled(
      SOURCES.map((src) => fetchFrom(src, barcode, controller.signal))
    );

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const name = buildName(r.value);
      if (!name) continue;
      return {
        found: true,
        name,
        category: classify(r.value.categories_tags),
        brand: (r.value.brands || "").split(",")[0].trim() || null,
        source: "Open Food Facts",
      };
    }
    return { found: false };
  } catch (err) {
    return { found: false };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { lookupBarcode, classify };
