// ============================================================
//  app.js — UI-логика приложения (SPA без фреймворков)
// ============================================================
import { getSession, signIn, signOut, onAuthStateChange } from './auth.js';
import {
  fetchClients, createClient, updateClient, deleteClient,
  fetchAllTransactions, createTransaction, computeBalances,
  getMigrationStatus, importInitialDebts, restoreBackup,
} from './database.js';
import {
  formatMoneyMinor, formatMoney, formatDate, todayISO,
  debounce, escapeHtml, downloadTextFile, csvField, toMinorUnits, newUuid, normalizePersonSearch,
} from './utils.js';

// ------------------------------------------------------------
// Исходные данные для одноразовой миграции (см. п.16 ТЗ)
// ------------------------------------------------------------
const INITIAL_DATA = [
  ['Зарифа ойтимло', 370], ['Хасан ни хотуни', 110], ['Муаллими', 140],
  ['Шахло и мавчуда', 910], ['Апай мехри', 100], ['Наргиз ямло', 240],
  ['Апай Дилором адаш', 170], ['Фргоналик клиент', 210], ['Шахноза сердухтар', 180],
  ['Дилором Москва', 1360], ['Парвина тилло', 180], ['Хуршед', 100],
  ['Шахлоя хешаш', 100], ['Шахноза сердухтар', 100], ['Адолатти авсунлари', 790],
  ['Апай джамила', 300], ['Дилшода', 260], ['Апай шахло', 7150],
  ['Хусенни хотуни', 370], ['Шахло ямло', 2410], ['Нигора парда', 440],
  ['Чаман дузанда', 100], ['Мархабо', 320], ['Апай нисо доктор', 50],
  ['Наргиз ямло', 220], ['Орзугул апа', 510], ['Аиша Бренда апаш', 50],
  ['Апай нисо', 460], ['Марзабо апа', 1290], ['Апай нигина уборка', 330],
  ['Наргиз', 160], ['Мавлюда дугона', 140], ['Апай дом соз', 30],
  ['Насиба ойтимло', 350], ['Рано ямло', 1190], ['Шахло тилло', 1780],
  ['Зарина', 100], ['Апай таманно', 450], ['Апай хурсанд', 350],
  ['Суман 988347667', 100], ['Аиша бренда апаш', 80], ['Бону', 50],
  ['Хосият дилшода', 220], ['Вахдатлик янгамулло', 600],
];

// ------------------------------------------------------------
// Состояние приложения
// ------------------------------------------------------------
const state = {
  clients: [],
  transactions: [],
  balances: new Map(), // client_id -> {balanceMinor, lastDate}
  sortMode: 'amount',
  searchQuery: '',
  currentClientId: null,
  addDebtReturnView: 'main',
};

