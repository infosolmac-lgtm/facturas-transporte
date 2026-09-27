/* =====================================================================
   Facturas de Transporte — app.js
   HTML/JS sin framework + Supabase (Auth, PostgreSQL, Storage)
   ===================================================================== */
(() => {
'use strict';

const cfg = window.APP_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
const BUCKET = cfg.BUCKET || 'facturas';
const ALERT_DAYS = cfg.ALERT_DAYS || 7;

const state = {
  profile: null,
  companies: [],
  filters: { q: '', company: '', status: '', year: '', month: '', from: '', to: '', min: '', max: '' },
  sort: { key: 'due_date', dir: 1 }
};

const STATUS = {
  vencida:             { label: 'Vencida',      cls: 'st-vencida' },
  pendiente:           { label: 'Pendiente',    cls: 'st-pendiente' },
  parcialmente_pagada: { label: 'Pago parcial', cls: 'st-parcial' },
  pagada:              { label: 'Pagada',       cls: 'st-pagada' },
  anulada:             { label: 'Anulada',      cls: 'st-anulada' }
};
const METHODS = {
  transferencia: 'Transferencia', pago_online: 'Pago online',
  domiciliacion: 'Domiciliación', tarjeta: 'Tarjeta', otro: 'Otro'
};
const EVENTS = {
  creada: 'Factura creada', editada: 'Datos editados', pagada: 'Marcada como pagada',
  pago_parcial: 'Pago parcial registrado', anulada: 'Factura anulada',
  reactivada: 'Reactivada', documento: 'Documento adjuntado'
};
const FIELD_LABELS = {
  company_id: 'Empresa', invoice_number: 'Nº factura', concept: 'Concepto', issue_date: 'Emisión',
  service_start_date: 'Inicio servicio', due_date: 'Vencimiento', subtotal: 'Base', tax: 'IVA',
  total: 'Total', amount_paid: 'Pagado', currency: 'Moneda', status: 'Estado',
  payment_date: 'Fecha pago', payment_method: 'Método pago', notes: 'Notas', file_path: 'Documento', paid_by: 'Pagada por'
};
const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

/* ---------------------------------------------------------------------
   Utilidades
   --------------------------------------------------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(n, cur = 'EUR') {
  if (n === null || n === undefined || n === '') return '—';
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur || 'EUR', useGrouping: 'always' }).format(n);
  } catch { return Number(n).toFixed(2) + ' ' + cur; }
}
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
function fdate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function fdatetime(ts) {
  return new Date(ts).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function parseAmount(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/[€\s]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
const amountInput = n => (n === null || n === undefined) ? '' : Number(n).toFixed(2).replace('.', ',');
const sum = (arr, k) => arr.reduce((s, i) => s + Number(i[k] || 0), 0);
const isOpen = i => i.status === 'pendiente' || i.status === 'parcialmente_pagada';
const badge = s => `<span class="badge ${STATUS[s]?.cls || ''}">${esc(STATUS[s]?.label || s)}</span>`;
const slug = s => String(s || 'x').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
const methodOptions = sel => `<option value="">—</option>` +
  Object.entries(METHODS).map(([k, l]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${l}</option>`).join('');

function dueText(days) {
  if (days === 0) return 'vence hoy';
  if (days === 1) return 'vence mañana';
  if (days > 1) return `vence en ${days} días`;
  if (days === -1) return 'vencida ayer';
  return `vencida hace ${Math.abs(days)} días`;
}

function errMsg(e) {
  const m = e?.message || String(e);
  if (e?.code === '23505' || /invoices_unique_number/.test(m)) return 'Ya existe una factura con ese número para esta empresa.';
  if (/transport_companies_name_key/.test(m)) return 'Ya existe una empresa con ese nombre.';
  if (/invoices_due_after_issue/.test(m)) return 'La fecha de vencimiento no puede ser anterior a la de emisión.';
  if (/Invalid login credentials/i.test(m)) return 'Email o contraseña incorrectos.';
  if (/row-level security|permission denied/i.test(m)) return 'Sin permiso para esta acción.';
  if (/mime type/i.test(m)) return 'Tipo de archivo no permitido. Usa PDF, JPG o PNG.';
  if (/exceeded the maximum allowed size|Payload too large/i.test(m)) return 'El archivo supera 10 MB.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Sin conexión. Revisa internet e inténtalo de nuevo.';
  return m;
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, type === 'err' ? 6000 : 3000);
}

function modal({ title, body = '', confirm = 'Aceptar', cancel = 'Cancelar', danger = false, onConfirm }) {
  return new Promise(resolve => {
    const w = document.createElement('div');
    w.className = 'modal-bg';
    w.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        ${cancel ? `<button class="btn" data-a="cancel" type="button">${esc(cancel)}</button>` : ''}
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="ok" type="button">${esc(confirm)}</button>
      </div></div>`;
    document.body.appendChild(w);
    const close = v => { w.remove(); resolve(v); };
    w.addEventListener('click', async e => {
      const a = e.target.dataset.a;
      if (e.target === w || a === 'cancel') return close(false);
      if (a === 'ok') {
        if (onConfirm) {
          e.target.disabled = true;
          let ok;
          try { ok = await onConfirm(w); } catch (err) { toast(errMsg(err), 'err'); ok = false; }
          e.target.disabled = false;
          if (ok === false) return;
        }
        close(true);
      }
    });
    const first = w.querySelector('input, select, textarea');
    if (first) first.focus();
  });
}

/* ---------------------------------------------------------------------
   Datos
   --------------------------------------------------------------------- */
async function loadCompanies() {
  const { data, error } = await sb.from('transport_companies').select('*').order('name');
  if (error) throw error;
  state.companies = data;
  return data;
}
async function loadInvoices() {
  const { data, error } = await sb.from('invoices_view').select('*').order('due_date', { ascending: true });
  if (error) throw error;
  return data;
}
async function updateInvoice(id, patch) {
  const { error } = await sb.from('invoices').update(patch).eq('id', id);
  if (error) throw error;
}
async function uploadDoc(file, companyName, number, issueDate) {
  if (file.size > 10 * 1024 * 1024) throw new Error('El archivo supera 10 MB.');
  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
  const path = `${(issueDate || todayISO()).slice(0, 4)}/${slug(companyName)}/${slug(number)}_${Date.now()}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return path;
}
async function openDoc(path, download = false) {
  const w = download ? null : window.open('', '_blank');   // abrir antes del await (Safari bloquea popups)
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 300, download ? { download: true } : undefined);
  if (error) { if (w) w.close(); toast(errMsg(error), 'err'); return; }
  if (w) w.location.href = data.signedUrl;
  else location.href = data.signedUrl;
}

/* ---------------------------------------------------------------------
   Autenticación
   --------------------------------------------------------------------- */
function showLogin(message = '') {
  state.profile = null;
  document.body.className = 'is-login';
  $('#app').innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="loginForm" autocomplete="on">
        <div>
          <h1>Facturas de Transporte</h1>
          <p class="muted" style="margin:4px 0 0">Acceso restringido</p>
        </div>
        <label>Email<input type="email" name="email" required autocomplete="username"></label>
        <label>Contraseña<input type="password" name="password" required autocomplete="current-password"></label>
        <button class="btn btn-primary btn-block" type="submit">Entrar</button>
        <p class="login-err" id="loginErr">${esc(message)}</p>
      </form>
    </div>`;
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('#loginErr').textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({
      email: String(f.get('email')).trim().toLowerCase(),
      password: String(f.get('password'))
    });
    btn.disabled = false;
    if (error) { $('#loginErr').textContent = errMsg(error); return; }
    startApp(data.user);
  });
}

