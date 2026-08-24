import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitPersistence, loadedCostOf, splitOutput, toolHistogram, type ClassSplit } from './anatomy.js';
import type { SessionAnalysis, Turn } from '../transcript/session.js';
import type { TokenCounter } from '../transcript/tokens.js';

const MODEL = 'claude-opus-4-6';
const TS = new Date('2026-01-01T00:00:00Z');
const IN = 5 / 1_000_000;
const OUT = 25 / 1_000_000;

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    index: 0,
    id: 'msg_0',
    model: MODEL,
    timestamp: TS,
    proseText: '',
    onlyTextBlocks: false,
    hasToolUse: false,
    toolCalls: [],
    toolCallText: '',
    hasThinking: false,
    incomingLegacyTokens: 0,
    hasFence: false,
    outputTokens: 0,
    inputTokens: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    injectedOneTime: [],
    injectedPerTurn: [],
    userPromptsBefore: 0,
    cavemanLive: false,
    ...overrides,
  };
}

function session(turns: Turn[], file = 'f'): SessionAnalysis {
  return { sessionId: file, file, cavemanActive: false, turns };
}

/** One token per character, so the arithmetic in each test stays visible. */
const perChar: TokenCounter = { count: async (text: string) => text.length };

test('reasoning is the residual of billed output on turns that carried a thinking block', async () => {
  const split = await splitOutput(
    session([
      turn({
        outputTokens: 1000,
        proseText: 'x'.repeat(100),
        toolCallText: 'y'.repeat(200),
        hasThinking: true,
      }),
    ]),
    perChar,
  );
  assert.deepEqual(split.prose, [100]);
  assert.deepEqual(split.toolCalls, [200]);
  assert.deepEqual(split.reasoning, [700], '1000 billed minus 300 counted');
  assert.equal(split.overflowTokens, 0);
});

test('a turn with no thinking block is never credited with reasoning', async () => {
  const split = await splitOutput(
    session([turn({ outputTokens: 1000, proseText: 'x'.repeat(100), hasThinking: false })]),
    perChar,
  );
  assert.deepEqual(split.reasoning, [0], 'the 900 unaccounted tokens are calibration error, not thought');
});

test('counted text above billed output is floored and reported rather than hidden', async () => {
  const split = await splitOutput(
    session([turn({ outputTokens: 100, proseText: 'x'.repeat(250), hasThinking: true })]),
    perChar,
  );
  assert.deepEqual(split.reasoning, [0], 'a negative residual must not become negative tokens');
  assert.equal(split.overflowTokens, 150);
});

test('fully loaded cost charges output once, the cache write once, then a read per later turn', () => {
  const turns = [
    turn({ outputTokens: 100, cacheWrite5m: 500 }),
    turn({ index: 1, cacheWrite5m: 500, cacheRead: 1000 }),
    turn({ index: 2, cacheWrite5m: 500, cacheRead: 2000 }),
  ];
  const cost = loadedCostOf(turns, [100, 0, 0])!;

  assert.ok(Math.abs(cost.outputUSD - 100 * OUT) < 1e-12);
  // written at turn 2 (1.25x input), then read at turn 3 (0.1x input)
  const expected = 100 * OUT + 100 * IN * 1.25 + 100 * IN * 0.1;
  assert.ok(Math.abs(cost.totalUSD - expected) < 1e-12);
  assert.ok(cost.totalUSD > cost.outputUSD, 'compounding must never make output cheaper');
});

test('the longer the session, the more a single output token costs', () => {
  const short = [turn({ outputTokens: 100, cacheWrite5m: 500 }), turn({ index: 1, cacheRead: 1000 })];
  const long = [
    turn({ outputTokens: 100, cacheWrite5m: 500 }),
    turn({ index: 1, cacheRead: 1000 }),
    turn({ index: 2, cacheRead: 2000 }),
    turn({ index: 3, cacheRead: 3000 }),
  ];
  const a = loadedCostOf(short, [100, 0])!;
  const b = loadedCostOf(long, [100, 0, 0, 0])!;
  assert.ok(b.totalUSD > a.totalUSD, 'each extra turn re-reads the same tokens again');
  assert.equal(a.outputUSD.toFixed(12), b.outputUSD.toFixed(12), 'the output-rate leg is unchanged');
});