// ------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showView(id) {
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  const el = document.getElementById('view-' + id);
  if (el) el.classList.add('is-active');
  const tabTarget = ['main', 'analytics', 'settings'].includes(id) ? id : null;
  if (tabTarget) {
    $$('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tabTarget));
  }
  window.scrollTo(0, 0);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

function showConfirm(title, text, okLabel = 'Удалить') {
  return new Promise((resolve) => {
    const overlay = $('#confirm-overlay');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    overlay.hidden = false;
    const cleanup = (result) => {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const okBtn = $('#confirm-ok');
    const cancelBtn = $('#confirm-cancel');
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ------------------------------------------------------------
// Онлайн/офлайн статус
// ------------------------------------------------------------
function updateOnlineStatus() {
  $('#offline-banner').hidden = navigator.onLine;
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ------------------------------------------------------------
// АВТОРИЗАЦИЯ
// ------------------------------------------------------------
async function init() {
  updateOnlineStatus();
  const session = await getSession();
  if (session) {
    await enterApp();
  } else {
    showView('login');
  }

  onAuthStateChange((session) => {
    if (!session) {
      $('#app-root').hidden = true;
      showView('login');
    }
  });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-submit');
  const errEl = $('#login-error');
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Вход…';
  try {
    await signIn($('#login-email').value.trim(), $('#login-password').value);
    await enterApp();
  } catch (err) {
    errEl.textContent = 'Не удалось войти: проверьте email и пароль.';
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
});

$('#btn-sign-out').addEventListener('click', async () => {
  const ok = await showConfirm('Выйти из аккаунта?', 'Вы сможете снова войти в любой момент.', 'Выйти');
  if (!ok) return;
  await signOut();
});

async function enterApp() {
  $('#view-login').hidden = true;
  $('#app-root').hidden = false;
  await refreshData();
  showView('main');
}

// ------------------------------------------------------------
// ЗАГРУЗКА ДАННЫХ
// ------------------------------------------------------------
async function refreshData() {
  const list = $('#clients-list');
  if (list && !state.clients.length) list.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    const [clients, transactions] = await Promise.all([fetchClients(), fetchAllTransactions()]);
    state.clients = clients;
    state.transactions = transactions;
    state.balances = computeBalances(transactions);
    renderMainList();
    renderAnalytics();
    if (state.currentClientId) renderClientDetail(state.currentClientId);
  } catch (err) {
    console.error(err);
    toast('Ошибка загрузки данных');
  }
}

// ------------------------------------------------------------
// ГЛАВНЫЙ ЭКРАН: список должников
// ------------------------------------------------------------
function getActiveClients() {
  return state.clients
    .map((c) => {
      const bal = state.balances.get(c.id) || { balanceMinor: 0, lastDate: null };
      return { ...c, balanceMinor: bal.balanceMinor, lastDate: bal.lastDate };
    })
    .filter((c) => c.balanceMinor > 0);
}

function applySearch(list) {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.phone || '').toLowerCase().includes(q));
}

function applySort(list) {
  const arr = [...list];
  if (state.sortMode === 'amount') arr.sort((a, b) => b.balanceMinor - a.balanceMinor);
  else if (state.sortMode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  else if (state.sortMode === 'date') arr.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
  return arr;
}

function renderMainList() {
  const allActive = getActiveClients();
  const active = applySort(applySearch(allActive));
  const totalMinor = allActive.reduce((sum, c) => sum + c.balanceMinor, 0);

  $('#total-debt-amount').textContent = formatMoneyMinor(totalMinor);
  $('#active-count').textContent = pluralDebtors(allActive.length);

  const listEl = $('#clients-list');
  const emptyEl = $('#clients-empty');
  if (active.length === 0) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
    listEl.innerHTML = active.map(clientItemHtml).join('');
  }
}

function clientItemHtml(c) {
  const initial = escapeHtml((c.name || '?').trim().charAt(0).toUpperCase());
  return `
    <div class="client-item" data-client-id="${c.id}" role="button" tabindex="0">
      <div class="client-avatar" aria-hidden="true">${initial}</div>
      <div class="client-item-main">
        <div class="client-item-name">${escapeHtml(c.name)}</div>
        <div class="client-item-date">${c.lastDate ? formatDate(c.lastDate) : 'нет операций'}</div>
      </div>
      <div class="client-item-amount ${c.balanceMinor <= 0 ? 'is-paid' : ''}">${formatMoneyMinor(c.balanceMinor)}</div>
      <span class="client-chevron" aria-hidden="true"></span>
    </div>`;
}

function pluralDebtors(n) {
  const mod10 = n % 10, mod100 = n % 100;
  let word = 'должников';
  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) word = 'должник';
    else if (mod10 >= 2 && mod10 <= 4) word = 'должника';
  }
  return `${n} активных ${word}`;
}

$('#clients-list').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.client-item')) { e.preventDefault(); openClient(e.target.closest('.client-item').dataset.clientId); } });

$('#clients-list').addEventListener('click', (e) => {
  const item = e.target.closest('.client-item');
  if (!item) return;
  openClient(item.dataset.clientId);
});

$('#search-input').addEventListener('input', debounce((e) => {
  state.searchQuery = e.target.value;
  renderMainList();
}, 200));

$$('.sort-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.sortMode = chip.dataset.sort;
    $$('.sort-chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    renderMainList();
  });
});

// ------------------------------------------------------------
// ЭКРАН КЛИЕНТА
// ------------------------------------------------------------
function openClient(clientId) {
  state.currentClientId = clientId;
  renderClientDetail(clientId);
  showView('client');
}

