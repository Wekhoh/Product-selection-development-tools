import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKeepaPeerFactsForMarketJudge,
  parseSellerSpriteKeepaPayload,
} from '../src/adapters/index.mjs';

test('keepa adapter: timestamped 1-year & 90d curves preserve ts/missing calendar days, separate price vs buybox, and distinguish observed_all_null from field_not_returned', () => {
  // Synthetic 1-year veteran curve with 1 missing calendar day (2026-02-06 missing, 2026-02-05 null on price while buybox stays 79.99)
  const ts = [
    '2026-02-03',
    '2026-02-04',
    '2026-02-05',
    // 2026-02-07 skips 2026-02-06!
    ...Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 1, 7 + i));
      return d.toISOString().slice(0, 10);
    }),
    ...Array.from({ length: 20 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 9 + i));
      return d.toISOString().slice(0, 10);
    }),
  ];
  const priceArr = [79.99, 79.99, null, ...Array(30).fill(79.99), ...Array(20).fill(59.99)];
  const buyboxArr = [79.99, 79.99, 79.99, ...Array(30).fill(79.99), ...Array(20).fill(59.99)];
  const nullCoupons = Array(ts.length).fill(null);

  const envelope = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          code: 'OK',
          data: {
            asin: 'B0SYNVET01',
            keepa_trend: {
              ts,
              series: {
                price: priceArr,
                buybox: buyboxArr,
                couponHistory: nullCoupons,
                oneTimeCouponHistory: nullCoupons,
              },
            },
          },
        }),
      },
    ],
  };

  const parsed = parseSellerSpriteKeepaPayload(envelope, { age_days: 420 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.asin, 'B0SYNVET01');
  assert.equal(parsed.shape, 'timestamped_keepa_curve');
  assert.equal(parsed.has_timestamps, true);
  assert.equal(parsed.date_window.sampled_days, 53);
  assert.equal(parsed.date_window.calendar_span_days, 54);
  assert.deepEqual(parsed.date_window.missing_calendar_dates, ['2026-02-06']);
  assert.equal(parsed.current_price_usd, 59.99);
  assert.equal(parsed.current_price_source, 'buybox');
  assert.equal(parsed.price_series.price.high, 79.99);
  assert.equal(parsed.price_series.price.low, 59.99);
  assert.equal(parsed.price_series.price.null_count, 1);
  assert.equal(parsed.price_series.priceList.field_status, 'field_not_returned');
  assert.equal(parsed.coupon_series.couponHistory.field_status, 'observed_all_null');
  assert.equal(parsed.coupon_status, 'none_observed');
  assert.equal(parsed.sustained_drop_or_clearance_watch, false, 'Couponless curve must NEVER repurpose the 20% single-coupon threshold as a clearance drop cutoff');
  assert.equal(parsed.is_brief_tail_dip, true);
  assert.equal(parsed.keepa_90d_steady, false, 'Two-level 90d curve requires qualitative MarketObservationJudge rather than auto-steady');

  // Verify true 365-day curve slicing: 270 days at $39.00 followed by trailing 90 days at $59.00 -> 90d median MUST be $59.00!
  const ts360 = Array.from({ length: 360 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 11, 1 + i));
    return d.toISOString().slice(0, 10);
  });
  const prices360 = [...Array(270).fill(39.00), ...Array(90).fill(59.00)];
  const parsed360 = parseSellerSpriteKeepaPayload({
    asin: 'B0SYN360D1',
    keepa_trend: {
      ts: ts360,
      series: { price: prices360 },
    },
  }, { age_days: 400 });
  assert.equal(parsed360.keepa_90d_median_usd, 59.00, '90-day median must slice trailing 90 calendar days ($59), not full 360-day median ($39)');
  assert.equal(parsed360.full_window_median_usd, 39.00);
  assert.equal(parsed360.keepa_90d_steady, true);
  const facts360 = buildKeepaPeerFactsForMarketJudge(parsed360);
  assert.equal(facts360.keepa_90d_median_usd, 59.00);
  assert.equal(facts360.keepa_90d_low_usd, 59.00);
  assert.equal(facts360.keepa_90d_high_usd, 59.00);
});

