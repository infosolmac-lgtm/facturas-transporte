const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const STATUS_LABELS = {
  unassigned: "Sin asignar",
  pending_start: "Pendiente",
  in_production: "En producción",
  paused: "Pausada",
  finished: "Terminada",
  picked_up: "Recogida",
};
const ASSIGN_LABELS = { pending_start: "Pendiente", in_production: "Trabajando", paused: "Pausada", finished: "Terminado", transferred: "Transferido" };
const LOCATION_LABELS = { nave1: "Nave 1", nave2: "Nave 2", devolucion: "Devolución", recogida: "Recogida" };
const TYPE_LABELS = { spa_cover: "Cubierta SPA", custom_tarp: "Lona a medida" };
const PAUSE_REASONS = [
  { id: "falta_material", label: "Falta de material" },
  { id: "error_orden", label: "Error en orden" },
  { id: "verificacion_jorge", label: "Verificación con Jorge" },
  { id: "ausente", label: "Ausente" },
  { id: "otra", label: "Otra" },
];
const DELIVERY_TYPES = [
  { id: "con_etiqueta", label: "Con etiqueta de envío" },
  { id: "sin_etiqueta", label: "Sin etiqueta" },
  { id: "recogida_cliente", label: "Recogida por el cliente" },
  { id: "jorge_lleva", label: "Jorge la llevará" },
];
const REOPEN_REASONS = [
  { id: "no_corresponde", label: "No corresponde con lo pedido" },
  { id: "ajustes", label: "Ajustes / modificaciones" },
  { id: "garantia", label: "Garantía" },
  { id: "transporte", label: "Transporte no pudo entregar" },
  { id: "otro", label: "Otro" },
];

let workers = [];
let orders = [];
let currentDetailOrder = null;
let newOrderDigits = "";
let newOrderType = null;
let newOrderNave = null;

/* ---------- sesión ---------- */
const SESSION_KEY = "apliurban_session";
function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (s.date !== today) return null;
    if (new Date().getHours() >= 18) return null;
    return s;
  } catch { return null; }
}
function setSession(workerId, name, pin) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    workerId, name, pin, date: new Date().toISOString().slice(0, 10)
  }));
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }

/* ---------- navegación ---------- */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}
document.querySelectorAll("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => showScreen("screen-" + btn.dataset.back));
});

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 2600);
}

function askMessage(msg) {
  return new Promise(resolve => {
    document.getElementById("message-text").textContent = msg;
    document.getElementById("modal-message").classList.remove("hidden");
    const okBtn = document.getElementById("message-ok");
    const onOk = () => {
      document.getElementById("modal-message").classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      resolve();
    };
    okBtn.addEventListener("click", onOk);
  });
}

function isBreakfastTime() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 540 && mins <= 570;
}

/* ---------- carga de datos ---------- */
async function loadWorkers() {
  const { data, error } = await sb.from("workers").select("id,name,active").eq("active", true);
  if (error) { toast("Error cargando trabajadores"); return; }
  workers = data;
}

function workerName(id) {
  const w = workers.find(w => w.id === id);
  return w ? w.name : null;
}

function pauseMinutes(pausedAt) {
  if (!pausedAt) return 0;
  return Math.floor((Date.now() - new Date(pausedAt).getTime()) / 60000);
}

async function loadOrders() {
  const twoDaysAgoMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { data, error } = await sb
    .from("orders")
    .select("id,order_number,client,work_type,status,current_location,created_at,updated_at,delivery_type,archived_at")
    .order("order_number");
  if (error) { toast("Error: " + error.message); console.error("loadOrders error:", error); return; }

  const visible = data.filter(o => {
    if (o.status !== "picked_up") return true;
    if (o.archived_at) return false;
    if (o.delivery_type === "con_etiqueta") return new Date(o.updated_at).getTime() >= twoDaysAgoMs;
    return true;
  });

  const { data: assignments, error: aErr } = await sb
    .from("order_assignments")
    .select("id,order_id,worker_id,note,status,paused_at,pause_reason,pause_reason_other,workers(name)")
    .not("status", "in", "(finished,transferred)");
  if (aErr) { toast("Error: " + aErr.message); console.error("loadAssignments error:", aErr); return; }

  orders = visible.map(o => ({
    ...o,
    assignments: assignments.filter(a => a.order_id === o.id),
  }));
  renderOrderList();
}

