import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const maintenance = [
  'cleanup-app-errors.yml',
  'cleanup-window-prices.yml',
  'cleanup-flight-price-feedback.yml',
  'cleanup-destination-requests.yml',
  'cleanup-price-storage.yml',
  'storage-metrics.yml',
  'keepalive.yml',
  'refresh-holidays.yml',
  'refresh-destination-events.yml',
];

test('every scheduled maintenance workflow is Berlin-night-only and collector-aware', () => {
  for (const name of maintenance) {
    const workflow = fs.readFileSync(new URL(name, workflowDir), 'utf8');
    assert.match(workflow, /timezone: 'Europe\/Berlin'/, `${name}: timezone`);
    assert.match(workflow, /group: etl-night-maintenance/, `${name}: maintenance lock`);
    assert.match(workflow, /actions: read/, `${name}: run-list permission`);
    assert.match(workflow, /for status in in_progress queued/, `${name}: active and queued collectors`);
    assert.match(workflow, /Twice-daily price fetch/, `${name}: main collector guard`);
    assert.match(workflow, /Carousel window prices/, `${name}: carousel collector guard`);
    assert.match(workflow, /Daily cheapest offers snapshot/, `${name}: roulette guard`);
    assert.match(workflow, /if: steps\.night\.outputs\.allowed == 'true'/, `${name}: work is gated`);
  }
});

test('short maintenance leaves a buffer before the 02:37 roulette refresh', () => {
  for (const name of maintenance.filter((name) => name !== 'refresh-destination-events.yml')) {
    const workflow = fs.readFileSync(new URL(name, workflowDir), 'utf8');
    assert.match(workflow, /minute_of_day < 140 && busy == 0/, `${name}: 02:20 cutoff`);
  }
});

test('the 90-minute monthly refresh must start before 01:00', () => {
  const workflow = fs.readFileSync(new URL('refresh-destination-events.yml', workflowDir), 'utf8');
  assert.match(workflow, /minute_of_day < 60 && busy == 0/);
});

test('roulette refresh epochs stay fixed in Berlin around the maintenance gap', () => {
  const workflow = fs.readFileSync(new URL('snapshot-daily-origin-cheapest.yml', workflowDir), 'utf8');
  assert.match(workflow, /cron: '37 \*\/2 \* \* \*'/);
  assert.match(workflow, /timezone: 'Europe\/Berlin'/);
});

test('quarterly storage retention runs at the start of the protected night gap', () => {
  const workflow = fs.readFileSync(new URL('cleanup-price-storage.yml', workflowDir), 'utf8');
  assert.match(workflow, /cron: '2 0 1 1,4,7,10 \*'/);
  assert.match(workflow, /node scripts\/cleanup-price-storage\.mjs/);
  assert.match(workflow, /Keep one year of snapshots and 35 days of progress markers/);
  assert.match(workflow, /options: \[dry-run, apply\]/);
  assert.match(workflow, /DRY_RUN:.*github\.event_name == 'workflow_dispatch'/);
});
