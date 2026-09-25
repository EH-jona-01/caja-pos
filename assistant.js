const airtable = require("./airtable");
const analytics = require("./analytics");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

function money(n) {
  return "$" + Math.round(n).toLocaleString("es-AR");
}

async function buildContext() {
  const [data, semana, products] = await Promise.all([
    analytics.getAnalytics({ days: null }),
    analytics.getAnalytics({ days: 7 }),
    airtable.getProducts(),
  ]);

  const now = new Date();
  const hoy =
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0");
  const ventasHoy = data.byDay.find((d) => d.date === hoy) || { total: 0, tickets: 0 };

  const lines = [];
  lines.push("Sos el asistente de datos de un kiosco/almacén que usa este punto de venta.");
  lines.push("Respondé en español rioplatense, corto y concreto, basándote SOLO en los datos de abajo.");
  lines.push("Si te preguntan algo que estos datos no permiten responder, decilo en vez de inventar.");
  lines.push("Usá números y nombres puntuales. No uses tablas markdown, el chat es angosto.");
  lines.push("Cuando detectes algo accionable (un producto que no rota, un horario flojo, un rubro fuerte), decilo.");
  lines.push("");
  lines.push(`FECHA DE HOY: ${hoy}`);
  lines.push("");
  lines.push(
    `TOTAL HISTÓRICO: ${data.summary.tickets} tickets, ${money(data.summary.totalVentas)} facturados, ticket promedio ${money(data.summary.ticketPromedio)}, ${data.summary.itemsVendidos} unidades vendidas.`
  );
  lines.push(`HOY: ${money(ventasHoy.total)} en ${ventasHoy.tickets} tickets.`);
  lines.push(
    `ÚLTIMOS 7 DÍAS: ${money(semana.summary.totalVentas)} en ${semana.summary.tickets} tickets (ticket promedio ${money(semana.summary.ticketPromedio)}).`
  );
  if (semana.growth && semana.growth.ventas !== null) {
    lines.push(
      `CRECIMIENTO vs los 7 días anteriores: ${semana.growth.ventas > 0 ? "+" : ""}${semana.growth.ventas}% en facturación, ${semana.growth.tickets > 0 ? "+" : ""}${semana.growth.tickets}% en cantidad de tickets.`
    );
  }
  lines.push("");
  lines.push("VENTAS POR MÉTODO DE PAGO (histórico):");
  data.byMethod.forEach((m) => lines.push(`- ${m.method}: ${money(m.total)} en ${m.tickets} tickets`));
  lines.push("");
  lines.push("VENTAS POR RUBRO (histórico):");
  data.byCategory.forEach((c) => lines.push(`- ${c.category}: ${money(c.total)}, ${c.qty} unidades`));
  lines.push("");
  lines.push("VENTAS POR DÍA (últimos días):");
  data.byDay.slice(-21).forEach((d) => lines.push(`- ${d.date}: ${money(d.total)} en ${d.tickets} tickets`));
  lines.push("");
  lines.push("VENTAS POR HORA (histórico, para detectar horarios pico):");
  data.byHour
    .filter((h) => h.tickets > 0)
    .forEach((h) => lines.push(`- ${String(h.hour).padStart(2, "0")}hs: ${money(h.total)} en ${h.tickets} tickets`));
  lines.push("");
  lines.push("PRODUCTOS MÁS VENDIDOS:");
  data.topProducts.forEach((p) => lines.push(`- ${p.name} (${p.category}): ${p.qty} unidades, ${money(p.revenue)}`));
  lines.push("");
  lines.push("PRODUCTOS QUE MENOS ROTAN (con al menos una venta):");
  data.worstProducts.forEach((p) => lines.push(`- ${p.name} (${p.category}): ${p.qty} unidades, ${money(p.revenue)}`));
  if (data.sinVentas.length) {
    lines.push("");
    lines.push("PRODUCTOS SIN NINGUNA VENTA:");
    data.sinVentas.forEach((p) => lines.push(`- ${p.name} (${p.category}), precio ${money(p.price)}`));
  }
  lines.push("");
  lines.push("CATÁLOGO COMPLETO (nombre | rubro | precio):");
  products.forEach((p) => lines.push(`- ${p.name} | ${p.category} | ${money(p.price)}`));

  return lines.join("\n");
}

async function ask(message, history = []) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("Falta ANTHROPIC_API_KEY en pos-app/.env para activar el asistente.");
    err.status = 501;
    throw err;
  }

  const system = await buildContext();

  const messages = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-10)
    .concat([{ role: "user", content: message }]);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system,
      messages,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(data.error ? data.error.message : "Error consultando a Claude.");
    err.status = 502;
    throw err;
  }

  const text = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return text;
}

// Clasifica un producto en uno de los rubros del comercio. Se usa sólo cuando el
// mapeo por palabras clave no alcanzó; si no hay API key, devuelve null y el
// formulario queda con el rubro sin preseleccionar.
async function classifyProduct(name, rubros) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !name || !rubros.length) return null;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 20,
        system:
          "Clasificás productos de kiosco/almacén. Respondé únicamente con uno de los rubros " +
          "de la lista, exactamente como está escrito, sin explicaciones ni puntuación.",
        messages: [
          {
            role: "user",
            content: `Producto: "${name}"\nRubros disponibles: ${rubros.join(", ")}\n\nRubro:`,
          },
        ],
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return rubros.find((r) => r.toLowerCase() === text.toLowerCase()) || null;
  } catch (err) {
    return null;
  }
}

module.exports = { ask, classifyProduct };