function renderClientDetail(clientId) {
  const client = state.clients.find((c) => c.id === clientId);
  if (!client) return;
  const bal = state.balances.get(clientId) || { balanceMinor: 0 };

  $('#client-name').textContent = client.name;
  $('#client-phone').textContent = client.phone || '';
  $('#client-balance').textContent = formatMoneyMinor(bal.balanceMinor);
  $('#client-balance').style.color = bal.balanceMinor > 0 ? 'var(--color-debt)' : 'var(--color-payment)';

  const history = state.transactions
    .filter((t) => t.client_id === clientId)
    .sort((a, b) => (b.transaction_date + b.created_at).localeCompare(a.transaction_date + a.created_at));

  $('#btn-delete-client').hidden = history.length > 0;
  $('#client-history').innerHTML = history.length
    ? history.map(historyItemHtml).join('')
    : '<div class="empty-state"><div class="empty-icon" aria-hidden="true"></div><div class="empty-title">Операций пока нет</div></div>';
}

function historyItemHtml(t) {
  const sign = t.type === 'PAYMENT' ? '-' : (t.type === 'DEBT' ? '+' : (t.amount < 0 ? '' : '+'));
  const typeClass = t.type === 'DEBT' ? 'type-debt' : t.type === 'PAYMENT' ? 'type-payment' : 'type-adjustment';
  const label = t.type === 'PAYMENT' ? 'Оплата' : (t.description || (t.type === 'ADJUSTMENT' ? 'Корректировка' : ''));
  return `
    <div class="history-item" data-tx-id="${t.id}">
      <div class="history-item-left">
        <div class="history-item-date">${formatDate(t.transaction_date)}</div>
        <div class="history-item-desc">${escapeHtml(label)}</div>
      </div>
      <div class="history-item-amount ${typeClass}">${sign}${formatMoney(Math.abs(t.amount))}</div>
    </div>`;
}

$$('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.back;
    if (target === 'prev') showView(state.addDebtReturnView);
    else showView(target);
  });
});

// ------------------------------------------------------------
// РЕДАКТИРОВАНИЕ КЛИЕНТА
// ------------------------------------------------------------
$('#client-edit-btn').addEventListener('click', () => {
  const client = state.clients.find((c) => c.id === state.currentClientId);
  if (!client) return;
  $('#edit-client-name').value = client.name;
  $('#edit-client-phone').value = client.phone || '';
  $('#edit-client-notes').value = client.notes || '';
  $('#edit-client-error').hidden = true;
  showView('edit-client');
});

$('#edit-client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#edit-client-submit');
  const errEl = $('#edit-client-error');
  errEl.hidden = true;
  const name = $('#edit-client-name').value.trim();
  if (!name) { errEl.textContent = 'Введите имя'; errEl.hidden = false; return; }
  btn.disabled = true;
  btn.textContent = 'Сохранение…';
  try {
    await updateClient(state.currentClientId, {
      name,
      phone: $('#edit-client-phone').value.trim() || null,
      notes: $('#edit-client-notes').value.trim() || null,
    });
    await refreshData();
    toast('Сохранено');
    showView('client');
  } catch (err) {
    errEl.textContent = 'Не удалось сохранить. Проверьте соединение и повторите.';
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить';
  }
});

$('#btn-delete-client').addEventListener('click', async () => {
  const client = state.clients.find((c) => c.id === state.currentClientId);
  if (!client) return;
  const hasHistory = state.transactions.some((t) => t.client_id === client.id);
  if (hasHistory) { toast('Клиента с финансовой историей удалить нельзя'); return; }
  const ok = await showConfirm('Удалить клиента?', `Удалить пустого клиента "${client.name}"?`);
  if (!ok) return;
  try {
    await deleteClient(client.id);
    await refreshData();
    state.currentClientId = null;
    toast('Клиент удалён');
    showView('main');
  } catch (err) {
    toast('Не удалось удалить клиента');
  }
});

// ------------------------------------------------------------
// ДОБАВИТЬ ДОЛГ
// ------------------------------------------------------------
function openAddDebt(fromView) {
  state.addDebtReturnView = fromView;
  $('#add-debt-form').reset();
  $('#add-debt-date').value = todayISO();
  $('#add-debt-error').hidden = true;
  $('#add-debt-client-id').value = '';
  $('#add-debt-client-suggestions').hidden = true;
  $('#add-debt-form').dataset.idempotencyKey = '';

  if (fromView === 'client') {
    const client = state.clients.find((c) => c.id === state.currentClientId);
    $('#add-debt-client-field').hidden = true;
    $('#add-debt-client-id').value = client.id;
    $('#add-debt-client-input').value = client.name;
  } else {
    $('#add-debt-client-field').hidden = false;
    $('#add-debt-client-input').value = '';
  }
  showView('add-debt');
  if (fromView !== 'client') setTimeout(() => $('#add-debt-client-input').focus(), 100);
}

