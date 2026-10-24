import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_KEYS, addUsage, money, laneTotals } from '../app/costs.mjs';

test('addUsage adds every token count', () => {
  const a = addUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 2, outputTokens: 3 });
  assert.equal(a.inputTokens, 12);
  assert.equal(a.outputTokens, 8);
  for (const k of TOKEN_KEYS) assert.equal(typeof a[k], 'number');
});

test('addUsage starts from nothing when one side is missing', () => {
  const a = addUsage(null, { totalTokens: 7 });
  assert.equal(a.totalTokens, 7);
  assert.equal(a.calls, 0);
});

test('money rounds to six places and refuses nonsense', () => {
  assert.equal(money(0.123456789), 0.123457);
  assert.equal(money('1'), null);
  assert.equal(money(Infinity), null);
});

test('laneTotals adds one lane and skips binned cards', () => {
  const cards = [
    { evidence: [{ stage: 'Analyse', usage: { totalTokens: 100 }, costUsd: 0.5 }] },
    { evidence: [{ stage: 'Analyse', usage: { totalTokens: 50 }, costUsd: 0.25 }] },
    { binnedAt: '2026-01-01', evidence: [{ stage: 'Analyse', usage: { totalTokens: 999 }, costUsd: 9 }] },
  ];
  const t = laneTotals(cards);
  assert.equal(t.lanes.Analyse.tokens, 150);
  assert.equal(t.lanes.Analyse.usd, 0.75);
  assert.equal(t.usd, 0);
});