test('an unpriced model yields no loaded cost rather than a wrong one', () => {
  assert.equal(loadedCostOf([turn({ model: 'some-model-we-do-not-price', outputTokens: 100 })], [100]), null);
});

test('the tool histogram counts every call, and turns and sessions separately', () => {
  const stats = toolHistogram([
    session([turn({ toolCalls: ['Bash', 'Bash', 'Read'] }), turn({ index: 1, toolCalls: ['Bash'] })], 'a'),
    session([turn({ toolCalls: ['Read'] })], 'b'),
  ]);

  const bash = stats.find((s) => s.name === 'Bash')!;
  assert.equal(bash.calls, 3, 'two calls in one turn are two calls');
  assert.equal(bash.turns, 2, 'but that turn counts once');
  assert.equal(bash.sessions, 1);

  const read = stats.find((s) => s.name === 'Read')!;
  assert.equal(read.calls, 2);
  assert.equal(read.sessions, 2);
  assert.equal(stats[0]!.name, 'Bash', 'sorted by call count');
});

test('the persistence fit recovers coefficients from a prefix built to known rules', () => {
  // Build a session where every class is carried into the prefix in full, plus 50 fixed tokens
  // per turn. A fit that cannot recover this cannot be trusted on real transcripts.
  const FIXED = 50;
  const reasoning = [300, 120, 470, 90, 260, 180, 350, 210, 140, 400];
  const prose = [40, 90, 20, 130, 60, 110, 30, 150, 80, 70];
  const toolCalls = [70, 30, 160, 50, 140, 20, 90, 60, 110, 40];
  const incoming = [0, 200, 90, 310, 150, 260, 70, 330, 190, 240];

  let prefix = 10_000;
  const turns: Turn[] = [];
  for (let i = 0; i < reasoning.length; i++) {
    turns.push(turn({ index: i, id: `msg_${i}`, cacheRead: prefix, incomingLegacyTokens: incoming[i]! }));
    prefix += reasoning[i]! + prose[i]! + toolCalls[i]! + (incoming[i + 1] ?? 0) + FIXED;
  }

  const split: ClassSplit = { reasoning, prose, toolCalls, overflowTokens: 0 };
  const one = session(turns);
  const fit = fitPersistence([one], new Map([[one, split]]), 1)!;

  assert.equal(fit.pairs, reasoning.length - 1);
  assert.ok(fit.rSquared > 0.999, `expected a near-exact fit, got R² ${fit.rSquared}`);
  for (const name of ['reasoning', 'prose', 'toolCalls', 'incoming'] as const) {
    assert.ok(Math.abs(fit.coefficients[name] - 1) < 1e-6, `${name} should be carried in full`);
  }
  assert.ok(Math.abs(fit.coefficients.intercept - FIXED) < 1e-6);
});

test('a class that is dropped from the prefix fits near zero, which is the whole point', () => {
  const reasoning = [300, 120, 470, 90, 260, 180, 350, 210, 140, 400];
  const prose = [40, 90, 20, 130, 60, 110, 30, 150, 80, 70];

  let prefix = 10_000;
  const turns: Turn[] = [];
  for (let i = 0; i < reasoning.length; i++) {
    turns.push(turn({ index: i, id: `msg_${i}`, cacheRead: prefix }));
    // reasoning is generated but deliberately NOT carried forward
    prefix += prose[i]!;
  }

  const one = session(turns);
  const fit = fitPersistence(
    [one],
    new Map([[one, { reasoning, prose, toolCalls: prose.map(() => 0), overflowTokens: 0 }]]),
    1,
  )!;
  assert.ok(Math.abs(fit.coefficients.reasoning) < 1e-6, 'a dropped class must not be charged for re-reads');
  assert.ok(Math.abs(fit.coefficients.prose - 1) < 1e-6);
});

test('pairs whose incoming context is large are excluded, because the transcript over-reports it', () => {
  const turns = [
    turn({ index: 0, id: 'msg_0', cacheRead: 1000 }),
    turn({ index: 1, id: 'msg_1', cacheRead: 2000, incomingLegacyTokens: 50_000 }),
  ];
  const one = session(turns);
  const split: ClassSplit = { reasoning: [10, 10], prose: [10, 10], toolCalls: [0, 0], overflowTokens: 0 };
  assert.equal(
    fitPersistence([one], new Map([[one, split]]), 1),
    null,
    'the only pair is filtered, so nothing to fit',
  );
});