/* ---------- render lista principal ---------- */
function renderOrderList() {
  const container = document.getElementById("order-list");
  const groups = { nave1: [], nave2: [], devolucion: [], recogida: [] };
  orders.forEach(o => groups[o.current_location].push(o));

  document.getElementById("summary").textContent = `${orders.length} órdenes activas`;

  let html = "";
  for (const loc of ["nave1", "nave2", "devolucion", "recogida"]) {
    const list = groups[loc];
    html += `<p class="section-label${loc === "devolucion" ? " section-devolucion" : ""}">${LOCATION_LABELS[loc]}: ${list.length} OT</p>`;
    if (list.length === 0) {
      html += `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 10px 2px;">Sin órdenes aquí</p>`;
    }
    list.forEach(o => {
      const active = o.assignments;
      const anyPaused = active.some(a => a.status === "paused");
      const names = active.map(a => a.workers ? a.workers.name : "?").join(", ");
      let sub;
      if (o.status === "picked_up") {
        sub = "";
      } else if (o.current_location === "devolucion") {
        sub = "Esperando asignación";
      } else {
        sub = names || (o.status === "pending_start" ? "Sin asignar" : "");
      }
      const rowClass = o.current_location === "devolucion" ? "order-row order-row-devolucion"
        : anyPaused ? "order-row order-row-paused" : "order-row";
      let statusHtml;
      if (o.current_location === "devolucion") {
        const mins = pauseMinutes(o.updated_at);
        statusHtml = `<span class="status-tag status-devolucion">↩ ${mins}m</span>`;
      } else if (anyPaused) {
        const maxMin = Math.max(...active.filter(a => a.status === "paused").map(a => pauseMinutes(a.paused_at)));
        statusHtml = `<span class="status-tag status-paused">⏸ ${maxMin}m</span>`;
      } else if (o.status === "picked_up") {
        const d = DELIVERY_TYPES.find(d => d.id === o.delivery_type);
        statusHtml = `<span class="status-tag status-finished">${d ? d.label : "Sin tipo"}</span>`;
      } else {
        statusHtml = `<span class="status-tag status-${o.status}"><span class="status-dot"></span>${STATUS_LABELS[o.status]}</span>`;
      }
      html += `
        <div class="${rowClass}" data-id="${o.id}">
          <div class="order-row-left">
            <div>
              <span class="order-num">${o.order_number[0]} ${o.order_number.slice(1)}</span>
              <div class="order-client">${o.client || ""}</div>
            </div>
            <span class="order-sub">${sub}</span>
          </div>
          ${statusHtml}
        </div>`;
    });
  }
  container.innerHTML = html;
  container.querySelectorAll(".order-row").forEach(row => {
    row.addEventListener("click", () => openDetail(row.dataset.id));
  });
}

/* ---------- detalle de orden ---------- */
async function openDetail(id) {
  const { data: order, error } = await sb.from("orders").select("*").eq("id", id).single();
  if (error) { toast("No se pudo abrir la orden"); return; }
  const { data: assignments, error: aErr } = await sb
    .from("order_assignments")
    .select("id,order_id,worker_id,note,status,paused_at,pause_reason,pause_reason_other,workers(name)")
    .eq("order_id", id)
    .order("created_at");
  if (aErr) { toast("No se pudieron cargar las asignaciones"); return; }
  order.assignments = assignments;
  if (order.current_location === "devolucion") {
    const { data: reopenEvent } = await sb
      .from("order_events")
      .select("note")
      .eq("order_id", id)
      .eq("event_type", "reopened")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    order.reopen_reason = reopenEvent ? reopenEvent.note : null;
  }
  currentDetailOrder = order;
  renderDetail(order);
  renderHistory(id);
  showScreen("screen-detail");
}

async function renderHistory(orderId) {
  const el = document.getElementById("order-history");
  const { data: events, error } = await sb
    .from("order_events")
    .select("event_type, occurred_at, confirmed_by_pin, workers(name)")
    .eq("order_id", orderId)
    .order("occurred_at", { ascending: false });
  if (error) { el.innerHTML = ""; return; }
  if (events.length === 0) { el.innerHTML = ""; return; }
  const labels = {
    created: "Creada", delivered: "Entregada", received: "Recibida", started: "Iniciada",
    finished: "Finalizada", paused: "Pausada", resumed: "Reanudada", control: "Control final",
    picked_up: "Recogida", edited: "Número editado"
  };
  el.innerHTML = `<p class="section-label">Historial</p>` + events.map(e => {
    const actor = e.workers ? e.workers.name : "?";
    const isJorge = actor === "Jorge";
    const time = new Date(e.occurred_at).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `<div class="history-row ${isJorge ? "jorge" : ""}">
      <span>${labels[e.event_type] || e.event_type} — ${actor}</span>
      <span class="history-time">${time}</span>
    </div>`;
  }).join("");
}

