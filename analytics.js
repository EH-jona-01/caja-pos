const airtable = require("./airtable");

// Los timestamps se guardan en UTC; agrupar por día tiene que usar la zona local
// del comercio o las ventas de la tarde caen en el día siguiente.
function localDay(iso) {
  const d = new Date(iso);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function daysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

function aggregate(sales) {
  const total = sales.reduce((sum, s) => sum + s.total, 0);
  return {
    totalVentas: total,
    tickets: sales.length,
    ticketPromedio: sales.length ? Math.round(total / sales.length) : 0,
    itemsVendidos: sales.reduce((sum, s) => sum + s.items.reduce((n, i) => n + i.qty, 0), 0),
  };
}

function pctChange(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function getAnalytics({ days } = {}) {
  const [allSales, products] = await Promise.all([airtable.getAllSales(), airtable.getProducts()]);

  const from = days ? daysAgo(days) : null;
  const sales = from ? allSales.filter((s) => new Date(s.ts) >= from) : allSales;

  // Período anterior del mismo largo, para medir crecimiento
  let previousSales = [];
  if (days) {
    const prevFrom = daysAgo(days * 2);
    previousSales = allSales.filter((s) => {
      const t = new Date(s.ts);
      return t >= prevFrom && t < from;
    });
  }

  const summary = aggregate(sales);
  const previous = aggregate(previousSales);
  const growth = days
    ? {
        ventas: pctChange(summary.totalVentas, previous.totalVentas),
        tickets: pctChange(summary.tickets, previous.tickets),
        ticketPromedio: pctChange(summary.ticketPromedio, previous.ticketPromedio),
        previousTotal: previous.totalVentas,
      }
    : null;

  const methodMap = {};
  const dayMap = {};
  const hourMap = {};
  const categoryMap = {};
  const productStats = {};

  products.forEach((p) => {
    productStats[p.id] = {
      productId: p.id,
      name: p.name,
      category: p.category || "Sin rubro",
      price: p.price,
      qty: 0,
      revenue: 0,
    };
  });

  for (let h = 8; h <= 22; h++) hourMap[h] = { hour: h, total: 0, tickets: 0 };

  sales.forEach((s) => {
    if (!methodMap[s.method]) methodMap[s.method] = { method: s.method, total: 0, tickets: 0 };
    methodMap[s.method].total += s.total;
    methodMap[s.method].tickets += 1;

    const day = localDay(s.ts);
    if (!dayMap[day]) dayMap[day] = { date: day, total: 0, tickets: 0 };
    dayMap[day].total += s.total;
    dayMap[day].tickets += 1;

    const hour = new Date(s.ts).getHours();
    if (!hourMap[hour]) hourMap[hour] = { hour, total: 0, tickets: 0 };
    hourMap[hour].total += s.total;
    hourMap[hour].tickets += 1;

    s.items.forEach((item) => {
      if (!productStats[item.productId]) {
        productStats[item.productId] = {
          productId: item.productId,
          name: item.name,
          category: "Sin rubro",
          price: item.unitPrice,
          qty: 0,
          revenue: 0,
        };
      }
      const stat = productStats[item.productId];
      stat.qty += item.qty;
      stat.revenue += item.lineTotal;

      const cat = stat.category;
      if (!categoryMap[cat]) categoryMap[cat] = { category: cat, total: 0, qty: 0 };
      categoryMap[cat].total += item.lineTotal;
      categoryMap[cat].qty += item.qty;
    });
  });

  const ranked = Object.values(productStats).sort((a, b) => b.revenue - a.revenue);
  const vendidos = ranked.filter((p) => p.qty > 0);
  const sinVentas = ranked.filter((p) => p.qty === 0);

  return {
    rangeDays: days || null,
    summary,
    growth,
    byMethod: Object.values(methodMap).sort((a, b) => b.total - a.total),
    byDay: Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)),
    byHour: Object.values(hourMap).sort((a, b) => a.hour - b.hour),
    byCategory: Object.values(categoryMap).sort((a, b) => b.total - a.total),
    topProducts: vendidos.slice(0, 6),
    worstProducts: vendidos.slice(-6).reverse(),
    sinVentas: sinVentas.slice(0, 8).map((p) => ({ name: p.name, category: p.category, price: p.price })),
  };
}

module.exports = { getAnalytics };
