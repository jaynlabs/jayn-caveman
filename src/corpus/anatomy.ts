import { price } from '../billing/pricing.js';
import type { SessionAnalysis, Turn } from '../transcript/session.js';
import { requestSize } from '../transcript/transition.js';
import { memoCountTokens, type TokenCounter } from '../transcript/tokens.js';

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

interface ToolTokenSample {
  name: string;
  tokens: number;
}

interface ToolTurnBreakdown {
  calls: Map<string, number>;
  results: Map<string, number>;
  callSamples: ToolTokenSample[];
  resultSamples: ToolTokenSample[];
  incomingTokens: number;
}

interface ToolSessionBreakdown {
  turns: ToolTurnBreakdown[];
}

const addTo = (map: Map<string, number>, key: string, amount: number): void => {
  map.set(key, (map.get(key) ?? 0) + amount);
};

function toolBreakdown(
  session: SessionAnalysis,
  split: ClassSplit,
  calibration: number,
): ToolSessionBreakdown {
  const turns = session.turns.map((turn, turnIndex): ToolTurnBreakdown => {
    const calls = new Map<string, number>();
    const callParts = turn.toolCallDetails.map((detail) => ({
      name: detail.name,
      tokens: memoCountTokens(turn.toolCallText.slice(detail.start, detail.end)),
    }));
    const rawCallTokens = callParts.reduce((sum, call) => sum + call.tokens, 0);
    const billedCallTokens = split.toolCalls[turnIndex] ?? 0;
    const callSamples = callParts.map((call) => ({
      ...call,
      tokens:
        rawCallTokens > 0
          ? billedCallTokens * (call.tokens / rawCallTokens)
          : callParts.length > 0
            ? billedCallTokens / callParts.length
            : 0,
    }));
    for (const call of callSamples) {
      addTo(calls, call.name, call.tokens);
    }

    const results = new Map<string, number>();
    const resultSamples = turn.incomingToolResults.map((result) => ({
      name: result.name,
      tokens: result.legacyTokens * calibration,
    }));
    for (const result of resultSamples) {
      addTo(results, result.name, result.tokens);
    }

    return {
      calls,
      results,
      callSamples,
      resultSamples,
      incomingTokens: turn.incomingLegacyTokens * calibration,
    };
  });

  return { turns };
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
 * Where every billed token came from.
 *
 * Five origins: the session preamble (system prompt + tool definitions + first user message), the
 * model's own output echoed back — split into the same three classes — and everything fed in
 * (tool results, user text, hook injections, reminders).
 *
 * This replaces an earlier attempt that priced each class with `replayDelta`, charging it a
 * cache read on every remaining turn of the session. That overstates: real conversations compact,
 * get context-edited and lose their prefix, so tokens do not survive to the end. On this library
 * the modelled figure came out at 4.39x the output rate against a measured 2.43x.
 *
 * So nothing here is modelled. Writes are attributed by differencing `cache_creation` against the
 * previous turn's billed output. Reads are attributed by carrying the composition of the prefix
 * and splitting each turn's OBSERVED `cache_read` across it. `identityRatio` is the audit: the
 * carried composition divided by what was actually billed. Far from 1.0 means this is wrong.
 */
export type Origin = 'preamble' | ContentClass | 'fedIn';

export const ORIGINS: Origin[] = ['preamble', 'reasoning', 'prose', 'toolCalls', 'fedIn'];

export const ORIGIN_LABEL: Record<Origin, string> = {
  preamble: 'preamble (system+tools)',
  reasoning: 'reasoning, echoed back',
  prose: 'prose, echoed back',
  toolCalls: 'tool calls, echoed back',
  fedIn: 'fed in (tool results, you)',
};

export interface OriginTotals {
  written: number;
  read: number;
  writeUSD: number;
  readUSD: number;
}

export interface Attribution {
  origins: Record<Origin, OriginTotals>;
  /** The output lane alone, per class — what generating the tokens cost before any echo. */
  classOutputUSD: Record<ContentClass, number>;
  /** Carried prefix / billed cache_read. The audit on the whole read side. */
  identityRatio: number;
  /** Prefix tokens dropped because the billed prefix shrank: compaction and context editing. */
  compactedTokens: number;
  toolCosts: Map<string, ToolCostTotals>;
  unpriced: boolean;
}

export interface ToolCostTotals {
  results: number;
  callTokens: number;
  resultTokens: number;
  callWrittenTokens: number;
  callReadTokens: number;
  resultWrittenTokens: number;
  resultReadTokens: number;
  callOutputUSD: number;
  callWriteUSD: number;
  callReadUSD: number;
  resultWriteUSD: number;
  resultReadUSD: number;
  callSizes: number[];
  resultSizes: number[];
}

const isColdStart = (turn: Turn) => turn.cacheRead === 0 && turn.cacheWrite5m + turn.cacheWrite1h > 0;

function zeroOrigins(): Record<Origin, OriginTotals> {
  return Object.fromEntries(
    ORIGINS.map((origin) => [origin, { written: 0, read: 0, writeUSD: 0, readUSD: 0 }]),
  ) as Record<Origin, OriginTotals>;
}

function zeroToolCost(): ToolCostTotals {
  return {
    results: 0,
    callTokens: 0,
    resultTokens: 0,
    callWrittenTokens: 0,
    callReadTokens: 0,
    resultWrittenTokens: 0,
    resultReadTokens: 0,
    callOutputUSD: 0,
    callWriteUSD: 0,
    callReadUSD: 0,
    resultWriteUSD: 0,
    resultReadUSD: 0,
    callSizes: [],
    resultSizes: [],
  };
}

function toolCost(costs: Map<string, ToolCostTotals>, name: string): ToolCostTotals {
  const existing = costs.get(name);
  if (existing) return existing;
  const created = zeroToolCost();
  costs.set(name, created);
  return created;
}

function distribute(
  total: number,
  weights: ReadonlyMap<string, number>,
  visit: (name: string, tokens: number) => void,
) {
  const denominator = [...weights.values()].reduce((sum, tokens) => sum + tokens, 0);
  if (total <= 0 || denominator <= 0) return;
  for (const [name, weight] of weights) visit(name, total * (weight / denominator));
}

export function attribute(
  sessions: readonly SessionAnalysis[],
  splits: ReadonlyMap<SessionAnalysis, ClassSplit>,
  toolBreakdowns: ReadonlyMap<SessionAnalysis, ToolSessionBreakdown> = new Map(),
): Attribution {
  const origins = zeroOrigins();
  const toolCosts = new Map<string, ToolCostTotals>();
  const classOutputUSD = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ContentClass, number>;
  let carried = 0;
  let billedPrefix = 0;
  let compactedTokens = 0;
  let unpriced = false;

  for (const session of sessions) {
    const split = splits.get(session);
    const toolSplit = toolBreakdowns.get(session);
    const inPrefixOf = Object.fromEntries(ORIGINS.map((o) => [o, 0])) as Record<Origin, number>;
    const callPrefix = new Map<string, number>();
    const resultPrefix = new Map<string, number>();
    const sum = () => ORIGINS.reduce((total, o) => total + inPrefixOf[o], 0);

    for (const [i, turn] of session.turns.entries()) {
      const toolTurn = toolSplit?.turns[i];
      for (const call of toolTurn?.callSamples ?? []) {
        toolCost(toolCosts, call.name).callSizes.push(call.tokens);
      }
      for (const result of toolTurn?.resultSamples ?? []) {
        const tool = toolCost(toolCosts, result.name);
        tool.results++;
        tool.resultTokens += result.tokens;
        tool.resultSizes.push(result.tokens);
      }
      if (split) {
        for (const contentClass of CLASSES) {
          const tokens = split[contentClass][i] ?? 0;
          if (tokens <= 0) continue;
          const cost = price(turn.model, turn.timestamp, { ...ZERO, outputTokens: tokens }).costUSD;
          if (cost === null) unpriced = true;
          else classOutputUSD[contentClass] += cost;
          if (contentClass === 'toolCalls' && toolTurn) {
            distribute(tokens, toolTurn.calls, (name, allocated) => {
              const tool = toolCost(toolCosts, name);
              tool.callTokens += allocated;
              if (cost !== null) tool.callOutputUSD += cost * (allocated / tokens);
            });
          }
        }
      }

      // --- read side, against the prefix as the API actually billed it
      let inPrefix = sum();

      // The system prompt and tool schemas are usually still cached from an earlier session, so on
      // the very first turn they arrive as cache_read and never appear as cache_creation anywhere
      // in this one. Without seeding them the prefix is short by the whole preamble for every turn
      // that follows, not just this one. A resumed session's carried-in history lands here too.
      if (i === 0 && inPrefix === 0 && turn.cacheRead > 0) {
        inPrefixOf.preamble += turn.cacheRead + turn.inputTokens;
        inPrefix = sum();
      }

      // Audit before correcting anything: once the previous turn was attributed, the reconstruction
      // should equal the input the API charged for that request.
      const before = i > 0 ? session.turns[i - 1] : undefined;
      if (before) {
        carried += inPrefix;
        billedPrefix += requestSize(before);
      }

      // A prefix cannot exceed the request that carried it. The ceiling is the WHOLE request, not
      // the cache_read portion: after an idle gap the cache expires and most of the prefix returns
      // as cache_creation. That is a re-write, not a compaction, and clamping to cache_read would
      // throw the entire history away and re-invent it as freshly fed-in content.
      const ceiling = requestSize(turn);
      if (ceiling > 0 && inPrefix > ceiling) {
        // the prefix genuinely shrank: compaction, context editing, or a dropped prefix. Rescale so
        // later turns keep attributing against something real instead of a phantom history.
        compactedTokens += inPrefix - ceiling;
        const keep = ceiling / inPrefix;
        for (const origin of ORIGINS) inPrefixOf[origin] *= keep;
        for (const [name, tokens] of callPrefix) callPrefix.set(name, tokens * keep);
        for (const [name, tokens] of resultPrefix) resultPrefix.set(name, tokens * keep);
        inPrefix = ceiling;
      }
      if (turn.cacheRead > 0 && inPrefix > 0) {
        const cost = price(turn.model, turn.timestamp, { ...ZERO, cacheRead: turn.cacheRead }).costUSD;
        if (cost === null) unpriced = true;
        else {
          const perToken = cost / turn.cacheRead;
          for (const origin of ORIGINS) {
            const tokens = turn.cacheRead * (inPrefixOf[origin] / inPrefix);
            origins[origin].read += tokens;
            origins[origin].readUSD += tokens * perToken;
          }
          for (const [name, amount] of callPrefix) {
            const tokens = turn.cacheRead * (amount / inPrefix);
            const tool = toolCost(toolCosts, name);
            tool.callReadTokens += tokens;
            tool.callReadUSD += tokens * perToken;
          }
          for (const [name, amount] of resultPrefix) {
            const tokens = turn.cacheRead * (amount / inPrefix);
            const tool = toolCost(toolCosts, name);
            tool.resultReadTokens += tokens;
            tool.resultReadUSD += tokens * perToken;
          }
        }
      }

      // --- write side, by differencing against the previous turn's output
      const write = turn.cacheWrite5m + turn.cacheWrite1h;
      if (write === 0) continue;
      const writeCost = price(turn.model, turn.timestamp, {
        ...ZERO,
        cacheWrite5m: turn.cacheWrite5m,
        cacheWrite1h: turn.cacheWrite1h,
      }).costUSD;
      if (writeCost === null) {
        unpriced = true;
        continue;
      }
      const perWrite = writeCost / write;
      const add = (origin: Origin, tokens: number) => {
        origins[origin].written += tokens;
        origins[origin].writeUSD += tokens * perWrite;
        inPrefixOf[origin] += tokens;
      };
      const addCall = (name: string, tokens: number) => {
        const tool = toolCost(toolCosts, name);
        tool.callWrittenTokens += tokens;
        tool.callWriteUSD += tokens * perWrite;
        addTo(callPrefix, name, tokens);
      };
      const addResult = (name: string, tokens: number) => {
        const tool = toolCost(toolCosts, name);
        tool.resultWrittenTokens += tokens;
        tool.resultWriteUSD += tokens * perWrite;
        addTo(resultPrefix, name, tokens);
      };

      // Re-writing prefix that already exists does not add new content: charge the tokens back to
      // whatever is already in there, proportionally, and leave the prefix composition alone.
      const rewrite = (amount: number) => {
        if (amount <= 0) return;
        const total = sum();
        if (total <= 0) {
          add('fedIn', amount);
          return;
        }
        for (const origin of ORIGINS) {
          const tokens = amount * (inPrefixOf[origin] / total);
          origins[origin].written += tokens;
          origins[origin].writeUSD += tokens * perWrite;
        }
        for (const [name, weight] of callPrefix) {
          const tokens = amount * (weight / total);
          const tool = toolCost(toolCosts, name);
          tool.callWrittenTokens += tokens;
          tool.callWriteUSD += tokens * perWrite;
        }
        for (const [name, weight] of resultPrefix) {
          const tokens = amount * (weight / total);
          const tool = toolCost(toolCosts, name);
          tool.resultWrittenTokens += tokens;
          tool.resultWriteUSD += tokens * perWrite;
        }
      };

      const prev = i > 0 ? session.turns[i - 1] : undefined;
      if (prev && isColdStart(turn)) {
        // the whole prefix was re-written after expiry, not just the new part
        rewrite(write);
        continue;
      }
      if (!prev) {
        add('preamble', write);
        continue;
      }

      // How much of this write is genuinely new content, decided by billing rather than by the
      // transcript. cache_read + cache_creation + input is the whole request, and that total is
      // invariant to how a TTL expiry splits tokens between read and write — so its turn-to-turn
      // delta is what actually arrived. Anything written beyond it is prefix being re-written.
      const attributable = Math.min(write, Math.max(0, requestSize(turn) - requestSize(prev)));
      const echoed = Math.min(attributable, prev.outputTokens);
      let toolEchoed = 0;
      if (echoed > 0) {
        const prior = CLASSES.map((c) => split?.[c][i - 1] ?? 0);
        const denominator = prior.reduce((a, b) => a + b, 0);
        if (denominator > 0) {
          CLASSES.forEach((contentClass, k) => {
            const tokens = echoed * (prior[k]! / denominator);
            add(contentClass, tokens);
            if (contentClass === 'toolCalls') toolEchoed = tokens;
          });
        } else add('fedIn', echoed); // output we could not classify; do not credit it to a class
      }
      const previousTools = toolSplit?.turns[i - 1];
      if (previousTools) distribute(toolEchoed, previousTools.calls, (name, tokens) => addCall(name, tokens));

      // Re-writes are invisible to isColdStart, which requires cache_read to be zero, but routine
      // once a session carries several cache breakpoints. Charging them to fedIn credits the whole
      // prefix to tool results and starves every other origin.
      rewrite(write - attributable);
      const fedIn = attributable - echoed;
      add('fedIn', fedIn);
      if (toolTurn) {
        const resultSeen = [...toolTurn.results.values()].reduce((sum, tokens) => sum + tokens, 0);
        const resultShare =
          resultSeen <= 0
            ? 0
            : toolTurn.incomingTokens > 0
              ? Math.min(1, resultSeen / toolTurn.incomingTokens)
              : 1;
        distribute(fedIn * resultShare, toolTurn.results, (name, tokens) => addResult(name, tokens));
      }
    }
  }

  return {
    origins,
    classOutputUSD,
    identityRatio: billedPrefix === 0 ? 1 : carried / billedPrefix,
    compactedTokens,
    toolCosts,
    unpriced,
  };
}

export interface ToolStat {
  name: string;
  calls: number;
  results: number;
  sessions: number;
  turns: number;
  callTokens: number;
  resultTokens: number;
  callWrittenTokens: number;
  callReadTokens: number;
  resultWrittenTokens: number;
  resultReadTokens: number;
  callP50Tokens: number;
  callP95Tokens: number;
  resultP50Tokens: number;
  resultP95Tokens: number;
  callOutputUSD: number;
  callWriteUSD: number;
  callReadUSD: number;
  resultWriteUSD: number;
  resultReadUSD: number;
  callTotalUSD: number;
  resultTotalUSD: number;
  totalUSD: number;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

export function toolHistogram(
  sessions: readonly SessionAnalysis[],
  costs: ReadonlyMap<string, ToolCostTotals> = new Map(),
): ToolStat[] {
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

  const names = new Set([...calls.keys(), ...costs.keys()]);
  return [...names]
    .map((name) => {
      const cost = costs.get(name) ?? zeroToolCost();
      const callTotalUSD = cost.callOutputUSD + cost.callWriteUSD + cost.callReadUSD;
      const resultTotalUSD = cost.resultWriteUSD + cost.resultReadUSD;
      return {
        name,
        calls: calls.get(name) ?? 0,
        results: cost.results,
        sessions: sessionsWith.get(name)?.size ?? 0,
        turns: turns.get(name) ?? 0,
        callTokens: cost.callTokens,
        resultTokens: cost.resultTokens,
        callWrittenTokens: cost.callWrittenTokens,
        callReadTokens: cost.callReadTokens,
        resultWrittenTokens: cost.resultWrittenTokens,
        resultReadTokens: cost.resultReadTokens,
        callP50Tokens: percentile(cost.callSizes, 0.5),
        callP95Tokens: percentile(cost.callSizes, 0.95),
        resultP50Tokens: percentile(cost.resultSizes, 0.5),
        resultP95Tokens: percentile(cost.resultSizes, 0.95),
        callOutputUSD: cost.callOutputUSD,
        callWriteUSD: cost.callWriteUSD,
        callReadUSD: cost.callReadUSD,
        resultWriteUSD: cost.resultWriteUSD,
        resultReadUSD: cost.resultReadUSD,
        callTotalUSD,
        resultTotalUSD,
        totalUSD: callTotalUSD + resultTotalUSD,
      };
    })
    .sort((a, b) => b.totalUSD - a.totalUSD || b.calls - a.calls || a.name.localeCompare(b.name));
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

  origins: Record<Origin, OriginTotals>;
  originUSD: Record<Origin, number>;
  identityRatio: number;
  compactedTokens: number;

  tools: ToolStat[];
  toolCallTotal: number;
  toolResultTotal: number;
  toolCallBillUSD: number;
  toolResultBillUSD: number;
  toolBillUSD: number;
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

  let unpriced = false;
  let turns = 0;
  let overflowTokens = 0;
  const splits = new Map<SessionAnalysis, ClassSplit>();
  const toolBreakdowns = new Map<SessionAnalysis, ToolSessionBreakdown>();

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
    toolBreakdowns.set(session, toolBreakdown(session, split, calibration));
    overflowTokens += split.overflowTokens;
    for (const contentClass of CLASSES) {
      classTokens[contentClass] += split[contentClass].reduce((a, b) => a + b, 0);
    }
  }

  const attributed = attribute(sessions, splits, toolBreakdowns);
  const originUSD = Object.fromEntries(
    ORIGINS.map((origin) => [
      origin,
      attributed.origins[origin].writeUSD + attributed.origins[origin].readUSD,
    ]),
  ) as Record<Origin, number>;

  // A class costs the output lane once, then the write and every re-read of the echo. Both legs
  // are measured; neither is projected forward to the end of the session.
  const classLoadedUSD = Object.fromEntries(
    CLASSES.map((c) => [c, attributed.classOutputUSD[c] + originUSD[c]]),
  ) as Record<ContentClass, number>;

  const tools = toolHistogram(sessions, attributed.toolCosts);
  return {
    label,
    sessions: sessions.length,
    turns,
    laneTokens: lanesTokens,
    laneUSD: lanesUSD,
    totalUSD: LANES.reduce((sum, lane) => sum + lanesUSD[lane], 0),
    unpriced: unpriced || attributed.unpriced,
    classTokens,
    classOutputUSD: attributed.classOutputUSD,
    classLoadedUSD,
    overflowTokens,
    origins: attributed.origins,
    originUSD,
    identityRatio: attributed.identityRatio,
    compactedTokens: attributed.compactedTokens,
    tools,
    toolCallTotal: tools.reduce((sum, tool) => sum + tool.calls, 0),
    toolResultTotal: tools.reduce((sum, tool) => sum + tool.results, 0),
    toolCallBillUSD: tools.reduce((sum, tool) => sum + tool.callTotalUSD, 0),
    toolResultBillUSD: tools.reduce((sum, tool) => sum + tool.resultTotalUSD, 0),
    toolBillUSD: tools.reduce((sum, tool) => sum + tool.totalUSD, 0),
    persistence: fitPersistence(sessions, splits, calibration),
  };
}
