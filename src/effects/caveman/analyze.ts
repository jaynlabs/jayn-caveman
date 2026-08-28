import { price } from '../../billing/pricing.js';
import { groundTruthSamples, mapLimit } from '../../transcript/load.js';
import {
  measureInjectionProfile,
  redundantTokensOf,
  type InjectionProfile,
} from '../../transcript/injection.js';
import {
  replaySession,
  totalsOf,
  type Placement,
  type SessionResult,
  type Totals,
} from '../../transcript/replay.js';
import { lastOfRunFlags, type SessionAnalysis, type Turn } from '../../transcript/session.js';
import { verifyCounter, type CounterCheck, type TokenCounter } from '../../transcript/tokens.js';
import type { ToolEffect } from '../types.js';
import { CAVEMAN_RATIOS, RATIO_SENSITIVITY, type CavemanRatios, type RatioScenario } from './effect.js';
import { isUsable, loadPFireModel, pFireWithSource, type PFireModel, type PFireSource } from './pfire.js';
import { detectLanguage } from './style.js';

export interface AnalysisReport {
  effect: ToolEffect;
  profile: InjectionProfile;
  counterCheck: CounterCheck;
  results: SessionResult[];
  totals: Totals;

  sensitivity: Array<{ scenario: RatioScenario; totals: Totals }>;

  proseShareOfBill: number;

  pFire: PFireModel;

  meanPFire: number;

  pFireTokensBySource: Record<PFireSource, number>;

  pFireUnavailable: boolean;
}

async function countTurns(
  session: SessionAnalysis,
  counter: TokenCounter,
): Promise<{ prose: number[]; injected: number[]; redundant: number[] }> {
  const model = session.turns[0]?.model ?? '';
  const prose = await mapLimit(session.turns, 8, (turn) =>
    turn.onlyTextBlocks && !turn.hasFence
      ? Promise.resolve(turn.outputTokens)
      : counter.count(turn.proseText, turn.model || model),
  );

  const injected = await mapLimit(session.turns, 8, async (turn: Turn) => {
    let total = 0;
    for (const text of new Set([...turn.injectedOneTime, ...turn.injectedPerTurn])) {
      total += await counter.count(text, turn.model || model);
    }
    return total;
  });
  const redundant = await redundantTokensOf(session, counter);
  return { prose, injected, redundant };
}

export interface AnalyzeOptions {
  ratios?: CavemanRatios;

  model?: string;

  alwaysFires?: boolean;

  /** Where a counterfactual token is assumed to sit in a partially re-written prefix. */
  placement?: Placement;

  /**
   * Stand in for the measured injection profile. Only `tools/injection-term.ts` passes it, to price
   * the same replay with the cost side switched off; the CLI never overrides what it measured.
   */
  profile?: InjectionProfile;
}

export async function analyze(
  sessions: SessionAnalysis[],
  counter: TokenCounter,
  effect: ToolEffect,
  { ratios = CAVEMAN_RATIOS, model, alwaysFires = false, placement, profile: override }: AnalyzeOptions = {},
): Promise<AnalysisReport> {
  const counterCheck = await verifyCounter(counter, groundTruthSamples(sessions));

  const counted = new Map<string, { prose: number[]; injected: number[]; redundant: number[] }>();
  for (const session of sessions) counted.set(session.file, await countTurns(session, counter));

  const profile = override ?? (await measureInjectionProfile(sessions, counter));
  const pFire = await loadPFireModel(sessions, counter, { model });

  const pFireUnavailable = !isUsable(pFire.curve) && pFire.prior === null;
  const chargeEveryTurn = alwaysFires || pFireUnavailable;

  const closesRun = new Map<string, boolean[]>();
  for (const session of sessions) closesRun.set(session.file, lastOfRunFlags(session.turns));

  const languages = new Map<string, string[]>();
  for (const session of sessions) {
    languages.set(
      session.file,
      session.turns.map((turn) => detectLanguage(turn.proseText)),
    );
  }

  const positionOf = (session: SessionAnalysis, index: number) => ({
    index,
    lastOfRun: closesRun.get(session.file)![index] ?? true,
    language: languages.get(session.file)![index] ?? 'unknown',
  });

  const rateOf = (session: SessionAnalysis, index: number, at: CavemanRatios): number => {
    if (session.cavemanActive && !session.turns[index]?.cavemanLive) return 1;
    const turn = positionOf(session, index);

    const R = turn.lastOfRun ? at.closing : at.midRun;

    const p = chargeEveryTurn ? 1 : pFireWithSource(pFire.curve, turn, pFire.prior).p;
    return p * R + (1 - p);
  };

  const forRatios = (at: CavemanRatios): SessionResult[] =>
    sessions.map((session) => {
      const { prose, injected, redundant } = counted.get(session.file)!;
      return replaySession(
        session,
        prose,
        (_turn, index) => rateOf(session, index, at),
        profile,
        injected,
        redundant,
        placement,
      );
    });

  const results = forRatios(ratios);
  const totals = totalsOf(results);

  let weighted = 0;
  let weight = 0;
  const pFireTokensBySource: Record<PFireSource, number> = { measured: 0, prior: 0, assumed: 0 };
  for (const session of sessions) {
    const { prose } = counted.get(session.file)!;
    for (const [index] of session.turns.entries()) {
      const tokens = prose[index] ?? 0;

      if (session.cavemanActive && !session.turns[index]?.cavemanLive) continue;
      const at = chargeEveryTurn
        ? { p: 1, source: 'assumed' as const }
        : pFireWithSource(pFire.curve, positionOf(session, index), pFire.prior);
      weighted += tokens * at.p;
      weight += tokens;
      pFireTokensBySource[at.source] += tokens;
    }
  }

  let proseUSD = 0;
  let totalUSD = 0;
  for (const session of sessions) {
    const { prose } = counted.get(session.file)!;
    for (const [index, turn] of session.turns.entries()) {
      const full = price(turn.model, turn.timestamp, turn).costUSD;
      if (full == null) continue;
      totalUSD += full;
      const outputOnly =
        price(turn.model, turn.timestamp, {
          inputTokens: 0,
          outputTokens: turn.outputTokens,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
        }).costUSD ?? 0;
      const share = turn.outputTokens === 0 ? 0 : (prose[index] ?? 0) / turn.outputTokens;
      proseUSD += outputOnly * share;
    }
  }

  return {
    effect,
    profile,
    counterCheck,
    results,
    totals,
    sensitivity: RATIO_SENSITIVITY.map((scenario) => ({
      scenario,
      totals: totalsOf(forRatios(scenario.ratios)),
    })),
    proseShareOfBill: totalUSD === 0 ? 0 : proseUSD / totalUSD,
    pFire,
    meanPFire: weight === 0 ? 1 : weighted / weight,
    pFireTokensBySource,
    pFireUnavailable,
  };
}
