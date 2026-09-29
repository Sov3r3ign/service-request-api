const LABELS = {
  status: { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' },
  priority: { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' },
  category: { facilities: 'Facilities', it: 'IT', hr: 'HR', other: 'Other' },
};
const FLOW = ['open', 'in_progress', 'resolved', 'closed'];
const ADVANCE_LABEL = {
  open: 'Start work',
  in_progress: 'Mark resolved',
  resolved: 'Close request',
};
// Mirrors the CHECK constraints in schema.sql
const LIMITS = {
  title: [3, 120],
  description: [3, 2000],
  requesterName: [2, 100],
};

const $ = (selector, root = document) => root.querySelector(selector);

const filtersForm = $('#filters');
const listEl = $('#list');
const statsEl = $('#stats');
const countEl = $('#count');
const toastEl = $('#toast');
const newDialog = $('#new-dialog');
const newForm = $('#new-form');
const detailDialog = $('#detail-dialog');
const detailForm = $('#detail-form');
const advanceBtn = $('#advance');

let current = null;
let loadToken = 0;
let toastTimer;

/* ---------- helpers ---------- */

// Builds DOM nodes with textContent only, so request text is never parsed as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDate = (iso) => dateFormat.format(new Date(iso));

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

function showError(form, message) {
  const el = $('.form-error', form);
  el.textContent = message || '';
  el.hidden = !message;
}

async function withBusy(button, task) {
  button.disabled = true;
  try {
    await task();
  } finally {
    button.disabled = false;
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Trimmed lengths must satisfy the database limits, otherwise the insert fails.
function lengthError(values) {
  const names = { title: 'Title', description: 'Description', requesterName: 'Name' };
  for (const [field, [min, max]] of Object.entries(LIMITS)) {
    if (!(field in values)) continue;
    const length = values[field].trim().length;
    if (length < min || length > max) {
      return `${names[field]} must be ${min} to ${max} characters.`;
    }
  }
  return '';
}

/* ---------- select options ---------- */

for (const select of document.querySelectorAll('select[data-options]')) {
  const labels = LABELS[select.dataset.options];
  if (select.dataset.all) select.append(h('option', { value: '' }, select.dataset.all));
  for (const [value, label] of Object.entries(labels)) {
    select.append(h('option', { value }, label));
  }
  if (select.dataset.default) select.value = select.dataset.default;
}

/* ---------- status pipeline ---------- */

function pipeline(status, large = false) {
  const index = FLOW.indexOf(status);
  if (large) {
    return h(
      'div',
      { class: 'pipe-lg', 'aria-label': `Status: ${LABELS.status[status]}` },
      FLOW.map((step, i) =>
        h(
          'div',
          { class: `step${i <= index ? ' on' : ''}${i === index ? ' current' : ''}` },
          h('i'),
          h('span', {}, LABELS.status[step]),
        ),
      ),
    );
  }
  return h(
    'span',
    { class: 'pipe', 'data-status': status, role: 'img', 'aria-label': `Status: ${LABELS.status[status]}` },
    FLOW.map((_, i) => h('i', { class: i <= index ? 'on' : '' })),
  );
}

/* ---------- list ---------- */

const hasFilters = () => [...new FormData(filtersForm).values()].some((v) => String(v).trim());

function rowEl(r) {
  return h(
    'li',
    {},
    h(
      'button',
      { class: 'row', type: 'button', 'data-priority': r.priority, onclick: () => openDetail(r) },
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-title' }, r.title),
        h(
          'span',
          { class: 'row-sub' },
          h('span', { class: 'tag' }, LABELS.category[r.category]),
          h('span', {}, `Requested by ${r.requester_name}`),
          r.assigned_to ? h('span', {}, `Assigned to ${r.assigned_to}`) : h('span', {}, 'Unassigned'),
        ),
      ),
      h('span', { class: `badge ${r.priority}` }, LABELS.priority[r.priority]),
      h('span', { class: 'row-status' }, pipeline(r.status), h('span', {}, LABELS.status[r.status])),
      h('time', { datetime: r.created_at }, fmtDate(r.created_at)),
    ),
  );
}

function renderList(rows) {
  countEl.textContent = `${rows.length} ${rows.length === 1 ? 'request' : 'requests'}`;

  if (rows.length === 0) {
    const filtered = hasFilters();
    listEl.replaceChildren(
      h(
        'li',
        { class: 'empty' },
        h('p', {}, filtered ? 'No requests match these filters.' : 'No requests yet.'),
        filtered
          ? h('button', { class: 'btn', type: 'button', onclick: () => filtersForm.reset() }, 'Clear filters')
          : h('button', { class: 'btn primary', type: 'button', onclick: openNew }, 'Create the first request'),
      ),
    );
    return;
  }
  listEl.replaceChildren(...rows.map(rowEl));
}

async function loadRequests() {
  const token = ++loadToken;
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(filtersForm)) {
    if (String(value).trim()) params.set(key, String(value).trim());
  }

  try {
    const rows = await api(`/api/requests?${params}`);
    if (token !== loadToken) return; // a newer search is already running
    renderList(rows);
  } catch (error) {
    if (token !== loadToken) return;
    countEl.textContent = '';
    listEl.replaceChildren(
      h(
        'li',
        { class: 'empty' },
        h('p', {}, `Couldn't load requests. ${error.message}`),
        h('button', { class: 'btn', type: 'button', onclick: loadRequests }, 'Try again'),
      ),
    );
  }
}

async function loadStats() {
  try {
    const d = await api('/api/dashboard');
    const items = [['Active', d.open], ['Resolved', d.resolved], ['Closed', d.closed], ['Total', d.total]];
    statsEl.replaceChildren(
      ...items.map(([label, value]) => h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, String(value)))),
    );
  } catch {
    statsEl.replaceChildren();
  }
}