test('keepa adapter: undated compact curve never lets 1-point buybox overwrite 92-point price and flags 3-sample tail dip without granting steady plateau', () => {
  // Mirrors the exact structure caught in Step 3A: 92 undated price samples ($39.99 dominant 66/92, 3 tail pts at $32.29) + 1-point undated buybox [42.99]
  const price92 = [
    ...Array(3).fill(42.99),
    ...Array(17).fill(39.99),
    ...Array(4).fill(35.99),
    ...Array(23).fill(39.99),
    ...Array(2).fill(35.99),
    ...Array(6).fill(39.99),
    ...Array(13).fill(42.99),
    ...Array(20).fill(39.99),
    42.99,
    ...Array(3).fill(32.29),
  ];
  assert.equal(price92.length, 92);

  const parsed = parseSellerSpriteKeepaPayload({
    asin: 'B0SYNPAINT',
    series: {
      price: price92,
      buybox: [42.99],
      priceList: [42.99],
    },
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.shape, 'undated_compact_curve');
  assert.equal(parsed.has_timestamps, false);
  assert.equal(parsed.date_window, null);
  assert.equal(parsed.current_price_usd, 32.29, '1-point buybox must NEVER overwrite 92-point price latest value');
  assert.equal(parsed.current_price_source, 'price');
  assert.equal(parsed.regular_median_usd, null, 'Undated curve must not claim a dated 90d median');
  assert.equal(parsed.undated_sample_median_usd, 39.99);
  assert.equal(parsed.dominant_plateau_usd, 39.99);
  assert.equal(parsed.dominant_plateau_samples, 66);
  assert.equal(parsed.is_brief_tail_dip, true);
  assert.equal(parsed.keepa_90d_steady, false, 'Undated 3-sample tail dip must NOT be marked keepa_90d_steady');
  assert.equal(parsed.coupon_status, 'unknown_not_returned', 'Unreturned coupon series must report unknown_not_returned, never none_observed');

  const judgeFacts = buildKeepaPeerFactsForMarketJudge(parsed);
  assert.equal(judgeFacts.current_price_usd, 32.29);
  assert.equal(judgeFacts.keepa_90d_median_usd, null);
  assert.equal(judgeFacts.undated_sample_median_usd, 39.99);
  assert.equal(judgeFacts.coupon_status, 'unknown_not_returned');

  // Package-only snapshot must NOT throw TypeError in buildKeepaPeerFactsForMarketJudge
  const pkgOnly = parseSellerSpriteKeepaPayload({
    asin: 'B0SYNPKG01',
    pkgDimensionsSize: '12.0 x 8.0 x 3.0 in',
    pkgWeightGram: 907.18,
  });
  assert.equal(pkgOnly.ok, true);
  assert.equal(pkgOnly.status, 'package_snapshot_only');
  const pkgOnlyFacts = buildKeepaPeerFactsForMarketJudge(pkgOnly);
  assert.equal(pkgOnlyFacts.asin, 'B0SYNPKG01');
  assert.equal(pkgOnlyFacts.keepa_90d_steady, false);
  assert.equal(pkgOnlyFacts.package_snapshot.length_in, 12);
});

test('keepa adapter: classifies <20% routine vs >=20% heavy coupons, review drop/jump events, and Keepa package snapshots', () => {
  const ts = Array.from({ length: 20 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 1 + i));
    return d.toISOString().slice(0, 10);
  });
  const reviews = [
    ...Array(8).fill(49),
    46, // review drop (-3)
    49,
    ...Array(5).fill(49),
    56, // review jump (+7, >10%)
    ...Array(4).fill(56),
  ];
  const heavyCouponPayload = {
    asin: 'B0SYNCOUP1',
    pkgDimensionsSize: '18.2 x 11.4 x 7.6 in',
    pkgWeightGram: 1814.37,
    fbaFees: 8.02,
    keepa_trend: {
      ts,
      series: {
        price: Array(20).fill(50.00),
        priceList: Array(20).fill(50.00),
        couponHistory: [...Array(18).fill(null), '25%', '25%'],
        reviews,
      },
    },
  };

  const parsedHeavy = parseSellerSpriteKeepaPayload(heavyCouponPayload, { age_days: 65 });
  assert.equal(parsedHeavy.coupon_status, 'heavy_ge_20pct');
  assert.equal(parsedHeavy.max_coupon_discount_fraction, 0.25);
  assert.equal(parsedHeavy.review_trajectory.has_drop_event, true);
  assert.equal(parsedHeavy.review_trajectory.has_jump_event, true);
  assert.equal(parsedHeavy.review_trajectory.newcomer_review_anomaly_hint, true);
  assert.equal(parsedHeavy.package_snapshot.length_in, 18.2);
  assert.equal(parsedHeavy.package_snapshot.unit_weight_lb, 4);

  const routineCouponPayload = {
    asin: 'B0SYNCOUP2',
    keepa_trend: {
      ts,
      series: {
        price: Array(20).fill(50.00),
        couponHistory: [...Array(19).fill(null), '10%'],
      },
    },
  };
  const parsedRoutine = parseSellerSpriteKeepaPayload(routineCouponPayload, { age_days: 200 });
  assert.equal(parsedRoutine.coupon_status, 'routine_under_20pct');
});