function renderDetail(o) {
  const session = getSession();
  const editBtn = !VIEWER_MODE && session && (session.name === "Juan" || session.name === "Jorge")
    ? `<button id="btn-edit-number" style="background:none;border:none;color:var(--blue);font-size:12px;display:block;margin:4px auto 0;">Editar número</button>`
    : "";
  document.getElementById("detail-content").innerHTML = `
    <div class="detail-timer-box">
      <p class="detail-order-num">${o.order_number[0]} ${o.order_number.slice(1)}</p>
      <span class="detail-type-badge">${TYPE_LABELS[o.work_type]}</span>
      ${editBtn}
    </div>
    <table class="detail-fields">
      <tr><td>Cliente</td><td>${o.client || "—"}</td></tr>
      <tr><td>Ubicación</td><td>${LOCATION_LABELS[o.current_location]}</td></tr>
      <tr><td>Estado</td><td>${STATUS_LABELS[o.status]}</td></tr>
    </table>
    <div id="edit-number-box" class="hidden" style="margin-bottom:16px;">
      <p class="field-label">Nuevo número (4 dígitos, el "1" es fijo)</p>
      <div class="order-display"><span>1</span> <span id="edit-number-digits">_ _ _ _</span></div>
      <div id="keypad-editnumber" class="keypad"></div>
      <button id="btn-confirm-edit-number" class="primary-btn" disabled>Confirmar cambio</button>
    </div>`;
  const editBtnEl = document.getElementById("btn-edit-number");
  if (editBtnEl) editBtnEl.addEventListener("click", () => openEditNumber(o));

  const activeAssignments = o.assignments.filter(a => a.status !== "finished" && a.status !== "transferred");
  const rowsEl = document.getElementById("assignment-rows");
  if (activeAssignments.length === 0) {
    rowsEl.innerHTML = `<p style="font-size:13px;color:var(--text-secondary);text-align:center;">Nadie asignado todavía</p>`;
  } else {
    rowsEl.innerHTML = activeAssignments.map(a => {
      const name = a.workers ? a.workers.name : "?";
      const isPaused = a.status === "paused";
      const session = getSession();
      const isMine = !VIEWER_MODE && session && (a.worker_id === session.workerId || session.name === "Juan" || session.name === "Jorge");
      let btns = "";
      if (VIEWER_MODE) {
        btns = "";
      } else if (isMine) {
        if (a.status === "pending_start") btns = `<button class="assign-act" data-id="${a.id}" data-act="start">Iniciar</button><button class="assign-act" data-id="${a.id}" data-act="transfer">Pasar orden</button>`;
        else if (a.status === "in_production") btns = `<button class="assign-act pause-btn" data-id="${a.id}" data-act="pause">Pausar</button><button class="assign-act finish-btn" data-id="${a.id}" data-act="finish">Finalizar</button><button class="assign-act" data-id="${a.id}" data-act="transfer">Pasar</button>`;
        else if (a.status === "paused") btns = `<button class="assign-act resume-btn" data-id="${a.id}" data-act="resume">Reanudar</button><button class="assign-act finish-btn" data-id="${a.id}" data-act="finish">Finalizar</button><button class="assign-act" data-id="${a.id}" data-act="transfer">Pasar</button>`;
      } else {
        btns = `<p style="font-size:12px;color:var(--text-secondary);margin:0;">Solo ${name} puede accionar esto</p>`;
      }
      const reasonLine = isPaused
        ? `<p class="assignment-note">⏸ ${pauseMinutes(a.paused_at)}m · ${a.pause_reason === "otra" ? a.pause_reason_other : (PAUSE_REASONS.find(r => r.id === a.pause_reason) || {label:"Desayuno"}).label}</p>`
        : "";
      return `
        <div class="assignment-row ${isPaused ? "paused" : ""}">
          <div class="assignment-row-top">
            <span class="assignment-name">${name}</span>
            <span class="assignment-status">${ASSIGN_LABELS[a.status]}</span>
          </div>
          ${a.note ? `<p class="assignment-note">${a.note}</p>` : ""}
          ${reasonLine}
          <div class="assignment-btns">${btns}</div>
        </div>`;
    }).join("");
  }

  document.querySelectorAll(".assign-act").forEach(btn => {
    btn.addEventListener("click", () => {
      const assignmentId = btn.dataset.id;
      const act = btn.dataset.act;
      const assignment = o.assignments.find(a => a.id === assignmentId);
      if (act === "start") handleStartAssignment(assignment, o);
      if (act === "pause") handlePauseAssignment(assignment, o);
      if (act === "resume") handleResumeAssignment(assignment, o);
      if (act === "finish") handleFinishAssignment(assignment, o);
      if (act === "transfer") handleTransferAssignment(assignment, o);
    });
  });

  const addBtn = document.getElementById("btn-add-person");
  const controlBox = document.getElementById("detail-control");
  if (VIEWER_MODE) {
    addBtn.classList.add("hidden");
    if (o.status === "picked_up") {
      controlBox.classList.remove("hidden");
      const d = DELIVERY_TYPES.find(d => d.id === o.delivery_type);
      controlBox.innerHTML = `<p style="text-align:center;font-size:13px;color:var(--text-secondary);margin:0;">Entrega: ${d ? d.label : "—"}</p>`;
    } else if (o.current_location === "devolucion") {
      controlBox.classList.remove("hidden");
      controlBox.innerHTML = `<p style="text-align:center;font-size:13px;color:#dc2626;margin:0;">En devolución${o.reopen_reason ? " — " + o.reopen_reason : ""}</p>`;
    } else {
      controlBox.classList.add("hidden");
    }
  } else if (o.current_location === "devolucion") {
    addBtn.classList.add("hidden");
    controlBox.classList.remove("hidden");
    controlBox.innerHTML = `
      <p style="text-align:center;font-size:13px;color:#dc2626;font-weight:600;margin:0 0 4px;">En devolución</p>
      ${o.reopen_reason ? `<p style="text-align:center;font-size:12px;color:var(--text-secondary);margin:0 0 10px;">Motivo: ${o.reopen_reason}</p>` : ""}
      <button class="secondary-btn" id="act-assign-devolucion">Asignar nave y persona</button>`;
    document.getElementById("act-assign-devolucion").addEventListener("click", () => handleAssignFromDevolucion(o));
  } else if (o.status === "finished") {
    addBtn.classList.add("hidden");
    controlBox.classList.remove("hidden");
    controlBox.innerHTML = `<button class="secondary-btn" id="act-control">Control final y recogida (Juan)</button>`;
    document.getElementById("act-control").addEventListener("click", () => handleControl(o));
  } else if (o.status === "picked_up") {
    addBtn.classList.add("hidden");
    controlBox.classList.remove("hidden");
    const d = DELIVERY_TYPES.find(d => d.id === o.delivery_type);
    controlBox.innerHTML = `
      <p style="text-align:center;font-size:13px;color:var(--text-secondary);margin:0 0 10px;">Entrega: ${d ? d.label : "—"}</p>
      <button class="secondary-btn" id="act-change-delivery">Cambiar tipo de entrega</button>
      <button class="secondary-btn" id="act-archive" style="margin-top:8px;">Marcar como completada (Juan)</button>
      <button class="secondary-btn" id="act-reopen" style="margin-top:8px;border-color:#dc2626;color:#dc2626;">Reabrir orden</button>`;
    document.getElementById("act-change-delivery").addEventListener("click", () => handleChangeDelivery(o));
    document.getElementById("act-archive").addEventListener("click", () => handleArchive(o));
    document.getElementById("act-reopen").addEventListener("click", () => handleReopenOrder(o));
  } else {
    const session = getSession();
    const alreadyIn = o.assignments.some(a => (a.status !== "finished" && a.status !== "transferred") && session && a.worker_id === session.workerId);
    addBtn.classList.toggle("hidden", alreadyIn);
    controlBox.classList.add("hidden");
    addBtn.onclick = () => handleAddPerson(o);
  }
}