$('#btn-add-debt').addEventListener('click', () => openAddDebt('main'));
$('#btn-client-add-debt').addEventListener('click', () => openAddDebt('client'));

$('#add-debt-client-input').addEventListener('input', debounce((e) => {
  const q = normalizePersonSearch(e.target.value);
  $('#add-debt-client-id').value = '';
  const box = $('#add-debt-client-suggestions');
  if (!q) { box.hidden = true; return; }
  const matches = state.clients.filter((c) => normalizePersonSearch(c.name).includes(q) || normalizePersonSearch(c.phone).includes(q)).slice(0, 8);
  let html = matches.map((c) => `<div class="suggestion-item" data-pick-id="${c.id}" data-pick-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.phone ? `<div class="client-item-date">${escapeHtml(c.phone)}</div>` : ''}</div>`).join('');
  html += `<div class="suggestion-item is-new" data-pick-new="${escapeHtml(e.target.value.trim())}">+ Добавить нового клиента «${escapeHtml(e.target.value.trim())}»</div>`;
  box.innerHTML = html;
  box.hidden = false;
}, 150));

$('#add-debt-client-suggestions').addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-pick-id]');
  const create = e.target.closest('[data-pick-new]');
  if (pick) {
    $('#add-debt-client-id').value = pick.dataset.pickId;
    $('#add-debt-client-input').value = pick.dataset.pickName;
    $('#add-debt-client-suggestions').hidden = true;
  } else if (create) {
    const name = create.dataset.pickNew;
    if (!name) return;
    try {
      const newClient = await createClient({ name });
      state.clients.push(newClient);
      $('#add-debt-client-id').value = newClient.id;
      $('#add-debt-client-input').value = newClient.name;
      $('#add-debt-client-suggestions').hidden = true;
      toast('Новый клиент добавлен');
    } catch (err) {
      toast('Не удалось создать клиента');
    }
  }
});

$('#add-debt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await submitDebtOrPayment({
    form: 'add-debt',
    type: 'DEBT',
    clientId: $('#add-debt-client-id').value,
    amountInput: $('#add-debt-amount'),
    descriptionInput: $('#add-debt-description'),
    dateInput: $('#add-debt-date'),
    submitBtn: $('#add-debt-submit'),
    errorBox: $('#add-debt-error'),
    errorText: $('#add-debt-error-text'),
    retryBtn: $('#add-debt-retry'),
    returnView: state.addDebtReturnView,
    requireClientPicked: state.addDebtReturnView === 'main',
  });
});
$('#add-debt-retry').addEventListener('click', () => $('#add-debt-form').requestSubmit());

// ------------------------------------------------------------
// ВНЕСТИ ОПЛАТУ
// ------------------------------------------------------------
$('#btn-client-add-payment').addEventListener('click', () => {
  const bal = state.balances.get(state.currentClientId) || { balanceMinor: 0 };
  if (bal.balanceMinor <= 0) { toast('У клиента нет текущего долга'); return; }
  $('#add-payment-form').reset();
  $('#add-payment-date').value = todayISO();
  $('#add-payment-error').hidden = true;
  $('#payment-current-balance').textContent = formatMoneyMinor(bal.balanceMinor);
  $('#add-payment-form').dataset.balanceMinor = bal.balanceMinor;
  $('#add-payment-form').dataset.idempotencyKey = '';
  showView('add-payment');
});

$('#btn-pay-full').addEventListener('click', () => {
  const balanceMinor = Number($('#add-payment-form').dataset.balanceMinor || 0);
  $('#add-payment-amount').value = (balanceMinor / 100).toFixed(balanceMinor % 100 ? 2 : 0);
});

$('#add-payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const balanceMinor = Number($('#add-payment-form').dataset.balanceMinor || 0);
  const amountMinor = toMinorUnits($('#add-payment-amount').value);
  if (amountMinor > balanceMinor) {
    $('#add-payment-error-text').textContent = 'Сумма оплаты не может быть больше текущего долга.';
    $('#add-payment-error').hidden = false;
    return;
  }
  await submitDebtOrPayment({
    form: 'add-payment', type: 'PAYMENT', clientId: state.currentClientId,
    amountInput: $('#add-payment-amount'), descriptionInput: null, dateInput: $('#add-payment-date'),
    submitBtn: $('#add-payment-submit'), errorBox: $('#add-payment-error'), errorText: $('#add-payment-error-text'),
    retryBtn: $('#add-payment-retry'), returnView: 'client', requireClientPicked: false,
  });
});
$('#add-payment-retry').addEventListener('click', () => $('#add-payment-form').requestSubmit());

