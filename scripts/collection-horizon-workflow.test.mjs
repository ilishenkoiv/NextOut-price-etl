import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/fetch-prices.yml', import.meta.url), 'utf8');
const job = (id) => workflow.split(`\n  ${id}:\n`)[1]?.split(/\n  [a-z_0-9]+:\n/)[0];

test('six-month horizon keeps the two schedules and disabled far-month switch', () => {
  assert.match(workflow, /HORIZON_MONTH_COUNT: '6'/);
  assert.match(workflow, /ENABLE_FAR_MONTHS: 'false'/);
  assert.match(workflow, /cron: '17 15 \* \* \*'/);
  assert.match(workflow, /cron: '17 7 \* \* \*'/);
  assert.match(job('collection_config'), /far_enabled=\$ENABLE_FAR_MONTHS/);
  for (let month = 7; month <= 12; month++) {
    const body = job(`month_${month}`);
    assert.match(body, new RegExp(`needs: \\[collection_config, month_${month - 1}\\]`));
    const condition = body.split('if: >-')[1].split('runs-on:')[0];
    assert.doesNotMatch(condition, /\benv\./, 'env is unavailable in GitHub job-level conditions');
    assert.match(condition, /needs\.collection_config\.outputs\.far_enabled == 'true'/);
    assert.match(condition, /always\(\)/, 'a failed previous month must not block subsequent collection');
  }
});

test('watchdog uses the same gate and reports configuration failures', () => {
  const body = job('watchdog');
  assert.match(body, /- collection_config/);
  assert.match(body, /FAR_EXPECTED:.*needs\.collection_config\.outputs\.far_enabled/);
  assert.match(body, /CONFIG_RESULT:.*needs\.collection_config\.result/);
  assert.match(body, /if \[ "\$CONFIG_RESULT" != success \]/);
});