/* ---------- modal PIN reutilizable ---------- */
let pinBuffer = "";
let pinResolve = null;

function askPin(workerNameLabel) {
  return new Promise(resolve => {
    pinResolve = resolve;
    pinBuffer = "";
    document.getElementById("pin-worker-name").textContent = workerNameLabel || "";
    document.getElementById("pin-error").classList.add("hidden");
    updatePinDots();
    document.getElementById("modal-pin").classList.remove("hidden");
  });
}
function closePinModal(result) {
  document.getElementById("modal-pin").classList.add("hidden");
  if (pinResolve) { pinResolve(result); pinResolve = null; }
}
function updatePinDots() {
  document.querySelectorAll("#modal-pin .dot").forEach((d, i) => {
    d.classList.toggle("filled", i < pinBuffer.length);
  });
}
function buildKeypad(container, onDigit, onBack, onCheck) {
  container.innerHTML = "";
  const keys = ["1","2","3","4","5","6","7","8","9","back","0","check"];
  keys.forEach(k => {
    const btn = document.createElement("button");
    if (k === "back") { btn.className = "key-back"; btn.textContent = "⌫"; btn.addEventListener("click", onBack); }
    else if (k === "check") { btn.className = "key-check"; btn.textContent = "✓"; btn.addEventListener("click", onCheck); }
    else { btn.textContent = k; btn.addEventListener("click", () => onDigit(k)); }
    container.appendChild(btn);
  });
}
buildKeypad(document.getElementById("keypad-pin"),
  (d) => { if (pinBuffer.length < 4) { pinBuffer += d; updatePinDots(); } },
  () => { pinBuffer = pinBuffer.slice(0, -1); updatePinDots(); },
  () => {
    if (pinBuffer.length !== 4) return;
    closePinModal(pinBuffer);
  }
);
document.querySelectorAll('#modal-pin [data-modal-cancel]').forEach(b =>
  b.addEventListener("click", () => closePinModal(null))
);

/* ---------- modal seleccionar trabajador ---------- */
let workerResolve = null;
function askWorker(title, filterFn) {
  return new Promise(resolve => {
    workerResolve = resolve;
    document.getElementById("worker-modal-title").textContent = title;
    const list = document.getElementById("worker-list");
    const filtered = filterFn ? workers.filter(filterFn) : workers;
    list.innerHTML = filtered.map(w =>
      `<button class="worker-item" data-id="${w.id}">${w.name}</button>`
    ).join("");
    list.querySelectorAll(".worker-item").forEach(btn => {
      btn.addEventListener("click", () => {
        document.getElementById("modal-worker").classList.add("hidden");
        workerResolve(btn.dataset.id);
        workerResolve = null;
      });
    });
    document.getElementById("modal-worker").classList.remove("hidden");
  });
}
document.querySelectorAll('#modal-worker [data-modal-cancel]').forEach(b =>
  b.addEventListener("click", () => {
    document.getElementById("modal-worker").classList.add("hidden");
    if (workerResolve) { workerResolve(null); workerResolve = null; }
  })
);

