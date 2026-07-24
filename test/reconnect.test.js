const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateReconnectDelay } = require('../index');

test('calculateReconnectDelay grows with attempts and caps at a max', () => {
  assert.equal(calculateReconnectDelay(0), 5000);
  assert.equal(calculateReconnectDelay(1), 10000);
  assert.equal(calculateReconnectDelay(2), 20000);
  assert.equal(calculateReconnectDelay(10), 60000);
});