// ------------------------------------------------------------
// Общая функция сохранения DEBT/PAYMENT (защита от двойного клика)
// ------------------------------------------------------------
async function submitDebtOrPayment({ form, type, clientId, amountInput, descriptionInput, dateInput, submitBtn, errorBox, errorText, retryBtn, returnView, requireClientPicked }) {
  errorBox.hidden = true; if (retryBtn) retryBtn.hidden = true;
  if (submitBtn.disabled) return;
  if (requireClientPicked && !clientId) { errorText.textContent = 'Выберите клиента из списка или добавьте нового.'; errorBox.hidden = false; return; }
  const amountMinor = toMinorUnits(amountInput.value);
  if (amountMinor <= 0) { errorText.textContent = 'Укажите корректную сумму больше нуля, максимум 2 знака после запятой.'; errorBox.hidden = false; return; }
  const formEl = document.getElementById(`${form}-form`);
  if (!formEl.dataset.idempotencyKey) formEl.dataset.idempotencyKey = newUuid();
  const key = formEl.dataset.idempotencyKey;
  submitBtn.disabled = true; const originalLabel = submitBtn.textContent; submitBtn.textContent = 'Сохранение…';
  try {
    await createTransaction({ client_id: clientId, type, amount: (amountMinor / 100).toFixed(2),
      description: descriptionInput ? (descriptionInput.value.trim() || null) : null, transaction_date: dateInput.value, idempotency_key: key });
    formEl.dataset.idempotencyKey = '';
    await refreshData();
    toast(type === 'DEBT' ? 'Долг добавлен' : 'Оплата сохранена');
    showView(returnView === 'main' ? 'main' : 'client');
  } catch (err) {
    console.error(err);
    const msg = String(err?.message || '');
    if (msg.includes('PAYMENT_EXCEEDS_BALANCE')) await refreshData();
    errorText.textContent = msg.includes('PAYMENT_EXCEEDS_BALANCE')
      ? 'Сумма оплаты не может быть больше текущего долга.'
      : 'Не удалось сохранить. Проверьте интернет.';
    errorBox.hidden = false; if (retryBtn) retryBtn.hidden = false;
  } finally { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
}

// ------------------------------------------------------------
// АРХИВ
// ------------------------------------------------------------
$('#btn-open-archive').addEventListener('click', () => {
  renderArchive();
  showView('archive');
});

function renderArchive() {
  const archived = getArchivedClients_v2();
  const listEl = $('#archive-list');
  const emptyEl = $('#archive-empty');
  if (archived.length === 0) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
    listEl.innerHTML = archived
      .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''))
      .map((c) => `
        <div class="client-item" data-client-id="${c.id}" role="button" tabindex="0">
          <div class="client-avatar" aria-hidden="true">${escapeHtml((c.name || '?').trim().charAt(0).toUpperCase())}</div>
          <div class="client-item-main">
            <div class="client-item-name">${escapeHtml(c.name)}</div>
            <div class="client-item-date">${c.lastDate ? formatDate(c.lastDate) : ''}</div>
          </div>
          <div class="client-item-amount is-paid">Погашено</div><span class="client-chevron" aria-hidden="true"></span>
        </div>`).join('');
  }
}
function getArchivedClients_v2() {
  return state.clients
    .map((c) => {
      const bal = state.balances.get(c.id) || { balanceMinor: 0, lastDate: null };
      return { ...c, balanceMinor: bal.balanceMinor, lastDate: bal.lastDate };
    })
    .filter((c) => c.balanceMinor <= 0 && state.transactions.some((t) => t.client_id === c.id));
}
$('#archive-list').addEventListener('click', (e) => {
  const item = e.target.closest('.client-item');
  if (!item) return;
  openClient(item.dataset.clientId);
});

