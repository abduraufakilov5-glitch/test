export function toMinorUnits(amount) {
  const raw = String(amount ?? '').trim().replace(',', '.');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) return 0;
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -minor : minor;
}
export function fromMinorUnits(minor) { return minor / 100; }
export function formatMoneyMinor(minor, opts = {}) { return formatMoney(fromMinorUnits(minor), opts); }
export function formatMoney(value, { showSign = false, suffix = 'сом.' } = {}) {
  const minor = toMinorUnits(value);
  const abs = Math.abs(minor);
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: abs % 100 ? 2 : 0, maximumFractionDigits: 2,
  }).format(abs / 100);
  const sign = minor < 0 ? '-' : (showSign && minor > 0 ? '+' : '');
  return `${sign}${formatted} ${suffix}`;
}
export function formatDate(dateStr) {
  if (!dateStr) return '';
  const value = String(dateStr).slice(0, 10);
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function debounce(fn, delay = 250) {
  let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}
export function escapeHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
export function downloadTextFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csvField(value) {
  const str = String(value ?? '');
  return /[",\n\r;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
export function newUuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
export function normalizePersonSearch(value) { return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru'); }
