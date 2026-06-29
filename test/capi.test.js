const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeCapi } = require('../lib/capi');

test('events_received maps to sent', () => {
  assert.deepEqual(summarizeCapi({ events_received: 1 }), { status: 'sent', received: 1 });
});
test('error payload maps to error', () => {
  assert.deepEqual(summarizeCapi({ error: { message: 'bad token' } }), { status: 'error', received: 0 });
});
test('null (skipped, env missing) maps to skipped', () => {
  assert.deepEqual(summarizeCapi(null), { status: 'skipped', received: 0 });
});