const refresh = () => Promise.all([loadRequests(), loadStats()]);

/* ---------- new request ---------- */

function openNew() {
  newForm.reset();
  showError(newForm, '');
  newDialog.showModal();
  $('#n-title').focus();
}

newForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(newForm));
  const problem = lengthError(values);
  if (problem) return showError(newForm, problem);

  await withBusy($('[type=submit]', newForm), async () => {
    try {
      await api('/api/requests', { method: 'POST', body: values });
      newDialog.close();
      toast('Request created.');
      refresh();
    } catch (error) {
      showError(newForm, error.message);
    }
  });
});

/* ---------- request detail ---------- */

function fillDetail(r) {
  current = r;
  $('#detail-heading').textContent = `Request #${r.id}`;
  $('#detail-sub').textContent = `Requested by ${r.requester_name} on ${fmtDate(r.created_at)}`;
  $('#detail-pipe').replaceChildren(pipeline(r.status, true));

  const next = FLOW[FLOW.indexOf(r.status) + 1];
  advanceBtn.hidden = !next;
  advanceBtn.dataset.next = next || '';
  advanceBtn.textContent = ADVANCE_LABEL[r.status] || '';
  $('#advance-note').textContent = next ? '' : 'This request is closed.';

  const f = detailForm.elements;
  f.title.value = r.title;
  f.description.value = r.description;
  f.category.value = r.category;
  f.priority.value = r.priority;
  f.assignedTo.value = r.assigned_to || '';
}

function openDetail(r) {
  showError(detailForm, '');
  fillDetail(r);
  detailDialog.showModal();
}

detailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = detailForm.elements;
  const body = {
    title: f.title.value,
    description: f.description.value,
    category: f.category.value,
    priority: f.priority.value,
  };
  // The API can't clear an assignee, so only send one when there is a value.
  if (f.assignedTo.value.trim()) body.assignedTo = f.assignedTo.value;

  const problem = lengthError(body);
  if (problem) return showError(detailForm, problem);

  await withBusy($('[type=submit]', detailForm), async () => {
    try {
      const updated = await api(`/api/requests/${current.id}`, { method: 'PATCH', body });
      fillDetail(updated);
      showError(detailForm, '');
      toast('Changes saved.');
      refresh();
    } catch (error) {
      showError(detailForm, error.message);
    }
  });
});

advanceBtn.addEventListener('click', () =>
  withBusy(advanceBtn, async () => {
    try {
      const updated = await api(`/api/requests/${current.id}`, {
        method: 'PATCH',
        body: { status: advanceBtn.dataset.next },
      });
      fillDetail(updated);
      showError(detailForm, '');
      toast(`Request moved to ${LABELS.status[updated.status]}.`);
      refresh();
    } catch (error) {
      showError(detailForm, error.message);
    }
  }),
);

/* ---------- wiring ---------- */

$('#new-btn').addEventListener('click', openNew);

for (const dialog of [newDialog, detailDialog]) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  $('[data-close]', dialog).addEventListener('click', () => dialog.close());
}

const debouncedLoad = debounce(loadRequests, 250);
filtersForm.addEventListener('input', debouncedLoad);
filtersForm.addEventListener('submit', (event) => event.preventDefault());
filtersForm.addEventListener('reset', () => setTimeout(loadRequests));

refresh();