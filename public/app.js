(function () {
  "use strict";

  // ═══════════ Estado ═══════════
  var state = {
    products: [],
    cart: {},            // productId -> qty
    method: "Efectivo",
    activeCat: "Todos",
    search: "",
    tab: "vender",
    scanMode: "vender",
    analytics: null,
    rangeDays: 7,
    chatHistory: [],
    cam: { stream: null, decoder: null, timer: null, running: false, lastCode: null, lastAt: 0 },
  };
  var charts = {};

  // ═══════════ Utilidades ═══════════
  function money(n) {
    return "$" + Math.round(n || 0).toLocaleString("es-MX");
  }
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function toast(text, kind) {
    var stack = el("toastStack");
    var t = document.createElement("div");
    t.className = "toast" + (kind ? " " + kind : "");
    t.textContent = text;
    stack.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .25s ease";
      t.style.opacity = "0";
      setTimeout(function () { t.remove(); }, 260);
    }, 2200);
  }

  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms || 40); } catch (e) {} }
  }

  // ═══════════ Persistencia local (modo offline) ═══════════
  var LS_QUEUE = "caja.pendingSales";
  var LS_PRODUCTS = "caja.products";

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function pendingSales() { return lsGet(LS_QUEUE, []); }
  function setPendingSales(list) { lsSet(LS_QUEUE, list); }

  var audioCtx = null;
  function beep(ok) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.frequency.value = ok ? 880 : 240;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.14);
      osc.start(); osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {}
  }

  // ═══════════ Navegación por tabs ═══════════
  var TABS = ["vender", "escanear", "reportes", "asistente"];

  function setTab(tab) {
    if (TABS.indexOf(tab) === -1) tab = "vender";
    state.tab = tab;
    if (location.hash.slice(1) !== tab) history.replaceState(null, "", "#" + tab);
    document.querySelectorAll(".view").forEach(function (v) {
      v.hidden = v.dataset.view !== tab;
    });
    document.querySelectorAll("#tabbar button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.tab === tab ? "true" : "false");
    });
    window.scrollTo({ top: 0 });

    if (tab !== "escanear") stopCamera();
    if (tab === "reportes") loadAnalytics(state.rangeDays);
    if (tab === "asistente") el("chatInput").focus();
  }

  el("tabbar").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-tab]");
    if (btn) setTab(btn.dataset.tab);
  });

  // ═══════════ Catálogo ═══════════
  function categories() {
    var out = [], seen = {};
    state.products.forEach(function (p) {
      var c = p.category || "Sin categoría";
      if (!seen[c]) { seen[c] = 1; out.push(c); }
    });
    return out.sort();
  }

  function renderChips() {
    var wrap = el("catChips");
    var cats = ["Todos"].concat(categories());
    wrap.innerHTML = cats.map(function (c) {
      return '<button type="button" data-cat="' + esc(c) + '" aria-pressed="' +
        (c === state.activeCat ? "true" : "false") + '">' + esc(c) + "</button>";
    }).join("");
  }

  el("catChips").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-cat]");
    if (!btn) return;
    state.activeCat = btn.dataset.cat;
    renderChips();
    renderGrid();
  });

  el("searchInput").addEventListener("input", function () {
    state.search = this.value.trim().toLowerCase();
    renderGrid();
  });

  function visibleProducts() {
    return state.products.filter(function (p) {
      var catOk = state.activeCat === "Todos" || (p.category || "Sin categoría") === state.activeCat;
      if (!catOk) return false;
      if (!state.search) return true;
      return (p.name || "").toLowerCase().indexOf(state.search) !== -1 ||
             (p.barcode || "").indexOf(state.search) !== -1;
    });
  }

  function renderGrid() {
    var grid = el("productGrid");
    var list = visibleProducts();
    el("gridEmpty").hidden = list.length > 0;

    grid.innerHTML = list.map(function (p) {
      var qty = state.cart[p.id] || 0;
      return '<button type="button" class="prod" data-id="' + esc(p.id) + '">' +
        (qty ? '<span class="pqty">' + qty + "</span>" : "") +
        '<span class="pname">' + esc(p.name) + "</span>" +
        '<span class="prow"><span class="pprice">' + money(p.price) + "</span>" +
        '<span class="pcat">' + esc(p.category || "") + "</span></span>" +
        "</button>";
    }).join("");
  }

  el("productGrid").addEventListener("click", function (e) {
    var btn = e.target.closest(".prod");
    if (!btn) return;
    addToCart(btn.dataset.id, 1, true);
  });

  // ═══════════ Carrito ═══════════
  function productById(id) {
    return state.products.filter(function (p) { return p.id === id; })[0];
  }

  function cartLines() {
    return Object.keys(state.cart)
      .filter(function (id) { return state.cart[id] > 0; })
      .map(function (id) {
        var p = productById(id);
        if (!p) return null;
        return { p: p, qty: state.cart[id], lineTotal: p.price * state.cart[id] };
      })
      .filter(Boolean);
  }

  function cartTotal() {
    return cartLines().reduce(function (s, l) { return s + l.lineTotal; }, 0);
  }

  function cartCount() {
    return cartLines().reduce(function (s, l) { return s + l.qty; }, 0);
  }

  function addToCart(id, qty, notify) {
    var p = productById(id);
    if (!p) return;
    state.cart[id] = (state.cart[id] || 0) + (qty || 1);
    buzz(25);
    if (notify) toast(p.name + " · " + money(p.price), "ok");
    renderGrid();
    renderCartBar();
    if (document.querySelector(".sheet .cart-lines")) renderCartSheet();
  }

  function renderCartBar() {
    var bar = el("cartBar");
    var n = cartCount();
    bar.hidden = n === 0;
    el("cartCount").textContent = n;
    el("cartTotal").textContent = money(cartTotal());
  }

  el("cartBar").addEventListener("click", openCartSheet);

  // ═══════════ Sheets ═══════════
  function openSheet(html, onMount) {
    closeSheet();
    var root = el("sheetRoot");
    var back = document.createElement("div");
    back.className = "sheet-backdrop";
    back.innerHTML = '<div class="sheet"><div class="sheet-grip"></div>' + html + "</div>";
    root.appendChild(back);
    back.addEventListener("click", function (e) { if (e.target === back) closeSheet(); });
    if (onMount) onMount(back.querySelector(".sheet"));
  }
  function closeSheet() { el("sheetRoot").innerHTML = ""; }

  var PAY_ICONS = {
    Efectivo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
    Tarjeta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
    Transferencia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h16l-3-3M20 16H4l3 3"/></svg>',
  };

  function openCartSheet() {
    openSheet(
      '<div class="sheet-head"><div><h2>Ticket</h2>' +
      '<span class="sub" id="sheetSub"></span></div>' +
      '<button type="button" class="btn subtle" id="clearCart">Vaciar</button></div>' +
      '<div class="cart-lines" id="cartLines"></div>' +
      '<div class="totals" id="cartTotals"></div>' +
      '<div class="pay-methods" id="payMethods">' +
      ["Efectivo", "Tarjeta", "Transferencia"].map(function (m) {
        return '<button type="button" data-method="' + m + '" aria-pressed="' +
          (state.method === m ? "true" : "false") + '">' + PAY_ICONS[m] + "<span>" + m + "</span></button>";
      }).join("") +
      "</div>" +
      '<div class="cash-box" id="cashBox">' +
      '<div class="quick-cash" id="quickCash"></div>' +
      '<div class="field"><input type="number" id="cashInput" class="mono" inputmode="numeric" placeholder="¿Con cuánto paga?" min="0" step="100"></div>' +
      '<div class="change-row" id="changeRow"><span>Vuelto</span><b class="mono" id="changeVal">$0</b></div>' +
      "</div>" +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn primary big" id="chargeBtn">Cobrar</button>' +
      '<button type="button" class="btn subtle" id="keepSelling">Seguir cargando</button>' +
      "</div>",
      function () {
        renderCartSheet();
        el("clearCart").addEventListener("click", function () {
          state.cart = {};
          renderGrid(); renderCartBar(); closeSheet();
          toast("Ticket vaciado");
        });
        el("keepSelling").addEventListener("click", closeSheet);
        el("payMethods").addEventListener("click", function (e) {
          var b = e.target.closest("button[data-method]");
          if (!b) return;
          state.method = b.dataset.method;
          document.querySelectorAll("#payMethods button").forEach(function (x) {
            x.setAttribute("aria-pressed", x === b ? "true" : "false");
          });
          renderCashBox();
        });
        el("cashInput").addEventListener("input", renderChange);
        el("chargeBtn").addEventListener("click", charge);
        el("cartLines").addEventListener("click", function (e) {
          var b = e.target.closest("button[data-act]");
          if (!b) return;
          var id = b.dataset.id;
          if (b.dataset.act === "inc") state.cart[id] = (state.cart[id] || 0) + 1;
          else state.cart[id] = Math.max(0, (state.cart[id] || 0) - 1);
          buzz(18);
          renderGrid(); renderCartBar();
          if (cartCount() === 0) { closeSheet(); return; }
          renderCartSheet();
        });
      }
    );
  }

  function renderCartSheet() {
    var lines = cartLines();
    var linesEl = el("cartLines");
    if (!linesEl) return;

    linesEl.innerHTML = lines.map(function (l) {
      return '<div class="cart-line">' +
        '<div><div class="cl-name">' + esc(l.p.name) + "</div>" +
        '<div class="cl-unit">' + money(l.p.price) + " c/u</div></div>" +
        '<div class="stepper">' +
        '<button type="button" data-act="dec" data-id="' + esc(l.p.id) + '" aria-label="Quitar uno">−</button>' +
        '<span class="mono">' + l.qty + "</span>" +
        '<button type="button" data-act="inc" data-id="' + esc(l.p.id) + '" aria-label="Agregar uno">+</button>' +
        "</div>" +
        '<div class="cl-total">' + money(l.lineTotal) + "</div>" +
        "</div>";
    }).join("");

    var total = cartTotal();
    var neto = Math.round(total / 1.16);
    el("sheetSub").textContent = cartCount() + (cartCount() === 1 ? " ítem" : " ítems");
    el("cartTotals").innerHTML =
      '<div class="trow"><span>Neto</span><span class="mono">' + money(neto) + "</span></div>" +
      '<div class="trow"><span>IVA 16% (incluido)</span><span class="mono">' + money(total - neto) + "</span></div>" +
      '<div class="trow grand"><span>Total</span><span class="mono">' + money(total) + "</span></div>";

    renderCashBox();
  }

  function renderCashBox() {
    var box = el("cashBox");
    if (!box) return;
    var isCash = state.method === "Efectivo";
    box.hidden = !isCash;
    if (!isCash) return;

    var total = cartTotal();
    var suggestions = [total];
    [1000, 2000, 5000, 10000, 20000].forEach(function (b) {
      var up = Math.ceil(total / b) * b;
      if (up > total && suggestions.indexOf(up) === -1 && suggestions.length < 4) suggestions.push(up);
    });

    el("quickCash").innerHTML = suggestions.map(function (v, i) {
      return '<button type="button" data-cash="' + v + '">' + (i === 0 ? "Justo" : money(v)) + "</button>";
    }).join("");

    el("quickCash").onclick = function (e) {
      var b = e.target.closest("button[data-cash]");
      if (!b) return;
      el("cashInput").value = b.dataset.cash;
      renderChange();
    };
    renderChange();
  }

  function renderChange() {
    var row = el("changeRow");
    if (!row) return;
    var received = parseFloat(el("cashInput").value) || 0;
    var diff = received - cartTotal();
    row.classList.toggle("short", diff < 0);
    row.querySelector("span").textContent = diff < 0 ? "Falta" : "Vuelto";
    el("changeVal").textContent = money(Math.abs(diff));
  }

  async function charge() {
    var lines = cartLines();
    if (!lines.length) return;

    var btn = el("chargeBtn");
    var payload = {
      items: lines.map(function (l) { return { productId: l.p.id, qty: l.qty }; }),
      method: state.method,
    };
    if (state.method === "Efectivo") {
      payload.received = parseFloat(el("cashInput").value) || cartTotal();
      if (payload.received < cartTotal()) {
        toast("El monto recibido es menor al total", "err");
        el("cashInput").focus();
        return;
      }
    }

    btn.disabled = true;
    btn.textContent = "Cobrando...";

    var total = cartTotal();
    var neto = Math.round(total / 1.16);

    try {
      var resp = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var sale = await resp.json();
      if (!resp.ok) {
        // Error de negocio (ej. producto inválido): no tiene sentido encolarlo.
        toast(sale.error || "No se pudo cobrar", "err");
        btn.disabled = false; btn.textContent = "Cobrar";
        return;
      }
      markServer(true);
      finishSale(sale);
      refreshToday();
    } catch (err) {
      markServer(false);
      // Sin conexión: la venta se guarda en el celular y se sube después.
      var offlineSale = {
        offline: true,
        localId: Date.now(),
        payload: payload,
        ts: new Date().toISOString(),
        method: state.method,
        subtotal: neto,
        iva: total - neto,
        total: total,
        received: payload.received || total,
        change: state.method === "Efectivo" ? (payload.received || total) - total : 0,
        items: lines.map(function (l) {
          return {
            productId: l.p.id, name: l.p.name,
            unitPrice: l.p.price, qty: l.qty, lineTotal: l.lineTotal,
          };
        }),
      };
      var queue = pendingSales();
      queue.push(offlineSale);
      setPendingSales(queue);
      finishSale(offlineSale);
      renderConnState();
    }
  }

  function finishSale(sale) {
    state.cart = {};
    renderGrid(); renderCartBar();
    beep(true); buzz([30, 50, 30]);
    showTicket(sale);
    state.analytics = null;
  }

  function showTicket(sale) {
    var ts = new Date(sale.ts);
    openSheet(
      '<div class="ticket">' +
      '<div class="ticket-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5.5 5.5L20 7"/></svg></div>' +
      "<h2>" + money(sale.total) + "</h2>" +
      '<div class="t-sub">Cobrado con ' + esc(sale.method) +
      (sale.method === "Efectivo" && sale.change > 0 ? " · vuelto " + money(sale.change) : "") + "</div>" +
      (sale.offline
        ? '<div class="offline-note">Guardada en el celular. Se registra sola cuando vuelva la conexión.</div>'
        : "") +
      '<div class="ticket-paper">' +
      '<div class="tp-line tp-muted"><span>' +
      (sale.offline ? "Ticket pendiente" : "Ticket #" + String(sale.id).padStart(4, "0")) +
      "</span><span>" +
      ts.toLocaleDateString("es-MX") + " " + ts.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) + "</span></div>" +
      sale.items.map(function (i) {
        return '<div class="tp-line"><span>' + i.qty + "× " + esc(i.name) + "</span><span>" + money(i.lineTotal) + "</span></div>";
      }).join("") +
      '<div class="tp-line tp-muted" style="margin-top:7px"><span>Neto</span><span>' + money(sale.subtotal) + "</span></div>" +
      '<div class="tp-line tp-muted"><span>IVA 16%</span><span>' + money(sale.iva) + "</span></div>" +
      '<div class="tp-line total"><span>Total</span><span>' + money(sale.total) + "</span></div>" +
      "</div>" +
      '<button type="button" class="btn mint big" id="newSale">Nueva venta</button>' +
      "</div>",
      function () {
        el("newSale").addEventListener("click", function () {
          closeSheet();
          setTab("vender");
        });
      }
    );
  }

  // ═══════════ Escáner ═══════════
  el("scanModes").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-mode]");
    if (!b) return;
    state.scanMode = b.dataset.mode;
    document.querySelectorAll("#scanModes button").forEach(function (x) {
      x.setAttribute("aria-pressed", x === b ? "true" : "false");
    });
    el("scanPanel").innerHTML = "";
  });

  el("quickScanBtn").addEventListener("click", function () {
    setTab("escanear");
    startCamera();
  });

  el("camToggleBtn").addEventListener("click", function () {
    if (state.cam.running) stopCamera(); else startCamera();
  });

  el("manualBtn").addEventListener("click", function () {
    var code = el("manualCode").value.trim();
    if (code) handleCode(code);
  });
  el("manualCode").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      var code = this.value.trim();
      if (code) handleCode(code);
    }
  });

  var ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("No se pudo descargar el lector de códigos.")); };
      document.head.appendChild(s);
    });
  }

  // Safari (iPhone), Firefox y Chrome de escritorio en Windows no traen BarcodeDetector,
  // así que se cae a ZXing, que corre en cualquier navegador con cámara.
  async function buildDecoder() {
    if ("BarcodeDetector" in window) {
      try {
        var formats = await window.BarcodeDetector.getSupportedFormats();
        var want = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar"]
          .filter(function (f) { return formats.indexOf(f) !== -1; });
        if (want.length) {
          return { kind: "native", detector: new window.BarcodeDetector({ formats: want }) };
        }
      } catch (e) { /* seguimos con ZXing */ }
    }

    if (!window.ZXing) {
      el("scanHint").textContent = "Preparando el lector de códigos...";
      await loadScript(ZXING_URL);
    }

    var hints = new Map();
    hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      window.ZXing.BarcodeFormat.EAN_13,
      window.ZXing.BarcodeFormat.EAN_8,
      window.ZXing.BarcodeFormat.UPC_A,
      window.ZXing.BarcodeFormat.UPC_E,
      window.ZXing.BarcodeFormat.CODE_128,
      window.ZXing.BarcodeFormat.CODE_39,
      window.ZXing.BarcodeFormat.ITF,
    ]);
    hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);

    // MultiFormatOneDReader sólo busca códigos de barras lineales: bastante más
    // rápido que el lector genérico, que además prueba QR y matriciales.
    var reader = new window.ZXing.MultiFormatOneDReader(hints);
    return { kind: "zxing", reader: reader, canvas: document.createElement("canvas"), tick: 0 };
  }

  async function startCamera() {
    if (state.cam.running) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el("scanHint").textContent =
        "La cámara necesita una conexión segura (https). Usá el campo de abajo mientras tanto.";
      el("manualCode").focus();
      return;
    }

    var btn = el("camToggleBtn");
    btn.disabled = true;
    btn.textContent = "Abriendo cámara...";

    try {
      state.cam.decoder = await buildDecoder();
    } catch (err) {
      el("scanHint").textContent = err.message + " Podés escribir el código abajo.";
      btn.disabled = false;
      btn.textContent = "Activar cámara";
      return;
    }

    try {
      state.cam.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (err) {
      var msg = err.name === "NotAllowedError"
        ? "Diste permiso denegado a la cámara. Habilitala para este sitio desde los ajustes del navegador."
        : err.name === "NotFoundError"
        ? "Este dispositivo no tiene cámara disponible."
        : "No se pudo abrir la cámara: " + err.message;
      el("scanHint").textContent = msg;
      btn.disabled = false;
      btn.textContent = "Activar cámara";
      return;
    }

    var video = el("camVideo");
    video.srcObject = state.cam.stream;
    video.setAttribute("playsinline", "");
    try { await video.play(); } catch (e) { /* iOS puede rechazar sin gesto */ }

    el("camBox").classList.add("live");
    btn.disabled = false;
    btn.textContent = "Apagar cámara";
    el("scanHint").textContent = "Apunta al código de barras. Se carga solo al detectarlo.";
    state.cam.running = true;

    if (state.cam.decoder.kind === "native") {
      requestAnimationFrame(scanTickNative);
    } else {
      // ZXing decodifica de forma sincrónica: a intervalo fijo para no trabar el celular.
      state.cam.timer = setInterval(scanTickZXing, 90);
    }
  }

  function stopCamera() {
    state.cam.running = false;
    if (state.cam.timer) { clearInterval(state.cam.timer); state.cam.timer = null; }
    if (state.cam.stream) {
      state.cam.stream.getTracks().forEach(function (t) { t.stop(); });
      state.cam.stream = null;
    }
    var box = el("camBox");
    if (box) box.classList.remove("live");
    var btn = el("camToggleBtn");
    if (btn) { btn.disabled = false; btn.textContent = "Activar cámara"; }
  }

  function onCodeDetected(value) {
    var now = Date.now();
    // Evitar re-lecturas del mismo código en ráfaga
    if (value === state.cam.lastCode && now - state.cam.lastAt < 2500) return;
    state.cam.lastCode = value;
    state.cam.lastAt = now;
    handleCode(value);
  }

  async function scanTickNative() {
    if (!state.cam.running) return;
    var video = el("camVideo");
    if (video && video.readyState >= 2) {
      try {
        var codes = await state.cam.decoder.detector.detect(video);
        if (codes.length) onCodeDetected(codes[0].rawValue);
      } catch (e) { /* frame ilegible, seguimos */ }
    }
    requestAnimationFrame(scanTickNative);
  }

  function decodeCanvas(decoder, canvas) {
    try {
      var source = new window.ZXing.HTMLCanvasElementLuminanceSource(canvas);
      var bitmap = new window.ZXing.BinaryBitmap(new window.ZXing.HybridBinarizer(source));
      var result = decoder.reader.decode(bitmap);
      return result ? result.getText() : null;
    } catch (e) {
      return null; // NotFoundException: este frame no tiene un código legible
    } finally {
      decoder.reader.reset();
    }
  }

  function scanTickZXing() {
    if (!state.cam.running) return;
    var video = el("camVideo");
    if (!video || video.readyState < 2 || !video.videoWidth) return;

    var d = state.cam.decoder;
    var canvas = d.canvas;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var vw = video.videoWidth, vh = video.videoHeight;

    // La mayoría de los ciclos mira sólo la franja del retículo, que es donde el
    // usuario apoya el código: menos píxeles y sin fondo que confunda. Cada cuarto
    // ciclo revisa el cuadro entero por si apuntó descentrado.
    d.tick = (d.tick + 1) % 4;
    var roi = d.tick !== 0;

    var sx = roi ? vw * 0.08 : 0;
    var sy = roi ? vh * 0.28 : 0;
    var sw = roi ? vw * 0.84 : vw;
    var sh = roi ? vh * 0.44 : vh;

    var targetW = 800;
    var scale = Math.min(1.6, targetW / sw);
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    var code = decodeCanvas(d, canvas);
    if (code) onCodeDetected(code);
  }

  async function handleCode(code) {
    el("manualCode").value = "";
    var known = state.products.filter(function (p) { return p.barcode === code || p.id === code; })[0];

    if (state.scanMode === "vender") {
      if (known) {
        beep(true);
        addToCart(known.id, 1, true);
        renderScanPanel(known, code);
      } else {
        beep(false); buzz([40, 60, 40]);
        renderNewProductForm(code);
      }
      return;
    }

    // Modo alta
    if (known) {
      beep(true);
      renderScanPanel(known, code, true);
    } else {
      beep(false);
      renderNewProductForm(code);
    }
  }

  function renderScanPanel(product, code, editable) {
    el("scanPanel").innerHTML =
      '<div class="scan-result found">' +
      '<div class="sr-head"><div>' +
      '<div class="sr-title">' + esc(product.name) + "</div>" +
      '<div class="sr-meta">' + esc(product.category || "") + " · " + esc(code) + "</div>" +
      "</div><span class=\"sr-badge ok\">En catálogo</span></div>" +
      '<div class="sr-price">' + money(product.price) + "</div>" +
      (editable
        ? '<div class="field"><label for="editPrice">Actualizar precio</label>' +
          '<input type="number" id="editPrice" class="mono" value="' + product.price + '" min="1" step="50"></div>' +
          '<button type="button" class="btn primary" id="savePrice">Guardar precio</button>'
        : '<button type="button" class="btn mint" id="addAgain">Agregar otra unidad</button>') +
      "</div>";

    if (editable) {
      el("savePrice").addEventListener("click", async function () {
        var price = parseFloat(el("editPrice").value);
        this.disabled = true;
        try {
          var resp = await fetch("/api/products/barcode/" + encodeURIComponent(code), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ price: price }),
          });
          var data = await resp.json();
          if (!resp.ok) { toast(data.error, "err"); this.disabled = false; return; }
          toast("Precio actualizado a " + money(data.price), "ok");
          await loadProducts();
          el("scanPanel").innerHTML = "";
        } catch (e) {
          toast("Sin conexión con el servidor", "err");
          this.disabled = false;
        }
      });
    } else {
      el("addAgain").addEventListener("click", function () {
        addToCart(product.id, 1, true);
      });
    }
  }

  async function renderNewProductForm(code) {
    // Mientras se consulta afuera, se muestra el formulario ya abierto para no
    // dejar la pantalla en blanco.
    el("scanPanel").innerHTML =
      '<div class="scan-result new"><div class="sr-head"><div>' +
      '<div class="sr-title">Buscando el producto...</div>' +
      '<div class="sr-meta mono">' + esc(code) + "</div>" +
      '</div><span class="sr-badge new">Sin registrar</span></div>' +
      '<div class="lookup-loading"><span class="spinner"></span>Consultando la base de códigos de barras</div></div>';

    var info = { found: false };
    try {
      var resp = await fetch("/api/products/lookup/" + encodeURIComponent(code));
      if (resp.ok) info = await resp.json();
    } catch (e) { /* sin conexión: se completa a mano */ }

    // Si mientras tanto se escaneó otra cosa, no pisar lo que haya ahora
    if (state.cam.lastCode && state.cam.lastCode !== code) return;

    if (info.known && info.product) {
      renderScanPanel(info.product, code);
      return;
    }

    var cats = categories();
    var found = info.found;
    var suggestedCat = info.category && cats.indexOf(info.category) !== -1 ? info.category : null;

    el("scanPanel").innerHTML =
      '<div class="scan-result new">' +
      '<div class="sr-head"><div>' +
      '<div class="sr-title">' + (found ? "Producto identificado" : "Producto nuevo") + "</div>" +
      '<div class="sr-meta mono">' + esc(code) + "</div>" +
      "</div><span class=\"sr-badge new\">Sin registrar</span></div>" +
      (found
        ? '<p class="lookup-note">Datos traídos de ' + esc(info.source) + ". Sólo falta el precio.</p>"
        : '<p class="lookup-note muted">No está en la base pública. Completá los datos a mano.</p>') +
      '<div class="form-grid">' +
      '<div class="field"><label for="npName">Nombre</label>' +
      '<input type="text" id="npName" placeholder="Ej: Chocolate 100g" value="' + esc(info.name || "") + '"></div>' +
      '<div class="field-row">' +
      '<div class="field"><label for="npCat">Categoría</label><select id="npCat">' +
      cats.map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === suggestedCat ? " selected" : "") + ">" + esc(c) + "</option>";
      }).join("") +
      '<option value="__new__">+ Nueva categoría</option></select></div>' +
      '<div class="field"><label for="npPrice">Precio</label><input type="number" id="npPrice" class="mono" inputmode="numeric" placeholder="0" min="1" step="50"></div>' +
      "</div>" +
      '<div class="field" id="npNewCatWrap" hidden><label for="npNewCat">Nombre de la categoría</label><input type="text" id="npNewCat"></div>' +
      "</div>" +
      '<button type="button" class="btn primary big" id="npSave">Guardar y cargar al ticket</button>' +
      "</div>";

    el("npCat").addEventListener("change", function () {
      el("npNewCatWrap").hidden = this.value !== "__new__";
    });

    // Si ya vino el nombre, lo único que falta es el precio: foco directo ahí.
    if (found && info.name) el("npPrice").focus();
    else el("npName").focus();

    el("npSave").addEventListener("click", async function () {
      var name = el("npName").value.trim();
      var price = parseFloat(el("npPrice").value);
      var catSel = el("npCat").value;
      var category = catSel === "__new__" ? el("npNewCat").value.trim() : catSel;

      if (!name) { toast("Falta el nombre", "err"); el("npName").focus(); return; }
      if (!category) { toast("Falta la categoría", "err"); return; }
      if (!price || price <= 0) { toast("Falta el precio", "err"); el("npPrice").focus(); return; }

      this.disabled = true;
      this.textContent = "Guardando...";
      try {
        var resp = await fetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode: code, name: name, category: category, price: price }),
        });
        var data = await resp.json();
        if (!resp.ok) {
          toast(data.error, "err");
          this.disabled = false; this.textContent = "Guardar y cargar al ticket";
          return;
        }
        await loadProducts();
        toast(data.name + " agregado al catálogo", "ok");
        beep(true);
        if (state.scanMode === "vender") addToCart(data.id, 1, false);
        el("scanPanel").innerHTML = "";
      } catch (e) {
        toast("Sin conexión con el servidor", "err");
        this.disabled = false; this.textContent = "Guardar y cargar al ticket";
      }
    });
  }

  // ═══════════ Reportes ═══════════
  el("rangeChips").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-days]");
    if (!b) return;
    document.querySelectorAll("#rangeChips button").forEach(function (x) {
      x.setAttribute("aria-pressed", x === b ? "true" : "false");
    });
    state.rangeDays = b.dataset.days ? Number(b.dataset.days) : null;
    loadAnalytics(state.rangeDays);
  });

  function deltaHtml(pct) {
    if (pct === null || pct === undefined) return '<span class="k-delta flat">sin comparación</span>';
    var cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    var arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
    return '<span class="k-delta ' + cls + '">' + arrow + " " + Math.abs(pct) + "% vs período anterior</span>";
  }

  function renderKpis(data) {
    var g = data.growth || {};
    var tiles = [
      { label: "Facturación", value: money(data.summary.totalVentas), delta: g.ventas },
      { label: "Tickets", value: String(data.summary.tickets), delta: g.tickets },
      { label: "Ticket promedio", value: money(data.summary.ticketPromedio), delta: g.ticketPromedio },
      { label: "Unidades", value: String(data.summary.itemsVendidos), delta: undefined },
    ];
    el("kpiGrid").innerHTML = tiles.map(function (t) {
      return '<div class="kpi"><span class="k-label">' + t.label + "</span>" +
        '<span class="k-value">' + t.value + "</span>" +
        (t.delta === undefined && !data.growth ? "" : deltaHtml(t.delta === undefined ? null : t.delta)) +
        "</div>";
    }).join("");
  }

  function chartBase(extra) {
    var grid = cssVar("--line"), muted = cssVar("--muted");
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false }, border: { color: grid } },
        y: { ticks: { color: muted, font: { size: 10 } }, grid: { color: grid }, border: { display: false } },
      },
    }, extra || {});
  }

  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    var canvas = el(id);
    if (!canvas) return;
    charts[id] = new Chart(canvas.getContext("2d"), config);
  }

  function renderCharts(data) {
    var accent = cssVar("--accent"), mint = cssVar("--mint"), muted = cssVar("--muted");

    // Evolución diaria
    el("trendSub").textContent = data.byDay.length + (data.byDay.length === 1 ? " día" : " días con ventas");
    draw("dayChart", {
      type: "line",
      data: {
        labels: data.byDay.map(function (d) {
          var p = d.date.split("-");
          return p[2] + "/" + p[1];
        }),
        datasets: [{
          data: data.byDay.map(function (d) { return d.total; }),
          borderColor: accent,
          backgroundColor: "rgba(255,138,61,.14)",
          fill: true, tension: .32, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2.5,
        }],
      },
      options: chartBase({
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return money(c.parsed.y); } } },
        },
      }),
    });

    // Top productos
    draw("topChart", {
      type: "bar",
      data: {
        labels: data.topProducts.map(function (p) { return p.name; }),
        datasets: [{
          data: data.topProducts.map(function (p) { return p.revenue; }),
          backgroundColor: accent, borderRadius: 6, maxBarThickness: 26,
        }],
      },
      options: chartBase({
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (c) {
                var p = data.topProducts[c.dataIndex];
                return money(p.revenue) + " · " + p.qty + " un.";
              },
            },
          },
        },
      }),
    });

    // Rubros
    var pal = [accent, mint, "#6AA9F4", "#D98BD0", "#E8C35A", muted];
    draw("catChart", {
      type: "doughnut",
      data: {
        labels: data.byCategory.map(function (c) { return c.category; }),
        datasets: [{
          data: data.byCategory.map(function (c) { return c.total; }),
          backgroundColor: pal, borderColor: cssVar("--surface"), borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "58%",
        plugins: {
          legend: { position: "bottom", labels: { color: cssVar("--text"), boxWidth: 10, font: { size: 10 }, padding: 9 } },
          tooltip: { callbacks: { label: function (c) { return c.label + ": " + money(c.parsed); } } },
        },
      },
    });

    // Métodos de pago
    draw("methodChart", {
      type: "doughnut",
      data: {
        labels: data.byMethod.map(function (m) { return m.method; }),
        datasets: [{
          data: data.byMethod.map(function (m) { return m.total; }),
          backgroundColor: [accent, mint, "#6AA9F4"], borderColor: cssVar("--surface"), borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "58%",
        plugins: {
          legend: { position: "bottom", labels: { color: cssVar("--text"), boxWidth: 10, font: { size: 10 }, padding: 9 } },
          tooltip: { callbacks: { label: function (c) { return c.label + ": " + money(c.parsed); } } },
        },
      },
    });

    // Horas
    var hours = data.byHour.filter(function (h) { return h.hour >= 7 && h.hour <= 23; });
    var maxHour = hours.reduce(function (m, h) { return h.total > m.total ? h : m; }, hours[0] || { total: 0 });
    draw("hourChart", {
      type: "bar",
      data: {
        labels: hours.map(function (h) { return String(h.hour).padStart(2, "0"); }),
        datasets: [{
          data: hours.map(function (h) { return h.total; }),
          backgroundColor: hours.map(function (h) { return h === maxHour ? accent : cssVar("--surface-3"); }),
          borderRadius: 4, maxBarThickness: 22,
        }],
      },
      options: chartBase({
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return money(c.parsed.y) + " · " + hours[c.dataIndex].tickets + " tickets"; } } },
        },
      }),
    });

    // Lo que no rota
    var rot = data.sinVentas.map(function (p) {
      return "<li><div><div>" + esc(p.name) + '</div><div class="r-cat">' + esc(p.category) + "</div></div>" +
        '<span class="r-val r-zero">0 ventas</span></li>';
    }).concat(data.worstProducts.slice(0, 4).map(function (p) {
      return "<li><div><div>" + esc(p.name) + '</div><div class="r-cat">' + esc(p.category) + "</div></div>" +
        '<span class="r-val">' + p.qty + " un. · " + money(p.revenue) + "</span></li>";
    }));
    el("rotList").innerHTML = rot.length ? rot.join("") : "<li>Todo el catálogo tuvo ventas en este período.</li>";
  }

  async function loadAnalytics(days) {
    try {
      var qs = days ? "?days=" + days : "";
      var resp = await fetch("/api/analytics" + qs);
      var data = await resp.json();
      if (!resp.ok) { toast(data.error || "Error cargando reportes", "err"); return; }
      state.analytics = data;
      renderKpis(data);
      if (window.Chart) renderCharts(data);
      else window.addEventListener("load", function () { renderCharts(data); }, { once: true });
    } catch (e) {
      toast("Sin conexión con el servidor", "err");
    }
  }

  // ═══════════ Asistente ═══════════
  // Markdown mínimo: negritas y viñetas. Escapa siempre antes de insertar.
  function lightMarkdown(text) {
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/^[-*]\s+/gm, "• ");
  }

  function addMsg(cls, text) {
    var div = document.createElement("div");
    div.className = "msg " + cls;
    if (cls.indexOf("bot") === 0) div.innerHTML = lightMarkdown(text);
    else div.textContent = text;
    el("chatLog").appendChild(div);
    div.scrollIntoView({ block: "end", behavior: "smooth" });
    return div;
  }

  el("suggestions").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    el("chatInput").value = b.textContent;
    el("chatForm").requestSubmit();
  });

  el("chatForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var text = el("chatInput").value.trim();
    if (!text) return;

    addMsg("me", text);
    el("chatInput").value = "";
    el("chatInput").disabled = true;
    el("chatSend").disabled = true;
    var thinking = addMsg("bot think", "Mirando tus ventas...");

    try {
      var resp = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: state.chatHistory.slice(-8) }),
      });
      var data = await resp.json();
      thinking.remove();
      if (!resp.ok) {
        addMsg("err", data.error || "No pude consultar al asistente.");
      } else {
        addMsg("bot", data.reply);
        state.chatHistory.push({ role: "user", content: text });
        state.chatHistory.push({ role: "assistant", content: data.reply });
      }
    } catch (err) {
      thinking.remove();
      addMsg("err", "Sin conexión con el servidor.");
    } finally {
      el("chatInput").disabled = false;
      el("chatSend").disabled = false;
      el("chatInput").focus();
    }
  });

  // ═══════════ Sincronización ═══════════
  var syncing = false;

  async function syncPending() {
    if (syncing || !navigator.onLine) return;
    var queue = pendingSales();
    if (!queue.length) { pingServer(); return; }

    syncing = true;
    renderConnState();
    var remaining = [];
    var uploaded = 0;

    for (var i = 0; i < queue.length; i++) {
      var sale = queue[i];
      try {
        var resp = await fetch("/api/sales", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sale.payload),
        });
        markServer(true);
        if (resp.ok) { uploaded++; continue; }
        if (resp.status >= 400 && resp.status < 500) {
          // El servidor la rechaza por datos: reintentar no la va a arreglar.
          uploaded++;
          continue;
        }
        remaining.push(sale);
      } catch (err) {
        markServer(false);
        remaining.push(sale); // la caja sigue inalcanzable
      }
    }

    setPendingSales(remaining);
    syncing = false;
    renderConnState();

    if (uploaded) {
      toast(uploaded + (uploaded === 1 ? " venta sincronizada" : " ventas sincronizadas"), "ok");
      state.analytics = null;
      refreshToday();
      if (state.tab === "reportes") loadAnalytics(state.rangeDays);
    }
  }

  // El dispositivo puede tener internet y aun así no alcanzar la caja (por ejemplo,
  // si la computadora que la corre se quedó sin conexión). Son dos estados distintos
  // y conviene mostrarlos distinto.
  var serverUp = true;

  function markServer(up) {
    if (serverUp === up) return;
    serverUp = up;
    renderConnState();
  }

  async function pingServer() {
    if (!navigator.onLine) { markServer(false); return; }
    try {
      var resp = await fetch("/api/health", { cache: "no-store" });
      markServer(resp.ok);
    } catch (e) {
      markServer(false);
    }
  }

  function renderConnState() {
    var pill = el("connPill");
    if (!pill) return;
    var queue = pendingSales();
    var noNet = !navigator.onLine;
    var cola = queue.length ? " · " + queue.length + " en cola" : "";

    if (!noNet && serverUp && !queue.length) { pill.hidden = true; return; }
    pill.hidden = false;

    if (syncing) {
      pill.className = "conn-pill syncing";
      pill.textContent = "Sincronizando...";
    } else if (noNet) {
      pill.className = "conn-pill offline";
      pill.textContent = "Sin internet" + cola;
    } else if (!serverUp) {
      pill.className = "conn-pill offline";
      pill.textContent = "Caja no disponible" + cola;
    } else {
      pill.className = "conn-pill pending";
      pill.textContent = queue.length + " venta" + (queue.length === 1 ? "" : "s") + " por subir";
    }
  }

  el("connPill").addEventListener("click", async function () {
    if (!navigator.onLine) { toast("El dispositivo sigue sin internet", "err"); return; }
    await pingServer();
    if (!serverUp) { toast("La caja sigue sin responder", "err"); return; }
    syncPending();
  });

  window.addEventListener("online", function () {
    renderConnState();
    syncPending();
    loadProducts().catch(function () {});
  });
  window.addEventListener("offline", renderConnState);

  // ═══════════ Carga inicial ═══════════
  async function loadProducts() {
    try {
      var resp = await fetch("/api/products");
      var list = await resp.json();
      if (Array.isArray(list) && list.length) {
        state.products = list;
        lsSet(LS_PRODUCTS, list);
      }
    } catch (err) {
      // Sin red: se usa el último catálogo guardado en el celular.
      var cached = lsGet(LS_PRODUCTS, []);
      if (!cached.length) throw err;
      state.products = cached;
    }
    renderChips();
    renderGrid();
  }

  async function refreshToday() {
    // Las ventas en cola todavía no están en Airtable, pero para el comercio ya son plata de hoy.
    var queue = pendingSales();
    var queueTotal = queue.reduce(function (s, v) { return s + v.total; }, 0);

    var total = queueTotal;
    var tickets = queue.length;

    try {
      var resp = await fetch("/api/sales/today");
      var data = await resp.json();
      total += data.summary.totalVentas;
      tickets += data.summary.tickets;
    } catch (e) { /* offline: se muestra sólo lo de la cola */ }

    el("todayTotal").textContent = money(total);
    el("appbarSub").innerHTML = "Caja 01 · " + tickets + " tickets · <span id=\"clock\">" +
      new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) + "</span>";
    renderConnState();
  }

  function tickClock() {
    var c = el("clock");
    if (c) c.textContent = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  }

  addMsg("bot", "Soy tu asistente. Miro todas tus ventas y te contesto en criollo.\nProbá con una de las preguntas de abajo.");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  loadProducts().catch(function () { toast("No se pudo cargar el catálogo", "err"); });
  refreshToday();
  renderConnState();
  pingServer();
  syncPending();
  setInterval(function () { pingServer(); syncPending(); }, 20000);
  if (location.hash) setTab(location.hash.slice(1));
  tickClock();
  setInterval(tickClock, 30000);
  setInterval(refreshToday, 60000);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopCamera();
  });
})();
