const ExcelJS = require('exceljs');
const { getPool } = require('./db');
const { resolveDateRange, getCashbookSummary, getReportData } = require('./cashbook');

const IDR_FORMAT = '"Rp" #,##0;[Red]("Rp" #,##0)';
const DATE_FORMAT = 'dd mmm yyyy';
const DATETIME_FORMAT = 'dd mmm yyyy hh:mm';
const SCOPE_SHEETS = {
  summary: 0,
  orders: 1,
  income: 2,
  expenses: 3,
  cashbook: 4,
};

function reportError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function parseScope(scope) {
  const value = String(scope || 'summary').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SCOPE_SHEETS, value)) {
    throw reportError('invalid_scope', 'scope must be summary, orders, income, expenses, or cashbook.');
  }
  return value;
}

async function getReportSummary(filters = {}) {
  const dateRange = resolveDateRange(filters);
  const pool = getPool();
  const [statusRows] = await pool.execute(
    `SELECT order_status, COUNT(*) AS order_count, COALESCE(SUM(total_amount), 0) AS order_value
     FROM orders
     WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
     GROUP BY order_status`,
    [dateRange.from, dateRange.to],
  );
  const orders = { count: 0, orderValue: 0, countsByStatus: {} };
  statusRows.forEach((row) => {
    const count = Number(row.order_count) || 0;
    orders.count += count;
    orders.orderValue += Number(row.order_value) || 0;
    orders.countsByStatus[row.order_status] = count;
  });
  const cashbook = await getCashbookSummary(dateRange);
  return { dateRange, orders, cashbook };
}

function excelDate(value, dateOnly = false) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return String(value);
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    dateOnly ? 0 : Number(match[4] || 0),
    dateOnly ? 0 : Number(match[5] || 0),
    dateOnly ? 0 : Number(match[6] || 0),
  ));
}

function safeCell(value) {
  if (typeof value !== 'string') return value == null ? '' : value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function addReportSheet(workbook, {
  name,
  title,
  dateRange,
  columns,
  rows,
  totalLabel = 'TOTAL',
  totalColumn = null,
  totalValue = null,
}) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.columns = columns.map((column) => ({ key: column.key, width: column.width || 18 }));
  worksheet.mergeCells(1, 1, 1, columns.length);
  worksheet.getCell(1, 1).value = title;
  worksheet.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111111' } };
  worksheet.getRow(1).height = 28;
  worksheet.mergeCells(2, 1, 2, columns.length);
  worksheet.getCell(2, 1).value = `Period: ${dateRange.from} to ${dateRange.to}`;
  worksheet.getCell(2, 1).font = { italic: true, color: { argb: 'FF666666' } };
  const header = worksheet.addRow(columns.map((column) => column.header));
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF333333' } };
    cell.alignment = { vertical: 'middle' };
  });

  rows.forEach((row) => {
    const excelRow = worksheet.addRow(columns.map((column) => safeCell(row[column.key])));
    columns.forEach((column, index) => {
      if (column.kind === 'currency') excelRow.getCell(index + 1).numFmt = IDR_FORMAT;
      if (column.kind === 'date') excelRow.getCell(index + 1).value = excelDate(row[column.key], true);
      if (column.kind === 'datetime') excelRow.getCell(index + 1).value = excelDate(row[column.key]);
    });
  });

  if (totalColumn !== null) {
    const values = Array(columns.length).fill('');
    values[0] = totalLabel;
    values[totalColumn] = totalValue;
    const totalRow = worksheet.addRow(values);
    totalRow.font = { bold: true };
    totalRow.getCell(totalColumn + 1).numFmt = IDR_FORMAT;
    totalRow.eachCell((cell) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FF111111' } } };
    });
  }

  worksheet.views = [{ state: 'frozen', ySplit: 3 }];
  worksheet.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: rows.length + 3, column: columns.length },
  };
  return worksheet;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

