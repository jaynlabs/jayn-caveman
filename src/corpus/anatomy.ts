import { price } from '../billing/pricing.js';
import { replayDelta } from '../transcript/replay.js';
import type { SessionAnalysis, Turn } from '../transcript/session.js';
import type { TokenCounter } from '../transcript/tokens.js';

/**
 * What a bill is made of, as opposed to how big it is.
 *
 * Two decompositions, and they answer different questions. The LANE split is what Anthropic
 * charges for — fresh input, cache read, cache write, output — and comes straight out of the
 * recorded `usage`, so it is exact. The CLASS split is what the tokens were — reasoning, prose,
 * tool calls — and has to be reconstructed, because the transcript does not label them.
 *
 * The two are not alternatives. A token of output is billed once in the output lane and then,
 * because every later turn resends the whole conversation, again in the write lane and once per
 * remaining turn in the read lane. Which is why the class split is priced twice below: at the
 * output rate alone, and fully loaded with everything it drags behind it.
 */

const ZERO = { inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

export type Lane = 'freshInput' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h' | 'output';

export const LANES: Lane[] = ['freshInput', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'output'];

export const LANE_LABEL: Record<Lane, string> = {
  freshInput: 'fresh input (1x)',
  cacheRead: 'cache read (0.1x)',
  cacheWrite1h: 'cache write 1h (2x)',
  cacheWrite5m: 'cache write 5m (1.25x)',
  output: 'output',
};

function laneTokens(turn: Turn, lane: Lane): number {
  switch (lane) {
    case 'freshInput':
      return turn.inputTokens;
    case 'cacheRead':
      return turn.cacheRead;
    case 'cacheWrite5m':
      return turn.cacheWrite5m;
    case 'cacheWrite1h':
      return turn.cacheWrite1h;
    case 'output':
      return turn.outputTokens;
  }
}

function priceOneLane(turn: Turn, lane: Lane): number | null {
  const tokens = laneTokens(turn, lane);
  if (tokens === 0) return 0;
  const key = lane === 'freshInput' ? 'inputTokens' : lane === 'output' ? 'outputTokens' : lane;
  return price(turn.model, turn.timestamp, { ...ZERO, [key]: tokens }).costUSD;
}

export type ContentClass = 'reasoning' | 'prose' | 'toolCalls';

export const CLASSES: ContentClass[] = ['reasoning', 'prose', 'toolCalls'];

export const CLASS_LABEL: Record<ContentClass, string> = {
  reasoning: 'reasoning (thinking)',
  prose: 'prose (visible text)',
  toolCalls: 'tool calls (JSON)',
};

/**
 * Billed output tokens, split by what they were.
 *
 * Prose and tool-call JSON are counted from the transcript and converted to billed scale by the
 * same calibration every other command uses. Reasoning is NOT counted — it is the residual.
 *
 * That is forced, not lazy. Claude Code runs with thinking `display` off or summarised, so what
 * lands in the transcript is a summary of the chain of thought; the raw chain is what gets
 * billed. Measured here, turns carrying a thinking block bill 2.6x their transcribed text while
 * turns without one bill 1.45x — the calibration factor exactly. Counting the summary would
 * undercount reasoning by roughly four times. The residual is the only honest estimator.
 */
export interface ClassSplit {
  reasoning: number[];
  prose: number[];
  toolCalls: number[];
  /**
   * Output tokens on turns where counted prose + tool JSON came out ABOVE what was billed, so
   * the reasoning residual had to be floored at zero. This is calibration noise, and it is
   * reported rather than hidden: a large value means the split should not be trusted.
   */
  overflowTokens: number;
}

export async function splitOutput(session: SessionAnalysis, counter: TokenCounter): Promise<ClassSplit> {
  const reasoning: number[] = [];
  const prose: number[] = [];
  const toolCalls: number[] = [];
  let overflowTokens = 0;

  for (const turn of session.turns) {
    const proseTokens = turn.proseText ? await counter.count(turn.proseText, turn.model) : 0;
    const toolTokens = turn.toolCallText ? await counter.count(turn.toolCallText, turn.model) : 0;
    const visible = proseTokens + toolTokens;
    // Never invent reasoning on a turn that never thought: without a thinking block the residual
    // is calibration error, not chain of thought.
    const residual = turn.hasThinking ? turn.outputTokens - visible : 0;
    if (visible > turn.outputTokens) overflowTokens += visible - turn.outputTokens;

    reasoning.push(Math.max(0, residual));
    prose.push(proseTokens);
    toolCalls.push(toolTokens);
  }
  return { reasoning, prose, toolCalls, overflowTokens };
}

/**
 * What a class of output actually costs, once the conversation is taken into account.
 *
 * `replayDelta` prices the counterfactual where those tokens were never emitted: it charges them
 * at the output rate on the turn they appear, at the cache-write rate on the next turn, and at
 * the cache-read rate on every turn after that. Negating it gives the fully loaded cost. The
 * naive output-rate-only figure is returned alongside, because the gap between them is the whole
 * point of the exercise.
 */
export function loadedCostOf(
  turns: Turn[],
  tokensPerTurn: number[],
): { outputUSD: number; totalUSD: number } | null {
  const delta = replayDelta(
    turns,
    tokensPerTurn,
    () => 0,
    () => 0,
  );
  if (!delta) return null;
  return { outputUSD: -delta.outputUSD, totalUSD: -delta.totalUSD };
}

export interface ToolStat {
  name: string;
  calls: number;
  sessions: number;
  turns: number;
}

export function toolHistogram(sessions: readonly SessionAnalysis[]): ToolStat[] {
  const calls = new Map<string, number>();
  const turns = new Map<string, number>();
  const sessionsWith = new Map<string, Set<string>>();

  for (const session of sessions) {
    for (const turn of session.turns) {
      const inTurn = new Set<string>();
      for (const name of turn.toolCalls) {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        inTurn.add(name);
        const seen = sessionsWith.get(name) ?? new Set<string>();
        seen.add(session.file);
        sessionsWith.set(name, seen);
      }
      for (const name of inTurn) turns.set(name, (turns.get(name) ?? 0) + 1);
    }
  }

  return [...calls.entries()]
    .map(([name, count]) => ({
      name,
      calls: count,
      sessions: sessionsWith.get(name)?.size ?? 0,
      turns: turns.get(name) ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/**
 * How much of each content class survives into the next request's prefix.
 *
 * The compounding model above assumes every output token stays in the conversation and is re-read
 * on every later turn. For prose and tool calls that is obviously true. For reasoning it is not
 * obvious at all — the API is free to drop thinking blocks from earlier turns, and if it does,
 * reasoning costs the output rate once and nothing after that.
 *
 * So it is measured rather than assumed: regress the growth of the billed prefix from one turn to
 * the next on the classes of content added in between. A coefficient near 1 means the class is
 * carried and re-read; near 0 means it is dropped. The tool-result coefficient doubles as the
 * control — it is known to be carried, so a fit that does not put it near 1 is not to be trusted.
 */
export interface PersistenceFit {
  pairs: number;
  coefficients: Record<'intercept' | ContentClass | 'incoming', number>;
  rSquared: number;
}

/** Ordinary least squares by Gauss-Jordan elimination. Returns null on a singular system. */
function solve(design: number[][], response: number[]): number[] | null {
  const width = design[0]?.length ?? 0;
  if (width === 0 || design.length <= width) return null;

  const normal = Array.from({ length: width }, () => new Array<number>(width + 1).fill(0));
  for (let row = 0; row < design.length; row++) {
    for (let a = 0; a < width; a++) {
      normal[a]![width] += design[row]![a]! * response[row]!;
      for (let b = 0; b < width; b++) normal[a]![b]! += design[row]![a]! * design[row]![b]!;
    }
  }

  for (let col = 0; col < width; col++) {
    let pivot = col;
    for (let row = col + 1; row < width; row++) {
      if (Math.abs(normal[row]![col]!) > Math.abs(normal[pivot]![col]!)) pivot = row;
    }
    [normal[col], normal[pivot]] = [normal[pivot]!, normal[col]!];
    if (Math.abs(normal[col]![col]!) < 1e-9) return null;
    for (let row = 0; row < width; row++) {
      if (row === col) continue;
      const factor = normal[row]![col]! / normal[col]![col]!;
      for (let j = col; j <= width; j++) normal[row]![j]! -= factor * normal[col]![j]!;
    }
  }
  return normal.map((row, i) => row[width]! / row[i]!);
}

/**
 * Tool results in the transcript are the UNTRUNCATED version; Claude Code sends a shortened one.
 * Pairs whose incoming context is small cannot be badly distorted by that, so the fit is
 * restricted to them. Without this filter the control coefficient lands near 0.007 instead of 1.
 */
const MAX_INCOMING_TOKENS = 1000;
const MAX_PLAUSIBLE_GROWTH = 200_000;

export function fitPersistence(
  sessions: readonly SessionAnalysis[],
  splits: ReadonlyMap<SessionAnalysis, ClassSplit>,
  calibration: number,
): PersistenceFit | null {
  const design: number[][] = [];
  const response: number[] = [];

  for (const session of sessions) {
    const split = splits.get(session);
    if (!split) continue;
    const prefixOf = (turn: Turn) =>
      turn.inputTokens + turn.cacheRead + turn.cacheWrite5m + turn.cacheWrite1h;

    for (let i = 0; i + 1 < session.turns.length; i++) {
      const from = session.turns[i]!;
      const to = session.turns[i + 1]!;
      if (from.model !== to.model) continue;

      const incoming = to.incomingLegacyTokens * calibration;
      if (incoming > MAX_INCOMING_TOKENS) continue;

      const growth = prefixOf(to) - prefixOf(from);
      if (growth <= 0 || growth > MAX_PLAUSIBLE_GROWTH) continue;

      design.push([1, split.reasoning[i]!, split.prose[i]!, split.toolCalls[i]!, incoming]);
      response.push(growth);
    }
  }

  // A class that never appears (a corpus with no tool calls, say) is an all-zero column and
  // makes the normal equations singular. Drop those columns and report them as 0.0 rather than
  // failing the whole fit — zero is the truthful coefficient for content that was never sent.
  const width = design[0]?.length ?? 0;
  const active: number[] = [];
  for (let col = 0; col < width; col++) {
    if (design.some((row) => row[col] !== 0)) active.push(col);
  }
  const reduced = solve(
    design.map((row) => active.map((col) => row[col]!)),
    response,
  );
  if (!reduced) return null;
  const beta = new Array<number>(width).fill(0);
  active.forEach((col, i) => (beta[col] = reduced[i]!));

  const mean = response.reduce((a, b) => a + b, 0) / response.length;
  let residual = 0;
  let total = 0;
  for (let row = 0; row < design.length; row++) {
    const predicted = design[row]!.reduce((sum, x, i) => sum + x * beta[i]!, 0);
    residual += (response[row]! - predicted) ** 2;
    total += (response[row]! - mean) ** 2;
  }

  return {
    pairs: design.length,
    coefficients: {
      intercept: beta[0]!,
      reasoning: beta[1]!,
      prose: beta[2]!,
      toolCalls: beta[3]!,
      incoming: beta[4]!,
    },
    rSquared: total === 0 ? 0 : 1 - residual / total,
  };
}

export interface Anatomy {
  label: string;
  sessions: number;
  turns: number;

  laneTokens: Record<Lane, number>;
  laneUSD: Record<Lane, number>;
  totalUSD: number;
  unpriced: boolean;

  classTokens: Record<ContentClass, number>;
  classOutputUSD: Record<ContentClass, number>;
  classLoadedUSD: Record<ContentClass, number>;
  overflowTokens: number;
  modelledSessions: number;

  tools: ToolStat[];
  toolCallTotal: number;
  persistence: PersistenceFit | null;
}

export async function anatomyOf(
  label: string,
  sessions: readonly SessionAnalysis[],
  counter: TokenCounter,
  calibration: number,
): Promise<Anatomy> {
  const lanesTokens = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
  const lanesUSD = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
  const classTokens = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ContentClass, number>;
  const classOutputUSD = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ContentClass, number>;
  const classLoadedUSD = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ContentClass, number>;

  let unpriced = false;
  let turns = 0;
  let overflowTokens = 0;
  let modelledSessions = 0;
  const splits = new Map<SessionAnalysis, ClassSplit>();

  for (const session of sessions) {
    turns += session.turns.length;
    for (const turn of session.turns) {
      for (const lane of LANES) {
        lanesTokens[lane] += laneTokens(turn, lane);
        const cost = priceOneLane(turn, lane);
        if (cost === null) unpriced = true;
        else lanesUSD[lane] += cost;
      }
    }

    const split = await splitOutput(session, counter);
    splits.set(session, split);
    overflowTokens += split.overflowTokens;

    let modelled = true;
    for (const contentClass of CLASSES) {
      const perTurn = split[contentClass];
      classTokens[contentClass] += perTurn.reduce((a, b) => a + b, 0);
      const cost = loadedCostOf(session.turns, perTurn);
      if (!cost) {
        modelled = false;
        continue;
      }
      classOutputUSD[contentClass] += cost.outputUSD;
      classLoadedUSD[contentClass] += cost.totalUSD;
    }
    if (modelled) modelledSessions++;
  }

  const tools = toolHistogram(sessions);
  return {
    label,
    sessions: sessions.length,
    turns,
    laneTokens: lanesTokens,
    laneUSD: lanesUSD,
    totalUSD: LANES.reduce((sum, lane) => sum + lanesUSD[lane], 0),
    unpriced,
    classTokens,
    classOutputUSD,
    classLoadedUSD,
    overflowTokens,
    modelledSessions,
    tools,
    toolCallTotal: tools.reduce((sum, tool) => sum + tool.calls, 0),
    persistence: fitPersistence(sessions, splits, calibration),
  };
}