/* ---------- modal nota ---------- */
function askNote() {
  return new Promise(resolve => {
    document.getElementById("note-input").value = "";
    document.getElementById("modal-note").classList.remove("hidden");
    const confirmBtn = document.getElementById("note-confirm");
    const cancelBtn = document.querySelector('#modal-note [data-modal-cancel]');
    const onConfirm = () => { cleanup(); resolve(document.getElementById("note-input").value.trim()); };
    const onCancel = () => { cleanup(); resolve(null); };
    function cleanup() {
      document.getElementById("modal-note").classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    }
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
}

/* ---------- modal motivo de pausa ---------- */
function askPauseReason() {
  return new Promise(resolve => {
    const list = document.getElementById("pause-reason-list");
    const otherInput = document.getElementById("pause-reason-other");
    const confirmBtn = document.getElementById("pause-reason-confirm");
    otherInput.classList.add("hidden");
    otherInput.value = "";
    confirmBtn.disabled = true;
    let selected = null;
    list.innerHTML = PAUSE_REASONS.map(r => `<button class="worker-item" data-r="${r.id}">${r.label}</button>`).join("");
    list.querySelectorAll("[data-r]").forEach(btn => {
      btn.addEventListener("click", () => {
        list.querySelectorAll("[data-r]").forEach(b => b.style.borderColor = "");
        btn.style.borderColor = "var(--border-accent, #1d4ed8)";
        selected = btn.dataset.r;
        otherInput.classList.toggle("hidden", selected !== "otra");
        confirmBtn.disabled = selected === "otra" ? otherInput.value.trim() === "" : false;
      });
    });
    otherInput.addEventListener("input", () => {
      if (selected === "otra") confirmBtn.disabled = otherInput.value.trim() === "";
    });
    const cancelBtn = document.querySelector('#modal-pause-reason [data-modal-cancel]');
    const onConfirm = () => {
      cleanup();
      resolve({ reason: selected, other: selected === "otra" ? otherInput.value.trim() : null });
    };
    const onCancel = () => { cleanup(); resolve(null); };
    function cleanup() {
      document.getElementById("modal-pause-reason").classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    }
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    document.getElementById("modal-pause-reason").classList.remove("hidden");
  });
}

/* ---------- modal tipo de entrega ---------- */
function askDeliveryType() {
  return new Promise(resolve => {
    const list = document.getElementById("delivery-list");
    const confirmBtn = document.getElementById("delivery-confirm");
    confirmBtn.disabled = true;
    let selected = null;
    list.innerHTML = DELIVERY_TYPES.map(d => `<button class="worker-item" data-d="${d.id}">${d.label}</button>`).join("");
    list.querySelectorAll("[data-d]").forEach(btn => {
      btn.addEventListener("click", () => {
        list.querySelectorAll("[data-d]").forEach(b => b.style.borderColor = "");
        btn.style.borderColor = "var(--border-accent, #1d4ed8)";
        selected = btn.dataset.d;
        confirmBtn.disabled = false;
      });
    });
    const cancelBtn = document.querySelector('#modal-delivery [data-modal-cancel]');
    const onConfirm = () => { cleanup(); resolve(selected); };
    const onCancel = () => { cleanup(); resolve(null); };
    function cleanup() {
      document.getElementById("modal-delivery").classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    }
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    document.getElementById("modal-delivery").classList.remove("hidden");
  });
}

/* ---------- acciones sobre asignaciones (usan la sesión activa, sin PIN) ---------- */
async function handleStartAssignment(a, o) {
  const session = getSession();
  const { error } = await sb.rpc("start_assignment", { p_assignment_id: a.id, p_worker_id: session.workerId, p_pin: session.pin });
  if (error) { toast("Error: " + error.message); console.error("start_assignment error:", error); return; }
  toast("Trabajo iniciado");
  await loadOrders(); openDetail(o.id);
}

async function handlePauseAssignment(a, o) {
  const session = getSession();
  if (isBreakfastTime()) {
    const { error } = await sb.rpc("pause_assignment", { p_assignment_id: a.id, p_worker_id: session.workerId, p_pin: session.pin, p_reason: "desayuno" });
    if (error) { toast("Error: " + error.message); console.error("pause_assignment error:", error); return; }
    toast("Pausada — desayuno");
    await loadOrders(); openDetail(o.id);
    return;
  }
  const result = await askPauseReason();
  if (!result) return;
  const { error } = await sb.rpc("pause_assignment", {
    p_assignment_id: a.id, p_worker_id: session.workerId, p_pin: session.pin,
    p_reason: result.reason, p_reason_other: result.other
  });
  if (error) { toast("Error: " + error.message); console.error("pause_assignment error:", error); return; }
  toast("Orden pausada");
  await loadOrders(); openDetail(o.id);
}

async function handleResumeAssignment(a, o) {
  const session = getSession();
  const { error } = await sb.rpc("resume_assignment", { p_assignment_id: a.id, p_worker_id: session.workerId, p_pin: session.pin });
  if (error) { toast("Error: " + error.message); console.error("resume_assignment error:", error); return; }
  toast("Orden reanudada");
  await loadOrders(); openDetail(o.id);
}

async function handleFinishAssignment(a, o) {
  const session = getSession();
  const { error } = await sb.rpc("finish_assignment", { p_assignment_id: a.id, p_worker_id: session.workerId, p_pin: session.pin });
  if (error) { toast("Error: " + error.message); console.error("finish_assignment error:", error); return; }
  toast("Trabajo finalizado");
  await loadOrders(); openDetail(o.id);
}

async function handleTransferAssignment(a, o) {
  const session = getSession();
  const toId = await askWorker("¿A quién se transfiere?", w => w.id !== a.worker_id);
  if (!toId) return;
  const { error } = await sb.rpc("transfer_assignment", {
    p_assignment_id: a.id, p_from_worker_id: session.workerId, p_to_worker_id: toId, p_pin: session.pin
  });
  if (error) { toast("Error: " + error.message); console.error("transfer_assignment error:", error); return; }
  toast("Orden transferida");
  await loadOrders(); openDetail(o.id);
}

async function handleAddPerson(o) {
  const session = getSession();
  const note = await askNote();
  if (note === null) return;
  const { error } = await sb.rpc("join_order", { p_order_id: o.id, p_worker_id: session.workerId, p_note: note, p_pin: session.pin });
  if (error) { toast("Error: " + error.message); console.error("join_order error:", error); return; }
  toast("Te uniste a la orden");
  await loadOrders(); openDetail(o.id);
}

function askReopenReason() {
  return new Promise(resolve => {
    const list = document.getElementById("reopen-reason-list");
    const otherInput = document.getElementById("reopen-reason-other");
    const confirmBtn = document.getElementById("reopen-reason-confirm");
    otherInput.classList.add("hidden");
    otherInput.value = "";
    confirmBtn.disabled = true;
    let selected = null;
    list.innerHTML = REOPEN_REASONS.map(r => `<button class="worker-item" data-r="${r.id}">${r.label}</button>`).join("");
    list.querySelectorAll("[data-r]").forEach(btn => {
      btn.addEventListener("click", () => {
        list.querySelectorAll("[data-r]").forEach(b => b.style.borderColor = "");
        btn.style.borderColor = "#dc2626";
        selected = btn.dataset.r;
        otherInput.classList.toggle("hidden", selected !== "otro");
        confirmBtn.disabled = false;
      });
    });
    const cancelBtn = document.querySelector('#modal-reopen-reason [data-modal-cancel]');
    const onConfirm = () => {
      const label = REOPEN_REASONS.find(r => r.id === selected).label;
      const text = selected === "otro" ? (otherInput.value.trim() || "Otro") : label;
      cleanup(); resolve(text);
    };
    const onCancel = () => { cleanup(); resolve(null); };
    function cleanup() {
      document.getElementById("modal-reopen-reason").classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    }
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    document.getElementById("modal-reopen-reason").classList.remove("hidden");
  });
}

function askNave() {
  return new Promise(resolve => {
    const list = document.getElementById("nave-list");
    list.innerHTML = `<button class="worker-item" data-n="nave1">Nave 1</button><button class="worker-item" data-n="nave2">Nave 2</button>`;
    list.querySelectorAll("[data-n]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.getElementById("modal-nave").classList.add("hidden");
        resolve(btn.dataset.n);
      });
    });
    const cancelBtn = document.querySelector('#modal-nave [data-modal-cancel]');
    cancelBtn.onclick = () => { document.getElementById("modal-nave").classList.add("hidden"); resolve(null); };
    document.getElementById("modal-nave").classList.remove("hidden");
  });
}