async function startApp(user) {
  const { data: profile, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error || !profile || !profile.active) {
    await sb.auth.signOut();
    showLogin('Usuario sin acceso activo. Contacta con el administrador.');
    return;
  }
  state.profile = profile;
  try { await loadCompanies(); } catch (e) { toast(errMsg(e), 'err'); }
  renderShell();
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/inicio';
  else route();
}

async function logout() {
  await sb.auth.signOut();
  history.replaceState(null, '', location.pathname);
  showLogin();
}

/* ---------------------------------------------------------------------
   Estructura y navegación
   --------------------------------------------------------------------- */
const NAV = [
  ['inicio', 'Inicio'], ['facturas', 'Facturas'], ['empresas', 'Empresas'],
  ['nueva', 'Nueva factura'], ['informes', 'Informes'], ['config', 'Configuración']
];

function renderShell() {
  document.body.className = '';
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="brand">Facturas de Transporte</div>
      <nav class="nav">${NAV.map(([k, l]) =>
        `<a href="#/${k}" data-nav="${k}" class="${k === 'nueva' ? 'nav-cta' : ''}">${l}</a>`).join('')}</nav>
      <div class="user">${esc(state.profile.full_name)}</div>
    </header>
    <main id="view" class="view"></main>`;
}

async function route() {
  if (!state.profile) return;
  const [, page = 'inicio', id] = (location.hash || '#/inicio').split('/');
  const navKey = { factura: 'facturas', editar: 'facturas', empresa: 'empresas' }[page] || page;
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === navKey));
  const v = $('#view');
  if (!v) return;
  v.innerHTML = '<div class="loading">Cargando…</div>';
  window.scrollTo(0, 0);
  try {
    switch (page) {
      case 'inicio':   return await pageDashboard(v);
      case 'facturas': return await pageInvoices(v);
      case 'factura':  return await pageInvoiceDetail(v, id);
      case 'nueva':    return await pageInvoiceForm(v, null);
      case 'editar':   return await pageInvoiceForm(v, id);
      case 'empresas': return await pageCompanies(v);
      case 'empresa':  return await pageCompanyDetail(v, id);
      case 'informes': return await pageReports(v);
      case 'config':   return await pageConfig(v);
      default: location.hash = '#/inicio';
    }
  } catch (e) {
    v.innerHTML = `<div class="empty">No se pudo cargar: ${esc(errMsg(e))}</div>`;
  }
}
window.addEventListener('hashchange', route);

function goInvoicesFiltered(patch) {
  state.filters = { q: '', company: '', status: '', year: '', month: '', from: '', to: '', min: '', max: '', ...patch };
  location.hash = '#/facturas';
}

/* ---------------------------------------------------------------------
   INICIO / DASHBOARD
   --------------------------------------------------------------------- */
async function pageDashboard(v) {
  const inv = await loadInvoices();
  const today = todayISO();
  const ym = today.slice(0, 7);
  const live = inv.filter(i => i.status !== 'anulada');
  const venc = inv.filter(i => i.effective_status === 'vencida');
  const pend = inv.filter(i => isOpen(i) && i.effective_status !== 'vencida');
  const pag  = inv.filter(i => i.status === 'pagada');

  const pendAmt = sum([...venc, ...pend], 'amount_due');
  const vencAmt = sum(venc, 'amount_due');
  const paidMonth = sum(pag.filter(i => (i.payment_date || '').startsWith(ym)), 'total');
  const totalMonth = sum(live.filter(i => i.issue_date.startsWith(ym)), 'total');

  const upcoming = [...pend].sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 10);
  const alerts = pend.filter(i => i.days_to_due >= 0 && i.days_to_due <= ALERT_DAYS)
                     .sort((a, b) => a.days_to_due - b.days_to_due);
  const overdue = [...venc].sort((a, b) => a.due_date.localeCompare(b.due_date));

  const miniRow = i => `<a href="#/factura/${i.id}">
      <span>${fdate(i.due_date)}</span>
      <span>${esc(i.company_name)}</span>
      <span class="hide-sm muted">${esc(i.invoice_number)}</span>
      <span class="num">${money(i.amount_due, i.currency)}</span></a>`;

  v.innerHTML = `
    <div class="page-head">
      <div><h1>Resumen</h1><div class="sub">${fdate(today)}</div></div>
      <a class="btn btn-primary" href="#/nueva">+ Nueva factura</a>
    </div>

    <div class="grid grid-3 stats" style="margin-bottom:16px">
      <a class="card stat st-vencida" href="#" data-go="vencida"><div class="label"><span class="dot"></span>Vencidas</div><div class="value">${venc.length}</div></a>
      <a class="card stat st-pendiente" href="#" data-go="pendiente"><div class="label"><span class="dot"></span>Pendientes</div><div class="value">${pend.length}</div></a>
      <a class="card stat st-pagada" href="#" data-go="pagada"><div class="label"><span class="dot"></span>Pagadas</div><div class="value">${pag.length}</div></a>
    </div>

    <div class="grid grid-4" style="margin-bottom:16px">
      <div class="card stat"><div class="label">Pendiente de pago</div><div class="value">${money(pendAmt)}</div><div class="hint">Incluye lo vencido</div></div>
      <div class="card stat st-vencida"><div class="label">Vencido</div><div class="value">${money(vencAmt)}</div></div>
      <div class="card stat"><div class="label">Pagado este mes</div><div class="value">${money(paidMonth)}</div></div>
      <div class="card stat"><div class="label">Facturado este mes</div><div class="value">${money(totalMonth)}</div></div>
    </div>

    ${alerts.length ? `
    <div class="card alerts">
      <h2>Avisos de vencimiento (próximos ${ALERT_DAYS} días)</h2>
      ${alerts.map(i => `<a class="alert-item" href="#/factura/${i.id}">
        <span>Factura <strong>${esc(i.invoice_number)}</strong> de ${esc(i.company_name)} · ${money(i.amount_due, i.currency)}</span>
        <span class="when ${i.days_to_due <= 1 ? 'urgent' : ''}">${dueText(i.days_to_due)}</span></a>`).join('')}
    </div>` : ''}

    <div class="grid grid-2">
      <div class="card">
        <h2>Facturas vencidas</h2>
        <div class="mini-list">${overdue.length ? overdue.map(miniRow).join('') : '<div class="muted">No hay facturas vencidas.</div>'}</div>
      </div>
      <div class="card">
        <h2>Próximos vencimientos</h2>
        <div class="mini-list">${upcoming.length ? upcoming.map(miniRow).join('') : '<div class="muted">No hay vencimientos pendientes.</div>'}</div>
      </div>
    </div>`;

  $$('[data-go]', v).forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    goInvoicesFiltered({ status: a.dataset.go });
  }));
}

/* ---------------------------------------------------------------------
   Tabla de facturas (reutilizable)
   --------------------------------------------------------------------- */
function renderInvoiceTable(container, list, { hideCompany = false } = {}) {
  const { key, dir } = state.sort;
  const sorted = [...list].sort((a, b) => {
    let x = a[key], y = b[key];
    if (key === 'total' || key === 'amount_due') { x = Number(x); y = Number(y); return (x - y) * dir; }
    return String(x ?? '').localeCompare(String(y ?? ''), 'es', { numeric: true }) * dir;
  });
  const cols = [
    ['due_date', 'Vence'], ...(hideCompany ? [] : [['company_name', 'Empresa']]),
    ['invoice_number', 'Nº factura'], ['concept', 'Concepto'], ['issue_date', 'Emisión'],
    ['total', 'Total'], ['amount_due', 'Pendiente'], ['effective_status', 'Estado']
  ];
  const arrow = k => k === key ? (dir === 1 ? ' ▲' : ' ▼') : '';
  const live = list.filter(i => i.status !== 'anulada');

  if (!list.length) { container.innerHTML = '<div class="card empty">No hay facturas con estos criterios.</div>'; return; }

  container.innerHTML = `
    <div class="table-wrap cards">
      <table>
        <thead><tr>${cols.map(([k, l]) =>
          `<th data-sort="${k}" class="${['total', 'amount_due'].includes(k) ? 'num' : ''}">${l}${arrow(k)}</th>`).join('')}<th></th></tr></thead>
        <tbody>${sorted.map(i => `
          <tr data-id="${i.id}" class="${i.effective_status === 'vencida' ? 'row-vencida' : ''}">
            <td data-label="Vence">${fdate(i.due_date)}</td>
            ${hideCompany ? '' : `<td data-label="Empresa"><strong>${esc(i.company_name)}</strong></td>`}
            <td data-label="Nº factura">${esc(i.invoice_number)}</td>
            <td data-label="Concepto" class="cell-concept">${esc(i.concept || '—')}</td>
            <td data-label="Emisión">${fdate(i.issue_date)}</td>
            <td data-label="Total" class="num">${money(i.total, i.currency)}</td>
            <td data-label="Pendiente" class="num">${i.status === 'anulada' ? '—' : money(i.amount_due, i.currency)}</td>
            <td data-label="Estado">${badge(i.effective_status)}</td>
            <td data-label="Documento">${i.file_path ? '<span class="doc-tag">PDF</span>' : ''}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="${hideCompany ? 4 : 5}">${list.length} factura${list.length === 1 ? '' : 's'}</td>
          <td class="num" data-label="Total">${money(sum(live, 'total'))}</td>
          <td class="num" data-label="Pendiente">${money(sum(live.filter(isOpen), 'amount_due'))}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
    </div>`;

  $$('th[data-sort]', container).forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    renderInvoiceTable(container, list, { hideCompany });
  }));
  $$('tbody tr', container).forEach(tr => tr.addEventListener('click', () => {
    location.hash = '#/factura/' + tr.dataset.id;
  }));
}

