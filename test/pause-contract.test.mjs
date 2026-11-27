// Absorbed from .local/reviews/20261127-maintainability-retrospective/public/pause-contract.test.mjs (Issue #54)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const fromRoot = file => import(pathToFileURL(resolve(file)).href);
const { openSelectionStore } = await fromRoot('src/store.mjs');
const { runPhase2Batch } = await fromRoot('src/pipeline.mjs');
const { makeGate1AScenario } = await fromRoot('test/helpers/stage4-fixtures.mjs');
const profile = JSON.parse(readFileSync('docs/design/reference-profile.r59.draft.json', 'utf8'));

for (const paused of [false, true]) {
  test(paused ? 'Already paused batch must make zero triage calls' : 'Active batch reaches the synthetic triage executor', async () => {
    const store = openSelectionStore(':memory:');
    try {
      if (paused) store.pauseQueue('gate1b_1688_queue', 'Synthetic pending owner verification');
      let calls = 0;
      const item = {
        form: {
          form_id: 'synthetic-desk-organizer', product_family_key: 'synthetic-organizer',
          label: 'Synthetic desk organizer', buyer_task: 'Sort desk supplies',
          saleable_set_composition: { qty: 1 },
        },
        gate1a_scenarios: [makeGate1AScenario({ id: 'demo', priceUsd: 48, fx_cny_per_usd: 7.2 })],
        luna_triage_candidates: [{ candidate_id: 'demo-peer', title: 'Adult desk organizer', price_usd: 49 }],
      };
      const result = await runPhase2Batch(store, {
        items: [item], profile, as_of_date: '2026-11-27',
        openai_hooks: { luna_triage: { enabled: true, decisionExecutor: async request => {
          calls += 1;
          return { status: 'completed', usable: true, content_status: 'usable',
            decisions: request.questions.map(q => ({ id: q.id, type: q.type,
              value: q.type === 'predicate' ? false : 'exact_peer' })) };
        } } },
      });
      if (paused) {
        assert.equal(result.batch_paused, true);
        assert.equal(result.pause_status, 'CAPTCHA_PAUSED');
        assert.equal(calls, 0, 'Check the saved pause before external triage on this batch.');
      } else {
        assert.ok(calls > 0, 'The same fixture should reach the stub when allowed.');
      }
    } finally {
      store.close();
    }
  });
}
