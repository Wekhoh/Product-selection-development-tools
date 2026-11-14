import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryReturnObservation, observedDailyUnits } from '../src/observations.mjs';

test('category and selected-market return rates retain distinct fields and percent units', () => {
  const result = categoryReturnObservation({ avgReturnRatio: 4.5, returnRatio: 7 });
  assert.equal(result.value, 0.045);
  assert.equal(result.selected_market_value, 0.07);
  assert.equal(categoryReturnObservation({ returnRatio: 7 }).value, null);
  assert.equal(categoryReturnObservation({ avgReturnRatio: 0 }).value, 0);
});

test('negative daily sentinel is missing, never a negative sale or zero-filled day', () => {
  const result = observedDailyUnits([{ date: '2026-01-01', units: 5 },
    { date: '2026-01-02', units: -1 }, { date: '2026-01-03', units: null },
    { date: '2026-01-04', units: 0 }]);
  assert.equal(result.observed_units, 5);
  assert.equal(result.observed_days, 2);
  assert.equal(result.missing_days, 2);
  assert.equal(result.complete_window_units, null);
});

test('daily adapter rejects duplicate dates and does not claim calendar coverage from supplied rows', () => {
  assert.throws(() => observedDailyUnits([{ date: '2026-01-01', units: 1 }, { date: '2026-01-01', units: 2 }]), /Unique/);
  assert.throws(() => observedDailyUnits([{ date: '2026-02-31', units: 1 }]), /Unique/);
  const result = observedDailyUnits([{ date: '2026-01-01', units: 2 }]);
  assert.equal(result.complete_declared_rows, true);
  assert.equal(result.complete_window_units, null);
});
