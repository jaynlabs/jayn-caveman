import { price } from '../billing/pricing.js';
import { requestSize, rewrittenTokens, survivingShare } from './transition.js';
import type { SessionAnalysis, Turn } from './session.js';
import type { InjectionProfile } from './injection.js';

const M = 1_000_000;
const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

interface Rates {
  input: number;

  output: number;

  write5m: number;
  write1h: number;
  read: number;
}

function ratesFor(model: string, timestamp: Date): Rates | null {
  const per = (tokens: Partial<typeof ZERO>) => price(model, timestamp, { ...ZERO, ...tokens }).costUSD;
  const input = per({ inputTokens: M });
  const output = per({ outputTokens: M });
  if (input == null || output == null || input === 0) return null;
  return {
    input: input / M,
    output: output / M,
    write5m: per({ cacheWrite5m: M })! / input,
    write1h: per({ cacheWrite1h: M })! / input,
    read: per({ cacheRead: M })! / input,
  };
}

function writeMultiplier(turn: Turn, rates: Rates): number {
  const total = turn.cacheWrite5m + turn.cacheWrite1h;
  if (total === 0) return rates.write5m;
  return (rates.write5m * turn.cacheWrite5m + rates.write1h * turn.cacheWrite1h) / total;
}

/**
 * Where in the prefix the counterfactual tokens sit.
 *
 * Billing says what fraction of the surviving prefix was written a second time. It does not say
 * *which* tokens those were, so it cannot say whether a token this replay invented would have been
 * among them. `proportional` spreads the delta through the prefix like everything else and is the
 * reported estimate; the other two are the corners of what the data allows, and exist so the
 * published figure can carry a range. See docs/replay-correction.md.
 */
export type Placement = 'proportional' | 'read' | 'rewrite';

/**
 * Of `delta` counterfactual tokens sitting in a prefix where `rewritten` of `cacheRead + rewritten`
 * came back as cache creation, the fraction to bill at the write multiplier. Sign-symmetric: a
 * removed token is credited wherever an added one would have been charged.
 */
function placedShare(placement: Placement, delta: number, cacheRead: number, rewritten: number): number {
  const present = cacheRead + rewritten;
  if (present <= 0 || rewritten <= 0) return 0;
  if (placement === 'proportional') return rewritten / present;

  const span = Math.min(Math.abs(delta), present);
  if (span <= 0) return 0;
  return placement === 'rewrite' ? Math.min(span, rewritten) / span : Math.max(0, span - cacheRead) / span;
}

export interface CostBreakdown {
  costUSD: number;
  unpriced: boolean;
}

export function observedCost(turns: Turn[]): CostBreakdown {
  let costUSD = 0;
  let unpriced = false;
  for (const turn of turns) {
    const result = price(turn.model, turn.timestamp, turn);
    if (result.unpriced || result.costUSD == null) unpriced = true;
    else costUSD += result.costUSD;
  }
  return { costUSD, unpriced };
}

export interface DeltaBreakdown {
  outputUSD: number;
  writeUSD: number;
  readUSD: number;
  totalUSD: number;

  /** Turns where a negative delta was truncated to keep the counterfactual prefix non-negative. */
  clampedTurns: number;
}

/**
 * Price the difference between the observed conversation and a counterfactual one.
 *
 * The observed bill is never touched; this returns only the delta beside it. `f` scales the prose a
 * turn emitted, `injectionDelta` adds or removes tokens that were fed in rather than written. Both
 * accumulate into a running prefix, and the point of this function is what that prefix costs on
 * every later turn: a cheap re-read while the cache holds, the write multiplier on whatever share
 * of it the model had to write a second time.
 */
export function replayDelta(
  turns: Turn[],
  proseTokens: number[],
  f: (turn: Turn, index: number) => number,
  injectionDelta: (turn: Turn, index: number) => number,
  placement: Placement = 'proportional',
): DeltaBreakdown | null {
  let outputUSD = 0;
  let writeUSD = 0;
  let readUSD = 0;
  let clampedTurns = 0;
  let pendingWrite = 0;
  let inPrefix = 0;

  for (const [index, turn] of turns.entries()) {
    const rates = ratesFor(turn.model, turn.timestamp);
    if (!rates) return null;
    const cw = writeMultiplier(turn, rates);
    const prev = index === 0 ? null : turns[index - 1]!;

    // whatever the conversation dropped on the way into this request, it dropped the delta too
    if (prev) inPrefix *= survivingShare(prev, turn);

    pendingWrite += injectionDelta(turn, index);

    // the counterfactual prefix is the observed one plus the delta, and cannot go below zero
    const floor = -requestSize(turn);
    if (inPrefix + pendingWrite < floor) {
      pendingWrite = floor - inPrefix;
      clampedTurns++;
    }

    // tokens joining the prefix are written once, at whatever mix of 5m and 1h this turn used
    writeUSD += pendingWrite * rates.input * cw;

    // tokens already in the prefix are read back — bar the share of it that was written again
    if (prev) {
      const share = placedShare(placement, inPrefix, turn.cacheRead, rewrittenTokens(prev, turn));
      writeUSD += inPrefix * share * rates.input * cw;
      readUSD += inPrefix * (1 - share) * rates.input * rates.read;
    }

    inPrefix += pendingWrite;
    pendingWrite = 0;

    const proseDelta = (proseTokens[index] ?? 0) * (f(turn, index) - 1);
    outputUSD += proseDelta * rates.output;
    pendingWrite += proseDelta;
  }

  return { outputUSD, writeUSD, readUSD, totalUSD: outputUSD + writeUSD + readUSD, clampedTurns };
}

