import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anatomyOf,
  attribute,
  fitPersistence,
  splitOutput,
  toolHistogram,
  type ClassSplit,
} from './anatomy.js';
import type { SessionAnalysis, Turn } from '../transcript/session.js';
import type { TokenCounter } from '../transcript/tokens.js';

const MODEL = 'claude-opus-4-6';
const TS = new Date('2026-01-01T00:00:00Z');

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
    toolCallDetails: [],
    hasThinking: false,
    incomingLegacyTokens: 0,
    incomingToolResults: [],
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

test('tool calls and results keep their cache costs separate', async () => {
  const writeCall = 'w'.repeat(100);
  const bashCall = 'b'.repeat(10);
  const report = await anatomyOf(
    'tools',
    [
      session([
        turn({
          id: 'msg_0',
          outputTokens: 100,
          cacheWrite1h: 1000,
          hasToolUse: true,
          toolCalls: ['Write'],
          toolCallText: writeCall,
          toolCallDetails: [{ id: 'write-1', name: 'Write', start: 0, end: writeCall.length }],
        }),
        turn({
          index: 1,
          id: 'msg_1',
          outputTokens: 10,
          cacheRead: 1000,
          cacheWrite1h: 400,
          hasToolUse: true,
          toolCalls: ['Bash'],
          toolCallText: bashCall,
          toolCallDetails: [{ id: 'bash-1', name: 'Bash', start: 0, end: bashCall.length }],
          incomingLegacyTokens: 300,
          incomingToolResults: [{ toolUseId: 'write-1', name: 'Write', legacyTokens: 300 }],
        }),
        turn({
          index: 2,
          id: 'msg_2',
          outputTokens: 1,
          proseText: 'x',
          cacheRead: 1400,
          cacheWrite1h: 10,
        }),
      ]),
    ],
    perChar,
    1,
  );

  const write = report.tools.find((tool) => tool.name === 'Write')!;
  assert.equal(write.callTokens, 100);
  assert.equal(write.results, 1);
  assert.equal(write.resultTokens, 300);
  assert.equal(write.callWrittenTokens, 100);
  assert.equal(write.resultWrittenTokens, 300);
  assert.equal(write.callReadTokens, 100);
  assert.equal(write.resultReadTokens, 300);
  assert.equal(write.callP50Tokens, 100);
  assert.equal(write.callP95Tokens, 100);
  assert.equal(write.resultP50Tokens, 300);
  assert.equal(write.resultP95Tokens, 300);
  assert.equal(write.callTotalUSD, write.callOutputUSD + write.callWriteUSD + write.callReadUSD);
  assert.equal(write.resultTotalUSD, write.resultWriteUSD + write.resultReadUSD);
  assert.equal(write.totalUSD, write.callTotalUSD + write.resultTotalUSD);
  assert.equal(report.tools[0]!.name, 'Write', 'dollar contribution, not call count, determines order');
  assert.equal(report.toolResultTotal, 1);
  assert.ok(
    Math.abs(report.toolBillUSD - report.toolCallBillUSD - report.toolResultBillUSD) < 1e-12,
    'the old combined subtotal remains a reconciliation check',
  );
  assert.ok(report.toolBillUSD > write.totalUSD, 'the subtotal includes the smaller Bash exchange too');
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

test('attribution splits a turn between the preamble, the echo of prior output, and what was fed in', () => {
  // turn 0 writes the preamble; turn 1 writes back turn 0's 100 output tokens plus 400 fed in
  const turns = [
    turn({ index: 0, id: 'msg_0', outputTokens: 100, cacheWrite1h: 1000 }),
    turn({ index: 1, id: 'msg_1', outputTokens: 0, cacheWrite1h: 500, cacheRead: 1000 }),
  ];
  const one = session(turns);
  const split: ClassSplit = { reasoning: [60, 0], prose: [40, 0], toolCalls: [0, 0], overflowTokens: 0 };
  const a = attribute([one], new Map([[one, split]]));

  assert.equal(a.origins.preamble.written, 1000);
  assert.equal(a.origins.fedIn.written, 400, '500 written minus the 100 echoed');
  assert.equal(a.origins.reasoning.written, 60, 'echo split 60/40 by the class mix of turn 0');
  assert.equal(a.origins.prose.written, 40);
  // turn 1 read the 1000-token preamble and nothing else was in the prefix yet
  assert.equal(a.origins.preamble.read, 1000);
  assert.equal(a.origins.fedIn.read, 0);
});

test('reads are charged against the real prefix, never projected to the end of the session', () => {
  // 100 output tokens at turn 0, then two turns that read a prefix which never grows
  const turns = [
    turn({ index: 0, id: 'msg_0', outputTokens: 100, cacheWrite1h: 100 }),
    turn({ index: 1, id: 'msg_1', cacheRead: 100 }),
    turn({ index: 2, id: 'msg_2', cacheRead: 100 }),
  ];
  const one = session(turns);
  const split: ClassSplit = {
    reasoning: [0, 0, 0],
    prose: [100, 0, 0],
    toolCalls: [0, 0, 0],
    overflowTokens: 0,
  };
  const a = attribute([one], new Map([[one, split]]));
  assert.equal(a.origins.preamble.read + a.origins.prose.read, 200, 'exactly the two billed reads');
  assert.equal(a.identityRatio, 1, 'carried prefix must equal what was billed');
});

test('a prefix that shrank is rescaled to the billed size instead of inventing history', () => {
  const turns = [
    turn({ index: 0, id: 'msg_0', outputTokens: 0, cacheWrite1h: 10_000 }),
    turn({ index: 1, id: 'msg_1', cacheRead: 2000 }), // compacted: 10k prefix became 2k
  ];
  const one = session(turns);
  const split: ClassSplit = { reasoning: [0, 0], prose: [0, 0], toolCalls: [0, 0], overflowTokens: 0 };
  const a = attribute([one], new Map([[one, split]]));
  assert.equal(a.compactedTokens, 8000);
  assert.equal(a.identityRatio, 1, 'after rescaling, the carry matches the bill exactly');
  assert.equal(a.origins.preamble.read, 2000, 'only what was billed is attributed');
});

test('output the split could not classify is not credited to any class', () => {
  const turns = [
    turn({ index: 0, id: 'msg_0', outputTokens: 100, cacheWrite1h: 100 }),
    turn({ index: 1, id: 'msg_1', cacheWrite1h: 100, cacheRead: 100 }),
  ];
  const one = session(turns);
  const split: ClassSplit = { reasoning: [0, 0], prose: [0, 0], toolCalls: [0, 0], overflowTokens: 0 };
  const a = attribute([one], new Map([[one, split]]));
  assert.equal(a.origins.reasoning.written + a.origins.prose.written + a.origins.toolCalls.written, 0);
  assert.equal(a.origins.fedIn.written, 100, 'unclassified echo falls through to fedIn');
});
