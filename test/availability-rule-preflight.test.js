import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAvailabilityRules } from '../scripts/availability-rule-preflight.mjs';

test('rule preflight explains non-root source permissions before stack launch', async () => {
  await assert.rejects(verifyAvailabilityRules({ repo: '/private/source', project: 'qa-preflight', run: async () => {
    throw Object.assign(new Error('private diagnostic'), { code: 1, stderr: 'open availability-rules.test.yaml: Permission denied' });
  } }), error => {
    assert.equal(error.code, 'AVAILABILITY_RULE_PREFLIGHT_PERMISSION');
    assert.match(error.message, /before stack launch/);
    assert.match(error.message, /non-root/);
    assert.match(error.message, /mode-0700/);
    assert.match(error.message, /disposable readable copy/);
    assert(!error.message.includes('private diagnostic'));
    return true;
  });
});

test('rule preflight preserves pinned non-root validation and reports other failures separately', async () => {
  const calls = [];
  const result = await verifyAvailabilityRules({ repo: '/source', project: 'qa-preflight', run: async (...args) => { calls.push(args); return { stdout: 'SUCCESS' }; } });
  assert.equal(result.stdout, 'SUCCESS');
  assert.equal(calls[0][0], 'docker');
  assert(calls[0][1].includes('prom/prometheus:v3.13.3'));
  assert(!calls[0][1].includes('--user'), 'the validator must not gain root authority');
  await assert.rejects(verifyAvailabilityRules({ repo: '/source', project: 'qa-preflight', run: async () => {
    throw Object.assign(new Error('private diagnostic'), { code: 1, stderr: 'invalid rule expression' });
  } }), error => error.code === 'AVAILABILITY_RULE_PREFLIGHT_FAILED' && !/mode-0700|private diagnostic/.test(error.message));
});

test('Docker daemon permission errors are not classified as source traversal failures', async () => {
  await assert.rejects(verifyAvailabilityRules({ repo: '/source', project: 'qa-preflight', run: async () => {
    throw Object.assign(new Error('private diagnostic'), { stderr: 'permission denied while trying to connect to the Docker daemon socket' });
  } }), error => error.code === 'AVAILABILITY_RULE_PREFLIGHT_FAILED' && !/mode-0700/.test(error.message));
});

test('promtool missing-rule warning identifies source visibility without guessing permissions', async () => {
  await assert.rejects(verifyAvailabilityRules({ repo: '/source', project: 'qa-preflight', run: async () => {
    throw Object.assign(new Error('private diagnostic'), { code: 1, stderr: 'WARNING: no file match pattern ../../monitoring/trace/availability-rules.yaml\nFAILED:' });
  } }), error => {
    assert.equal(error.code, 'AVAILABILITY_RULE_PREFLIGHT_SOURCE');
    assert.match(error.message, /missing|unreadable/);
    assert.match(error.message, /mode-0700/);
    assert(!error.message.includes('private diagnostic'));
    return true;
  });
});
