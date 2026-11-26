import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FBA_2027_DEFAULT_INBOUND_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  estimateGate1A2027,
  lookupUnifiedReturnsProcessing2027,
  lookupVerified2027PerReturnFee,
  validateFeeBasis,
} from '../src/fba-calculator.mjs';
import { calculateEconomics, evaluateEarlyScreen } from '../src/economics.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function makeApparelLedger({ pkg, perReturnFeeUsd, physicalReturnFraction = 0.10, effectiveFrom = '2027-01-15' }) {
  const returnsUsd = Math.round((physicalReturnFraction * perReturnFeeUsd + Number.EPSILON) * 1e10) / 1e10;
  const price = 34.99;
  const netRevenue = price * (1 - physicalReturnFraction);
  const netRef = price * 0.17 * (1 - physicalReturnFraction) + price * 0.17 * physicalReturnFraction * 0.20;
  const disbursement = netRevenue - netRef - 4.09 - 0.16 - 0.03 - returnsUsd;
  const collectionUsd = Math.round((disbursement * 0.006 + Number.EPSILON) * 1e10) / 1e10;
  return {
    id: 'sc-apparel-4oz',
    saleable_unit: '1 synthetic garment',
    assumptions: ['Synthetic apparel returns single-table test'],
    price_usd: price,
    refund_fraction: physicalReturnFraction,
    physical_return_fraction: physicalReturnFraction,
    is_apparel_or_shoes: true,
    fee_category: 'Apparel',
    order_units: 100,
    fx_cny_per_usd: 7.2,
    collection_rate: 0.006,
    packages: [{ id: 'pkg-apparel', ...pkg }],
    fee_context: {
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'pkg-apparel',
      sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
      storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
      inbound: FBA_2027_DEFAULT_INBOUND_WINDOW,
    },
    referral_terms: {
      referral_fraction: 0.17,
      refund_admin_fraction: 0.20,
      refund_admin_cap_usd: 5.00,
    },
    lines: [
      { id: 'procurement', status: 'sourced', basis: 'Synthetic 100-set quote', amount_usd: 6.00, order_units: 100, first_order_promotion: false, components: ['procurement'], evidence: ['ev-1'] },
      { id: 'domestic_freight', status: 'sourced', basis: 'Synthetic domestic delivery', amount_usd: 0.20, order_units: 100, first_order_promotion: false, components: ['domestic_freight'], evidence: ['ev-1'] },
      { id: 'headhaul', status: 'sourced', basis: 'Synthetic ocean headhaul with bond', amount_usd: 1.00, components: ['headhaul', 'carrier_bond'], evidence: ['ev-1'] },
      {
        id: 'referral',
        status: 'estimated',
        basis: '2027 US Apparel 17% referral net of refund admin',
        amount_usd: Number(netRef.toFixed(10)),
        components: ['referral'],
        evidence: ['ev-1'],
        fee_basis: {
          status: 'published',
          version: 'US-REF-2027-v1',
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pkg-apparel',
          effective_from: '2027-01-15',
          effective_through: '2027-12-31',
          evidence: ['ev-1'],
        },
      },
      {
        id: 'fulfillment',
        status: 'estimated',
        basis: '2027 US Apparel Small Standard FBA fulfillment',
        amount_usd: 4.09,
        components: ['fulfillment'],
        evidence: ['ev-1'],
        fee_basis: {
          status: 'published',
          version: 'US-FBA-2027-nonpeak-complete-v2',
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pkg-apparel',
          effective_from: '2027-01-15',
          effective_through: '2027-10-14',
          evidence: ['ev-1'],
        },
      },
      {
        id: 'placement',
        status: 'estimated',
        basis: '2027 US Small Standard placement',
        amount_usd: 0.16,
        components: ['placement'],
        evidence: ['ev-1'],
        fee_basis: {
          status: 'published',
          version: 'US-FBA-2027-nonpeak-standard-v1',
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pkg-apparel',
          effective_from: '2027-01-15',
          effective_through: '2027-12-31',
          evidence: ['ev-1'],
        },
      },
      {
        id: 'storage',
        status: 'estimated',
        basis: '2027 US off-peak storage',
        amount_usd: 0.03,
        components: ['storage'],
        evidence: ['ev-1'],
        fee_basis: {
          status: 'published',
          version: 'US-FBA-2027-nonpeak-standard-v1',
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pkg-apparel',
          effective_from: '2027-02-01',
          effective_through: '2027-09-30',
          evidence: ['ev-1'],
        },
      },
      {
        id: 'returns_processing',
        status: 'estimated',
        basis: '2027 US Apparel returns processing',
        amount_usd: returnsUsd,
        components: ['returns_processing'],
        evidence: ['ev-1'],
        per_return_fee_usd: perReturnFeeUsd,
        fee_basis: {
          status: 'published',
          version: 'US-FBA-2027-nonpeak-complete-v2',
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pkg-apparel',
          effective_from: effectiveFrom,
          effective_through: '2027-12-31',
          per_return_fee_usd: perReturnFeeUsd,
          evidence: ['ev-1'],
        },
      },
      {
        id: 'returns_disposal',
        status: 'deferred',
        basis: 'Deferred paired initial return assumption',
        amount_usd: null,
        components: ['returns_disposal'],
        evidence: ['ev-1'],
      },
      {
        id: 'recovery_credit',
        status: 'deferred',
        basis: 'Deferred paired initial return assumption',
        amount_usd: null,
        components: ['recovery_credit'],
        evidence: ['ev-1'],
      },
      {
        id: 'collection',
        status: 'estimated',
        basis: '0.6% payout collection',
        amount_usd: collectionUsd,
        rate_fraction: 0.006,
        components: ['collection'],
        evidence: ['ev-1'],
      },
      {
        id: 'other_applicable',
        status: 'not_applicable',
        basis: 'No other applicable fees',
        amount_usd: 0,
        components: ['other_applicable'],
        evidence: ['ev-1'],
        fee_basis: {
          status: 'published',
          version: 'US-FBA-2027-nonpeak-complete-v2',
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pkg-apparel',
          effective_from: '2027-01-15',
          effective_through: '2027-12-31',
          evidence: ['ev-1'],
        },
      },
    ],
  };
}

