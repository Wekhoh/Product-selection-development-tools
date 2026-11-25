/**
 * Shared ISO-8601 date and calendar-month window helpers.
 */
export function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function validIsoWindow(win) {
  return Boolean(win && validIsoDate(win.from) && validIsoDate(win.through) && win.from <= win.through);
}

export function monthsIn(fromOrWindow, through) {
  const from = typeof fromOrWindow === 'object' && fromOrWindow !== null ? fromOrWindow.from : fromOrWindow;
  const end = typeof fromOrWindow === 'object' && fromOrWindow !== null ? fromOrWindow.through : through;
  if (!validIsoDate(from) || !validIsoDate(end) || from > end) return [];
  const months = new Set();
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    months.add(m);
    if (++m > 12) {
      m = 1;
      y++;
    }
    if (months.size === 12) break;
  }
  return [...months];
}

export function monthsInIsoWindow(win) {
  return validIsoWindow(win) ? monthsIn(win.from, win.through) : [];
}

export function calendarDaysBetweenIso(earlierIso, laterIso) {
  if (!validIsoDate(earlierIso) || !validIsoDate(laterIso)) return null;
  const a = Date.parse(`${earlierIso}T00:00:00Z`);
  const b = Date.parse(`${laterIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