async function handleReopenOrder(o) {
  const reason = await askReopenReason();
  if (!reason) return;
  const actorId = await askWorker("¿Quién reabre la orden?", w => w.name === "Jorge" || w.name === "Juan");
  if (!actorId) return;
  const actor = workers.find(w => w.id === actorId);
  const pin = await askPin(actor.name);
  if (!pin) return;
  const { error } = await sb.rpc("reopen_order", { p_order_id: o.id, p_reason: reason, p_worker_id: actor.id, p_pin: pin });
  if (error) { toast("Error: " + error.message); console.error("reopen_order error:", error); return; }
  toast("Orden reabierta — en devolución");
  await loadOrders(); showScreen("screen-main");
}

async function handleAssignFromDevolucion(o) {
  const nave = await askNave();
  if (!nave) return;
  const list = nave === "nave1" ? ["Jorge", "Andrés", "Mahicol"] : ["Kevin", "Elmer", "Juan"];
  const targetId = await askWorker("¿A quién se asigna?", w => list.includes(w.name));
  if (!targetId) return;
  const actorId = await askWorker("¿Quién confirma la asignación?", w => w.name === "Jorge" || w.name === "Juan");
  if (!actorId) return;
  const actor = workers.find(w => w.id === actorId);
  const pin = await askPin(actor.name);
  if (!pin) return;
  const { error } = await sb.rpc("assign_from_devolucion", {
    p_order_id: o.id, p_nave: nave, p_target_worker_id: targetId, p_worker_id: actor.id, p_pin: pin
  });
  if (error) { toast("Error: " + error.message); console.error("assign_from_devolucion error:", error); return; }
  toast("Orden asignada");
  await loadOrders(); openDetail(o.id);
}

async function handleControl(o) {
  const juan = workers.find(w => w.name === "Juan");
  const delivery = await askDeliveryType();
  if (!delivery) return;
  const pin = await askPin("Juan");
  if (!pin) return;
  const { error } = await sb.rpc("control_and_pickup_order", { p_order_id: o.id, p_worker_id: juan.id, p_pin: pin, p_delivery: delivery });
  if (error) { toast("Error: " + error.message); console.error("control_and_pickup_order error:", error); return; }
  toast("Orden entregada al cliente");
  await loadOrders(); showScreen("screen-main");
}

function openEditNumber(o) {
  const box = document.getElementById("edit-number-box");
  box.classList.remove("hidden");
  let digits = "";
  const display = () => {
    document.getElementById("edit-number-digits").textContent = digits.padEnd(4, "_").split("").join(" ");
    document.getElementById("btn-confirm-edit-number").disabled = digits.length !== 4;
  };
  buildKeypad(document.getElementById("keypad-editnumber"),
    (d) => { if (digits.length < 4) { digits += d; display(); } },
    () => { digits = digits.slice(0, -1); display(); },
    () => {}
  );
  display();
  document.getElementById("btn-confirm-edit-number").onclick = async () => {
    if (digits.length !== 4) return;
    const juan = workers.find(w => w.name === "Juan");
    const pin = await askPin("Juan");
    if (!pin) return;
    const newNumber = "1" + digits;
    const { error } = await sb.rpc("update_order_number", { p_order_id: o.id, p_new_number: newNumber, p_worker_id: juan.id, p_pin: pin });
    if (error) { toast("Error: " + error.message); console.error("update_order_number error:", error); return; }
    toast("Número actualizado");
    await loadOrders(); openDetail(o.id);
  };
}

async function handleChangeDelivery(o) {
  const delivery = await askDeliveryType();
  if (!delivery) return;
  const actorId = await askWorker("¿Quién confirma el cambio?", w => w.name === "Jorge" || w.name === "Juan");
  if (!actorId) return;
  const actor = workers.find(w => w.id === actorId);
  const pin = await askPin(actor.name);
  if (!pin) return;
  const { error } = await sb.rpc("update_delivery_type", { p_order_id: o.id, p_delivery: delivery, p_worker_id: actor.id, p_pin: pin });
  if (error) { toast("Error: " + error.message); console.error("update_delivery_type error:", error); return; }
  toast("Tipo de entrega actualizado");
  await loadOrders(); openDetail(o.id);
}

async function handleArchive(o) {
  const juan = workers.find(w => w.name === "Juan");
  const pin = await askPin("Juan");
  if (!pin) return;
  const { error } = await sb.rpc("archive_order", { p_order_id: o.id, p_worker_id: juan.id, p_pin: pin });
  if (error) { toast("Error: " + error.message); console.error("archive_order error:", error); return; }
  toast("Orden marcada como completada");
  await loadOrders(); showScreen("screen-main");
}

/* ---------- nueva orden ---------- */
document.getElementById("btn-new-order").addEventListener("click", () => {
  newOrderDigits = ""; newOrderType = null; newOrderNave = null;
  document.getElementById("input-client").value = "";
  document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("selected"));
  document.getElementById("new-order-step2").classList.add("hidden");
  updateNewOrderDisplay();
  showScreen("screen-new-order");
});