function makeApparelEarlyScreenInput({ pkg, perReturnFeeUsd, physicalReturnFraction = 0.10 }) {
  return {
    profile_revision: 59,
    saleable_unit: '1 synthetic garment',
    price_usd: 34.99,
    specific_rights_conflict: false,
    strong_date_dependency: false,
    fx_cny_per_usd: 7.2,
    order_units: 100,
    first_order_promotion: false,
    goods_cny_per_unit: 43.2,
    domestic_freight_cny_per_unit: 1.44,
    refund_fraction: physicalReturnFraction,
    physical_return_fraction: physicalReturnFraction,
    is_apparel_or_shoes: true,
    fee_category: 'Apparel',
    pkg,
    packages: [{ id: 'pkg-apparel', ...pkg }],
    evidence_ids: ['ev-1'],
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
    fee_context: {
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'pkg-apparel',
      sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
      storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
      inbound: FBA_2027_DEFAULT_INBOUND_WINDOW,
    },
    referral_terms: {
      referral_fraction: 0.17,
      refund_admin_fraction: 0.20,
      refund_admin_cap_usd: 5.00,
    },
    fulfillment_usd: 4.09,
    placement_usd: 0.16,
    storage_usd: 0.03,
    headhaul_usd: 1.00,
    collection_rate: 0.006,
    other_applicable_usd: 0,
    per_return_fee_usd: perReturnFeeUsd,
    returns_processing_fee_basis: {
      status: 'published',
      version: 'US-FBA-2027-nonpeak-complete-v2',
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'pkg-apparel',
      effective_from: '2027-01-15',
      effective_through: '2027-12-31',
      per_return_fee_usd: perReturnFeeUsd,
      evidence: ['ev-1'],
    },
  };
}