export interface SessionResult {
  sessionId: string;
  file: string;
  cavemanActive: boolean;
  turns: number;

  proseTokens: number;

  userPrompts: number;

  actualUSD: number;

  paidUSD: number;
  vanillaUSD: number;
  optimizedUSD: number;
  unpriced: boolean;

  modelled: boolean;

  delta: DeltaBreakdown | null;
}

export function replaySession(
  session: SessionAnalysis,
  proseTokens: number[],

  effectiveRatio: (turn: Turn, index: number) => number,
  profile: InjectionProfile,
  injectedTokensPerTurn: number[],

  redundantTokensPerTurn: number[] = [],
  placement: Placement = 'proportional',
): SessionResult {
  const observed = observedCost(session.turns);
  const base: SessionResult = {
    sessionId: session.sessionId,
    file: session.file,
    cavemanActive: session.cavemanActive,
    turns: session.turns.length,
    proseTokens: proseTokens.reduce((total, tokens) => total + tokens, 0),
    userPrompts: session.turns.reduce((total, turn) => total + turn.userPromptsBefore, 0),
    actualUSD: observed.costUSD,
    paidUSD: observed.costUSD,
    vanillaUSD: observed.costUSD,
    optimizedUSD: observed.costUSD,
    unpriced: observed.unpriced,
    modelled: false,
    delta: null,
  };

  if (session.cavemanActive) {
    const delta = replayDelta(
      session.turns,
      proseTokens,
      (turn, index) => 1 / effectiveRatio(turn, index),
      (_turn, index) => -(injectedTokensPerTurn[index] ?? 0),
      placement,
    );
    if (!delta) return base;

    const redundant = replayDelta(
      session.turns,
      proseTokens,
      () => 1,
      (_turn, index) => -(redundantTokensPerTurn[index] ?? 0),
      placement,
    );
    return {
      ...base,
      actualUSD: observed.costUSD + (redundant?.totalUSD ?? 0),
      vanillaUSD: observed.costUSD + delta.totalUSD,
      modelled: true,
      delta,
    };
  }

  const delta = replayDelta(
    session.turns,
    proseTokens,
    effectiveRatio,
    (turn, index) => {
      const oneTime = index === 0 ? profile.oneTimeTokens : 0;
      return oneTime + turn.userPromptsBefore * profile.perPromptTokens;
    },
    placement,
  );
  if (!delta) return base;
  return { ...base, optimizedUSD: observed.costUSD + delta.totalUSD, modelled: true, delta };
}

export interface Totals {
  actualUSD: number;

  paidUSD: number;

  misconfiguredUSD: number;
  vanillaUSD: number;
  optimizedUSD: number;
  savedUSD: number;
  savedPct: number;
  availableUSD: number;
  availablePct: number;
  sessions: number;
  sessionsWithTool: number;
}

export function totalsOf(results: SessionResult[]): Totals {
  const sum = (pick: (r: SessionResult) => number) => results.reduce((a, r) => a + pick(r), 0);
  const actualUSD = sum((r) => r.actualUSD);
  const paidUSD = sum((r) => r.paidUSD);
  const vanillaUSD = sum((r) => r.vanillaUSD);
  const optimizedUSD = sum((r) => r.optimizedUSD);
  return {
    actualUSD,
    paidUSD,
    misconfiguredUSD: paidUSD - actualUSD,
    vanillaUSD,
    optimizedUSD,
    savedUSD: vanillaUSD - actualUSD,
    savedPct: vanillaUSD === 0 ? 0 : (vanillaUSD - actualUSD) / vanillaUSD,
    availableUSD: actualUSD - optimizedUSD,
    availablePct: vanillaUSD === 0 ? 0 : (actualUSD - optimizedUSD) / vanillaUSD,
    sessions: results.length,
    sessionsWithTool: results.filter((r) => r.cavemanActive).length,
  };
}
