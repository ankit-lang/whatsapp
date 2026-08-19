const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhoneNumber, calculateReconnectDelay } = require('../index');

test('normalizePhoneNumber removes non-numeric characters correctly', () => {
  assert.equal(normalizePhoneNumber('+31 6 12345678'), '31612345678');
  assert.equal(normalizePhoneNumber('+(91) 98765-43210'), '919876543210');
  assert.equal(normalizePhoneNumber('  001-555-0199 '), '0015550199');
});

test('calculateReconnectDelay bounds check', () => {
  assert.equal(calculateReconnectDelay(0), 5000);
  assert.equal(calculateReconnectDelay(1), 10000);
  assert.equal(calculateReconnectDelay(100), 60000);
});
