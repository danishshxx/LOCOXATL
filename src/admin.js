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
  let catalogGroups = [];
  let lastFocusedElement = null;
  let pendingImageData = null;
  let pendingImageRemoval = false;

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

      const dot = $('#dbDot');
      const pillText = $('#dbPillText');
      const topStatus = $('#topDbStatus');

      if (connected) {
        dot.className = 'db-dot connected';
        pillText.textContent = 'MySQL Live';
        topStatus.textContent = 'ONLINE (MYSQL CONNECTED)';
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
    const target = ['orders', 'accounting', 'catalog'].includes(view) ? view : 'orders';
    activeView = target;

    $$('[data-view-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== target;
    });
    $$('#adminViewTabs .admin-view-tab').forEach((tab) => {
      const isActive = tab.dataset.view === target;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });

    if (target === 'catalog' && !catalogGroups.length) loadCatalogGroups();
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
  // Catalog groups
  // ---------------------------------------------------------------------------
  async function loadCatalogGroups() {
    const tbody = $('#catalogGroupsBody');
    const note = $('#catalogSourceNote');
    tbody.innerHTML = '<tr><td colspan="6" class="table-loading">Loading catalog groups...</td></tr>';

    try {
      const response = await adminFetch('/api/admin/catalog/groups');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Catalog groups could not be loaded.');
      catalogGroups = data.groups || [];
      renderCatalogGroups();
      const live = catalogGroups.filter((group) => group.isActive).length;
      note.textContent = `${catalogGroups.length} collection${catalogGroups.length === 1 ? '' : 's'} · ${live} visible on the storefront.`;
    } catch (error) {
      catalogGroups = [];
      tbody.innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
      note.textContent = 'Catalog management needs the MySQL connection. The storefront keeps using the bundled catalogue.';
    }
  }

  // Only the upload endpoint's own paths may be used as a CSS background.
  function safeImageUrl(url) {
    return /^\/assets\/uploads\/catalog\/[A-Za-z0-9._-]+$/.test(String(url || '')) ? String(url) : '';
  }

  function renderCatalogGroups() {
    const tbody = $('#catalogGroupsBody');
    if (!catalogGroups.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No catalog groups yet. Add the first collection.</td></tr>';
      return;
    }

    tbody.innerHTML = catalogGroups.map((group, index) => {
      const thumb = safeImageUrl(group.imageUrl);
      return `
      <tr data-group-row="${group.id}">
        <td class="catalog-order-cell">
          <span class="catalog-order-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="catalog-order-controls">
            <button type="button" class="icon-button catalog-move" data-move="-1" data-group-id="${group.id}" aria-label="Move ${escapeHtml(group.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-button catalog-move" data-move="1" data-group-id="${group.id}" aria-label="Move ${escapeHtml(group.name)} down" ${index === catalogGroups.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
        </td>
        <td class="customer-cell">
          <span class="catalog-group-name">
            ${thumb
              ? `<span class="catalog-thumb" style="background-image:url('${thumb}')" aria-hidden="true"></span>`
              : '<span class="catalog-thumb is-empty" aria-hidden="true">◇</span>'}
            <strong>${escapeHtml(group.name)}</strong>
          </span>
          <span>${escapeHtml(group.tagline || 'No tagline')}</span>
        </td>
        <td><code class="catalog-slug">${escapeHtml(group.slug)}</code></td>
        <td class="catalog-description-cell">${escapeHtml((group.description || '—').slice(0, 90))}</td>
        <td>
          <label class="toggle-switch toggle-switch-inline">
            <input type="checkbox" data-toggle-group="${group.id}" ${group.isActive ? 'checked' : ''} aria-label="Show ${escapeHtml(group.name)} on the storefront" />
            <span class="toggle-track" aria-hidden="true"></span>
            <span class="toggle-label">${group.isActive ? 'Live' : 'Hidden'}</span>
          </label>
        </td>
        <td>
          <button type="button" class="button button-outline button-small" data-edit-group="${group.id}">Edit</button>
        </td>
      </tr>
    `;
    }).join('');

    tbody.querySelectorAll('[data-edit-group]').forEach((button) => {
      button.addEventListener('click', () => openGroupModal(Number(button.dataset.editGroup)));
    });
    tbody.querySelectorAll('[data-toggle-group]').forEach((input) => {
      input.addEventListener('change', () => toggleGroup(Number(input.dataset.toggleGroup), input.checked));
    });
    tbody.querySelectorAll('[data-move]').forEach((button) => {
      button.addEventListener('click', () => moveGroup(Number(button.dataset.groupId), Number(button.dataset.move)));
    });
  }

  async function toggleGroup(id, isActive) {
    try {
      const response = await adminFetch(`/api/admin/catalog/groups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Collection could not be updated.');
      await loadCatalogGroups();
      showToast(isActive ? 'Collection published to the storefront.' : 'Collection hidden from the storefront.');
    } catch (error) {
      showToast(`Catalog error: ${error.message}`);
      await loadCatalogGroups();
    }
  }

  async function moveGroup(id, direction) {
    const index = catalogGroups.findIndex((group) => group.id === id);
    if (index < 0) return;
    const neighbour = catalogGroups[index + direction];
    if (!neighbour) return;

    const current = catalogGroups[index];
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
      await loadCatalogGroups();
    } catch (error) {
      showToast(`Reorder error: ${error.message}`);
    }
  }

  function openGroupModal(groupId) {
    const group = groupId ? catalogGroups.find((row) => row.id === groupId) : null;
    $('#groupFormError').hidden = true;
    $('#groupForm').reset();
    $('#groupFormId').value = group ? String(group.id) : '';
    $('#groupName').value = group ? group.name : '';
    $('#groupSlug').value = group ? group.slug : '';
    $('#groupTagline').value = group ? group.tagline : '';
    $('#groupDescription').value = group ? group.description : '';
    $('#groupSortOrder').value = String(group ? group.sortOrder : catalogGroups.length);
    $('#groupIsActive').checked = group ? Boolean(group.isActive) : true;
    $('#groupModalEyebrow').textContent = group ? 'EDIT COLLECTION' : 'NEW COLLECTION';
    $('#groupModalTitle').textContent = group ? group.name : 'Add group';
    $('#groupFormSubmit').textContent = group ? 'Save changes' : 'Create group';

    pendingImageData = null;
    pendingImageRemoval = false;
    $('#groupImageInput').value = '';
    $('#groupImageNote').textContent = '';
    $('#groupImageNote').hidden = true;
    renderGroupImagePreview(group ? group.imageUrl : '');

    lastFocusedElement = document.activeElement;
    $('#groupModalBackdrop').hidden = false;
    $('#groupName').focus();
  }

  function renderGroupImagePreview(source) {
    const preview = $('#groupImagePreview');
    const thumb = $('#groupImageThumb');
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

  /**
   * Downscales the chosen photo in the browser before upload: the server only ever receives a
   * validated, reasonably sized WebP/JPEG data URL.
   */
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

  $('#groupImageInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    const note = $('#groupImageNote');
    if (!file) return;

    note.hidden = false;
    note.textContent = 'Preparing image…';

    try {
      pendingImageData = await readImageFile(file);
      pendingImageRemoval = false;
      renderGroupImagePreview(pendingImageData);
      const kilobytes = Math.round((pendingImageData.length * 0.75) / 1024);
      note.textContent = `Ready to upload · about ${kilobytes} KB after resizing.`;
    } catch (error) {
      pendingImageData = null;
      note.textContent = error.message;
      $('#groupImageInput').value = '';
    }
  });

  $('#groupImageRemove').addEventListener('click', () => {
    pendingImageData = null;
    pendingImageRemoval = true;
    $('#groupImageInput').value = '';
    renderGroupImagePreview('');
    const note = $('#groupImageNote');
    note.textContent = 'The image will be removed when you save.';
    note.hidden = false;
  });

  function closeGroupModal() {
    $('#groupModalBackdrop').hidden = true;
    pendingImageData = null;
    pendingImageRemoval = false;
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();
    lastFocusedElement = null;
  }

  $('#addGroupBtn').addEventListener('click', () => openGroupModal(null));
  $('#refreshCatalogBtn').addEventListener('click', () => loadCatalogGroups());
  $('#groupModalClose').addEventListener('click', closeGroupModal);
  $('#groupFormCancel').addEventListener('click', closeGroupModal);
  $('#groupModalBackdrop').addEventListener('click', (event) => {
    if (event.target === $('#groupModalBackdrop')) closeGroupModal();
  });

  $('#groupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#groupFormId').value;
    const errorEl = $('#groupFormError');
    const payload = {
      name: $('#groupName').value,
      slug: $('#groupSlug').value,
      tagline: $('#groupTagline').value,
      description: $('#groupDescription').value,
      sortOrder: Number($('#groupSortOrder').value),
      isActive: $('#groupIsActive').checked,
    };

    errorEl.hidden = true;
    $('#groupFormSubmit').disabled = true;

    try {
      const response = await adminFetch(
        id ? `/api/admin/catalog/groups/${id}` : '/api/admin/catalog/groups',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Collection could not be saved.');

      const saved = data.group;
      if (pendingImageData && saved) {
        const imageResponse = await adminFetch(`/api/admin/catalog/groups/${saved.id}/image`, {
          method: 'POST',
          body: JSON.stringify({ dataUrl: pendingImageData }),
        });
        const imageBody = await imageResponse.json().catch(() => ({}));
        if (!imageResponse.ok) throw new Error(imageBody.message || 'The card image could not be uploaded.');
      } else if (pendingImageRemoval && saved) {
        const imageResponse = await adminFetch(`/api/admin/catalog/groups/${saved.id}/image`, { method: 'DELETE' });
        if (!imageResponse.ok) {
          const imageBody = await imageResponse.json().catch(() => ({}));
          throw new Error(imageBody.message || 'The card image could not be removed.');
        }
      }

      closeGroupModal();
      await loadCatalogGroups();
      showToast(id ? 'Collection updated.' : 'Collection created.');
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      $('#groupFormSubmit').disabled = false;
    }
  });

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
    const groupModalOpen = !$('#groupModalBackdrop').hidden;
    const drawerOpen = !$('#detailDrawerBackdrop').hidden;

    if (event.key === 'Tab') {
      if (groupModalOpen) trapFocusWithin($('#groupModal'), event);
      else if (drawerOpen) trapFocusWithin($('#detailDrawer'), event);
      return;
    }

    if (event.key !== 'Escape') return;
    if (groupModalOpen) {
      closeGroupModal();
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
