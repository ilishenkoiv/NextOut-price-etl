import test from 'node:test';
import assert from 'node:assert/strict';
import { dbErrorCode, logDbError } from './db-error.mjs';

test('dbErrorCode falls back to unknown on empty string, not just null/undefined (|| not ??)', () => {
  assert.equal(dbErrorCode({ code: '' }), 'unknown');
  assert.equal(dbErrorCode({ code: null }), 'unknown');
  assert.equal(dbErrorCode({}), 'unknown');
  assert.equal(dbErrorCode({ code: '42501' }), '42501');
});

test('logDbError emits one structured db_error line with op, code, status, message, details, hint, attempt', () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    logDbError({ op: 'test_op', error: { code: '', message: 'fetch failed', details: 'd', hint: 'h' }, status: 500, attempt: 2 });
  } finally { console.error = original; }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, { event: 'db_error', op: 'test_op', code: 'unknown', status: 500, message: 'fetch failed', details: 'd', hint: 'h', attempt: 2 });
});

test('logDbError never invents secrets and tolerates a missing error object', () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try { logDbError({ op: 'missing_error', error: null, status: null, attempt: 1 }); }
  finally { console.error = original; }
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, { event: 'db_error', op: 'missing_error', code: 'unknown', status: null, message: null, details: null, hint: null, attempt: 1 });
});
