/**
 * LOCOXATL — Admin Dashboard & Workshop Production Studio
 * Handles operations control, order management, status lifecycle,
 * and 3D keychain production inspection.
 */

(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  const money = (value) =>
    new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
      .format(value || 0)
      .replace('IDR', 'Rp')
      .replace(/\s/g, '');

  const formatDate = (isoString) => {
    if (!isoString) return '—';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return date.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // State
  let currentPage = 1;
  const currentLimit = 15;
  let currentStatus = '';
  let currentSearch = '';
  let currentOrder = null;
  let viewerInstance = null;
  let searchDebounceTimer = null;
  let cashbookPage = 1;
  let cashbookTotalPages = 1;
  let cashbookEntries = [];
  let expenseCategories = [];
  let editingExpenseId = null;
  let accountingSummaryPoll = null;
  let activeView = 'orders';
  let pricingOptions = [];
  let productSettings = null;
  let dbSchemaReady = true;
  let lastFocusedElement = null;
  // Artist & Group Management keeps its own copy of the groups so the Catalog tab and this tab
  // never overwrite each other's freshly edited rows.
  let artistGroups = [];
  let artistGroupTab = 'groups';
  let artistMembers = [];
  let artistPendingCover = null;
  let artistPendingCoverRemoval = false;
  let artistPendingHero = null;
  let artistPendingHeroRemoval = false;
  let artistPendingPortrait = null;
  let artistPendingPortraitRemoval = false;
  let artistPendingDesign = null;
  let artistPendingDesignRemoval = false;
  // Bundle packages ("paketan") live on the same Catalog view as groups and members.
  let bundles = [];
  let bundlePendingImage = null;
  let bundlePendingImageRemoval = false;

  // ---------------------------------------------------------------------------
  // API Client with Auth
  // ---------------------------------------------------------------------------
  async function adminFetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
    });
    if (response.status === 401) {
      handleUnauthorized();
      throw new Error('Unauthorized');
    }
    return response;
  }

  function databaseMessage(error, fallback) {
    if (dbSchemaReady === false) {
      return 'MySQL is connected, but required tables are missing. Run "npm run db:migrate".';
    }
    const text = String(error && error.message ? error.message : '').trim();
    return text ? fallback + ': ' + text : fallback + ' could not be loaded.';
  }

  function showToast(message) {
    const toast = $('#adminToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  // ---------------------------------------------------------------------------
  // Health & Database Check
  // ---------------------------------------------------------------------------
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const connected = Boolean(data?.database?.connected);
      const configured = Boolean(data?.database?.configured);
      const schemaReady = data?.database?.schemaReady !== false;
      dbSchemaReady = schemaReady;

      const dot = $('#dbDot');
      const pillText = $('#dbPillText');
      const topStatus = $('#topDbStatus');

      if (connected && schemaReady) {
        dot.className = 'db-dot connected';
        pillText.textContent = 'MySQL Live';
        topStatus.textContent = 'ONLINE (MYSQL CONNECTED)';
      } else if (connected) {
        dot.className = 'db-dot demo';
        pillText.textContent = 'MySQL Live · schema pending';
        topStatus.textContent = 'MYSQL CONNECTED (MIGRATIONS PENDING)';
      } else if (configured) {
        dot.className = 'db-dot demo';
        pillText.textContent = 'MySQL Unreachable';
        topStatus.textContent = 'DATABASE OFFLINE';
      } else {
        dot.className = 'db-dot demo';
        pillText.textContent = 'Demo Mode (No DB)';
        topStatus.textContent = 'LOCAL DEMO MODE';
      }
    } catch {
      $('#topDbStatus').textContent = 'OFFLINE';
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication Flow
  // ---------------------------------------------------------------------------
  function handleUnauthorized() {
    $('#loginBackdrop').hidden = false;
    $('#adminMain').hidden = true;
    $('#logoutButton').hidden = true;
    $('#accountingNavLink').hidden = true;
    if (accountingSummaryPoll) clearInterval(accountingSummaryPoll);
    accountingSummaryPoll = null;
  }

  async function verifyAuth() {
    try {
      const res = await fetch('/api/admin/auth/verify', {
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          $('#loginBackdrop').hidden = true;
          $('#adminMain').hidden = false;
          $('#logoutButton').hidden = false;
          initDashboard();
          return;
        }
      }
      handleUnauthorized();
    } catch {
      handleUnauthorized();
    }
  }

  $('#adminLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameInput = $('#adminUsernameInput');
    const passwordInput = $('#adminPasswordInput');
    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const errorEl = $('#loginError');
    const submitBtn = $('#loginSubmitBtn');

    errorEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    try {
      const res = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'same-origin',
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        $('#loginBackdrop').hidden = true;
        $('#adminMain').hidden = false;
        $('#logoutButton').hidden = false;
        if (passwordInput) passwordInput.value = '';
        initDashboard();
      } else {
        errorEl.textContent = data.message || 'Invalid username or password.';
        errorEl.hidden = false;
      }
    } catch (err) {
      errorEl.textContent = 'Unable to reach the server. Make sure server is running.';
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Sign In <span>↗</span>';
    }
  });

  $('#logoutButton').addEventListener('click', async () => {
    try {
      await fetch('/api/admin/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch { /* best effort */ }
    handleUnauthorized();
    showToast('Signed out from Admin Dashboard.');
  });

  // ---------------------------------------------------------------------------
  // Metrics Loading
  // ---------------------------------------------------------------------------
  async function loadMetrics() {
    try {
      const res = await adminFetch('/api/admin/metrics');
      if (!res.ok) return;
      const { metrics } = await res.json();
      const counts = metrics.countsByStatus || {};

      $('#metricTotalOrders').textContent = metrics.totalOrders || 0;
      $('#metricPendingVerification').textContent = counts.payment_confirmation_sent || 0;
      $('#metricWaitingPayment').textContent = counts.waiting_for_payment || 0;
      $('#metricInProduction').textContent = counts.in_production || 0;
      $('#metricShippedDone').textContent = (counts.shipped || 0) + (counts.completed || 0);
      $('#metricTotalRevenue').textContent = money(metrics.totalRevenue || 0);

      // Update tab chip counts
      $('#countAll').textContent = metrics.totalOrders || 0;
      $('#countUnpaid').textContent = (counts.waiting_for_payment || 0) + (counts.payment_confirmation_sent || 0);
      $('#countProof').textContent = counts.payment_confirmation_sent || 0;
      $('#countWaiting').textContent = counts.waiting_for_payment || 0;
      $('#countPaid').textContent = counts.paid || 0;
      $('#countProd').textContent = counts.in_production || 0;
      $('#countShipped').textContent = counts.shipped || 0;
      $('#countCompleted').textContent = counts.completed || 0;
      $('#countCancelled').textContent = counts.cancelled || 0;
    } catch (err) {
      console.warn('Failed to load metrics:', err);
    }
  }

  function localDateInputValue(date = new Date()) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function accountingDateParams() {
    const period = $('#accountingPeriod').value;
    const params = new URLSearchParams({ period });
    if (period === 'custom') {
      const from = $('#accountingDateFrom').value;
      const to = $('#accountingDateTo').value;
      if (!from || !to) return null;
      params.set('from', from);
      params.set('to', to);
    }
    return params;
  }

  async function loadCashbookSummary() {
    const params = accountingDateParams();
    if (!params) return;
    try {
      const response = await adminFetch(`/api/admin/cashbook/summary?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Cashbook summary could not be loaded.');
      const summary = data.summary;
      $('#cashbookTotalIncome').textContent = money(summary.totals.income);
      $('#cashbookTotalExpenses').textContent = money(summary.totals.expenses);
      $('#cashbookBalance').textContent = money(summary.totals.balance);
      $('#cashbookRangeBalance').textContent = money(summary.range.balance);
      $('#cashbookRangeLabel').textContent = `${summary.range.period} · ${summary.range.from} to ${summary.range.to}`;
      $('#dailyCashSummary').textContent = money(summary.periods.daily.balance);
      $('#weeklyCashSummary').textContent = money(summary.periods.weekly.balance);
      $('#monthlyCashSummary').textContent = money(summary.periods.monthly.balance);
      $('#yearlyCashSummary').textContent = money(summary.periods.yearly.balance);
      $('#cashbookChartRange').textContent = `${summary.range.from} – ${summary.range.to}`;
      renderCashbookChart(summary.chart || []);
    } catch (error) {
      console.warn('Failed to load cashbook summary:', error);
    }
  }

  async function loadCashbookEntries() {
    const params = accountingDateParams();
    if (!params) return;
    params.set('page', String(cashbookPage));
    params.set('limit', '15');
    params.set('type', $('#cashbookTypeFilter').value);
    const tbody = $('#cashbookEntriesBody');
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading">Loading cashbook...</td></tr>';
    try {
      const response = await adminFetch(`/api/admin/cashbook?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Cashbook transactions could not be loaded.');
      cashbookEntries = data.entries || [];
      cashbookTotalPages = data.pagination.totalPages || 1;
      renderCashbookEntries(data.entries || []);
      $('#cashbookPaginationInfo').textContent = `Showing ${data.entries.length} of ${data.pagination.total} transactions`;
      $('#cashbookPageDisplay').textContent = `${cashbookPage} / ${cashbookTotalPages}`;
      $('#cashbookPrevPageBtn').disabled = cashbookPage <= 1;
      $('#cashbookNextPageBtn').disabled = cashbookPage >= cashbookTotalPages;
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function renderCashbookChart(chartRows) {
    const canvas = $('#cashbookChart');
    const context = canvas.getContext('2d');
    if (!context) return;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.floor(bounds.width));
    const height = 180;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);

    const byDate = new Map();
    chartRows.forEach((row) => {
      if (!byDate.has(row.date)) byDate.set(row.date, { income: 0, expense: 0 });
      byDate.get(row.date)[row.entryType] = row.amount;
    });
    const days = [...byDate.entries()].slice(-14);
    if (!days.length) {
      context.fillStyle = '#777';
      context.font = '12px sans-serif';
      context.fillText('No cashbook activity in this date range.', 12, 28);
      return;
    }

    const maxValue = Math.max(1, ...days.map(([, values]) => Math.max(values.income, values.expense)));
    const chartTop = 12;
    const chartHeight = 126;
    const groupWidth = (width - 32) / days.length;
    context.strokeStyle = '#dedee0';
    context.beginPath();
    context.moveTo(24, chartTop + chartHeight);
    context.lineTo(width - 8, chartTop + chartHeight);
    context.stroke();
    days.forEach(([date, values], index) => {
      const center = 24 + groupWidth * index + groupWidth / 2;
      const barWidth = Math.max(3, Math.min(12, groupWidth * 0.28));
      const incomeHeight = values.income / maxValue * chartHeight;
      const expenseHeight = values.expense / maxValue * chartHeight;
      context.fillStyle = '#111';
      context.fillRect(center - barWidth - 1, chartTop + chartHeight - incomeHeight, barWidth, incomeHeight);
      context.fillStyle = '#aaa';
      context.fillRect(center + 1, chartTop + chartHeight - expenseHeight, barWidth, expenseHeight);
      context.fillStyle = '#777';
      context.font = '9px sans-serif';
      context.textAlign = 'center';
      context.fillText(date.slice(5), center, chartTop + chartHeight + 18);
    });
  }

  function renderCashbookEntries(entries) {
    const tbody = $('#cashbookEntriesBody');
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No cashbook transactions in this date range.</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map((entry) => {
      const isExpense = entry.entryType === 'expense';
      const reference = entry.orderNumber || entry.adminUsername || '—';
      const correction = entry.correctionNote
        ? `<small class="accounting-correction-note">Correction: ${escapeHtml(entry.correctionNote)}</small>`
        : '';
      return `
        <tr>
          <td>${escapeHtml(entry.transactionDate)}</td>
          <td><span class="cashbook-type cashbook-type-${escapeHtml(entry.entryType)}">${escapeHtml(entry.entryType)}</span></td>
          <td>${escapeHtml(entry.category)}</td>
          <td>${escapeHtml(entry.description)}${correction}</td>
          <td>${escapeHtml(entry.paymentMethod || '—')}</td>
          <td>${escapeHtml(reference)}</td>
          <td class="amount-cell">${isExpense ? '−' : '+'}${money(entry.amount)}</td>
          <td class="accounting-row-actions">
            ${isExpense ? `<button type="button" class="text-link" data-correct-expense="${entry.id}">Correct</button>` : ''}
            ${entry.supersedesEntryId ? `<button type="button" class="text-link" data-expense-history="${entry.id}">History</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-correct-expense]').forEach((button) => {
      button.addEventListener('click', () => beginExpenseCorrection(Number(button.dataset.correctExpense)));
    });
    tbody.querySelectorAll('[data-expense-history]').forEach((button) => {
      button.addEventListener('click', () => showExpenseHistory(Number(button.dataset.expenseHistory)));
    });
  }

  async function loadExpenseCategories() {
    try {
      const response = await adminFetch('/api/admin/cashbook/categories');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Expense categories could not be loaded.');
      expenseCategories = (data.categories || []).filter((category) => category.entryType === 'expense');
      const active = expenseCategories.filter((category) => category.isActive);
      $('#expenseCategory').innerHTML = active.map((category) =>
        `<option value="${category.id}">${escapeHtml(category.name)}</option>`
      ).join('');
      $('#expenseCategoryList').innerHTML = expenseCategories.map((category) => `
        <li>
          <span>${escapeHtml(category.name)}</span>
          <button type="button" class="text-link" data-category-id="${category.id}" data-category-active="${!category.isActive}">
            ${category.isActive ? 'Disable' : 'Enable'}
          </button>
        </li>
      `).join('');
      $('#expenseCategoryList').querySelectorAll('[data-category-id]').forEach((button) => {
        button.addEventListener('click', () => setExpenseCategory(
          Number(button.dataset.categoryId),
          button.dataset.categoryActive === 'true',
        ));
      });
    } catch (error) {
      showToast(`Category error: ${error.message}`);
    }
  }

  async function refreshAccounting() {
    await Promise.all([loadCashbookSummary(), loadCashbookEntries(), loadExpenseCategories()]);
  }

  function beginExpenseCorrection(id) {
    const entry = cashbookEntries.find((row) => row.id === id);
    if (!entry || entry.entryType !== 'expense') return;
    editingExpenseId = id;
    $('#expenseDate').value = entry.transactionDate;
    $('#expenseCategory').value = String(entry.categoryId);
    $('#expenseDescription').value = entry.description;
    $('#expenseAmount').value = String(entry.amount);
    $('#expensePaymentMethod').value = entry.paymentMethod;
    $('#expenseNotes').value = entry.notes || '';
    $('#expenseCorrectionNote').value = '';
    $('#correctionNoteWrap').hidden = false;
    $('#cancelExpenseCorrectionBtn').hidden = false;
    $('#expenseFormHeading').textContent = `CORRECT EXPENSE #${id}`;
    $('#expenseSubmitBtn').textContent = 'Save Correction';
    $('#cashbookExpenseForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetExpenseForm() {
    editingExpenseId = null;
    $('#cashbookExpenseForm').reset();
    $('#expenseDate').value = localDateInputValue();
    $('#correctionNoteWrap').hidden = true;
    $('#cancelExpenseCorrectionBtn').hidden = true;
    $('#expenseFormHeading').textContent = 'RECORD AN EXPENSE';
    $('#expenseSubmitBtn').textContent = 'Record Expense';
  }

  async function showExpenseHistory(id) {
    try {
      const response = await adminFetch(`/api/admin/cashbook/entries/${id}/history`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Correction history could not be loaded.');
      const history = data.history.map((entry) => (
        `${entry.transactionDate} · ${money(entry.amount)} · ${entry.description}`
        + (entry.correctionNote ? ` · ${entry.correctionNote}` : '')
      ));
      window.alert(history.join('\n'));
    } catch (error) {
      showToast(`History error: ${error.message}`);
    }
  }

  async function setExpenseCategory(id, isActive) {
    try {
      const response = await adminFetch(`/api/admin/cashbook/categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Category could not be updated.');
      await loadExpenseCategories();
      showToast('Expense category updated.');
    } catch (error) {
      showToast(`Category error: ${error.message}`);
    }
  }

  $('#accountingPeriod').addEventListener('change', () => {
    const isCustom = $('#accountingPeriod').value === 'custom';
    $('#accountingCustomDates').hidden = !isCustom;
    if (isCustom) {
      const today = localDateInputValue();
      if (!$('#accountingDateFrom').value) $('#accountingDateFrom').value = `${today.slice(0, 7)}-01`;
      if (!$('#accountingDateTo').value) $('#accountingDateTo').value = today;
      return;
    }
    cashbookPage = 1;
    refreshAccounting();
  });

  ['accountingDateFrom', 'accountingDateTo'].forEach((id) => {
    $(`#${id}`).addEventListener('change', () => {
      cashbookPage = 1;
      refreshAccounting();
    });
  });
  $('#cashbookTypeFilter').addEventListener('change', () => {
    cashbookPage = 1;
    loadCashbookEntries();
  });
  $('#refreshAccountingBtn').addEventListener('click', () => refreshAccounting());
  $('#cashbookPrevPageBtn').addEventListener('click', () => {
    if (cashbookPage > 1) {
      cashbookPage -= 1;
      loadCashbookEntries();
    }
  });
  $('#cashbookNextPageBtn').addEventListener('click', () => {
    if (cashbookPage < cashbookTotalPages) {
      cashbookPage += 1;
      loadCashbookEntries();
    }
  });

  $('#cashbookExpenseForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      categoryId: Number($('#expenseCategory').value),
      transactionDate: $('#expenseDate').value,
      description: $('#expenseDescription').value,
      amount: $('#expenseAmount').value,
      paymentMethod: $('#expensePaymentMethod').value,
      notes: $('#expenseNotes').value,
    };
    const isCorrection = Boolean(editingExpenseId);
    if (isCorrection) body.correctionNote = $('#expenseCorrectionNote').value;
    try {
      const url = isCorrection
        ? `/api/admin/cashbook/expenses/${editingExpenseId}`
        : '/api/admin/cashbook/expenses';
      const response = await adminFetch(url, {
        method: isCorrection ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Expense could not be saved.');
      resetExpenseForm();
      await refreshAccounting();
      showToast(isCorrection ? 'Expense correction recorded.' : 'Expense recorded.');
    } catch (error) {
      showToast(`Expense error: ${error.message}`);
    }
  });

  $('#cancelExpenseCorrectionBtn').addEventListener('click', resetExpenseForm);

  $('#cashbookCategoryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const nameInput = $('#newExpenseCategory');
    try {
      const response = await adminFetch('/api/admin/cashbook/categories', {
        method: 'POST',
        body: JSON.stringify({ name: nameInput.value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Category could not be created.');
      nameInput.value = '';
      await loadExpenseCategories();
      showToast('Expense category added.');
    } catch (error) {
      showToast(`Category error: ${error.message}`);
    }
  });

  document.querySelectorAll('[data-export-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      const params = accountingDateParams();
      if (!params) {
        showToast('Choose both dates for a custom report range.');
        return;
      }
      params.set('scope', button.dataset.exportScope);
      window.location.href = `/api/admin/reports/export.xlsx?${params.toString()}`;
    });
  });

  // ---------------------------------------------------------------------------
  // Orders List & Table
  // ---------------------------------------------------------------------------
  async function loadOrders() {
    const tbody = $('#ordersTableBody');
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">Loading order records…</td></tr>';

    const params = new URLSearchParams({
      page: currentPage,
      limit: currentLimit,
    });
    if (currentStatus) params.set('status', currentStatus);
    if (currentSearch) params.set('q', currentSearch);

    try {
      const res = await adminFetch(`/api/admin/orders?${params.toString()}`);
      if (!res.ok) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Could not load orders.</td></tr>';
        return;
      }
      const data = await res.json();
      const orders = data.orders || [];
      const pagination = data.pagination || { total: 0, page: 1, totalPages: 1 };

      renderOrdersTable(orders);
      renderPagination(pagination);
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Database unavailable or error loading orders.</td></tr>';
    }
  }

  function renderOrdersTable(orders) {
    const tbody = $('#ordersTableBody');
    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No orders found matching the filter.</td></tr>';
      return;
    }

    tbody.innerHTML = orders.map((order) => {
      const firstItem = order.items?.[0];
      const config = firstItem?.configuration?.configuration || firstItem?.configuration || {};
      const baseName = config.base?.name || config.base || 'Custom base';
      const initial = config.initial ? `Initial "${config.initial}"` : '';
      const addons = Array.isArray(config.addons) ? config.addons.map((a) => a.name || a).join(', ') : '';
      const detailsLine = [baseName, initial, addons].filter(Boolean).join(' · ');

      const statusBadge = `<span class="status-pill status-${order.status}">${formatStatusLabel(order.status)}</span>`;
      const needsAction = order.status === 'waiting_for_payment' || order.status === 'payment_confirmation_sent';

      return `
        <tr data-order-number="${escapeHtml(order.orderNumber)}"${needsAction ? ' class="row-attention"' : ''}>
          <td class="order-code-cell">${escapeHtml(order.orderNumber)}</td>
          <td>${formatDate(order.createdAt)}</td>
          <td class="customer-cell">
            <strong>${escapeHtml(order.customer.name)}</strong>
            <span>${escapeHtml(order.customer.phone)}</span>
          </td>
          <td class="product-cell">
            <strong>${escapeHtml(firstItem?.productName || 'LOCOXATL Keychain')}</strong>
            <span>${escapeHtml(detailsLine || 'Standard assembly')}</span>
          </td>
          <td class="amount-cell">${money(order.total)}</td>
          <td>${statusBadge}</td>
          <td>
            <button type="button" class="button button-outline button-small inspect-btn" data-order="${escapeHtml(order.orderNumber)}">
              Inspect & Manage ↗
            </button>
          </td>
        </tr>
      `;
    }).join('');

    // Attach inspect click handlers
    tbody.querySelectorAll('.inspect-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const orderNumber = btn.dataset.order;
        openOrderDrawer(orderNumber);
      });
    });
  }

  function formatStatusLabel(status) {
    const map = {
      waiting_for_payment: 'Waiting Payment',
      payment_confirmation_sent: 'Proof Sent (WA)',
      paid: 'Paid / Verified',
      in_production: 'In Workshop',
      shipped: 'Shipped',
      completed: 'Completed',
      cancelled: 'Cancelled',
    };
    return map[status] || status.toUpperCase();
  }

  function renderPagination(pagination) {
    const { total, page, totalPages } = pagination;
    $('#paginationInfo').textContent = `Showing ${(page - 1) * currentLimit + (total ? 1 : 0)}–${Math.min(page * currentLimit, total)} of ${total} orders`;
    $('#pageCurrentDisplay').textContent = `${page} / ${totalPages}`;
    $('#prevPageBtn').disabled = page <= 1;
    $('#nextPageBtn').disabled = page >= totalPages;
  }

  $('#prevPageBtn').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage -= 1;
      loadOrders();
    }
  });

  $('#nextPageBtn').addEventListener('click', () => {
    currentPage += 1;
    loadOrders();
  });

  // Filter tabs
  $$('#statusTabs .tab-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#statusTabs .tab-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      currentStatus = chip.dataset.status || '';
      currentPage = 1;
      loadOrders();
    });
  });

  // Search input
  const searchInput = $('#orderSearchInput');
  const clearBtn = $('#clearSearchBtn');

  searchInput.addEventListener('input', () => {
    const val = searchInput.value.trim();
    clearBtn.hidden = !val;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentSearch = val;
      currentPage = 1;
      loadOrders();
    }, 280);
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.hidden = true;
    currentSearch = '';
    currentPage = 1;
    loadOrders();
  });

  $('#refreshBtn').addEventListener('click', () => {
    loadMetrics();
    loadOrders();
    showToast('Dashboard data refreshed ⟳');
  });

  // ---------------------------------------------------------------------------
  // Order Detail Drawer & 3D Viewer Inspection
  // ---------------------------------------------------------------------------
  async function openOrderDrawer(orderNumber) {
    const drawerBackdrop = $('#detailDrawerBackdrop');
    lastFocusedElement = document.activeElement;
    drawerBackdrop.hidden = false;
    $('#drawerOrderTitle').textContent = orderNumber;
    $('#drawerEyebrow').textContent = 'LOADING ORDER DETAILS…';
    const drawer = $('#detailDrawer');
    if (drawer) drawer.focus();

    try {
      const res = await adminFetch(`/api/admin/orders/${encodeURIComponent(orderNumber)}`);
      if (!res.ok) throw new Error('Order not found');
      const data = await res.json();
      currentOrder = data.order;
      renderOrderDetail(currentOrder);
      loadOrderIn3D(currentOrder);
    } catch (err) {
      showToast(`Failed to load order ${orderNumber}: ${err.message}`);
      closeOrderDrawer();
    }
  }

  function closeOrderDrawer() {
    $('#detailDrawerBackdrop').hidden = true;
    currentOrder = null;
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();
    lastFocusedElement = null;
  }

  $('#drawerCloseBtn').addEventListener('click', closeOrderDrawer);
  $('#detailDrawerBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#detailDrawerBackdrop')) closeOrderDrawer();
  });

  function renderOrderDetail(order) {
    $('#drawerEyebrow').textContent = `ORDER INSPECTION · ${order.status.toUpperCase()}`;
    $('#drawerOrderTitle').textContent = order.orderNumber;

    // Status Badge
    const statusBadge = $('#detailStatusBadge');
    statusBadge.textContent = formatStatusLabel(order.status);
    statusBadge.className = `status-badge-lg status-${order.status}`;
    $('#manualStatusSelect').value = order.status;

    // Quick Action Buttons
    renderQuickStatusActions(order);

    // Payment verification context: when it happened, or what is still missing.
    const statusMeta = $('#detailStatusMeta');
    if (order.paymentVerifiedAt) {
      statusMeta.textContent = `Payment verified ${formatDate(order.paymentVerifiedAt)}`;
      statusMeta.hidden = false;
    } else if (order.status === 'payment_confirmation_sent') {
      statusMeta.textContent = 'Customer confirmed the payment — check the WhatsApp proof, then verify.';
      statusMeta.hidden = false;
    } else if (order.status === 'waiting_for_payment') {
      statusMeta.textContent = 'No payment confirmation from the customer yet.';
      statusMeta.hidden = false;
    } else {
      statusMeta.textContent = '';
      statusMeta.hidden = true;
    }

    // Customer
    $('#custName').textContent = order.customer.name || '—';
    $('#custPhone').textContent = order.customer.phone || '—';
    $('#custEmail').textContent = order.customer.email || 'None';
    $('#custAddress').textContent = order.customer.address || '—';

    if (order.customer.note) {
      $('#custNote').textContent = order.customer.note;
      $('#custNoteWrap').hidden = false;
    } else {
      $('#custNoteWrap').hidden = true;
    }

    // WhatsApp Action Link
    const waPhone = cleanWhatsAppNumber(order.customer.phone);
    const waMessage = [
      `Halo Kak ${order.customer.name}, salam dari LOCOXATL!`,
      `Mengenai pesanan Anda: ${order.orderNumber}`,
      `Status saat ini: ${formatStatusLabel(order.status)}`,
      order.trackingNumber ? `Nomor Resi: ${order.trackingNumber} (${order.shippingCourier || 'Kurir'})` : '',
      'Apakah ada yang bisa kami bantu mengenai pesanan ini?',
    ].filter(Boolean).join('\n');
    $('#customerWhatsAppBtn').href = `https://wa.me/${waPhone}?text=${encodeURIComponent(waMessage)}`;

    // Items list
    $('#detailCreatedAt').textContent = formatDate(order.createdAt);
    $('#detailTotalAmount').textContent = money(order.total);

    const itemsContainer = $('#detailItemsList');
    itemsContainer.innerHTML = (order.items || []).map((item) => `
      <div class="order-item-row">
        <div>
          <strong>${escapeHtml(item.productName)}</strong> × ${item.quantity}
          <div style="font-size:10px; color:#888;">Unit: ${money(item.unitPrice)}</div>
        </div>
        <strong>${money(item.subtotal)}</strong>
      </div>
    `).join('');

    // Fulfillment & Notes Form
    $('#courierInput').value = order.shippingCourier || '';
    $('#trackingInput').value = order.trackingNumber || '';
    $('#adminNotesTextarea').value = order.adminNotes || '';
    $('#notesSaveIndicator').hidden = true;

    // Timeline History
    renderTimeline(order.history, order.createdAt);

    // BOM (Bill of Materials) Specs
    renderBOM(order.configuration);

    // Raw JSON Toggle
    const rawJsonEl = $('#rawJsonCode');
    rawJsonEl.textContent = JSON.stringify(order.configuration || {}, null, 2);
    rawJsonEl.hidden = true;
    $('#toggleRawJsonBtn').textContent = 'Show 3D Configuration JSON ▾';
  }

  function cleanWhatsAppNumber(phone) {
    if (!phone) return '';
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    return p;
  }

  function renderQuickStatusActions(order) {
    const container = $('#quickStatusActions');
    container.innerHTML = '';

    const createBtn = (label, nextStatus, isPrimary = true) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = isPrimary ? 'btn-action-verify' : 'btn-action-secondary';
      btn.textContent = label;
      btn.addEventListener('click', () => updateStatus(order.orderNumber, nextStatus));
      return btn;
    };

    if (order.status === 'payment_confirmation_sent' || order.status === 'waiting_for_payment') {
      container.appendChild(createBtn('✓ Verify Payment (Mark Paid)', 'paid', true));
      container.appendChild(createBtn('Cancel Order', 'cancelled', false));
    } else if (order.status === 'paid') {
      container.appendChild(createBtn('⚙ Start Workshop Production', 'in_production', true));
      container.appendChild(createBtn('Cancel Order', 'cancelled', false));
    } else if (order.status === 'in_production') {
      container.appendChild(createBtn('📦 Mark as Shipped', 'shipped', true));
      container.appendChild(createBtn('✓ Complete Order', 'completed', false));
    } else if (order.status === 'shipped') {
      container.appendChild(createBtn('✓ Mark Order Completed', 'completed', true));
    } else {
      const label = document.createElement('span');
      label.style.fontSize = '11px';
      label.style.color = '#777';
      label.textContent = `Order is ${order.status.replace(/_/g, ' ')}. Use manual override below if needed.`;
      container.appendChild(label);
    }
  }

  async function updateStatus(orderNumber, nextStatus, notes = '') {
    // Freeze the quick actions while the transition is in flight so a double click cannot
    // fire two verifications.
    const actionContainer = $('#quickStatusActions');
    const actionButtons = actionContainer ? [...actionContainer.querySelectorAll('button')] : [];
    actionButtons.forEach((button) => { button.disabled = true; });

    try {
      const res = await adminFetch(`/api/admin/orders/${encodeURIComponent(orderNumber)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: nextStatus,
          notes: notes || `Status changed to ${nextStatus} via dashboard`,
          courier: $('#courierInput').value.trim() || undefined,
          trackingNumber: $('#trackingInput').value.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Status update failed');

      currentOrder = data.order;
      renderOrderDetail(currentOrder);
      loadMetrics();
      loadOrders();
      await refreshAccounting();
      showToast(nextStatus === 'paid'
        ? 'Payment verified — income booked in the cashbook.'
        : `Order status updated to: ${formatStatusLabel(nextStatus)}`);
    } catch (err) {
      showToast(`Status update error: ${err.message}`);
      actionButtons.forEach((button) => { button.disabled = false; });
    }
  }

  $('#applyManualStatusBtn').addEventListener('click', () => {
    if (!currentOrder) return;
    const nextStatus = $('#manualStatusSelect').value;
    updateStatus(currentOrder.orderNumber, nextStatus, 'Manual override from dropdown');
  });

  $('#fulfillmentNotesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentOrder) return;

    const courier = $('#courierInput').value.trim();
    const tracking = $('#trackingInput').value.trim();
    const adminNotes = $('#adminNotesTextarea').value.trim();
    const indicator = $('#notesSaveIndicator');

    try {
      const res = await adminFetch(`/api/admin/orders/${encodeURIComponent(currentOrder.orderNumber)}/notes`, {
        method: 'PATCH',
        body: JSON.stringify({
          shippingCourier: courier,
          trackingNumber: tracking,
          adminNotes: adminNotes,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Notes save failed');

      currentOrder = data.order;
      indicator.hidden = false;
      setTimeout(() => { indicator.hidden = true; }, 3000);
      showToast('Fulfillment & workshop notes saved ✓');
    } catch (err) {
      showToast(`Error saving notes: ${err.message}`);
    }
  });

  function renderTimeline(history = [], createdAt) {
    const list = $('#statusTimelineList');
    const items = [...(history || [])];

    if (!items.length) {
      list.innerHTML = `
        <div class="timeline-item">
          <strong>Order Placed</strong>
          <span>${formatDate(createdAt)}</span>
        </div>
      `;
      return;
    }

    list.innerHTML = items.map((h) => `
      <div class="timeline-item">
        <strong>${formatStatusLabel(h.newStatus)}</strong>
        <span>Changed by ${escapeHtml(h.changedBy || 'admin')} · ${formatDate(h.createdAt)}</span>
        ${h.notes ? `<p style="margin:2px 0 0; color:#555; font-size:10px;">${escapeHtml(h.notes)}</p>` : ''}
      </div>
    `).join('');
  }

  function renderBOM(configuration) {
    const list = $('#bomList');
    if (!configuration) {
      list.innerHTML = '<div class="bom-item"><span>No 3D configuration data available.</span></div>';
      return;
    }

    const c = configuration.configuration || configuration;
    const baseName = c.base?.name || c.base || 'Heart Base';
    const claspName = c.clasp?.name || c.clasp || 'Silver Clasp';
    const initial = c.initial || 'None';
    const addons = Array.isArray(c.addons) ? c.addons : [];

    list.innerHTML = `
      <div class="bom-item">
        <strong>Base Charm Silhouette</strong>
        <span>${escapeHtml(String(baseName))} (Beveled Acrylic)</span>
      </div>
      <div class="bom-item">
        <strong>Personalized Initial</strong>
        <span>${initial !== 'None' ? `Letter "${escapeHtml(initial)}"` : 'No Initial'}</span>
      </div>
      <div class="bom-item">
        <strong>Clasp & Keyring</strong>
        <span>${escapeHtml(String(claspName))}</span>
      </div>
      ${addons.map((a) => `
        <div class="bom-item">
          <strong>Accessory Add-on</strong>
          <span>${escapeHtml(a.name || a.id || String(a))}</span>
        </div>
      `).join('')}
    `;
  }

  $('#toggleRawJsonBtn').addEventListener('click', () => {
    const code = $('#rawJsonCode');
    const isHidden = code.hidden;
    code.hidden = !isHidden;
    $('#toggleRawJsonBtn').textContent = isHidden
      ? 'Hide 3D Configuration JSON ▴'
      : 'Show 3D Configuration JSON ▾';
  });

  // ---------------------------------------------------------------------------
  // 3D Viewer Mounting & Model Injection
  // ---------------------------------------------------------------------------
  async function loadOrderIn3D(order) {
    const canvas = $('#adminViewerCanvas');
    const stage = $('#adminViewerStage');
    if (!canvas || !stage) return;

    stage.dataset.viewer = 'loading';

    // Normalize config
    const raw = order.configuration || {};
    const c = raw.configuration || raw;

    let baseId = 'heart';
    if (typeof c.base === 'object' && c.base?.id) baseId = c.base.id;
    else if (typeof c.base === 'string') baseId = c.base;

    let claspId = 'silver';
    if (typeof c.clasp === 'object' && c.clasp?.id) claspId = c.clasp.id;
    else if (typeof c.clasp === 'string') claspId = c.clasp;

    const addons = Array.isArray(c.addons)
      ? c.addons.map((a) => (typeof a === 'object' ? a.id : a)).filter(Boolean)
      : [];

    const targetConfig = {
      base: baseId,
      clasp: claspId,
      addons,
      initial: typeof c.initial === 'string' ? c.initial : '',
      finishes: c.finishes || {},
      hidden: c.hidden || [],
    };

    if (!viewerInstance) {
      try {
        const { mountStudioViewer } = await import('./three/viewer.mjs');
        const elements = {
          canvas,
          stage,
          explodeButton: $('#adminViewerExplode'),
          assembleButton: $('#adminViewerAssemble'),
          resetButton: $('#adminViewerReset'),
          partList: $('#adminViewerPartList'),
          selectionName: $('#adminSelectionName'),
          selectionMeta: $('#adminSelectionMeta'),
          swatches: null,
          visibilityToggle: null,
          hint: $('#adminViewerHint'),
        };

        viewerInstance = mountStudioViewer(elements, targetConfig);
      } catch (err) {
        console.warn('Admin 3D viewer initialization error:', err);
        stage.dataset.viewer = 'failed';
        $('#adminPreviewFallback').hidden = false;
        return;
      }
    } else {
      viewerInstance.applyState(targetConfig);
    }

    stage.dataset.viewer = 'ready';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------------------
  // Dashboard views: Orders / Cashbook & Reports / Catalog Groups
  // ---------------------------------------------------------------------------
  function setActiveView(view) {
    const target = ['orders', 'accounting', 'artists', 'product'].includes(view) ? view : 'orders';
    activeView = target;

    $$('[data-view-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== target;
    });
    $$('#adminViewTabs .admin-view-tab').forEach((tab) => {
      const isActive = tab.dataset.view === target;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });

    if (target === 'artists') setArtistTab(artistGroupTab);
    if (target === 'product') loadProductSetup();
    if (target === 'accounting') refreshAccounting();
  }

  $$('#adminViewTabs .admin-view-tab').forEach((tab) => {
    tab.addEventListener('click', () => setActiveView(tab.dataset.view));
  });

  $('#accountingNavLink').addEventListener('click', (event) => {
    event.preventDefault();
    setActiveView('accounting');
    $('#accountingSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------------------------------------------------------------------------
  // Artist & Group Management
  //
  // This view owns two related resources: the group (hero images, focal crops, eyebrow, store
  // visibility, ordering) and its members (name, portrait, visibility, ordering). Images are
  // uploaded as data URLs and stored by the server in Cloudinary or the local fallback; only the
  // resulting URL is persisted in MySQL.
  // ---------------------------------------------------------------------------
  function setArtistTab(tab) {
    const target = ['groups', 'members', 'bundles'].includes(tab) ? tab : 'groups';
    artistGroupTab = target;

    $$('[data-artist-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.artistPanel !== target;
    });
    $$('#artistSubtabs .catalog-subtab').forEach((button) => {
      const isActive = button.dataset.artistTab === target;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });

    if (target === 'groups') loadArtistGroups();
    if (target === 'members') loadArtistMembers();
    if (target === 'bundles') loadBundles();
  }

  $$('#artistSubtabs .catalog-subtab').forEach((button) => {
    button.addEventListener('click', () => setArtistTab(button.dataset.artistTab));
  });

  async function loadArtistGroups() {
    const tbody = $('#artistGroupsBody');
    const note = $('#artistGroupsNote');
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">Loading artist groups...</td></tr>';

    try {
      const response = await adminFetch('/api/admin/catalog/groups');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Artist groups could not be loaded.');
      artistGroups = data.groups || [];
      renderArtistGroups();
      const live = artistGroups.filter((group) => group.isActive).length;
      note.textContent = `${artistGroups.length} group${artistGroups.length === 1 ? '' : 's'} · ${live} visible on the storefront.`;
    } catch (error) {
      artistGroups = [];
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
      note.textContent = databaseMessage(error, 'Artist groups');
    }
  }

  function renderArtistGroups() {
    const tbody = $('#artistGroupsBody');
    if (!artistGroups.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No groups yet. Add the first artist or group.</td></tr>';
      return;
    }

    tbody.innerHTML = artistGroups.map((group, index) => {
      const cover = safeImageUrl(group.imageUrl);
      const hero = safeImageUrl(group.heroImageUrl);
      return `
      <tr data-artist-group-row="${group.id}">
        <td class="catalog-order-cell">
          <span class="catalog-order-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="catalog-order-controls">
            <button type="button" class="icon-button catalog-move" data-move-artist-group="-1" data-group-id="${group.id}" aria-label="Move ${escapeHtml(group.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-button catalog-move" data-move-artist-group="1" data-group-id="${group.id}" aria-label="Move ${escapeHtml(group.name)} down" ${index === artistGroups.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
        </td>
        <td class="customer-cell">
          <span class="catalog-group-name">
            ${cover
              ? `<span class="catalog-thumb" style="background-image:url('${cover}')" aria-hidden="true"></span>`
              : '<span class="catalog-thumb is-empty" aria-hidden="true">◇</span>'}
            <strong>${escapeHtml(group.name)}</strong>
          </span>
          <span>${escapeHtml(group.tagline || 'No tagline')}</span>
        </td>
        <td><code class="catalog-slug">${escapeHtml(group.slug)}</code></td>
        <td class="catalog-description-cell">${escapeHtml(group.eyebrow || 'Default eyebrow')}</td>
        <td>
          <span class="artist-image-flag${cover ? ' is-set' : ''}">Cover</span>
          <span class="artist-image-flag${hero ? ' is-set' : ''}">Hero</span>
        </td>
        <td>
          <label class="toggle-switch toggle-switch-inline">
            <input type="checkbox" data-toggle-artist-group="${group.id}" ${group.isActive ? 'checked' : ''} aria-label="Show ${escapeHtml(group.name)} on the storefront" />
            <span class="toggle-track" aria-hidden="true"></span>
            <span class="toggle-label">${group.isActive ? 'Live' : 'Hidden'}</span>
          </label>
        </td>
        <td class="artist-row-actions">
          <button type="button" class="button button-outline button-small" data-edit-artist-group="${group.id}">Edit</button>
          <button type="button" class="text-link" data-view-members-group="${group.id}">Members</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-edit-artist-group]').forEach((button) => {
      button.addEventListener('click', () => openArtistGroupModal(Number(button.dataset.editArtistGroup)));
    });
    tbody.querySelectorAll('[data-view-members-group]').forEach((button) => {
      button.addEventListener('click', () => {
        const groupId = String(button.dataset.viewMembersGroup);
        const filter = $('#memberGroupFilter');
        if (filter) filter.value = groupId;
        setArtistTab('members');
        artistMembers = [];
        loadArtistMembers();
      });
    });
    tbody.querySelectorAll('[data-toggle-artist-group]').forEach((input) => {
      input.addEventListener('change', () => toggleArtistGroup(Number(input.dataset.toggleArtistGroup), input.checked));
    });
    tbody.querySelectorAll('[data-move-artist-group]').forEach((button) => {
      button.addEventListener('click', () => moveArtistGroup(Number(button.dataset.groupId), Number(button.dataset.moveArtistGroup)));
    });
  }

  async function toggleArtistGroup(id, isActive) {
    try {
      const response = await adminFetch(`/api/admin/catalog/groups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Group could not be updated.');
      await loadArtistGroups();
      showToast(isActive ? 'Group published to the storefront.' : 'Group hidden from the storefront.');
    } catch (error) {
      showToast(`Artist error: ${error.message}`);
      await loadArtistGroups();
    }
  }

  async function moveArtistGroup(id, direction) {
    const index = artistGroups.findIndex((group) => group.id === id);
    if (index < 0) return;
    const current = artistGroups[index];
    const neighbour = artistGroups[index + direction];
    if (!neighbour) return;

    const updates = current.sortOrder === neighbour.sortOrder
      ? [[current.id, neighbour.sortOrder + (direction > 0 ? 1 : -1)]]
      : [[current.id, neighbour.sortOrder], [neighbour.id, current.sortOrder]];

    try {
      for (const [groupId, sortOrder] of updates) {
        await adminFetch(`/api/admin/catalog/groups/${groupId}`, {
          method: 'PATCH',
          body: JSON.stringify({ sortOrder }),
        });
      }
      await loadArtistGroups();
    } catch (error) {
      showToast(`Reorder error: ${error.message}`);
    }
  }

  const FOCAL_VALUES = ['50% 50%', '50% 20%', '50% 80%', '20% 50%', '80% 50%', '20% 20%', '80% 20%', '20% 80%', '80% 80%'];

  function setFocalSelect(select, value) {
    if (!select) return;
    const target = String(value || '50% 50%');
    select.innerHTML = FOCAL_VALUES
      .map((focal) => `<option value="${focal}">${focal}</option>`)
      .join('');
    select.value = FOCAL_VALUES.includes(target) ? target : '50% 50%';
  }

  function renderArtistImagePreview(previewId, thumbId, source) {
    const preview = $(`#${previewId}`);
    const thumb = $(`#${thumbId}`);
    if (!preview || !thumb) return;
    const value = String(source || '');
    const safe = value.startsWith('data:image/') ? value : safeImageUrl(value);
    if (safe) {
      thumb.src = safe;
      preview.hidden = false;
    } else {
      thumb.removeAttribute('src');
      preview.hidden = true;
    }
  }

  function setImageNote(noteId, message) {
    const note = $(`#${noteId}`);
    if (!note) return;
    if (!message) {
      note.hidden = true;
      note.textContent = '';
      return;
    }
    note.hidden = false;
    note.textContent = message;
  }

  function openArtistGroupModal(groupId) {
    const group = groupId ? artistGroups.find((row) => row.id === groupId) : null;
    $('#artistGroupFormError').hidden = true;
    $('#artistGroupForm').reset();
    $('#artistGroupFormId').value = group ? String(group.id) : '';
    $('#artistGroupName').value = group ? group.name : '';
    $('#artistGroupSlug').value = group ? group.slug : '';
    $('#artistGroupEyebrow').value = group ? group.eyebrow : '';
    $('#artistGroupTagline').value = group ? group.tagline : '';
    $('#artistGroupDescription').value = group ? group.description : '';
    $('#artistGroupSortOrder').value = String(group ? group.sortOrder : artistGroups.length);
    $('#artistGroupIsActive').checked = group ? Boolean(group.isActive) : true;
    setFocalSelect($('#artistCoverFocal'), group ? group.coverFocal : '50% 50%');
    setFocalSelect($('#artistHeroFocal'), group ? group.heroFocal : '50% 50%');
    $('#artistGroupModalEyebrow').textContent = group ? 'EDIT GROUP' : 'NEW GROUP';
    $('#artistGroupModalTitle').textContent = group ? group.name : 'Add group';
    $('#artistGroupFormSubmit').textContent = group ? 'Save changes' : 'Create group';
    $('#artistGroupDelete').hidden = !group;

    artistPendingCover = null;
    artistPendingCoverRemoval = false;
    artistPendingHero = null;
    artistPendingHeroRemoval = false;
    $('#artistCoverInput').value = '';
    $('#artistHeroInput').value = '';
    setImageNote('artistCoverNote', '');
    setImageNote('artistHeroNote', '');
    renderArtistImagePreview('artistCoverPreview', 'artistCoverThumb', group ? group.imageUrl : '');
    renderArtistImagePreview('artistHeroPreview', 'artistHeroThumb', group ? group.heroImageUrl : '');

    lastFocusedElement = document.activeElement;
    $('#artistGroupModalBackdrop').hidden = false;
    $('#artistGroupModal').focus();
    $('#artistGroupName').focus();
  }

  function closeArtistGroupModal() {
    $('#artistGroupModalBackdrop').hidden = true;
    artistPendingCover = null;
    artistPendingCoverRemoval = false;
    artistPendingHero = null;
    artistPendingHeroRemoval = false;
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();
    lastFocusedElement = null;
  }

  $('#artistCoverInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setImageNote('artistCoverNote', 'Preparing image…');
    try {
      artistPendingCover = await readImageFile(file);
      artistPendingCoverRemoval = false;
      renderArtistImagePreview('artistCoverPreview', 'artistCoverThumb', artistPendingCover);
      setImageNote('artistCoverNote', `Ready to upload · about ${Math.round((artistPendingCover.length * 0.75) / 1024)} KB after resizing.`);
    } catch (error) {
      artistPendingCover = null;
      setImageNote('artistCoverNote', error.message);
      $('#artistCoverInput').value = '';
    }
  });

  $('#artistCoverRemove').addEventListener('click', () => {
    artistPendingCover = null;
    artistPendingCoverRemoval = true;
    $('#artistCoverInput').value = '';
    renderArtistImagePreview('artistCoverPreview', 'artistCoverThumb', '');
    setImageNote('artistCoverNote', 'The cover will be removed when you save.');
  });

  $('#artistHeroInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setImageNote('artistHeroNote', 'Preparing image…');
    try {
      artistPendingHero = await readImageFile(file);
      artistPendingHeroRemoval = false;
      renderArtistImagePreview('artistHeroPreview', 'artistHeroThumb', artistPendingHero);
      setImageNote('artistHeroNote', `Ready to upload · about ${Math.round((artistPendingHero.length * 0.75) / 1024)} KB after resizing.`);
    } catch (error) {
      artistPendingHero = null;
      setImageNote('artistHeroNote', error.message);
      $('#artistHeroInput').value = '';
    }
  });

  $('#artistHeroRemove').addEventListener('click', () => {
    artistPendingHero = null;
    artistPendingHeroRemoval = true;
    $('#artistHeroInput').value = '';
    renderArtistImagePreview('artistHeroPreview', 'artistHeroThumb', '');
    setImageNote('artistHeroNote', 'The hero image will be removed when you save.');
  });

  /** Uploads (or clears) one group image, returning the refreshed group. */
  async function saveGroupImage(groupId, kind, dataUrl) {
    const url = `/api/admin/catalog/groups/${groupId}/image${kind === 'hero' ? '?kind=hero' : ''}`;
    const response = dataUrl === null
      ? await adminFetch(url, { method: 'DELETE' })
      : await adminFetch(url, { method: 'POST', body: JSON.stringify({ dataUrl }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || 'The image could not be saved.');
    return body.group;
  }

  $('#addArtistGroupBtn').addEventListener('click', () => openArtistGroupModal(null));
  $('#refreshArtistGroupsBtn').addEventListener('click', () => loadArtistGroups());
  $('#artistGroupModalClose').addEventListener('click', closeArtistGroupModal);
  $('#artistGroupFormCancel').addEventListener('click', closeArtistGroupModal);
  $('#artistGroupModalBackdrop').addEventListener('click', (event) => {
    if (event.target === $('#artistGroupModalBackdrop')) closeArtistGroupModal();
  });

  $('#artistGroupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#artistGroupFormId').value;
    const errorEl = $('#artistGroupFormError');
    const payload = {
      name: $('#artistGroupName').value,
      slug: $('#artistGroupSlug').value,
      eyebrow: $('#artistGroupEyebrow').value,
      tagline: $('#artistGroupTagline').value,
      description: $('#artistGroupDescription').value,
      coverFocal: $('#artistCoverFocal').value,
      heroFocal: $('#artistHeroFocal').value,
      sortOrder: Number($('#artistGroupSortOrder').value),
      isActive: $('#artistGroupIsActive').checked,
    };

    errorEl.hidden = true;
    $('#artistGroupFormSubmit').disabled = true;

    try {
      const response = await adminFetch(
        id ? `/api/admin/catalog/groups/${id}` : '/api/admin/catalog/groups',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Group could not be saved.');

      let saved = data.group;
      // A failed cover/hero upload must not turn a retry into a second POST for the same slug.
      if (!id) $('#artistGroupFormId').value = String(saved.id);
      if (artistPendingCover) saved = await saveGroupImage(saved.id, 'cover', artistPendingCover);
      else if (artistPendingCoverRemoval) saved = await saveGroupImage(saved.id, 'cover', null);
      if (artistPendingHero) saved = await saveGroupImage(saved.id, 'hero', artistPendingHero);
      else if (artistPendingHeroRemoval) saved = await saveGroupImage(saved.id, 'hero', null);

      closeArtistGroupModal();
      await loadArtistGroups();
      artistMembers = [];
      showToast(id ? 'Group updated.' : 'Group created.');
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      $('#artistGroupFormSubmit').disabled = false;
    }
  });

  $('#artistGroupDelete').addEventListener('click', async () => {
    const id = $('#artistGroupFormId').value;
    if (!id) return;
    const group = artistGroups.find((row) => String(row.id) === String(id));
    const name = group ? group.name : 'this group';
    const memberCount = artistMembers.filter((member) => String(member.groupId) === String(id)).length;
    const warning = memberCount > 0
      ? `\n\nIts ${memberCount} member${memberCount === 1 ? '' : 's'} will be deleted too.`
      : '';
    if (!window.confirm(`Delete "${name}" permanently?${warning}\n\nThis cannot be undone.`)) return;

    try {
      const response = await adminFetch(`/api/admin/catalog/groups/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Group could not be deleted.');
      closeArtistGroupModal();
      await loadArtistGroups();
      artistMembers = [];
      showToast(`Deleted "${name}".`);
    } catch (error) {
      showToast(`Delete error: ${error.message}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Bundle packages ("paketan")
  //
  // A bundle is a fixed price that includes a quota of eligible add-ons for free. It reuses the
  // same table, modal and image helpers as groups and members; the only new control is the
  // eligible add-on picker, which stays empty when any active add-on may be taken.
  // ---------------------------------------------------------------------------
  async function loadBundles() {
    const tbody = $('#bundlesBody');
    const note = $('#bundlesNote');
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">Loading bundle packages...</td></tr>';

    try {
      await ensureArtistGroupsLoaded();
      const response = await adminFetch('/api/admin/catalog/bundles');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Bundle packages could not be loaded.');
      bundles = data.bundles || [];
      renderBundles();
      const live = bundles.filter((bundle) => bundle.isActive).length;
      note.textContent = `${bundles.length} bundle${bundles.length === 1 ? '' : 's'} · ${live} offered in the studio.`;
    } catch (error) {
      bundles = [];
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
      note.textContent = databaseMessage(error, 'Bundle packages');
    }
  }

  function bundleAddonSummary(keys) {
    return Array.isArray(keys) && keys.length ? keys.join(', ') : 'any add-on';
  }

  function renderBundles() {
    const tbody = $('#bundlesBody');
    if (!bundles.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No bundle packages yet. Add the first paketan.</td></tr>';
      return;
    }

    tbody.innerHTML = bundles.map((bundle) => {
      const image = safeImageUrl(bundle.imageUrl);
      const collection = bundle.groupId ? groupName(bundle.groupId) : 'Every collection';
      return `
      <tr data-bundle-row="${bundle.id}">
        <td class="customer-cell">
          <span class="catalog-group-name">
            ${image
              ? `<span class="catalog-thumb" style="background-image:url('${image}')" aria-hidden="true"></span>`
              : '<span class="catalog-thumb is-empty" aria-hidden="true">◇</span>'}
            <strong>${escapeHtml(bundle.name)}</strong>
          </span>
          <span>${escapeHtml(bundle.description || 'No description')}</span>
        </td>
        <td>${escapeHtml(collection)}</td>
        <td><code class="catalog-slug">${escapeHtml(bundle.slug)}</code></td>
        <td>${escapeHtml(money(bundle.price))}</td>
        <td>${bundle.freeAddonQuota} free · ${escapeHtml(bundleAddonSummary(bundle.allowedAddonKeys))}</td>
        <td>
          <label class="toggle-switch toggle-switch-inline">
            <input type="checkbox" data-toggle-bundle="${bundle.id}" ${bundle.isActive ? 'checked' : ''} aria-label="Offer ${escapeHtml(bundle.name)} in the studio" />
            <span class="toggle-track" aria-hidden="true"></span>
            <span class="toggle-label">${bundle.isActive ? 'Live' : 'Hidden'}</span>
          </label>
        </td>
        <td class="artist-row-actions">
          <button type="button" class="button button-outline button-small" data-edit-bundle="${bundle.id}">Edit</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-edit-bundle]').forEach((button) => {
      button.addEventListener('click', () => openBundleModal(Number(button.dataset.editBundle)));
    });
    tbody.querySelectorAll('[data-toggle-bundle]').forEach((input) => {
      input.addEventListener('change', () => toggleBundle(Number(input.dataset.toggleBundle), input.checked));
    });
  }

  async function toggleBundle(id, isActive) {
    try {
      const response = await adminFetch(`/api/admin/catalog/bundles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Bundle could not be updated.');
      await loadBundles();
      showToast(isActive ? 'Bundle shown in the studio.' : 'Bundle hidden from the studio.');
    } catch (error) {
      showToast(`Bundle error: ${error.message}`);
      await loadBundles();
    }
  }

  function syncBundleGroupOptions() {
    const select = $('#bundleGroup');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Every collection</option>'
      + artistGroups
        .map((group) => `<option value="${group.id}">${escapeHtml(group.name)}${group.isActive ? '' : ' (hidden)'}</option>`)
        .join('');
    select.value = current;
  }

  /** Eligible add-ons come from the live price table, with src/options.js as the fallback. */
  function renderBundleAddonChoices(selected) {
    const container = $('#bundleAddonChoices');
    if (!container) return;

    const configured = (pricingOptions.length ? pricingOptions : [])
      .filter((option) => option.category === 'addon' && option.key !== 'initial')
      .map((option) => ({ key: option.key, label: option.label }));
    const fallback = window.LocoxatlOptions && Array.isArray(window.LocoxatlOptions.addons)
      ? window.LocoxatlOptions.addons
        .filter((addon) => addon.id !== 'initial')
        .map((addon) => ({ key: addon.id, label: addon.name }))
      : [];
    const list = configured.length ? configured : fallback;
    const chosen = new Set(Array.isArray(selected) ? selected : []);

    container.innerHTML = list.length
      ? list.map((addon) => `
        <label class="bundle-addon-option">
          <input type="checkbox" data-bundle-addon="${escapeHtml(addon.key)}" ${chosen.has(addon.key) ? 'checked' : ''} />
          <span>${escapeHtml(addon.label)}</span>
        </label>`).join('')
      : '<p class="catalog-image-note">No add-ons are configured yet.</p>';
  }

  async function openBundleModal(bundleId) {
    if (!pricingOptions.length) await loadPricing();
    if (!artistGroups.length) await ensureArtistGroupsLoaded().catch(() => {});

    const bundle = bundleId ? bundles.find((row) => row.id === bundleId) : null;
    syncBundleGroupOptions();
    $('#bundleFormError').hidden = true;
    $('#bundleForm').reset();
    $('#bundleFormId').value = bundle ? String(bundle.id) : '';
    $('#bundleName').value = bundle ? bundle.name : '';
    $('#bundleSlug').value = bundle ? bundle.slug : '';
    $('#bundleGroup').value = bundle && bundle.groupId ? String(bundle.groupId) : '';
    $('#bundlePrice').value = bundle ? String(bundle.price) : '';
    $('#bundleQuota').value = String(bundle ? bundle.freeAddonQuota : 1);
    $('#bundleSortOrder').value = String(bundle ? bundle.sortOrder : bundles.length);
    $('#bundleDescription').value = bundle ? bundle.description : '';
    $('#bundleIsActive').checked = bundle ? Boolean(bundle.isActive) : true;
    renderBundleAddonChoices(bundle ? bundle.allowedAddonKeys : null);

    bundlePendingImage = null;
    bundlePendingImageRemoval = false;
    $('#bundleImageInput').value = '';
    setImageNote('bundleImageNote', '');
    renderArtistImagePreview('bundleImagePreview', 'bundleImageThumb', bundle ? bundle.imageUrl : '');

    $('#bundleModalEyebrow').textContent = bundle ? 'EDIT BUNDLE' : 'NEW BUNDLE';
    $('#bundleModalTitle').textContent = bundle ? bundle.name : 'Add bundle';
    $('#bundleFormSubmit').textContent = bundle ? 'Save changes' : 'Create bundle';

    lastFocusedElement = document.activeElement;
    $('#bundleModalBackdrop').hidden = false;
    $('#bundleModal').focus();
    $('#bundleName').focus();
  }

  function closeBundleModal() {
    $('#bundleModalBackdrop').hidden = true;
    bundlePendingImage = null;
    bundlePendingImageRemoval = false;
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();
    lastFocusedElement = null;
  }

  $('#bundleImageInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setImageNote('bundleImageNote', 'Preparing image…');
    try {
      bundlePendingImage = await readImageFile(file);
      bundlePendingImageRemoval = false;
      renderArtistImagePreview('bundleImagePreview', 'bundleImageThumb', bundlePendingImage);
      setImageNote('bundleImageNote', `Ready to upload · about ${Math.round((bundlePendingImage.length * 0.75) / 1024)} KB after resizing.`);
    } catch (error) {
      bundlePendingImage = null;
      setImageNote('bundleImageNote', error.message);
      $('#bundleImageInput').value = '';
    }
  });

  $('#bundleImageRemove').addEventListener('click', () => {
    bundlePendingImage = null;
    bundlePendingImageRemoval = true;
    $('#bundleImageInput').value = '';
    renderArtistImagePreview('bundleImagePreview', 'bundleImageThumb', '');
    setImageNote('bundleImageNote', 'The image will be removed when you save.');
  });

  $('#addBundleBtn').addEventListener('click', () => openBundleModal(null));
  $('#refreshBundlesBtn').addEventListener('click', () => loadBundles());
  $('#bundleModalClose').addEventListener('click', closeBundleModal);
  $('#bundleFormCancel').addEventListener('click', closeBundleModal);
  $('#bundleModalBackdrop').addEventListener('click', (event) => {
    if (event.target === $('#bundleModalBackdrop')) closeBundleModal();
  });

  $('#bundleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#bundleFormId').value;
    const errorEl = $('#bundleFormError');
    const allowedAddonKeys = [...$$('[data-bundle-addon]')]
      .filter((input) => input.checked)
      .map((input) => input.dataset.bundleAddon);
    const payload = {
      name: $('#bundleName').value,
      slug: $('#bundleSlug').value,
      groupId: $('#bundleGroup').value || null,
      description: $('#bundleDescription').value,
      bundlePrice: Number($('#bundlePrice').value),
      freeAddonQuota: Number($('#bundleQuota').value),
      allowedAddonKeys: allowedAddonKeys.length ? allowedAddonKeys : null,
      sortOrder: Number($('#bundleSortOrder').value),
      isActive: $('#bundleIsActive').checked,
    };
    if (!Number.isInteger(payload.bundlePrice) || payload.bundlePrice < 0) {
      showToast('Bundle price must be a whole number of at least 0.');
      $('#bundlePrice').focus();
      return;
    }
    if (bundlePendingImage) payload.imageUrl = bundlePendingImage;
    else if (bundlePendingImageRemoval) payload.imageUrl = null;

    errorEl.hidden = true;
    $('#bundleFormSubmit').disabled = true;

    try {
      const response = await adminFetch(
        id ? `/api/admin/catalog/bundles/${id}` : '/api/admin/catalog/bundles',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Bundle could not be saved.');

      closeBundleModal();
      await loadBundles();
      showToast(id ? 'Bundle updated.' : 'Bundle created.');
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      $('#bundleFormSubmit').disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Group members
  // ---------------------------------------------------------------------------
  async function ensureArtistGroupsLoaded() {
    if (artistGroups.length) return;
    const response = await adminFetch('/api/admin/catalog/groups');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Groups could not be loaded.');
    artistGroups = data.groups || [];
  }

  /** Keeps the member table filter and the member modal picker on the same group list. */
  function syncMemberGroupSelectors() {
    const options = artistGroups
      .map((group) => `<option value="${group.id}">${escapeHtml(group.name)}${group.isActive ? '' : ' (hidden)'}</option>`)
      .join('');

    const filter = $('#memberGroupFilter');
    if (filter) {
      const selected = filter.value;
      filter.innerHTML = `<option value="">All groups</option>${options}`;
      filter.value = selected;
      if (filter.value !== selected) filter.value = '';
    }

    const picker = $('#artistMemberGroup');
    if (picker) {
      const current = picker.value;
      picker.innerHTML = options;
      if (current) picker.value = current;
    }
  }

  function groupName(groupId) {
    const group = artistGroups.find((row) => String(row.id) === String(groupId));
    return group ? group.name : '—';
  }

  async function loadArtistMembers() {
    const tbody = $('#artistMembersBody');
    const note = $('#artistMembersNote');
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">Loading group members...</td></tr>';

    try {
      await ensureArtistGroupsLoaded();
      syncMemberGroupSelectors();

      const groupId = $('#memberGroupFilter') ? $('#memberGroupFilter').value : '';
      const url = groupId
        ? `/api/admin/catalog/members?groupId=${encodeURIComponent(groupId)}`
        : '/api/admin/catalog/members';
      const response = await adminFetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Members could not be loaded.');

      artistMembers = data.members || [];
      renderArtistMembers();
      const live = artistMembers.filter((member) => member.isActive).length;
      note.textContent = `${artistMembers.length} member${artistMembers.length === 1 ? '' : 's'} · ${live} visible on the storefront.`;
    } catch (error) {
      artistMembers = [];
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
      note.textContent = databaseMessage(error, 'Members');
    }
  }

  function renderArtistMembers() {
    const tbody = $('#artistMembersBody');
    if (!artistMembers.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No members here yet. Add the first member.</td></tr>';
      return;
    }

    tbody.innerHTML = artistMembers.map((member, index) => {
      const thumb = safeImageUrl(member.portraitUrl);
      return `
      <tr data-artist-member-row="${member.id}">
        <td class="catalog-order-cell">
          <span class="catalog-order-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="catalog-order-controls">
            <button type="button" class="icon-button catalog-move" data-move-member="-1" data-member-id="${member.id}" aria-label="Move ${escapeHtml(member.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-button catalog-move" data-move-member="1" data-member-id="${member.id}" aria-label="Move ${escapeHtml(member.name)} down" ${index === artistMembers.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
        </td>
        <td class="customer-cell">
          <span class="catalog-group-name">
            ${thumb
              ? `<span class="catalog-thumb" style="background-image:url('${thumb}')" aria-hidden="true"></span>`
              : '<span class="catalog-thumb is-empty" aria-hidden="true">◇</span>'}
            <strong>${escapeHtml(member.name)}</strong>
          </span>
        </td>
        <td>${escapeHtml(groupName(member.groupId))}</td>
        <td><code class="catalog-slug">${escapeHtml(member.slug)}</code></td>
        <td>
          <span class="artist-image-flag${safeImageUrl(member.designImageUrl) ? ' is-set' : ''}">Artwork</span>
        </td>
        <td>
          <label class="toggle-switch toggle-switch-inline">
            <input type="checkbox" data-toggle-member="${member.id}" ${member.isActive ? 'checked' : ''} aria-label="Show ${escapeHtml(member.name)} on the storefront" />
            <span class="toggle-track" aria-hidden="true"></span>
            <span class="toggle-label">${member.isActive ? 'Live' : 'Hidden'}</span>
          </label>
        </td>
        <td>
          <button type="button" class="button button-outline button-small" data-edit-member="${member.id}">Edit</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-edit-member]').forEach((button) => {
      button.addEventListener('click', () => openArtistMemberModal(Number(button.dataset.editMember)));
    });
    tbody.querySelectorAll('[data-toggle-member]').forEach((input) => {
      input.addEventListener('change', () => toggleMember(Number(input.dataset.toggleMember), input.checked));
    });
    tbody.querySelectorAll('[data-move-member]').forEach((button) => {
      button.addEventListener('click', () => moveMember(Number(button.dataset.memberId), Number(button.dataset.moveMember)));
    });
  }

  async function toggleMember(id, isActive) {
    try {
      const response = await adminFetch(`/api/admin/catalog/members/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Member could not be updated.');
      await loadArtistMembers();
      showToast(isActive ? 'Member published to the storefront.' : 'Member hidden from the storefront.');
    } catch (error) {
      showToast(`Member error: ${error.message}`);
      await loadArtistMembers();
    }
  }

  async function moveMember(id, direction) {
    const index = artistMembers.findIndex((member) => member.id === id);
    if (index < 0) return;
    const current = artistMembers[index];
    const neighbour = artistMembers[index + direction];
    // Sort order is per group, so never swap across a group boundary.
    if (!neighbour || String(neighbour.groupId) !== String(current.groupId)) return;

    const updates = current.sortOrder === neighbour.sortOrder
      ? [[current.id, neighbour.sortOrder + (direction > 0 ? 1 : -1)]]
      : [[current.id, neighbour.sortOrder], [neighbour.id, current.sortOrder]];

    try {
      for (const [memberId, sortOrder] of updates) {
        await adminFetch(`/api/admin/catalog/members/${memberId}`, {
          method: 'PATCH',
          body: JSON.stringify({ sortOrder }),
        });
      }
      await loadArtistMembers();
    } catch (error) {
      showToast(`Reorder error: ${error.message}`);
    }
  }

  function openArtistMemberModal(memberId) {
    const member = memberId ? artistMembers.find((row) => row.id === memberId) : null;
    if (!artistGroups.length) {
      showToast('Load the groups first.');
      return;
    }

    syncMemberGroupSelectors();

    $('#artistMemberFormError').hidden = true;
    $('#artistMemberForm').reset();
    $('#artistMemberFormId').value = member ? String(member.id) : '';
    $('#artistMemberName').value = member ? member.name : '';
    $('#artistMemberSlug').value = member ? member.slug : '';
    $('#artistMemberGroup').value = String(member ? member.groupId : ($('#memberGroupFilter').value || artistGroups[0].id));
    $('#artistMemberSortOrder').value = String(member ? member.sortOrder : 0);
    $('#artistMemberIsActive').checked = member ? Boolean(member.isActive) : true;
    $('#artistMemberModalEyebrow').textContent = member ? 'EDIT MEMBER' : 'NEW MEMBER';
    $('#artistMemberModalTitle').textContent = member ? member.name : 'Add member';
    $('#artistMemberFormSubmit').textContent = member ? 'Save changes' : 'Create member';
    $('#artistMemberDelete').hidden = !member;

    artistPendingPortrait = null;
    artistPendingPortraitRemoval = false;
    $('#artistPortraitInput').value = '';
    setImageNote('artistPortraitNote', '');
    renderArtistImagePreview('artistPortraitPreview', 'artistPortraitThumb', member ? member.portraitUrl : '');

    artistPendingDesign = null;
    artistPendingDesignRemoval = false;
    $('#artistDesignInput').value = '';
    setImageNote('artistDesignNote', '');
    renderArtistImagePreview('artistDesignPreview', 'artistDesignThumb', member ? member.designImageUrl : '');

    lastFocusedElement = document.activeElement;
    $('#artistMemberModalBackdrop').hidden = false;
    $('#artistMemberModal').focus();
    $('#artistMemberName').focus();
  }

  function closeArtistMemberModal() {
    $('#artistMemberModalBackdrop').hidden = true;
    artistPendingPortrait = null;
    artistPendingPortraitRemoval = false;
    artistPendingDesign = null;
    artistPendingDesignRemoval = false;
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();
    lastFocusedElement = null;
  }

  $('#artistPortraitInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setImageNote('artistPortraitNote', 'Preparing image…');
    try {
      artistPendingPortrait = await readImageFile(file);
      artistPendingPortraitRemoval = false;
      renderArtistImagePreview('artistPortraitPreview', 'artistPortraitThumb', artistPendingPortrait);
      setImageNote('artistPortraitNote', `Ready to upload · about ${Math.round((artistPendingPortrait.length * 0.75) / 1024)} KB after resizing.`);
    } catch (error) {
      artistPendingPortrait = null;
      setImageNote('artistPortraitNote', error.message);
      $('#artistPortraitInput').value = '';
    }
  });

  $('#artistPortraitRemove').addEventListener('click', () => {
    artistPendingPortrait = null;
    artistPendingPortraitRemoval = true;
    $('#artistPortraitInput').value = '';
    renderArtistImagePreview('artistPortraitPreview', 'artistPortraitThumb', '');
    setImageNote('artistPortraitNote', 'The portrait will be removed when you save.');
  });

  $('#artistDesignInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setImageNote('artistDesignNote', 'Preparing image…');
    try {
      artistPendingDesign = await readImageFile(file);
      artistPendingDesignRemoval = false;
      renderArtistImagePreview('artistDesignPreview', 'artistDesignThumb', artistPendingDesign);
      setImageNote('artistDesignNote', `Ready to upload · about ${Math.round((artistPendingDesign.length * 0.75) / 1024)} KB after resizing.`);
    } catch (error) {
      artistPendingDesign = null;
      setImageNote('artistDesignNote', error.message);
      $('#artistDesignInput').value = '';
    }
  });

  $('#artistDesignRemove').addEventListener('click', () => {
    artistPendingDesign = null;
    artistPendingDesignRemoval = true;
    $('#artistDesignInput').value = '';
    renderArtistImagePreview('artistDesignPreview', 'artistDesignThumb', '');
    setImageNote('artistDesignNote', 'The keychain artwork will be removed when you save.');
  });

  $('#addMemberBtn').addEventListener('click', () => openArtistMemberModal(null));
  $('#refreshMembersBtn').addEventListener('click', () => loadArtistMembers());
  $('#memberGroupFilter').addEventListener('change', () => loadArtistMembers());
  $('#artistMemberModalClose').addEventListener('click', closeArtistMemberModal);
  $('#artistMemberFormCancel').addEventListener('click', closeArtistMemberModal);
  $('#artistMemberModalBackdrop').addEventListener('click', (event) => {
    if (event.target === $('#artistMemberModalBackdrop')) closeArtistMemberModal();
  });

  $('#artistMemberForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#artistMemberFormId').value;
    const errorEl = $('#artistMemberFormError');
    const payload = {
      groupId: Number($('#artistMemberGroup').value),
      name: $('#artistMemberName').value,
      slug: $('#artistMemberSlug').value,
      sortOrder: Number($('#artistMemberSortOrder').value),
      isActive: $('#artistMemberIsActive').checked,
    };
    // The portrait and keychain artwork are sent with the row so a failed insert never orphans
    // an upload.
    if (artistPendingPortrait) payload.portraitUrl = artistPendingPortrait;
    else if (artistPendingPortraitRemoval) payload.portraitUrl = null;
    if (artistPendingDesign) payload.designImageUrl = artistPendingDesign;
    else if (artistPendingDesignRemoval) payload.designImageUrl = null;

    errorEl.hidden = true;
    $('#artistMemberFormSubmit').disabled = true;

    try {
      const response = await adminFetch(
        id ? `/api/admin/catalog/members/${id}` : '/api/admin/catalog/members',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Member could not be saved.');

      closeArtistMemberModal();
      await loadArtistMembers();
      showToast(id ? 'Member updated.' : 'Member created.');
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      $('#artistMemberFormSubmit').disabled = false;
    }
  });

  $('#artistMemberDelete').addEventListener('click', async () => {
    const id = $('#artistMemberFormId').value;
    if (!id) return;
    const member = artistMembers.find((row) => String(row.id) === String(id));
    const name = member ? member.name : 'this member';
    if (!window.confirm(`Delete "${name}" permanently?\n\nThis cannot be undone.`)) return;

    try {
      const response = await adminFetch(`/api/admin/catalog/members/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Member could not be deleted.');
      closeArtistMemberModal();
      await loadArtistMembers();
      showToast(`Deleted "${name}".`);
    } catch (error) {
      showToast(`Delete error: ${error.message}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Shared image helpers (group images, member portraits and keychain artwork)
  // ---------------------------------------------------------------------------
  // Only URLs produced by the upload endpoint may be used as a CSS background: the local
  // fallback directory and Cloudinary delivery URLs (used on Railway).
  const LOCAL_UPLOAD_PATH = /^\/assets\/uploads\/catalog\/[A-Za-z0-9._-]+$/;
  const CLOUDINARY_PATH = /^https:\/\/res\.cloudinary\.com\/[a-z0-9-]+\/image\/upload\/[A-Za-z0-9._~\-/]+$/;

  function safeImageUrl(url) {
    const value = String(url || '');
    return LOCAL_UPLOAD_PATH.test(value) || CLOUDINARY_PATH.test(value) ? value : '';
  }

  async function readImageFile(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      throw new Error('Choose a PNG, JPEG or WebP image.');
    }
    if (file.size > 12 * 1024 * 1024) {
      throw new Error('That image is larger than 12 MB.');
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('That file could not be read as an image.'));
        element.src = objectUrl;
      });

      const limit = 1600;
      const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

      const webp = canvas.toDataURL('image/webp', 0.85);
      return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  // ---------------------------------------------------------------------------
  // Product Setup — one global silhouette, shared base price and universal options
  // ---------------------------------------------------------------------------
  async function loadProductSettings() {
    const note = $('#productSettingsNote');
    if (note) note.textContent = 'Loading…';
    try {
      const response = await adminFetch('/api/admin/product-settings');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Product settings could not be loaded.');
      productSettings = data.product || null;
      renderProductSettings();
      if (note) note.textContent = 'These settings apply to every member immediately.';
    } catch (error) {
      productSettings = null;
      if (note) note.textContent = databaseMessage(error, 'Product settings');
    }
  }

  function renderProductSettings() {
    if (!productSettings) return;
    const select = $('#baseModelSelect');
    if (select) {
      const models = Array.isArray(productSettings.baseModels) && productSettings.baseModels.length
        ? productSettings.baseModels
        : [{ key: 'heart', label: 'Heart' }, { key: 'star', label: 'Star' }, { key: 'bow', label: 'Ribbon' }];
      select.innerHTML = models
        .map((model) => `<option value="${escapeHtml(model.key)}">${escapeHtml(model.label)}</option>`)
        .join('');
      select.value = productSettings.baseModel || 'heart';
    }
    const price = $('#basePriceInput');
    if (price) price.value = String(productSettings.basePrice ?? '');
  }

  async function saveProductSettings(event) {
    event.preventDefault();
    const button = $('#saveProductSettingsBtn');
    const note = $('#productSettingsNote');
    const payload = {
      baseModel: $('#baseModelSelect').value,
      basePrice: Number($('#basePriceInput').value),
    };
    if (!Number.isInteger(payload.basePrice) || payload.basePrice < 0) {
      showToast('Base price must be a whole number of at least 0.');
      $('#basePriceInput').focus();
      return;
    }
    button.disabled = true;
    if (note) note.textContent = 'Saving…';
    try {
      const response = await adminFetch('/api/admin/product-settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Product settings could not be saved.');
      productSettings = data.product || null;
      renderProductSettings();
      if (note) note.textContent = 'Product settings saved.';
      showToast('Product settings saved.');
      pricingOptions = [];
      await loadPricing();
    } catch (error) {
      if (note) note.textContent = error.message;
      showToast(`Product settings error: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function loadProductSetup() {
    loadProductSettings();
    if (!pricingOptions.length) loadPricing();
  }

  $('#refreshProductSettingsBtn').addEventListener('click', () => loadProductSettings());
  $('#productSettingsForm').addEventListener('submit', saveProductSettings);

  // ---------------------------------------------------------------------------
  // Studio pricing (add-ons, initial and clasp; the base price lives in Product Setup)
  // ---------------------------------------------------------------------------
  async function loadPricing() {
    const tbody = $('#pricingBody');
    const note = $('#pricingNote');
    tbody.innerHTML = '<tr><td colspan="4" class="table-loading">Loading pricing...</td></tr>';

    try {
      const response = await adminFetch('/api/admin/pricing');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Pricing could not be loaded.');
      pricingOptions = (data.options || []).filter((option) => option.category !== 'base');
      renderPricing();
      const live = pricingOptions.filter((option) => option.isActive).length;
      note.textContent = `${pricingOptions.length} options · ${live} offered in the studio. Saved prices apply to new orders immediately.`;
    } catch (error) {
      pricingOptions = [];
      tbody.innerHTML = `<tr><td colspan="4" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
      note.textContent = databaseMessage(error, 'Pricing');
    }
  }

  function renderPricing() {
    const tbody = $('#pricingBody');
    if (!pricingOptions.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No pricing options yet.</td></tr>';
      return;
    }

    const groups = [
      { key: 'addon', label: 'ADD-ONS' },
      { key: 'clasp', label: 'CLASPS' },
    ];

    let markup = '';
    for (const group of groups) {
      const rows = pricingOptions.filter((option) => option.category === group.key);
      if (!rows.length) continue;
      markup += `<tr class="pricing-group-row"><td colspan="4">${group.label}</td></tr>`;
      markup += rows.map((option) => `
        <tr data-pricing-row="${escapeHtml(option.key)}">
          <td><input type="text" class="pricing-label-input" data-pricing-label="${escapeHtml(option.key)}" value="${escapeHtml(option.label)}" maxlength="120" aria-label="Label for ${escapeHtml(option.key)}" /></td>
          <td><code class="catalog-slug">${escapeHtml(option.key)}</code></td>
          <td><input type="number" class="pricing-price-input" data-pricing-price="${escapeHtml(option.key)}" value="${option.price}" min="0" step="1000" inputmode="numeric" aria-label="Price for ${escapeHtml(option.key)}" /></td>
          <td>
            <label class="toggle-switch toggle-switch-inline">
              <input type="checkbox" data-pricing-active="${escapeHtml(option.key)}" ${option.isActive ? 'checked' : ''} aria-label="Offer ${escapeHtml(option.key)} in the studio" />
              <span class="toggle-track" aria-hidden="true"></span>
              <span class="toggle-label">${option.isActive ? 'Live' : 'Off'}</span>
            </label>
          </td>
        </tr>`).join('');
    }

    tbody.innerHTML = markup || '<tr><td colspan="4" class="table-empty">No pricing options yet.</td></tr>';
  }

  async function savePricing() {
    const button = $('#savePricingBtn');
    const note = $('#pricingNote');
    const updates = [];

    for (const option of pricingOptions) {
      const priceInput = $(`[data-pricing-price="${option.key}"]`);
      const labelInput = $(`[data-pricing-label="${option.key}"]`);
      const activeInput = $(`[data-pricing-active="${option.key}"]`);
      if (!priceInput) continue;

      const price = Number(priceInput.value);
      if (!Number.isInteger(price) || price < 0) {
        showToast(`Price for ${option.key} must be a whole number of at least 0.`);
        priceInput.focus();
        return;
      }
      updates.push({
        optionKey: option.key,
        price,
        label: labelInput ? labelInput.value : option.label,
        isActive: activeInput ? activeInput.checked : option.isActive,
      });
    }

    if (!updates.length) {
      showToast('Nothing to save.');
      return;
    }

    button.disabled = true;
    note.textContent = 'Saving prices…';
    try {
      const response = await adminFetch('/api/admin/pricing', {
        method: 'PATCH',
        body: JSON.stringify({ options: updates }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Pricing could not be saved.');
      pricingOptions = data.options || [];
      renderPricing();
      note.textContent = 'Pricing saved. New orders use these prices.';
      showToast('Pricing saved.');
    } catch (error) {
      note.textContent = error.message;
      showToast(`Pricing error: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  $('#refreshPricingBtn').addEventListener('click', () => loadPricing());
  $('#savePricingBtn').addEventListener('click', savePricing);

  // Keeps Tab inside an open dialog, so focus never lands on the page behind it.
  function trapFocusWithin(container, event) {
    if (!container || event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null || element === document.activeElement);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Escape closes the topmost overlay and returns focus to the control that opened it.
  document.addEventListener('keydown', (event) => {
    const artistGroupModalOpen = !$('#artistGroupModalBackdrop').hidden;
    const artistMemberModalOpen = !$('#artistMemberModalBackdrop').hidden;
    const bundleModalOpen = !$('#bundleModalBackdrop').hidden;
    const drawerOpen = !$('#detailDrawerBackdrop').hidden;

    if (event.key === 'Tab') {
      if (artistGroupModalOpen) trapFocusWithin($('#artistGroupModal'), event);
      else if (artistMemberModalOpen) trapFocusWithin($('#artistMemberModal'), event);
      else if (bundleModalOpen) trapFocusWithin($('#bundleModal'), event);
      else if (drawerOpen) trapFocusWithin($('#detailDrawer'), event);
      return;
    }

    if (event.key !== 'Escape') return;
    if (artistGroupModalOpen) {
      closeArtistGroupModal();
      return;
    }
    if (artistMemberModalOpen) {
      closeArtistMemberModal();
      return;
    }
    if (bundleModalOpen) {
      closeBundleModal();
      return;
    }
    if (drawerOpen) closeOrderDrawer();
  });

  // ---------------------------------------------------------------------------
  // Dashboard Startup
  // ---------------------------------------------------------------------------
  function initDashboard() {
    $('#accountingNavLink').hidden = false;
    $('#expenseDate').value = localDateInputValue();
    setActiveView('orders');
    loadMetrics();
    loadOrders();
    refreshAccounting();
    checkHealth();
    if (!accountingSummaryPoll) {
      // Skip the ten-second refresh while the tab is in the background.
      accountingSummaryPoll = setInterval(() => {
        if (document.hidden) return;
        loadCashbookSummary();
      }, 10000);
    }
  }

  // Check auth on page load
  checkHealth();
  verifyAuth();
})();
