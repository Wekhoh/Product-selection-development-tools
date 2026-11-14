/** Small adapters for two observed provider ambiguities. No retrieval or scoring. */
const finite = n => typeof n === 'number' && Number.isFinite(n);

export function categoryReturnObservation(ratioComparison) {
  const valid = n => finite(n) && n >= 0 && n <= 100;
  const average = ratioComparison?.avgReturnRatio;
  const selected = ratioComparison?.returnRatio;
  return {
    value: valid(average) ? average / 100 : null,
    unit: 'fraction',
    source_field: 'ratioComparison.avgReturnRatio',
    selected_market_value: valid(selected) ? selected / 100 : null,
    selected_market_field: 'ratioComparison.returnRatio',
    reason: valid(average) ? 'Category-average percentage converted once.'
      : 'Category average is unavailable; selected-market return rate is not substituted.',
  };
}

export function observedDailyUnits(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('Nonempty declared daily observations required');
  const dates = new Set();
  let observed = 0, missing = 0;
  for (const row of rows) {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date ||
      dates.has(row.date)) throw new TypeError('Unique valid daily dates required');
    dates.add(row.date);
    if (row.units === null || row.units === -1) { missing++; continue; }
    if (!finite(row.units) || row.units < 0) throw new TypeError('Units must be nonnegative or the declared null/-1 missing sentinel');
    observed += row.units;
    if (!Number.isFinite(observed)) throw new TypeError('Unit total exceeds finite numeric range');
  }
  return { observed_units: observed, observed_days: rows.length - missing, missing_days: missing,
    declared_days: rows.length, complete_declared_rows: missing === 0,
    // Completeness applies only to supplied rows, not an unobserved calendar window.
    complete_window_units: null };
}