function updateNewOrderDisplay() {
  const padded = newOrderDigits.padEnd(4, "_").split("").join(" ");
  document.getElementById("new-order-digits").textContent = padded;
  if (newOrderDigits.length === 4) {
    document.getElementById("new-order-step2").classList.remove("hidden");
  } else {
    document.getElementById("new-order-step2").classList.add("hidden");
  }
}
buildKeypad(document.getElementById("keypad-neworder"),
  (d) => { if (newOrderDigits.length < 4) { newOrderDigits += d; updateNewOrderDisplay(); } },
  () => { newOrderDigits = newOrderDigits.slice(0, -1); updateNewOrderDisplay(); },
  () => {}
);
document.querySelectorAll("[data-type]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-type]").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    newOrderType = btn.dataset.type;
    if (!newOrderNave) {
      newOrderNave = newOrderType === "spa_cover" ? "nave1" : "nave2";
      document.querySelectorAll("[data-nave]").forEach(b => b.classList.toggle("selected", b.dataset.nave === newOrderNave));
    }
    checkNewOrderReady();
  });
});
document.querySelectorAll("[data-nave]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-nave]").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    newOrderNave = btn.dataset.nave;
    checkNewOrderReady();
  });
});
document.getElementById("input-client").addEventListener("input", checkNewOrderReady);
function checkNewOrderReady() {
  const client = document.getElementById("input-client").value.trim();
  document.getElementById("btn-continue-neworder").disabled = !(client && newOrderType && newOrderNave);
}

document.getElementById("btn-continue-neworder").addEventListener("click", async () => {
  const client = document.getElementById("input-client").value.trim();
  const naveWorkers = newOrderNave === "nave1" ? ["Jorge","Andrés","Mahicol"] : ["Kevin","Elmer","Juan"];
  const workerId = await askWorker("Asignar a", w => naveWorkers.includes(w.name));
  if (!workerId) return;
  const creatorId = await askWorker("¿Quién crea la orden?", w => w.name === "Jorge" || w.name === "Juan");
  if (!creatorId) return;
  const creator = workers.find(w => w.id === creatorId);
  const pin = await askPin(creator.name);
  if (!pin) return;
  const fullNumber = "1" + newOrderDigits;
  const { error } = await sb.rpc("create_order", {
    p_order_number: fullNumber, p_client: client, p_work_type: newOrderType,
    p_nave: newOrderNave, p_worker_id: workerId, p_creator_id: creator.id, p_pin: pin
  });
  if (error) {
    if (error.message.includes("duplicate")) toast("Ese número de orden ya existe");
    else toast("Error: " + error.message);
    console.error("create_order error:", error);
    return;
  }
  toast("Orden creada");
  await loadOrders();
  showScreen("screen-main");
});

/* ---------- reportes (solo Juan) ---------- */
document.getElementById("btn-reports").addEventListener("click", async () => {
  const juan = workers.find(w => w.name === "Juan");
  const pin = await askPin("Juan — acceso a reportes");
  if (!pin) return;
  const { data: ok, error } = await sb.rpc("verify_pin", { p_worker_id: juan.id, p_pin: pin, p_required_name: "Juan" });
  if (error || !ok) { toast("PIN incorrecto"); return; }
  currentReportPeriod = "daily";
  currentReportDate = new Date();
  showScreen("screen-reports");
  renderReportRange();
  loadReport();
});

let currentReportPeriod = "daily";
let currentReportDate = new Date();

document.querySelectorAll(".report-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".report-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    currentReportPeriod = tab.dataset.period;
    currentReportDate = new Date();
    renderReportRange();
    loadReport();
  });
});

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { week: Math.ceil((((d - yearStart) / 86400000) + 1) / 7), year: d.getUTCFullYear() };
}

function renderReportRange() {
  const el = document.getElementById("report-range-picker");
  let label = "";
  if (currentReportPeriod === "daily") {
    label = currentReportDate.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
  } else if (currentReportPeriod === "weekly") {
    const { week, year } = getISOWeek(currentReportDate);
    label = `Semana ${week}, ${year}`;
  } else {
    label = currentReportDate.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  }
  el.innerHTML = `
    <button id="range-prev">‹</button>
    <span class="report-range-label">${label}</span>
    <button id="range-next">›</button>
  `;
  document.getElementById("range-prev").addEventListener("click", () => { shiftReportRange(-1); });
  document.getElementById("range-next").addEventListener("click", () => { shiftReportRange(1); });
}
function shiftReportRange(dir) {
  const d = new Date(currentReportDate);
  if (currentReportPeriod === "daily") d.setDate(d.getDate() + dir);
  else if (currentReportPeriod === "weekly") d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir);
  currentReportDate = d;
  renderReportRange();
  loadReport();
}

