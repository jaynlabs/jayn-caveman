/**
 * How a request turns into the next one, classified from billing alone.
 *
 * `replayDelta` prices a counterfactual token by asking one question of each turn: was this a
 * cold start, or not? That is a binary, and the transition between two consecutive requests is
 * not. This walks every corpus and counts which transitions actually occur, how much billed
 * cache creation each class carries, and — the number the replay actually needs — what fraction
 * of the surviving prefix gets re-written rather than read on the turns where both happen.
 *
 *   npx tsx tools/transitions.ts <root>,<root>
 */
import { labelFor } from '../src/cli/roots.js';
import { loadSessions } from '../src/transcript/load.js';
import {
  classify,
  requestSize,
  rewriteShare,
  rewrittenTokens,
  writtenTokens,
  type Transition,
} from '../src/transcript/transition.js';
import type { SessionAnalysis } from '../src/transcript/session.js';

const roots = (process.argv[2] ?? '').split(',').filter(Boolean);
if (roots.length === 0) throw new Error('usage: tsx tools/transitions.ts <root>,<root>');

const CLASSES: Transition[] = ['steady', 'growth', 'cold', 'partial', 'compaction', 'compactionRewrite'];

const LABEL: Record<Transition, string> = {
  steady: 'normal cache hit (nothing new)',
  growth: 'genuine prefix growth',
  cold: 'full cold start',
  partial: 'partial TTL rewrite',
  compaction: 'prefix shrink / compaction',
  compactionRewrite: 'compaction + rewrite together',
};

interface Tally {
  turns: number;
  writeTokens: number;
  readTokens: number;
  rewrittenTokens: number;
}

function empty(): Record<Transition, Tally> {
  return Object.fromEntries(
    CLASSES.map((c) => [c, { turns: 0, writeTokens: 0, readTokens: 0, rewrittenTokens: 0 }]),
  ) as Record<Transition, Tally>;
}

interface Walk {
  tally: Record<Transition, Tally>;
  shares: number[];
  requestTokens: number;
  freshInputTokens: number;
}

function walk(sessions: SessionAnalysis[]): Walk {
  const tally = empty();
  const shares: number[] = [];
  let requestTokens = 0;
  let freshInputTokens = 0;
  for (const session of sessions) {
    for (const [index, turn] of session.turns.entries()) {
      requestTokens += requestSize(turn);
      freshInputTokens += turn.inputTokens;
      if (index === 0) continue;
      const prev = session.turns[index - 1]!;
      const kind = classify(prev, turn);
      const entry = tally[kind];
      entry.turns++;
      entry.writeTokens += writtenTokens(turn);
      entry.readTokens += turn.cacheRead;
      entry.rewrittenTokens += rewrittenTokens(prev, turn);
      if (kind === 'partial') shares.push(rewriteShare(prev, turn));
    }
  }
  return { tally, shares, requestTokens, freshInputTokens };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const num = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n}`;

const pooled: SessionAnalysis[] = [];
for (const root of roots) {
  const sessions = await loadSessions(root);
  pooled.push(...sessions);
  report(labelFor(root), sessions);
}
if (roots.length > 1) report('all corpora pooled', pooled);

function report(label: string, sessions: SessionAnalysis[]): void {
  const { tally, shares, requestTokens, freshInputTokens } = walk(sessions);
  const turns = CLASSES.reduce((total, c) => total + tally[c].turns, 0);
  const writes = CLASSES.reduce((total, c) => total + tally[c].writeTokens, 0);
  const rewritten = CLASSES.reduce((total, c) => total + tally[c].rewrittenTokens, 0);

  console.log('');
  console.log(`## ${label} — ${sessions.length} sessions, ${turns} transitions`);
  console.log('');
  console.log(
    `  ${'transition'.padEnd(32)}${'turns'.padStart(9)}${'% turns'.padStart(9)}` +
      `${'cache creation'.padStart(16)}${'% of creation'.padStart(15)}`,
  );
  console.log(`  ${'-'.repeat(79)}`);
  for (const kind of CLASSES) {
    const entry = tally[kind];
    if (entry.turns === 0) continue;
    console.log(
      `  ${LABEL[kind].padEnd(32)}${String(entry.turns).padStart(9)}` +
        `${pct(entry.turns / turns).padStart(9)}${num(entry.writeTokens).padStart(16)}` +
        `${pct(writes === 0 ? 0 : entry.writeTokens / writes).padStart(15)}`,
    );
  }

  console.log('');
  console.log(
    `  re-written prefix          ${num(rewritten).padStart(9)} tokens, ` +
      `${pct(writes === 0 ? 0 : rewritten / writes)} of all cache creation`,
  );
  console.log(
    `  fresh input (never cached) ${num(freshInputTokens).padStart(9)} tokens, ` +
      `${pct(requestTokens === 0 ? 0 : freshInputTokens / requestTokens)} of the whole request`,
  );

  if (shares.length > 0) {
    const sorted = [...shares].sort((a, b) => a - b);
    console.log(
      `  on a partial rewrite, that share of the surviving prefix:  ` +
        `p25 ${pct(quantile(sorted, 0.25))}  p50 ${pct(quantile(sorted, 0.5))}  ` +
        `p75 ${pct(quantile(sorted, 0.75))}  p95 ${pct(quantile(sorted, 0.95))}`,
    );
  }
}