function filterInvoices(inv) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const min = parseAmount(f.min), max = parseAmount(f.max);
  return inv.filter(i => {
    if (f.company && i.company_id !== f.company) return false;
    if (f.status === 'abiertas') { if (!isOpen(i)) return false; }
    else if (f.status && i.effective_status !== f.status) return false;
    if (f.year && !i.issue_date.startsWith(f.year)) return false;
    if (f.month && i.issue_date.slice(5, 7) !== f.month) return false;
    if (f.from && i.due_date < f.from) return false;
    if (f.to && i.due_date > f.to) return false;
    if (min !== null && !Number.isNaN(min) && Number(i.total) < min) return false;
    if (max !== null && !Number.isNaN(max) && Number(i.total) > max) return false;
    if (q && !`${i.invoice_number} ${i.concept || ''} ${i.company_name}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/* ---------------------------------------------------------------------
   FACTURAS
   --------------------------------------------------------------------- */
async function pageInvoices(v) {
  const inv = await loadInvoices();
  const f = state.filters;
  const years = [...new Set(inv.map(i => i.issue_date.slice(0, 4)))].sort().reverse();
  const statusOpts = [['', 'Todos los estados'], ['abiertas', 'Pendientes + vencidas'], ['vencida', 'Vencidas'],
    ['pendiente', 'Pendientes'], ['parcialmente_pagada', 'Pago parcial'], ['pagada', 'Pagadas'], ['anulada', 'Anuladas']];

  v.innerHTML = `
    <div class="page-head">
      <h1>Facturas</h1>
      <a class="btn btn-primary" href="#/nueva">+ Nueva factura</a>
    </div>
    <div class="card filters">
      <input type="search" id="f-q" placeholder="Buscar por nº, concepto o empresa" value="${esc(f.q)}">
      <select id="f-company"><option value="">Todas las empresas</option>
        ${state.companies.map(c => `<option value="${c.id}" ${f.company === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="f-status">${statusOpts.map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="f-year"><option value="">Todos los años</option>
        ${years.map(y => `<option ${f.year === y ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <select id="f-month"><option value="">Todos los meses</option>
        ${MONTHS.map((m, n) => { const k = String(n + 1).padStart(2, '0'); return `<option value="${k}" ${f.month === k ? 'selected' : ''}>${m}</option>`; }).join('')}</select>
      <div class="row2">
        <label>Vence desde<input type="date" id="f-from" value="${esc(f.from)}"></label>
        <label>Vence hasta<input type="date" id="f-to" value="${esc(f.to)}"></label>
        <label>Importe mín.<input id="f-min" inputmode="decimal" value="${esc(f.min)}" placeholder="0,00"></label>
        <label>Importe máx.<input id="f-max" inputmode="decimal" value="${esc(f.max)}" placeholder="0,00"></label>
        <button class="btn" id="f-clear" type="button">Limpiar filtros</button>
      </div>
    </div>
    <div id="table"></div>`;

  const apply = () => {
    Object.assign(state.filters, {
      q: $('#f-q').value, company: $('#f-company').value, status: $('#f-status').value,
      year: $('#f-year').value, month: $('#f-month').value, from: $('#f-from').value,
      to: $('#f-to').value, min: $('#f-min').value, max: $('#f-max').value
    });
    renderInvoiceTable($('#table'), filterInvoices(inv));
  };
  $$('.filters input, .filters select', v).forEach(el => el.addEventListener('input', apply));
  $('#f-clear').addEventListener('click', () => { goInvoicesFiltered({}); route(); });
  apply();
}

/* ---------------------------------------------------------------------
   DETALLE DE FACTURA
   --------------------------------------------------------------------- */
async function pageInvoiceDetail(v, id) {
  const { data: i, error } = await sb.from('invoices_view').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!i) { v.innerHTML = '<div class="empty">Factura no encontrada.</div>'; return; }
  const { data: events } = await sb.from('invoice_events')
    .select('*, profiles(full_name)').eq('invoice_id', id).order('created_at', { ascending: false });
  const company = state.companies.find(c => c.id === i.company_id);

  const cell = (k, val, big = false) => `<div><div class="k">${k}</div><div class="v ${big ? 'big' : ''}">${val}</div></div>`;
  const describe = ev => {
    if (!ev.details || ev.event_type === 'creada') return '';
    return Object.entries(ev.details)
      .filter(([k]) => FIELD_LABELS[k] && !['paid_by', 'file_path', 'company_id'].includes(k))
      .map(([k, c]) => `${FIELD_LABELS[k]}: ${esc(c?.antes ?? '—')} → ${esc(c?.despues ?? '—')}`).join(' · ');
  };

  v.innerHTML = `
    <a class="back no-print" href="#/facturas">← Volver a facturas</a>
    <div class="page-head">
      <div>
        <h1>${esc(i.company_name)} · ${esc(i.invoice_number)}</h1>
        <div class="sub">${badge(i.effective_status)}
          ${isOpen(i) ? ` <span style="margin-left:6px">${dueText(i.days_to_due)}</span>` : ''}</div>
      </div>
      <div class="actions no-print">
        ${isOpen(i) ? `<button class="btn btn-success" id="a-pay">Marcar como pagada</button>
                        <button class="btn" id="a-partial">Pago parcial</button>` : ''}
        <a class="btn" href="#/editar/${i.id}">Editar</a>
      </div>
    </div>

    <div class="card">
      <div class="detail-grid">
        ${cell('Total', money(i.total, i.currency), true)}
        ${cell('Pendiente', i.status === 'anulada' ? '—' : money(i.amount_due, i.currency), true)}
        ${cell('Pagado', money(i.amount_paid, i.currency), true)}
        ${cell('Empresa', `<a href="#/empresa/${i.company_id}">${esc(i.company_name)}</a>`)}
        ${cell('Nº factura', esc(i.invoice_number))}
        ${cell('Concepto', esc(i.concept || '—'))}
        ${cell('Fecha de emisión', fdate(i.issue_date))}
        ${cell('Inicio del servicio', fdate(i.service_start_date))}
        ${cell('Vencimiento', fdate(i.due_date))}
        ${cell('Base imponible', money(i.subtotal, i.currency))}
        ${cell('IVA', money(i.tax, i.currency))}
        ${cell('Moneda', esc(i.currency))}
        ${cell('Método de pago', esc(METHODS[i.payment_method] || METHODS[company?.default_payment_method] || '—'))}
        ${cell('Fecha de pago', fdate(i.payment_date))}
        ${cell('Pagada por', esc(i.paid_by_name || '—'))}
        ${cell('Registrada por', esc(i.created_by_name || '—'))}
        <div style="grid-column:1/-1">${cell('Notas', esc(i.notes || '—'))}</div>
      </div>
    </div>

    <div class="card no-print">
      <h2>Documento</h2>
      <div class="actions">
        ${i.file_path ? `<button class="btn" id="a-view">Ver documento</button>
                         <button class="btn" id="a-download">Descargar</button>` : '<span class="muted" style="align-self:center">Sin documento adjunto.</span>'}
        <label class="btn">${i.file_path ? 'Reemplazar documento' : 'Adjuntar PDF o foto'}
          <input type="file" id="a-file" accept="application/pdf,image/*" hidden></label>
      </div>
    </div>

    <div class="card">
      <h2>Historial</h2>
      <ul class="timeline">${(events || []).map(ev => `
        <li><div><div>${esc(EVENTS[ev.event_type] || ev.event_type)} · <strong>${esc(ev.profiles?.full_name || '—')}</strong></div>
          ${describe(ev) ? `<div class="d">${describe(ev)}</div>` : ''}</div>
          <div class="t">${fdatetime(ev.created_at)}</div></li>`).join('') || '<li class="muted">Sin registros.</li>'}
      </ul>
    </div>

    <div class="actions no-print" style="justify-content:flex-end">
      ${i.status === 'pagada' ? '<button class="btn btn-danger" id="a-unpay">Deshacer pago</button>' : ''}
      ${i.status === 'anulada' ? '<button class="btn" id="a-reactivate">Reactivar factura</button>'
                               : (i.status !== 'pagada' ? '<button class="btn btn-danger" id="a-void">Anular factura</button>' : '')}
    </div>`;

  const defMethod = i.payment_method || company?.default_payment_method || '';
  const on = (sel, fn) => { const el = $(sel, v); if (el) el.addEventListener('click', fn); };

  on('#a-pay', () => modal({
    title: 'Marcar como pagada',
    body: `<p style="margin:0">${esc(i.company_name)} · ${esc(i.invoice_number)} · <strong>${money(i.total, i.currency)}</strong></p>
      <label class="field"><span>Fecha de pago</span><input type="date" id="m-date" value="${todayISO()}" max="${todayISO()}"></label>
      <label class="field"><span>Método de pago</span><select id="m-method">${methodOptions(defMethod)}</select></label>`,
    confirm: 'Confirmar pago',
    onConfirm: async w => {
      const d = $('#m-date', w).value;
      if (!d) { toast('Indica la fecha de pago.', 'err'); return false; }
      await updateInvoice(i.id, { status: 'pagada', payment_date: d, payment_method: $('#m-method', w).value || null });
      toast('Factura marcada como pagada.');
      route();
    }
  }));

  on('#a-partial', () => modal({
    title: 'Registrar pago parcial',
    body: `<p style="margin:0">Total de la factura: <strong>${money(i.total, i.currency)}</strong></p>
      <label class="field"><span>Importe pagado acumulado</span>
        <input id="m-amount" inputmode="decimal" value="${amountInput(i.amount_paid || null)}" placeholder="0,00"></label>
      <label class="field"><span>Método de pago</span><select id="m-method">${methodOptions(defMethod)}</select></label>
      <span class="hint">Si el importe iguala el total, la factura pasa a pagada.</span>`,
    confirm: 'Guardar',
    onConfirm: async w => {
      const amt = parseAmount($('#m-amount', w).value);
      if (amt === null || Number.isNaN(amt) || amt <= 0) { toast('Importe no válido.', 'err'); return false; }
      if (amt > Number(i.total)) { toast('El importe supera el total de la factura.', 'err'); return false; }
      const method = $('#m-method', w).value || null;
      if (amt >= Number(i.total)) await updateInvoice(i.id, { status: 'pagada', payment_method: method });
      else await updateInvoice(i.id, { status: 'parcialmente_pagada', amount_paid: amt, payment_method: method });
      toast('Pago registrado.');
      route();
    }
  }));

  on('#a-void', () => modal({
    title: 'Anular factura',
    body: '<p style="margin:0">La factura quedará anulada y no contará en importes ni informes. Se puede reactivar después.</p>',
    confirm: 'Anular', danger: true,
    onConfirm: async () => { await updateInvoice(i.id, { status: 'anulada' }); toast('Factura anulada.'); route(); }
  }));

  on('#a-unpay', () => modal({
    title: 'Deshacer pago',
    body: '<p style="margin:0">La factura volverá a estado pendiente y se eliminará la fecha de pago. El cambio queda en el historial.</p>',
    confirm: 'Deshacer pago', danger: true,
    onConfirm: async () => { await updateInvoice(i.id, { status: 'pendiente', amount_paid: 0 }); toast('Pago deshecho.'); route(); }
  }));

  on('#a-reactivate', async () => {
    const partial = Number(i.amount_paid) > 0 && Number(i.amount_paid) < Number(i.total);
    try {
      await updateInvoice(i.id, { status: partial ? 'parcialmente_pagada' : 'pendiente' });
      toast('Factura reactivada.');
      route();
    } catch (e) { toast(errMsg(e), 'err'); }
  });

  on('#a-view', () => openDoc(i.file_path));
  on('#a-download', () => openDoc(i.file_path, true));

  const fileInput = $('#a-file', v);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    toast('Subiendo documento…');
    try {
      const path = await uploadDoc(file, i.company_name, i.invoice_number, i.issue_date);
      await updateInvoice(i.id, { file_path: path });
      toast('Documento adjuntado.');
      route();
    } catch (e) { toast(errMsg(e), 'err'); }
  });
}

/* ---------------------------------------------------------------------
   NUEVA / EDITAR FACTURA
   --------------------------------------------------------------------- */
async function pageInvoiceForm(v, id) {
  await loadCompanies();
  let inv = null;
  if (id) {
    const { data, error } = await sb.from('invoices').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) { v.innerHTML = '<div class="empty">Factura no encontrada.</div>'; return; }
    inv = data;
  }
  const companies = state.companies.filter(c => c.active || c.id === inv?.company_id);
  const val = k => esc(inv?.[k] ?? '');
  let selectedFile = null;
  let totalTouched = !!inv;

  v.innerHTML = `
    <a class="back" href="${id ? '#/factura/' + id : '#/facturas'}">← ${id ? 'Volver a la factura' : 'Volver a facturas'}</a>
    <div class="page-head"><h1>${id ? 'Editar factura' : 'Nueva factura'}</h1></div>

    <div class="form-layout">
      <form id="inv-form" class="card" novalidate>
        <label class="dropzone" id="drop">
          <input type="file" id="file" accept="application/pdf,image/*" hidden>
          <strong>${inv?.file_path ? 'Arrastra aquí un documento para reemplazar el actual' : 'Arrastra el PDF de la factura aquí'}</strong>
          <span class="muted">o</span>
          <span class="btn">Seleccionar archivo</span>
          <small id="file-name">${inv?.file_path ? 'Documento actual adjunto' : ''}</small>
        </label>

        <div class="form-grid">
          <label class="field full"><span>Empresa <span class="req">*</span></span>
            <select name="company_id" required><option value="">Selecciona empresa…</option>
              ${companies.map(c => `<option value="${c.id}" ${inv?.company_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select></label>
          <label class="field"><span>Nº factura <span class="req">*</span></span>
            <input name="invoice_number" required value="${val('invoice_number')}" autocomplete="off"></label>
          <label class="field"><span>Moneda</span>
            <select name="currency">${['EUR', 'USD', 'GBP'].map(c => `<option ${(inv?.currency || 'EUR') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label class="field full"><span>Concepto</span>
            <input name="concept" value="${val('concept')}" placeholder="Ej.: Envíos septiembre"></label>
          <label class="field"><span>Fecha de emisión <span class="req">*</span></span>
            <input type="date" name="issue_date" required value="${val('issue_date')}"></label>
          <label class="field"><span>Inicio del servicio</span>
            <input type="date" name="service_start_date" value="${val('service_start_date')}"></label>
          <div class="field full"><span>Fecha de vencimiento <span class="req">*</span></span>
            <div class="inline">
              <input type="date" name="due_date" required value="${val('due_date')}" style="max-width:200px">
              ${[0, 15, 30, 60].map(d => `<button type="button" class="btn btn-sm" data-days="${d}">${d === 0 ? 'Al emitir' : '+' + d + ' días'}</button>`).join('')}
            </div></div>
          <label class="field"><span>Base imponible</span>
            <input name="subtotal" inputmode="decimal" value="${amountInput(inv?.subtotal)}" placeholder="0,00"></label>
          <div class="field"><span>IVA</span>
            <div class="inline"><input name="tax" inputmode="decimal" value="${amountInput(inv?.tax)}" placeholder="0,00" style="flex:1">
              <button type="button" class="btn btn-sm" id="iva21">21%</button></div></div>
          <label class="field"><span>Total <span class="req">*</span></span>
            <input name="total" inputmode="decimal" required value="${amountInput(inv?.total)}" placeholder="0,00"></label>
          <label class="field"><span>Método de pago</span>
            <select name="payment_method">${methodOptions(inv?.payment_method || '')}</select></label>
          <label class="field full"><span>Notas</span>
            <textarea name="notes">${val('notes')}</textarea></label>
          ${!id ? `
          <div class="field full">
            <label class="check"><input type="checkbox" id="already-paid"> Esta factura ya está pagada</label>
            <input type="date" id="paid-date" value="${todayISO()}" max="${todayISO()}" style="max-width:200px;display:none">
          </div>` : ''}
        </div>

        <div class="actions" style="margin-top:20px;justify-content:flex-end">
          <a class="btn" href="${id ? '#/factura/' + id : '#/facturas'}">Cancelar</a>
          <button class="btn btn-primary" type="submit" id="save">Guardar factura</button>
        </div>
      </form>

      <div class="preview-col">
        <div class="preview" id="preview"><span>La vista previa del documento aparecerá aquí.</span></div>
      </div>
    </div>`;

  const form = $('#inv-form');
  const F = n => form.elements[n];

  // Vista previa del documento
  const showPreview = (url, type) => {
    const p = $('#preview');
    if (!url) { p.innerHTML = '<span>La vista previa del documento aparecerá aquí.</span>'; return; }
    p.innerHTML = /pdf/.test(type) ? `<iframe src="${url}" title="Documento"></iframe>` : `<img src="${url}" alt="Documento">`;
  };
  if (inv?.file_path) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrl(inv.file_path, 600);
    if (data) showPreview(data.signedUrl, inv.file_path.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image');
  }
  const pickFile = file => {
    if (!file) return;
    if (!/pdf|image/.test(file.type)) { toast('Usa un PDF o una imagen.', 'err'); return; }
    if (file.size > 10 * 1024 * 1024) { toast('El archivo supera 10 MB.', 'err'); return; }
    selectedFile = file;
    $('#file-name').textContent = file.name;
    showPreview(URL.createObjectURL(file), file.type);
  };
  const drop = $('#drop');
  $('#file').addEventListener('change', e => pickFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => pickFile(e.dataTransfer.files[0]));

  // Método de pago por defecto de la empresa
  F('company_id').addEventListener('change', () => {
    const c = state.companies.find(x => x.id === F('company_id').value);
    if (c?.default_payment_method && !F('payment_method').value) F('payment_method').value = c.default_payment_method;
  });

  // Vencimiento rápido
  $$('[data-days]', form).forEach(b => b.addEventListener('click', () => {
    if (!F('issue_date').value) { toast('Indica primero la fecha de emisión.', 'err'); return; }
    F('due_date').value = addDays(F('issue_date').value, Number(b.dataset.days));
  }));

  // Totales
  const recalc = () => {
    if (totalTouched) return;
    const s = parseAmount(F('subtotal').value), t = parseAmount(F('tax').value);
    if (s !== null && !Number.isNaN(s)) F('total').value = amountInput(s + (Number.isNaN(t) || t === null ? 0 : t));
  };
  F('subtotal').addEventListener('input', recalc);
  F('tax').addEventListener('input', recalc);
  F('total').addEventListener('input', () => { totalTouched = F('total').value.trim() !== ''; });
  $('#iva21').addEventListener('click', () => {
    const s = parseAmount(F('subtotal').value);
    if (s === null || Number.isNaN(s)) { toast('Indica primero la base imponible.', 'err'); return; }
    const tax = Math.round(s * 21) / 100;
    F('tax').value = amountInput(tax);
    F('total').value = amountInput(s + tax);
    totalTouched = false;
  });

  const paidChk = $('#already-paid');
  if (paidChk) paidChk.addEventListener('change', () => { $('#paid-date').style.display = paidChk.checked ? 'block' : 'none'; });

  // Guardar
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const subtotal = parseAmount(F('subtotal').value);
    const tax = parseAmount(F('tax').value);
    const total = parseAmount(F('total').value);
    const payload = {
      company_id: F('company_id').value,
      invoice_number: F('invoice_number').value.trim(),
      concept: F('concept').value.trim() || null,
      issue_date: F('issue_date').value,
      service_start_date: F('service_start_date').value || null,
      due_date: F('due_date').value,
      subtotal, tax, total,
      currency: F('currency').value,
      payment_method: F('payment_method').value || null,
      notes: F('notes').value.trim() || null
    };
    const missing = [];
    if (!payload.company_id) missing.push('empresa');
    if (!payload.invoice_number) missing.push('nº factura');
    if (!payload.issue_date) missing.push('fecha de emisión');
    if (!payload.due_date) missing.push('vencimiento');
    if (total === null) missing.push('total');
    if (missing.length) { toast('Falta: ' + missing.join(', ') + '.', 'err'); return; }
    if ([subtotal, tax, total].some(n => Number.isNaN(n))) { toast('Revisa los importes: formato no válido.', 'err'); return; }
    if (total < 0) { toast('El total no puede ser negativo.', 'err'); return; }
    if (payload.due_date < payload.issue_date) { toast('El vencimiento no puede ser anterior a la emisión.', 'err'); return; }
    if (subtotal !== null && tax !== null && Math.abs(subtotal + tax - total) > 0.01) {
      const ok = await modal({
        title: 'Importes no cuadran',
        body: `<p style="margin:0">Base (${money(subtotal)}) + IVA (${money(tax)}) = ${money(subtotal + tax)}, pero el total indicado es ${money(total)}. ¿Guardar igualmente?</p>`,
        confirm: 'Guardar igualmente'
      });
      if (!ok) return;
    }
    if (!id && paidChk?.checked) {
      payload.status = 'pagada';
      payload.payment_date = $('#paid-date').value || todayISO();
    }

    const btn = $('#save');
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      let invoiceId = id;
      if (id) {
        await updateInvoice(id, payload);
      } else {
        const { data, error } = await sb.from('invoices').insert(payload).select('id').single();
        if (error) throw error;
        invoiceId = data.id;
      }
      if (selectedFile) {
        try {
          const cname = state.companies.find(c => c.id === payload.company_id)?.name;
          const path = await uploadDoc(selectedFile, cname, payload.invoice_number, payload.issue_date);
          await updateInvoice(invoiceId, { file_path: path });
        } catch (upErr) {
          toast('Factura guardada, pero el documento no se pudo subir: ' + errMsg(upErr), 'err');
          location.hash = '#/factura/' + invoiceId;
          return;
        }
      }
      toast(id ? 'Cambios guardados.' : 'Factura registrada.');
      location.hash = '#/factura/' + invoiceId;
    } catch (err) {
      toast(errMsg(err), 'err');
      btn.disabled = false;
      btn.textContent = 'Guardar factura';
    }
  });
}

/* ---------------------------------------------------------------------
   EMPRESAS
   --------------------------------------------------------------------- */
function companyStats(inv, cid) {
  const list = inv.filter(i => i.company_id === cid);
  const live = list.filter(i => i.status !== 'anulada');
  const open = list.filter(isOpen);
  const venc = list.filter(i => i.effective_status === 'vencida');
  return {
    list, count: live.length, pending: sum(open, 'amount_due'), overdueCount: venc.length,
    overdue: sum(venc, 'amount_due'), total: sum(live, 'total'),
    paid: sum(list.filter(i => i.status === 'pagada'), 'total'),
    paidCount: list.filter(i => i.status === 'pagada').length, openCount: open.length - venc.length
  };
}

function companyModal(c = null) {
  return modal({
    title: c ? 'Editar empresa' : 'Nueva empresa',
    body: `
      <label class="field"><span>Nombre <span class="req">*</span></span><input id="c-name" value="${esc(c?.name)}"></label>
      <label class="field"><span>NIF / CIF</span><input id="c-tax" value="${esc(c?.tax_id)}"></label>
      <label class="field"><span>Método de pago habitual</span><select id="c-method">${methodOptions(c?.default_payment_method || '')}</select></label>
      <label class="field"><span>Email</span><input type="email" id="c-email" value="${esc(c?.email)}"></label>
      <label class="field"><span>Teléfono</span><input type="tel" id="c-phone" value="${esc(c?.phone)}"></label>
      <label class="field"><span>Notas</span><textarea id="c-notes">${esc(c?.notes)}</textarea></label>
      <label class="check"><input type="checkbox" id="c-active" ${!c || c.active ? 'checked' : ''}> Empresa activa</label>`,
    confirm: 'Guardar',
    onConfirm: async w => {
      const row = {
        name: $('#c-name', w).value.trim().toUpperCase(),
        tax_id: $('#c-tax', w).value.trim() || null,
        default_payment_method: $('#c-method', w).value || null,
        email: $('#c-email', w).value.trim() || null,
        phone: $('#c-phone', w).value.trim() || null,
        notes: $('#c-notes', w).value.trim() || null,
        active: $('#c-active', w).checked
      };
      if (!row.name) { toast('Indica el nombre.', 'err'); return false; }
      const q = c ? sb.from('transport_companies').update(row).eq('id', c.id)
                  : sb.from('transport_companies').insert(row);
      const { error } = await q;
      if (error) throw error;
      await loadCompanies();
      toast('Empresa guardada.');
      route();
    }
  });
}

async function pageCompanies(v) {
  const [inv] = await Promise.all([loadInvoices(), loadCompanies()]);
  const rows = state.companies.map(c => ({ c, s: companyStats(inv, c.id) }));

  v.innerHTML = `
    <div class="page-head">
      <h1>Empresas de transporte</h1>
      <button class="btn btn-primary" id="new-company">+ Nueva empresa</button>
    </div>
    <div class="table-wrap cards">
      <table>
        <thead><tr><th>Empresa</th><th>Pago habitual</th><th class="num">Facturas</th><th class="num">Vencidas</th>
          <th class="num">Pendiente</th><th class="num">Total facturado</th><th>Estado</th></tr></thead>
        <tbody>${rows.map(({ c, s }) => `
          <tr data-id="${c.id}">
            <td data-label="Empresa"><strong>${esc(c.name)}</strong></td>
            <td data-label="Pago habitual">${esc(METHODS[c.default_payment_method] || '—')}</td>
            <td data-label="Facturas" class="num">${s.count}</td>
            <td data-label="Vencidas" class="num">${s.overdueCount ? `<span class="badge st-vencida">${s.overdueCount}</span>` : '0'}</td>
            <td data-label="Pendiente" class="num">${money(s.pending)}</td>
            <td data-label="Total facturado" class="num">${money(s.total)}</td>
            <td data-label="Estado">${c.active ? 'Activa' : '<span class="muted">Inactiva</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  $('#new-company').addEventListener('click', () => companyModal());
  $$('tbody tr', v).forEach(tr => tr.addEventListener('click', () => { location.hash = '#/empresa/' + tr.dataset.id; }));
}

async function pageCompanyDetail(v, id) {
  const [inv] = await Promise.all([loadInvoices(), loadCompanies()]);
  const c = state.companies.find(x => x.id === id);
  if (!c) { v.innerHTML = '<div class="empty">Empresa no encontrada.</div>'; return; }
  const s = companyStats(inv, id);
  const upcoming = s.list.filter(i => isOpen(i) && i.effective_status !== 'vencida')
    .sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5);

  v.innerHTML = `
    <a class="back" href="#/empresas">← Volver a empresas</a>
    <div class="page-head">
      <div><h1>${esc(c.name)}</h1>
        <div class="sub">${esc(METHODS[c.default_payment_method] || 'Sin método habitual')}${c.tax_id ? ' · ' + esc(c.tax_id) : ''}${c.active ? '' : ' · Inactiva'}</div></div>
      <div class="actions">
        <button class="btn" id="edit-company">Editar empresa</button>
        <a class="btn btn-primary" href="#/nueva">+ Nueva factura</a>
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:16px">
      <div class="card stat st-vencida"><div class="label"><span class="dot"></span>Vencidas</div><div class="value">${s.overdueCount}</div><div class="hint">${money(s.overdue)}</div></div>
      <div class="card stat st-pendiente"><div class="label"><span class="dot"></span>Pendientes</div><div class="value">${s.openCount}</div><div class="hint">${money(s.pending - s.overdue)}</div></div>
      <div class="card stat st-pagada"><div class="label"><span class="dot"></span>Pagadas</div><div class="value">${s.paidCount}</div><div class="hint">${money(s.paid)}</div></div>
      <div class="card stat"><div class="label">Total gastado</div><div class="value">${money(s.total)}</div><div class="hint">${s.count} facturas</div></div>
    </div>

    ${upcoming.length ? `<div class="card"><h2>Próximos vencimientos</h2><div class="mini-list">
      ${upcoming.map(i => `<a href="#/factura/${i.id}"><span>${fdate(i.due_date)}</span><span>${esc(i.invoice_number)}</span>
        <span class="hide-sm muted">${dueText(i.days_to_due)}</span><span class="num">${money(i.amount_due, i.currency)}</span></a>`).join('')}
    </div></div>` : ''}

    ${(c.email || c.phone || c.notes) ? `<div class="card"><h2>Contacto</h2>
      <div class="detail-grid">
        <div><div class="k">Email</div><div class="v">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</div></div>
        <div><div class="k">Teléfono</div><div class="v">${esc(c.phone || '—')}</div></div>
        <div><div class="k">Notas</div><div class="v">${esc(c.notes || '—')}</div></div>
      </div></div>` : ''}

    <h2>Facturas</h2>
    <div id="table"></div>`;

  $('#edit-company').addEventListener('click', () => companyModal(c));
  renderInvoiceTable($('#table'), s.list, { hideCompany: true });
}

/* ---------------------------------------------------------------------
   INFORMES
   --------------------------------------------------------------------- */
async function pageReports(v, selectedYear) {
  const all = await loadInvoices();
  const inv = all.filter(i => i.status !== 'anulada');
  const curYear = todayISO().slice(0, 4);
  const years = [...new Set([curYear, ...inv.map(i => i.issue_date.slice(0, 4))])].sort().reverse();
  const year = selectedYear || curYear;
  const yInv = inv.filter(i => i.issue_date.startsWith(year));

  const byCompany = state.companies.map(c => {
    const l = yInv.filter(i => i.company_id === c.id);
    return { name: c.name, n: l.length, total: sum(l, 'total'), pending: sum(l.filter(isOpen), 'amount_due') };
  }).filter(r => r.n > 0).sort((a, b) => b.total - a.total);

  const byMonth = MONTHS.map((m, n) => {
    const k = `${year}-${String(n + 1).padStart(2, '0')}`;
    return {
      m, billed: sum(yInv.filter(i => i.issue_date.startsWith(k)), 'total'),
      paid: sum(inv.filter(i => i.status === 'pagada' && (i.payment_date || '').startsWith(k)), 'total')
    };
  });

  const byYear = years.map(y => ({ y, total: sum(inv.filter(i => i.issue_date.startsWith(y)), 'total') })).filter(r => r.total > 0);
  const open = inv.filter(isOpen);
  const venc = inv.filter(i => i.effective_status === 'vencida');

  v.innerHTML = `
    <div class="page-head">
      <div><h1>Informes</h1><div class="sub">Importes de facturas no anuladas, por fecha de emisión</div></div>
      <div class="actions no-print">
        <select id="r-year" style="width:auto">${years.map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <button class="btn" id="r-print">Imprimir / PDF</button>
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:16px">
      <a class="card stat st-pendiente" href="#" data-go="abiertas"><div class="label">Pendiente de pago (todas las fechas)</div>
        <div class="value">${money(sum(open, 'amount_due'))}</div><div class="hint">${open.length} facturas</div></a>
      <a class="card stat st-vencida" href="#" data-go="vencida"><div class="label">Vencido (todas las fechas)</div>
        <div class="value">${money(sum(venc, 'amount_due'))}</div><div class="hint">${venc.length} facturas</div></a>
    </div>

    <div class="grid grid-2">
      <div>
        <h2>Gasto por empresa · ${year}</h2>
        <div class="table-wrap" style="margin-bottom:16px"><table class="static">
          <thead><tr><th>Empresa</th><th class="num">Facturas</th><th class="num">Total</th><th class="num">Pendiente</th></tr></thead>
          <tbody>${byCompany.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.n}</td><td class="num">${money(r.total)}</td><td class="num">${money(r.pending)}</td></tr>`).join('')
            || '<tr><td colspan="4" class="muted">Sin facturas en este año.</td></tr>'}</tbody>
          <tfoot><tr><td>TOTAL</td><td class="num">${byCompany.reduce((s, r) => s + r.n, 0)}</td>
            <td class="num">${money(byCompany.reduce((s, r) => s + r.total, 0))}</td>
            <td class="num">${money(byCompany.reduce((s, r) => s + r.pending, 0))}</td></tr></tfoot>
        </table></div>

        <h2>Gasto anual</h2>
        <div class="table-wrap"><table class="static">
          <thead><tr><th>Año</th><th class="num">Total facturado</th></tr></thead>
          <tbody>${byYear.map(r => `<tr><td>${r.y}</td><td class="num">${money(r.total)}</td></tr>`).join('')
            || '<tr><td colspan="2" class="muted">Sin datos.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div>
        <h2>Gasto mensual · ${year}</h2>
        <div class="table-wrap"><table class="static">
          <thead><tr><th>Mes</th><th class="num">Facturado</th><th class="num">Pagado</th></tr></thead>
          <tbody>${byMonth.map(r => `<tr><td>${r.m}</td><td class="num">${money(r.billed)}</td><td class="num">${money(r.paid)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>TOTAL</td><td class="num">${money(sum(byMonth, 'billed'))}</td><td class="num">${money(sum(byMonth, 'paid'))}</td></tr></tfoot>
        </table></div>
        <p class="hint">"Pagado" se asigna al mes de la fecha de pago.</p>
      </div>
    </div>`;

  $('#r-year').addEventListener('change', e => pageReports(v, e.target.value));
  $('#r-print').addEventListener('click', () => window.print());
  $$('[data-go]', v).forEach(a => a.addEventListener('click', e => { e.preventDefault(); goInvoicesFiltered({ status: a.dataset.go }); }));
}

/* ---------------------------------------------------------------------
   CONFIGURACIÓN
   --------------------------------------------------------------------- */
async function pageConfig(v) {
  const { data: users } = await sb.from('profiles').select('full_name, email, role, active').order('full_name');
  const { data: { user } } = await sb.auth.getUser();
  const p = state.profile;

  v.innerHTML = `
    <div class="page-head"><h1>Configuración</h1></div>
    <div class="grid grid-2">
      <div class="card">
        <h2>Mi cuenta</h2>
        <div class="detail-grid" style="grid-template-columns:1fr 1fr">
          <div><div class="k">Nombre</div><div class="v">${esc(p.full_name)}</div></div>
          <div><div class="k">Rol</div><div class="v">${p.role === 'admin' ? 'Administrador' : 'Usuario'}</div></div>
          <div style="grid-column:1/-1"><div class="k">Email</div><div class="v">${esc(user?.email || p.email)}</div></div>
        </div>
        <div class="actions" style="margin-top:16px"><button class="btn btn-danger" id="logout">Cerrar sesión</button></div>
      </div>

      <form class="card" id="pwd-form">
        <h2>Cambiar contraseña</h2>
        <div class="modal-body">
          <label class="field"><span>Nueva contraseña</span><input type="password" id="pwd1" minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>Repetir contraseña</span><input type="password" id="pwd2" minlength="8" autocomplete="new-password"></label>
          <span class="hint">Mínimo 8 caracteres.</span>
        </div>
        <div class="actions" style="margin-top:16px"><button class="btn btn-primary" type="submit">Actualizar contraseña</button></div>
      </form>
    </div>

    <div class="card">
      <h2>Usuarios con acceso</h2>
      <div class="table-wrap"><table class="static">
        <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th></tr></thead>
        <tbody>${(users || []).map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td>
          <td>${u.role === 'admin' ? 'Administrador' : 'Usuario'}</td><td>${u.active ? 'Activo' : 'Inactivo'}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="hint">El alta de usuarios se realiza desde el panel de Supabase (Authentication → Users).</p>
    </div>
    <p class="hint">Versión ${esc(cfg.VERSION || '')}</p>`;

  $('#logout').addEventListener('click', logout);
  $('#pwd-form').addEventListener('submit', async e => {
    e.preventDefault();
    const a = $('#pwd1').value, b = $('#pwd2').value;
    if (a.length < 8) { toast('La contraseña debe tener al menos 8 caracteres.', 'err'); return; }
    if (a !== b) { toast('Las contraseñas no coinciden.', 'err'); return; }
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) { toast(errMsg(error), 'err'); return; }
    $('#pwd1').value = ''; $('#pwd2').value = '';
    toast('Contraseña actualizada.');
  });
}

/* ---------------------------------------------------------------------
   Arranque
   --------------------------------------------------------------------- */
(async function init() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showLogin();
    await startApp(session.user);
  } catch (e) {
    showLogin('No se pudo conectar. Revisa tu conexión.');
  }
})();

})();