test('official 2027 Apparel returns rates (4.00 oz = $1.65, 4.01 oz = $1.75) stay consistent across forward estimation and ledger verification while preserving applicability checks', () => {
  const pkg4oz = { length_in: 10, width_in: 8, height_in: 0.5, unit_weight_oz: 4.00 };
  const pkg401oz = { length_in: 10, width_in: 8, height_in: 0.5, unit_weight_oz: 4.01 };

  // Forward estimation
  const est4 = lookupUnifiedReturnsProcessing2027({
    pkg: pkg4oz,
    physical_return_fraction: 0.10,
    is_apparel_or_shoes: true,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  const est401 = lookupUnifiedReturnsProcessing2027({
    pkg: pkg401oz,
    physical_return_fraction: 0.10,
    is_apparel_or_shoes: true,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(est4.status, 'verified');
  assert.equal(est4.per_return_fee_usd, 1.65);
  assert.equal(est401.status, 'verified');
  assert.equal(est401.per_return_fee_usd, 1.75);

  const g1a4 = estimateGate1A2027({
    pkg: pkg4oz,
    price_usd: 34.99,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.10,
    physical_return_fraction: 0.10,
    is_apparel: true,
    fee_category: 'Apparel',
    referral_terms: { referral_fraction: 0.17, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
    headhaul_usd: 1.00,
    collection_rate: 0.006,
    other_applicable_usd: 0,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
    storage_window: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
    inbound_window: FBA_2027_DEFAULT_INBOUND_WINDOW,
  });
  assert.equal(g1a4.status, 'verified');
  assert.equal(g1a4.components.returns_processing.per_return_fee_usd, 1.65);

  // Ledger verification & direct helper
  assert.equal(lookupVerified2027PerReturnFee(pkg4oz, { isApparelOrShoes: true, allowAll2027Tiers: true }), 1.65);
  assert.equal(lookupVerified2027PerReturnFee(pkg401oz, { isApparelOrShoes: true, allowAll2027Tiers: true }), 1.75);
  assert.equal(lookupVerified2027PerReturnFee(pkg4oz, { isApparelOrShoes: true, allowAll2027Tiers: false }), null);

  const opts = { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['ev-1'] };
  const validLedger4 = makeApparelLedger({ pkg: pkg4oz, perReturnFeeUsd: 1.65 });
  const validLedger401 = makeApparelLedger({ pkg: pkg401oz, perReturnFeeUsd: 1.75 });
  assert.equal(validateFeeBasis(validLedger4, opts).status, 'validated');
  assert.equal(validateFeeBasis(validLedger401, opts).status, 'validated');
  assert.equal(calculateEconomics(validLedger4, opts).scoring_supported, true);
  assert.equal(calculateEconomics(validLedger401, opts).scoring_supported, true);

  const es4 = evaluateEarlyScreen(makeApparelEarlyScreenInput({ pkg: pkg4oz, perReturnFeeUsd: 1.65 }));
  assert.equal(es4.returns_processing_components.per_return_fee_usd, 1.65);
  assert.equal(es4.returns_processing_components.expected_fee_per_shipped_unit_usd, 0.165);

  // Caller applicability validation stays intact
  const wrongFeeLedger = makeApparelLedger({ pkg: pkg4oz, perReturnFeeUsd: 1.66 });
  assert.equal(validateFeeBasis(wrongFeeLedger, opts).status, 'needs_evidence');
  assert.equal(calculateEconomics(wrongFeeLedger, opts).scoring_supported, false);

  const backdatedLedger = makeApparelLedger({ pkg: pkg4oz, perReturnFeeUsd: 1.65, effectiveFrom: '2027-01-14' });
  assert.equal(validateFeeBasis(backdatedLedger, opts).status, 'needs_evidence');
  assert.equal(calculateEconomics(backdatedLedger, opts).scoring_supported, false);

  const badWindowEst = lookupUnifiedReturnsProcessing2027({
    pkg: pkg4oz,
    physical_return_fraction: 0.10,
    is_apparel_or_shoes: true,
    sales_window: { from: '2027-01-14', through: '2027-09-30' },
  });
  assert.equal(badWindowEst.status, 'needs_calculator_verification');

  // Unrelated nullable/non-boolean package flags (e.g. is_sipp: null) must NEVER bypass official per-return fee verification
  const pkgWithNullSipp = { ...pkg4oz, is_sipp: null };
  assert.equal(lookupVerified2027PerReturnFee(pkgWithNullSipp, { isApparelOrShoes: true, allowAll2027Tiers: true }), 1.65);
  const bogusFeeWithNullSippLedger = makeApparelLedger({ pkg: pkgWithNullSipp, perReturnFeeUsd: 0.01 });
  assert.equal(validateFeeBasis(bogusFeeWithNullSippLedger, opts).status, 'needs_evidence');
  assert.equal(calculateEconomics(bogusFeeWithNullSippLedger, opts).scoring_supported, false);
  const bogusEarlyScreen = evaluateEarlyScreen(makeApparelEarlyScreenInput({ pkg: pkgWithNullSipp, perReturnFeeUsd: 0.01 }));
  assert.equal(bogusEarlyScreen.returns_processing_components, null);
});

test('isolated +$0.01 single-tier annual rate-table mutation on Small Standard Apparel 4.00 oz moves BOTH forward estimation and ledger verification to $1.66 while 4.01 oz stays $1.75', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue10-single-table-'));
  try {
    const tmpSrc = join(dir, 'src');
    cpSync(join(REPO_ROOT, 'src', 'rates'), join(tmpSrc, 'rates'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'utils'), join(tmpSrc, 'utils'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'business-thresholds.mjs'), join(tmpSrc, 'business-thresholds.mjs'));
    cpSync(join(REPO_ROOT, 'src', 'fba-calculator.mjs'), join(tmpSrc, 'fba-calculator.mjs'));
    cpSync(join(REPO_ROOT, 'src', 'economics.mjs'), join(tmpSrc, 'economics.mjs'));

    // Mutate strictly ONE single row in the canonical annual table: Small Standard Apparel <= 4 oz ($1.65 -> $1.66)
    const tablesPath = join(tmpSrc, 'rates', 'fba-2027-tables.mjs');
    const origTables = readFileSync(tablesPath, 'utf8');
    const apparelSmall4ozRe = /(APPAREL_SHOES_STANDARD_RETURNS_2027[\s\S]*?small_standard_oz:\s*Object\.freeze\(\[\s*Object\.freeze\(\{\s*max_oz:\s*4,\s*return_fee:\s*)1\.65(\s*\}\))/;
    const mutated = origTables.replace(apparelSmall4ozRe, '$11.66$2');
    assert.notEqual(mutated, origTables, 'Expected Small Standard Apparel max_oz: 4 row in fba-2027-tables.mjs');
    writeFileSync(tablesPath, mutated, 'utf8');

    const isoFba = await import(pathToFileURL(join(tmpSrc, 'fba-calculator.mjs')).href);
    const isoEcon = await import(pathToFileURL(join(tmpSrc, 'economics.mjs')).href);

    const pkg4oz = { length_in: 10, width_in: 8, height_in: 0.5, unit_weight_oz: 4.00 };
    const pkg401oz = { length_in: 10, width_in: 8, height_in: 0.5, unit_weight_oz: 4.01 };

    // 1. Small Standard Apparel 4.00 oz tracks the mutated $1.66 across BOTH forward estimation AND ledger verification
    const est4 = isoFba.lookupUnifiedReturnsProcessing2027({
      pkg: pkg4oz,
      physical_return_fraction: 0.10,
      is_apparel_or_shoes: true,
      sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
    });
    assert.equal(est4.status, 'verified');
    assert.equal(est4.per_return_fee_usd, 1.66, 'Forward estimation must reflect mutated annual row ($1.66)');

    const g1a4 = isoFba.estimateGate1A2027({
      pkg: pkg4oz,
      price_usd: 34.99,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.10,
      physical_return_fraction: 0.10,
      is_apparel: true,
      fee_category: 'Apparel',
      referral_terms: { referral_fraction: 0.17, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
      headhaul_usd: 1.00,
      collection_rate: 0.006,
      other_applicable_usd: 0,
      sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
      storage_window: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
      inbound_window: FBA_2027_DEFAULT_INBOUND_WINDOW,
    });
    assert.equal(g1a4.status, 'verified');
    assert.equal(g1a4.components.returns_processing.per_return_fee_usd, 1.66);

    assert.equal(
      isoFba.lookupVerified2027PerReturnFee(pkg4oz, { isApparelOrShoes: true, allowAll2027Tiers: true }),
      1.66,
      'Ledger verification lookup must track the exact same annual table row ($1.66)',
    );

    const opts = { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['ev-1'] };
    const ledger4New = makeApparelLedger({ pkg: pkg4oz, perReturnFeeUsd: 1.66 });
    const ledger4Old = makeApparelLedger({ pkg: pkg4oz, perReturnFeeUsd: 1.65 });
    assert.equal(isoFba.validateFeeBasis(ledger4New, opts).status, 'validated');
    assert.equal(isoEcon.calculateEconomics(ledger4New, opts).scoring_supported, true);
    assert.equal(isoFba.validateFeeBasis(ledger4Old, opts).status, 'needs_evidence', 'Old $1.65 must fail after annual row moves to $1.66');
    assert.equal(isoEcon.calculateEconomics(ledger4Old, opts).scoring_supported, false);

    const es4New = isoEcon.evaluateEarlyScreen(makeApparelEarlyScreenInput({ pkg: pkg4oz, perReturnFeeUsd: 1.66 }));
    const es4Old = isoEcon.evaluateEarlyScreen(makeApparelEarlyScreenInput({ pkg: pkg4oz, perReturnFeeUsd: 1.65 }));
    assert.equal(es4New.returns_processing_components.per_return_fee_usd, 1.66);
    assert.equal(es4Old.returns_processing_components, null, 'Early screen must reject stale $1.65 against mutated $1.66 annual row');

    // 2. Adjacent 4.01 oz Apparel bracket remains untouched at $1.75 in BOTH paths
    const est401 = isoFba.lookupUnifiedReturnsProcessing2027({
      pkg: pkg401oz,
      physical_return_fraction: 0.10,
      is_apparel_or_shoes: true,
      sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
    });
    assert.equal(est401.per_return_fee_usd, 1.75);
    assert.equal(isoFba.lookupVerified2027PerReturnFee(pkg401oz, { isApparelOrShoes: true, allowAll2027Tiers: true }), 1.75);
    assert.equal(isoFba.validateFeeBasis(makeApparelLedger({ pkg: pkg401oz, perReturnFeeUsd: 1.75 }), opts).status, 'validated');
    assert.equal(isoEcon.calculateEconomics(makeApparelLedger({ pkg: pkg401oz, perReturnFeeUsd: 1.75 }), opts).scoring_supported, true);
    const es401 = isoEcon.evaluateEarlyScreen(makeApparelEarlyScreenInput({ pkg: pkg401oz, perReturnFeeUsd: 1.75 }));
    assert.equal(es401.returns_processing_components.per_return_fee_usd, 1.75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
