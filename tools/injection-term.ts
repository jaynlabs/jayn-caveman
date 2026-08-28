/**
 * What the injection term is worth: the same replay, priced with caveman's cost side switched off.
 *
 * The README and the methodology both claim that this one term decides the sign of the projection.
 * The claim needs a number, and the number moves whenever the replay does, so it is computed here
 * rather than remembered. Prints the pooled measured-p_fire row with the shipped profile charged
 * and with nothing charged, at each placement.
 *
 *   npx tsx tools/injection-term.ts <root>,<root> [model]
 */
import { analyze } from '../src/effects/caveman/analyze.js';
import { CAVEMAN } from '../src/effects/caveman/effect.js';
import { cohortOf } from '../src/cli/projection.js';
import { labelFor } from '../src/cli/roots.js';
import { calibrateLocally, loadSessions } from '../src/transcript/load.js';
import type { InjectionProfile } from '../src/transcript/injection.js';
import type { Placement } from '../src/transcript/replay.js';
import type { SessionAnalysis } from '../src/transcript/session.js';

const roots = (process.argv[2] ?? '').split(',').filter(Boolean);
if (roots.length === 0) throw new Error('usage: tsx tools/injection-term.ts <root>,<root> [model]');
const model = process.argv[3];

const FREE: InjectionProfile = { oneTimeTokens: 0, perPromptTokens: 0, sessions: 0, borrowed: true };
const PLACEMENTS: Placement[] = ['read', 'proportional', 'rewrite'];

const pooled: SessionAnalysis[] = [];
for (const root of roots) pooled.push(...cohortOf(labelFor(root), await loadSessions(root), true).sessions);
const counter = calibrateLocally(pooled).counter;

const pct = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(n * 100).toFixed(2)}%`;
const usd = (n: number) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`;

console.log(
  `  ${'placement'.padEnd(16)}${'injections free'.padStart(22)}${'injections charged'.padStart(22)}`,
);
console.log(`  ${'-'.repeat(60)}`);
for (const placement of PLACEMENTS) {
  const free = await analyze(pooled, counter, CAVEMAN, { model, placement, profile: FREE });
  const charged = await analyze(pooled, counter, CAVEMAN, { model, placement });
  const cell = (t: { availableUSD: number; availablePct: number }) =>
    `${usd(t.availableUSD)}  ${pct(t.availablePct)}`.padStart(22);
  console.log(`  ${placement.padEnd(16)}${cell(free.totals)}${cell(charged.totals)}`);
}
