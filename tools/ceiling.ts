/**
 * The cache-amplified prose ceiling: what a corpus would save if a tool deleted ALL of the
 * model's prose and cost nothing to run. R = 0 in both strata, p_fire = 1, no injection charged.
 *
 * Not part of the shipped CLI, because it prices a tool that does not exist. It is the bound the
 * README and the blog quote as "the real ceiling", so it lives here rather than in a notebook.
 *
 *   npx tsx tools/ceiling.ts <root>,<root> [proportional|read|rewrite]
 */
import { cohortOf } from '../src/cli/projection.js';
import { labelFor } from '../src/cli/roots.js';
import { calibrateLocally, loadSessions, mapLimit } from '../src/transcript/load.js';
import { observedCost, replayDelta, type Placement } from '../src/transcript/replay.js';
import type { SessionAnalysis } from '../src/transcript/session.js';
import type { TokenCounter } from '../src/transcript/tokens.js';

const roots = (process.argv[2] ?? '').split(',').filter(Boolean);
if (roots.length === 0) throw new Error('usage: tsx tools/ceiling.ts <root>,<root> [placement]');
const placement = (process.argv[3] ?? 'proportional') as Placement;

async function proseOf(session: SessionAnalysis, counter: TokenCounter): Promise<number[]> {
  const model = session.turns[0]?.model ?? '';
  return mapLimit(session.turns, 8, (turn) =>
    turn.onlyTextBlocks && !turn.hasFence
      ? Promise.resolve(turn.outputTokens)
      : counter.count(turn.proseText, turn.model || model),
  );
}

interface Row {
  label: string;
  sessions: number;
  billUSD: number;
  outputOnlyUSD: number;
  amplifiedUSD: number;
}

async function ceilingOf(label: string, sessions: SessionAnalysis[]): Promise<Row> {
  const counter = calibrateLocally(sessions).counter;
  let billUSD = 0;
  let outputOnlyUSD = 0;
  let amplifiedUSD = 0;

  for (const session of sessions) {
    const prose = await proseOf(session, counter);
    billUSD += observedCost(session.turns).costUSD;

    // free tool, perfect compression: every prose token gone, nothing injected in its place
    const delta = replayDelta(
      session.turns,
      prose,
      () => 0,
      () => 0,
      placement,
    );
    if (!delta) continue;
    amplifiedUSD += -delta.totalUSD;
    outputOnlyUSD += -delta.outputUSD;
  }
  return { label, sessions: sessions.length, billUSD, outputOnlyUSD, amplifiedUSD };
}

const rows: Row[] = [];
const pooled: SessionAnalysis[] = [];
for (const root of roots) {
  const cohort = cohortOf(labelFor(root), await loadSessions(root), true);
  pooled.push(...cohort.sessions);
  rows.push(await ceilingOf(cohort.label, cohort.sessions));
}
if (rows.length > 1) rows.push(await ceilingOf('all', pooled));

const pct = (n: number, of: number) => `${of === 0 ? 0 : ((n / of) * 100).toFixed(1)}%`;
console.log(
  `  ${'corpus'.padEnd(18)}${'sessions'.padStart(10)}${'bill'.padStart(11)}` +
    `${'prose, output only'.padStart(20)}${'ceiling, amplified'.padStart(20)}`,
);
console.log(`  ${'-'.repeat(77)}`);
for (const row of rows) {
  console.log(
    `  ${row.label.padEnd(18)}${String(row.sessions).padStart(10)}${`$${row.billUSD.toFixed(2)}`.padStart(11)}` +
      `${pct(row.outputOnlyUSD, row.billUSD).padStart(20)}${pct(row.amplifiedUSD, row.billUSD).padStart(20)}`,
  );
}
