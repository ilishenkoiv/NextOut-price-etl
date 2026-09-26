// Owner spec 2026-09-26, item 4: under coordinated mode these 7 standalone maintenance workflows
// no longer run on their own schedule (the coordinator's nightly maintenance block now owns that
// work — see maintenance-window.mjs), but a manual workflow_dispatch must still work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const GATED_JOB_LEVEL = [
  'cleanup-app-errors.yml', 'cleanup-destination-requests.yml', 'cleanup-flight-price-feedback.yml',
  'check-flight-price-feedback.yml', 'storage-metrics.yml', 'cleanup-window-prices.yml', 'cleanup-price-storage.yml',
];

test('all 7 workflows: scheduled run skipped under coordinated mode, workflow_dispatch always allowed', () => {
  for (const name of GATED_JOB_LEVEL) {
    const workflow = fs.readFileSync(new URL(name, workflowDir), 'utf8');
    assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' \|\| vars\.COLLECTION_MODE != 'coordinated'/, `${name}: job-level gate`);
    assert.match(workflow, /workflow_dispatch/, `${name}: manual trigger exists`);
  }
});

test('cleanup-window-prices and cleanup-price-storage: standalone (non-coordinated) runtime behavior is untouched', () => {
  for (const name of ['cleanup-window-prices.yml', 'cleanup-price-storage.yml']) {
    const workflow = fs.readFileSync(new URL(name, workflowDir), 'utf8');
    // The bash night/idle gate's own COLLECTION_MODE short-circuit is unchanged — a manual
    // dispatch under coordinated mode still reaches it and is allowed immediately.
    assert.match(workflow, /if \[ "\$COLLECTION_MODE" = "coordinated" \]; then/, `${name}: bash short-circuit intact`);
    assert.match(workflow, /minute_of_day < 140 && busy == 0/, `${name}: standalone night/idle window unchanged`);
  }
});