async function createReportWorkbook(filters = {}) {
  const scope = parseScope(filters.scope);
  const dateRange = resolveDateRange(filters);
  const [report, cashbookSummary] = await Promise.all([
    getReportData(dateRange),
    getCashbookSummary(dateRange),
  ]);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LOCOXATL Admin Dashboard';
  workbook.created = new Date();
  workbook.modified = new Date();

  const orderTotal = sum(report.orders, 'total');
  const summaryRows = [
    { metric: 'Current cash balance', amount: cashbookSummary.totals.balance, detail: 'All effective cashbook records' },
    { metric: 'All-time income', amount: cashbookSummary.totals.income, detail: 'Verified order payments' },
    { metric: 'All-time expenses', amount: cashbookSummary.totals.expenses, detail: 'Effective expense records' },
    { metric: 'Range income', amount: report.totals.income, detail: `${dateRange.from} to ${dateRange.to}` },
    { metric: 'Range expenses', amount: report.totals.expenses, detail: `${dateRange.from} to ${dateRange.to}` },
    { metric: 'Range cash flow', amount: report.totals.balance, detail: 'Range income less expenses' },
    { metric: 'Today income', amount: cashbookSummary.periods.daily.income, detail: 'Current server date' },
    { metric: 'Today expenses', amount: cashbookSummary.periods.daily.expenses, detail: 'Current server date' },
    { metric: 'This week income', amount: cashbookSummary.periods.weekly.income, detail: 'Monday through current date' },
    { metric: 'This week expenses', amount: cashbookSummary.periods.weekly.expenses, detail: 'Monday through current date' },
    { metric: 'This month income', amount: cashbookSummary.periods.monthly.income, detail: 'Current calendar month' },
    { metric: 'This month expenses', amount: cashbookSummary.periods.monthly.expenses, detail: 'Current calendar month' },
    { metric: 'This year income', amount: cashbookSummary.periods.yearly.income, detail: 'Current calendar year' },
    { metric: 'This year expenses', amount: cashbookSummary.periods.yearly.expenses, detail: 'Current calendar year' },
    { metric: 'Orders in range', amount: report.orders.length, detail: 'Includes unpaid orders; not counted as income' },
    { metric: 'Order value in range', amount: orderTotal, detail: 'Gross order value; not cashbook income' },
  ];
  const summarySheet = addReportSheet(workbook, {
    name: 'Summary',
    title: 'LOCOXATL Financial Summary',
    dateRange,
    columns: [
      { key: 'metric', header: 'Metric', width: 30 },
      { key: 'amount', header: 'Amount / Count', width: 22, kind: 'currency' },
      { key: 'detail', header: 'Notes', width: 48 },
    ],
    rows: summaryRows,
  });
  summaryRows.forEach((row, index) => {
    if (row.metric === 'Orders in range') summarySheet.getCell(index + 4, 2).numFmt = '0';
  });
  summarySheet.getCell(4, 2).numFmt = IDR_FORMAT;

  addReportSheet(workbook, {
    name: 'Orders',
    title: 'LOCOXATL Orders',
    dateRange,
    columns: [
      { key: 'orderNumber', header: 'Order Number', width: 22 },
      { key: 'createdAt', header: 'Order Date', width: 20, kind: 'datetime' },
      { key: 'customerName', header: 'Customer', width: 26 },
      { key: 'email', header: 'Email', width: 30 },
      { key: 'phone', header: 'Phone', width: 18 },
      { key: 'status', header: 'Status', width: 26 },
      { key: 'total', header: 'Order Value (IDR)', width: 22, kind: 'currency' },
      { key: 'paymentVerifiedAt', header: 'Payment Verified', width: 20, kind: 'datetime' },
    ],
    rows: report.orders,
    totalColumn: 6,
    totalValue: orderTotal,
  });

  const incomeRows = report.entries.filter((entry) => entry.entryType === 'income');
  addReportSheet(workbook, {
    name: 'Income',
    title: 'LOCOXATL Verified Income',
    dateRange,
    columns: [
      { key: 'transactionDate', header: 'Date', width: 16, kind: 'date' },
      { key: 'category', header: 'Category', width: 25 },
      { key: 'description', header: 'Description', width: 42 },
      { key: 'paymentMethod', header: 'Payment Method', width: 22 },
      { key: 'orderNumber', header: 'Order Number', width: 22 },
      { key: 'amount', header: 'Income (IDR)', width: 20, kind: 'currency' },
    ],
    rows: incomeRows,
    totalColumn: 5,
    totalValue: sum(incomeRows, 'amount'),
  });

  const expenseRows = report.entries.filter((entry) => entry.entryType === 'expense');
  addReportSheet(workbook, {
    name: 'Expenses',
    title: 'LOCOXATL Expenses',
    dateRange,
    columns: [
      { key: 'transactionDate', header: 'Date', width: 16, kind: 'date' },
      { key: 'category', header: 'Category', width: 25 },
      { key: 'description', header: 'Description', width: 42 },
      { key: 'paymentMethod', header: 'Payment Method', width: 22 },
      { key: 'notes', header: 'Notes', width: 40 },
      { key: 'amount', header: 'Expense (IDR)', width: 20, kind: 'currency' },
    ],
    rows: expenseRows,
    totalColumn: 5,
    totalValue: sum(expenseRows, 'amount'),
  });

  addReportSheet(workbook, {
    name: 'Cashbook',
    title: 'LOCOXATL Cashbook',
    dateRange,
    columns: [
      { key: 'transactionDate', header: 'Date', width: 16, kind: 'date' },
      { key: 'entryType', header: 'Type', width: 14 },
      { key: 'category', header: 'Category', width: 25 },
      { key: 'description', header: 'Description', width: 42 },
      { key: 'paymentMethod', header: 'Payment Method', width: 22 },
      { key: 'orderNumber', header: 'Order Number', width: 22 },
      { key: 'amount', header: 'Amount (IDR)', width: 20, kind: 'currency' },
    ],
    rows: report.entries,
    totalLabel: 'NET CASH FLOW',
    totalColumn: 6,
    totalValue: report.totals.balance,
  });

  workbook.views = [{ activeTab: SCOPE_SHEETS[scope], firstSheet: 0, visibility: 'visible' }];
  return workbook.xlsx.writeBuffer();
}

module.exports = { createReportWorkbook, getReportSummary, parseScope };