// ------------------------------------------------------------
// АНАЛИТИКА
// ------------------------------------------------------------
function renderAnalytics() {
  const active = getActiveClients();
  const totalMinor = active.reduce((s, c) => s + c.balanceMinor, 0);

  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let monthDebtMinor = 0, monthPaymentMinor = 0;
  for (const t of state.transactions) {
    if (!t.transaction_date || !t.transaction_date.startsWith(ym)) continue;
    const minor = toMinorUnits(t.amount);
    if (t.type === 'DEBT') monthDebtMinor += minor;
    else if (t.type === 'PAYMENT') monthPaymentMinor += minor;
  }

  const paidCount = state.clients.filter((c) => {
    const bal = state.balances.get(c.id);
    return bal && bal.balanceMinor <= 0 && state.transactions.some((t) => t.client_id === c.id);
  }).length;

  const avgMinor = active.length ? Math.round(totalMinor / active.length) : 0;

  $('#stat-total-debt').textContent = formatMoneyMinor(totalMinor);
  $('#stat-active-count').textContent = String(active.length);
  $('#stat-month-debt').textContent = formatMoneyMinor(monthDebtMinor);
  $('#stat-month-payment').textContent = formatMoneyMinor(monthPaymentMinor);
  $('#stat-avg-debt').textContent = formatMoneyMinor(avgMinor);
  $('#stat-paid-count').textContent = String(paidCount);
}

// ------------------------------------------------------------
// НАВИГАЦИЯ ПО ТАБАМ
// ------------------------------------------------------------
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'analytics') renderAnalytics();
    showView(btn.dataset.tab);
  });
});

// ------------------------------------------------------------
// ЭКСПОРТ CSV
// ------------------------------------------------------------
$('#btn-export-csv').addEventListener('click', () => {
  const rows = [['client', 'phone', 'transaction_type', 'amount', 'description', 'transaction_date']];
  const clientsById = new Map(state.clients.map((c) => [c.id, c]));
  for (const t of state.transactions) {
    const c = clientsById.get(t.client_id);
    rows.push([
      c ? c.name : '',
      c ? (c.phone || '') : '',
      t.type,
      t.amount,
      t.description || '',
      t.transaction_date,
    ]);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map(csvField).join(',')).join('\n');
  downloadTextFile(`dolgi-export-${todayISO()}.csv`, csv, 'text/csv');
  toast('CSV сохранён');
});

// ------------------------------------------------------------
// ЭКСПОРТ / ИМПОРТ JSON-РЕЗЕРВНОЙ КОПИИ
// ------------------------------------------------------------
$('#btn-export-json').addEventListener('click', () => {
  const backup = {
    schema_version: 2,
    backup_id: newUuid(),
    exported_at: new Date().toISOString(),
    clients: state.clients,
    transactions: state.transactions,
  };
  downloadTextFile(`dolgi-backup-${todayISO()}.json`, JSON.stringify(backup, null, 2), 'application/json');
  toast('Резервная копия сохранена');
});

$('#btn-import-json').addEventListener('click', () => $('#import-json-file').click());

let pendingImportData = null;
$('#import-json-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.schema_version !== 2 || !data.backup_id || !Array.isArray(data.clients) || !Array.isArray(data.transactions)) throw new Error('bad schema');
    for (const c of data.clients) if (!c?.id || !String(c.name || '').trim()) throw new Error('bad client');
    for (const t of data.transactions) {
      if (!t?.client_id || !['DEBT','PAYMENT','ADJUSTMENT'].includes(t.type) || toMinorUnits(t.amount) === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(t.transaction_date || ''))) throw new Error('bad transaction');
    }
    pendingImportData = data;
    renderImportPreview(data);
    showView('import-preview');
  } catch (err) {
    toast('Файл повреждён или не является резервной копией');
  } finally {
    e.target.value = '';
  }
});

function renderImportPreview(data) {
  $('#import-preview-body').innerHTML = `
    <div class="migration-summary">
      <div class="migration-summary-count">${data.clients.length} клиентов</div>
      <div>${data.transactions.length} операций</div>
      <div style="margin-top:6px;color:var(--color-text-secondary);font-size:0.85rem;">Экспортировано: ${data.exported_at ? formatDate(data.exported_at.slice(0, 10)) : '—'}</div>
    </div>
    <div class="form-error" style="background:var(--color-primary-tint);color:var(--color-primary-dark);">
      Безопасный режим REPLACE: текущие клиенты и операции этого аккаунта будут атомарно заменены данными из backup. Если проверка или восстановление завершится ошибкой, база полностью откатится. Один и тот же backup_id нельзя восстановить дважды.
    </div>
    <button id="confirm-import-btn" class="btn btn-primary btn-block">Импортировать</button>
  `;
  $('#confirm-import-btn').addEventListener('click', runImport, { once: true });
}