function getRangeBounds() {
  const d = new Date(currentReportDate);
  let start, end;
  if (currentReportPeriod === "daily") {
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  } else if (currentReportPeriod === "weekly") {
    const day = d.getDay() || 7;
    start = new Date(d); start.setDate(d.getDate() - day + 1); start.setHours(0,0,0,0);
    end = new Date(start); end.setDate(start.getDate() + 7);
  } else {
    start = new Date(d.getFullYear(), d.getMonth(), 1);
    end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return { start, end };
}

async function loadReport() {
  const { start, end } = getRangeBounds();
  const { data: events, error } = await sb
    .from("order_events")
    .select("order_id, event_type, from_worker_id, occurred_at, orders(order_number)")
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    .order("occurred_at");
  if (error) { toast("Error cargando reporte"); return; }

  const createdOrders = new Set(events.filter(e => e.event_type === "created").map(e => e.order_id));
  const finishedOrders = new Set(events.filter(e => e.event_type === "finished").map(e => e.order_id));

  const workTimeByWorker = {};
  const workTimeByOrderAndWorker = {};
  const orderNumbers = {};
  const byOrder = {};
  events.forEach(e => {
    (byOrder[e.order_id] ||= []).push(e);
    if (e.orders) orderNumbers[e.order_id] = e.orders.order_number;
  });
  Object.entries(byOrder).forEach(([orderId, evList]) => {
    for (let i = 0; i < evList.length; i++) {
      if (evList[i].event_type === "started") {
        const next = evList.slice(i + 1).find(e =>
          (e.event_type === "finished" || e.event_type === "delivered") && e.from_worker_id === evList[i].from_worker_id
        );
        if (next) {
          const ms = new Date(next.occurred_at) - new Date(evList[i].occurred_at);
          const name = workerName(evList[i].from_worker_id) || "Desconocido";
          workTimeByWorker[name] = (workTimeByWorker[name] || 0) + ms;
          (workTimeByOrderAndWorker[orderId] ||= {});
          workTimeByOrderAndWorker[orderId][name] = (workTimeByOrderAndWorker[orderId][name] || 0) + ms;
        }
      }
    }
  });

  function fmt(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  let html = `<div class="metric-grid">
    <div class="metric-card"><div class="m-label">Órdenes creadas</div><div class="m-value">${createdOrders.size}</div></div>
    <div class="metric-card"><div class="m-label">Órdenes terminadas</div><div class="m-value">${finishedOrders.size}</div></div>
  </div>`;

  html += `<p class="section-label">Tiempo trabajado por persona (total del periodo)</p>`;
  const entries = Object.entries(workTimeByWorker).sort((a,b) => b[1]-a[1]);
  if (entries.length === 0) {
    html += `<p style="font-size:13px;color:var(--text-secondary);">Sin datos en este periodo</p>`;
  } else {
    entries.forEach(([name, ms]) => {
      html += `<div class="worker-stat-row"><span>${name}</span><span>${fmt(ms)}</span></div>`;
    });
  }

  html += `<p class="section-label">Detalle por orden</p>`;
  const orderIds = Object.keys(workTimeByOrderAndWorker).sort((a, b) =>
    (orderNumbers[a] || "").localeCompare(orderNumbers[b] || ""));
  if (orderIds.length === 0) {
    html += `<p style="font-size:13px;color:var(--text-secondary);">Sin órdenes con tiempo registrado en este periodo</p>`;
  } else {
    orderIds.forEach(orderId => {
      const num = orderNumbers[orderId] || "?";
      html += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;">
        <p style="font-weight:600;font-size:14px;margin:0 0 6px;">${num[0]} ${num.slice(1)}</p>`;
      Object.entries(workTimeByOrderAndWorker[orderId]).sort((a,b) => b[1]-a[1]).forEach(([name, ms]) => {
        html += `<div style="display:flex;justify-content:space-between;font-size:13px;padding:2px 0;"><span>${name}</span><span>${fmt(ms)}</span></div>`;
      });
      html += `</div>`;
    });
  }

  document.getElementById("report-content").innerHTML = html;
}

document.getElementById("btn-print-report").addEventListener("click", () => {
  window.print();
});

/* ---------- login (una vez por dispositivo, hasta las 6pm) ---------- */
async function requireLogin() {
  let session = getSession();
  while (!session) {
    const workerId = await askWorker("¿Quién eres?");
    if (!workerId) continue;
    const w = workers.find(x => x.id === workerId);
    const pin = await askPin(w.name);
    if (!pin) continue;
    const { data: ok, error } = await sb.rpc("verify_pin", { p_worker_id: workerId, p_pin: pin });
    if (error || !ok) { await askMessage("PIN incorrecto"); continue; }
    setSession(workerId, w.name, pin);
    session = getSession();
    if (!session) { await askMessage("Fuera de horario (antes de las 6pm). Usa el enlace de solo consulta si necesitas ver algo."); }
  }
  document.getElementById("session-name").textContent = session.name;
}

document.getElementById("btn-logout").addEventListener("click", async () => {
  clearSession();
  toast("Sesión cerrada");
  await requireLogin();
});

document.getElementById("btn-refresh").addEventListener("click", async () => {
  await loadOrders();
  if (document.getElementById("screen-detail").classList.contains("active") && currentDetailOrder) {
    openDetail(currentDetailOrder.id);
  }
  toast("Actualizado");
});

/* ---------- modo solo lectura (link compartido) ---------- */
const VIEWER_MODE = new URLSearchParams(location.search).has("viewonly");

/* ---------- init ---------- */
(async function init() {
  await loadWorkers();
  if (VIEWER_MODE) {
    document.getElementById("session-bar").classList.add("hidden");
    document.getElementById("btn-new-order").classList.add("hidden");
    document.getElementById("btn-reports").classList.add("hidden");
  } else {
    await requireLogin();
  }
  await loadOrders();
  setInterval(() => {
    if (!VIEWER_MODE && !getSession()) { location.reload(); return; }
    if (document.getElementById("screen-main").classList.contains("active")) {
      renderOrderList();
    }
    if (document.getElementById("screen-detail").classList.contains("active") && currentDetailOrder) {
      openDetail(currentDetailOrder.id);
    }
  }, 30000);

  sb.channel("orders-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => loadOrders())
    .on("postgres_changes", { event: "*", schema: "public", table: "order_assignments" }, () => {
      loadOrders();
      if (document.getElementById("screen-detail").classList.contains("active") && currentDetailOrder) {
        openDetail(currentDetailOrder.id);
      }
    })
    .subscribe();
})();
