export const TOKEN_KEYS = [
  'inputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'calls',
];

export function addUsage(a, u) {
  const out = Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
  for (const k of TOKEN_KEYS) out[k] = Number(a?.[k] || 0) + Number(u?.[k] || 0);
  return out;
}

export function money(n) {
  return typeof n === 'number' && isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

export function laneTotals(cards) {
  const lanes = {};
  let usd = 0;
  for (const c of cards) {
    if (c.binnedAt) continue;
    for (const e of (c.evidence || [])) {
      if (!e.usage && e.costUsd == null) continue;
      const key = e.stageKey || e.stage;
      const lane = lanes[key] || (lanes[key] = { tokens: 0, usd: 0, priced: false, basis: '' });
      lane.tokens += Number(e.usage?.totalTokens || 0);
      if (typeof e.costUsd === 'number') { lane.usd += e.costUsd; lane.priced = true; }
      if (e.priceBasis) lane.basis = e.priceBasis;
    }
    if (typeof c.costUsd === 'number') usd += c.costUsd;
  }
  for (const k of Object.keys(lanes)) lanes[k].usd = money(lanes[k].usd);
  return { lanes, usd: money(usd) };
}