async function runImport() {
  const btn = $('#confirm-import-btn');
  const ok = await showConfirm('Восстановить резервную копию?', 'Режим REPLACE полностью заменит текущие данные аккаунта содержимым backup. Операция атомарная.', 'Восстановить');
  if (!ok) { btn.disabled = false; return; }
  btn.disabled = true; btn.textContent = 'Восстанавливаем…';
  try {
    await restoreBackup(pendingImportData); pendingImportData = null; await refreshData();
    toast('Резервная копия восстановлена'); showView('settings');
  } catch (err) {
    console.error(err);
    toast(String(err?.message || '').includes('BACKUP_ALREADY_RESTORED') ? 'Этот backup уже восстанавливался' : 'Восстановление отменено: данные не изменены');
    btn.disabled = false; btn.textContent = 'Импортировать';
  }
}

// ------------------------------------------------------------
// ПЕРВОНАЧАЛЬНАЯ МИГРАЦИЯ
// ------------------------------------------------------------
$('#btn-open-migration').addEventListener('click', async () => {
  showView('migration');
  await renderMigrationScreen();
});

async function renderMigrationScreen() {
  const body = $('#migration-body');
  body.innerHTML = '<p style="color:var(--color-text-secondary)">Проверка статуса…</p>';
  let status;
  try {
    status = await getMigrationStatus();
  } catch (err) {
    body.innerHTML = '<div class="form-error">Не удалось проверить статус миграции. Проверьте соединение.</div>';
    return;
  }

  if (status && status.initial_migration_done) {
    body.innerHTML = `
      <div class="migration-done">
        <div style="font-size:32px;margin-bottom:8px;">✅</div>
        Первоначальный перенос уже выполнен ${status.migrated_at ? 'от ' + formatDate(status.migrated_at.slice(0, 10)) : ''}.<br/>
        Повторный перенос недоступен, чтобы не задвоить долги.
      </div>`;
    return;
  }

  const totalMinor = INITIAL_DATA.reduce((s, [, amount]) => s + toMinorUnits(amount), 0);
  const rowsHtml = INITIAL_DATA.map(([name, amount], idx) => `
    <div class="migration-row">
      <span>${idx + 1}. ${escapeHtml(name)}</span>
      <strong>${formatMoney(amount)}</strong>
    </div>`).join('');

  body.innerHTML = `
    <div class="migration-summary">
      <div class="migration-summary-count">Найдено ${INITIAL_DATA.length} исходных записи</div>
      <div>Общая сумма: <strong>${formatMoneyMinor(totalMinor)}</strong></div>
    </div>
    <p style="color:var(--color-text-secondary);font-size:0.88rem;">
      Похожие или повторяющиеся имена НЕ будут объединены автоматически — каждая запись станет отдельным клиентом.
      Это сохраняет исходные данные без догадок о том, один это человек или разные.
    </p>
    <div class="migration-list">${rowsHtml}</div>
    <div id="migration-error" class="form-error" hidden></div>
    <button id="migration-import-btn" class="btn btn-primary btn-block">Импортировать</button>
  `;
  $('#migration-import-btn').addEventListener('click', runMigration, { once: true });
}

async function runMigration() {
  const btn = $('#migration-import-btn'); const errEl = $('#migration-error');
  btn.disabled = true; btn.textContent = 'Переносим…'; errEl.hidden = true;
  try {
    const result = await importInitialDebts();
    await refreshData(); toast(`Перенесено ${result.count} записей`); await renderMigrationScreen();
  } catch (err) {
    console.error(err);
    errEl.textContent = String(err?.message || '').includes('INITIAL_MIGRATION_ALREADY_DONE')
      ? 'Первоначальный перенос уже был выполнен.'
      : 'Перенос не выполнен. Сервер откатил операцию целиком — частичных данных нет.';
    errEl.hidden = false; btn.disabled = false; btn.textContent = 'Импортировать';
  }
}

// ------------------------------------------------------------
// СТАРТ
// ------------------------------------------------------------
init();

// Регистрация service worker (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('Service worker registration failed', err);
    });
  });
}
