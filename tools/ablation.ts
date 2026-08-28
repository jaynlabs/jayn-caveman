/**
 * Which part of the replay correction moved the prose ceiling, and in which direction.
 *
 * The correction changed three things at once — partial rewrites are priced as writes, a compacted
 * prefix stops carrying the delta, and the delta can no longer exceed the prefix it lives in — and
 * they do not pull the same way. This prices the same corpora with each switched on alone. The
 * `old` column reproduces the published figures exactly, which is what makes the rest readable.
 *
 * It duplicates the pricing loop of `replayDelta` on purpose, so that each half can be turned off
 * without a flag existing in the shipped code. Diagnostic only; nothing published depends on it.
 *
 *   npx tsx tools/ablation.ts <root>,<root>
 */
import { price } from '../src/billing/pricing.js';
import { cohortOf } from '../src/cli/projection.js';
import { labelFor } from '../src/cli/roots.js';
import { calibrateLocally, loadSessions, mapLimit } from '../src/transcript/load.js';
import { observedCost } from '../src/transcript/replay.js';
import { requestSize, rewrittenTokens, survivingShare } from '../src/transcript/transition.js';
import type { SessionAnalysis, Turn } from '../src/transcript/session.js';

const roots = (process.argv[2] ?? '').split(',').filter(Boolean);

const M = 1_000_000;
const ZERO = { inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
function rates(turn: Turn) {
  const per = (t: Partial<typeof ZERO>) => price(turn.model, turn.timestamp, { ...ZERO, ...t }).costUSD!;
  const input = per({ inputTokens: M });
  return {
    input: input / M,
    output: per({ outputTokens: M }) / M,
    w5: per({ cacheWrite5m: M }) / input,
    w1: per({ cacheWrite1h: M }) / input,
    read: per({ cacheRead: M }) / input,
  };
}

interface Variant {
  rewrite: boolean;
  compaction: boolean;
  clamp: boolean;
}

/** replayDelta with each half of the correction independently switchable. R = 0, no injection. */
function ceilingDelta(turns: Turn[], prose: number[], v: Variant): number {
  let total = 0;
  let pending = 0;
  let inPrefix = 0;
  for (const [index, turn] of turns.entries()) {
    const r = rates(turn);
    const written = turn.cacheWrite5m + turn.cacheWrite1h;
    const cw = written === 0 ? r.w5 : (r.w5 * turn.cacheWrite5m + r.w1 * turn.cacheWrite1h) / written;
    const prev = index === 0 ? null : turns[index - 1]!;

    if (prev && v.compaction) inPrefix *= survivingShare(prev, turn);
    const floor = -requestSize(turn);
    if (v.clamp && inPrefix + pending < floor) pending = floor - inPrefix;
    total += pending * r.input * cw;

    if (prev) {
      const rewritten = rewrittenTokens(prev, turn);
      const present = turn.cacheRead + rewritten;
      const cold = turn.cacheRead === 0 && written > 0;
      const share = v.rewrite ? (present <= 0 ? 0 : rewritten / present) : cold ? 1 : 0;
      total += inPrefix * share * r.input * cw;
      total += inPrefix * (1 - share) * r.input * r.read;
    }

    inPrefix += pending;
    pending = 0;
    const d = (prose[index] ?? 0) * -1;
    total += d * r.output;
    pending += d;
  }
  return total;
}

const VARIANTS: Array<[string, Variant]> = [
  ['old', { rewrite: false, compaction: false, clamp: false }],
  ['+ rewrite', { rewrite: true, compaction: false, clamp: false }],
  ['+ compaction', { rewrite: false, compaction: true, clamp: false }],
  ['+ clamp', { rewrite: false, compaction: false, clamp: true }],
  ['corrected', { rewrite: true, compaction: true, clamp: true }],
];

console.log(`  ${'corpus'.padEnd(12)}${VARIANTS.map(([n]) => n.padStart(14)).join('')}`);
console.log(`  ${'-'.repeat(12 + 14 * VARIANTS.length)}`);

const pooled: SessionAnalysis[] = [];
for (const root of roots) {
  const cohort = cohortOf(labelFor(root), await loadSessions(root), true);
  pooled.push(...cohort.sessions);
  await report(cohort.label, cohort.sessions);
}
await report('all', pooled);

async function report(label: string, sessions: SessionAnalysis[]): Promise<void> {
  const counter = calibrateLocally(sessions).counter;
  const cells = VARIANTS.map(() => 0);
  let bill = 0;
  for (const session of sessions) {
    const model = session.turns[0]?.model ?? '';
    const prose = await mapLimit(session.turns, 8, (turn) =>
      turn.onlyTextBlocks && !turn.hasFence
        ? Promise.resolve(turn.outputTokens)
        : counter.count(turn.proseText, turn.model || model),
    );
    bill += observedCost(session.turns).costUSD;
    for (const [i, [, v]] of VARIANTS.entries()) cells[i]! += -ceilingDelta(session.turns, prose, v);
  }
  console.log(
    `  ${label.padEnd(12)}` + cells.map((c) => `${((c / bill) * 100).toFixed(1)}%`.padStart(14)).join(''),
  );
}
