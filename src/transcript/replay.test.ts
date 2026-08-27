import assert from 'node:assert/strict';
import { test } from 'node:test';
import { price } from '../billing/pricing.js';
import { observedCost, replayDelta, replaySession, totalsOf } from './replay.js';
import type { SessionAnalysis, Turn } from './session.js';
import type { InjectionProfile } from './injection.js';

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

const PROSE_RATIO = 0.35;
const NO_INJECTION: InjectionProfile = { oneTimeTokens: 0, perPromptTokens: 0, sessions: 0, borrowed: false };

test('observedCost reconciles against pricing.ts for every turn', () => {
  const turns = [
    turn({ outputTokens: 1000, cacheWrite5m: 2000, cacheRead: 10_000 }),
    turn({ index: 1, outputTokens: 500, cacheWrite1h: 1000, cacheRead: 12_000 }),
  ];
  const expected = turns.reduce((sum, t) => sum + price(t.model, t.timestamp, t).costUSD!, 0);
  assert.equal(observedCost(turns).costUSD, expected);
});

test('single turn: only the output side moves, nothing has entered the prefix yet', () => {
  const turns = [turn({ outputTokens: 100 })];
  const delta = replayDelta(
    turns,
    [100],
    () => 1 / 0.35,
    () => 0,
  )!;
  const expectedProse = 100 * (1 / 0.35 - 1);
  assert.ok(Math.abs(delta.outputUSD - expectedProse * OUT) < 1e-12);
  assert.equal(delta.writeUSD, 0);
  assert.equal(delta.readUSD, 0);
});

test('two turns: turn-1 prose is written at turn 2, still never read', () => {
  const turns = [
    turn({ outputTokens: 100, cacheWrite5m: 500 }),
    turn({ index: 1, outputTokens: 100, cacheWrite5m: 500, cacheRead: 1000 }),
  ];
  const delta = replayDelta(
    turns,
    [100, 100],
    () => 1 / 0.35,
    () => 0,
  )!;
  const perTurnProse = 100 * (1 / 0.35 - 1);

  assert.ok(Math.abs(delta.outputUSD - 2 * perTurnProse * OUT) < 1e-12);

  assert.ok(Math.abs(delta.writeUSD - perTurnProse * IN * 1.25) < 1e-12);

  assert.equal(delta.readUSD, 0);
});

test('three turns: divergence from turn 1 is re-read at turn 3 (the compounding term)', () => {
  const turns = [
    turn({ outputTokens: 100, cacheWrite5m: 500 }),
    turn({ index: 1, outputTokens: 0, cacheWrite5m: 500, cacheRead: 1000 }),
    turn({ index: 2, outputTokens: 0, cacheWrite5m: 500, cacheRead: 2000 }),
  ];
  const delta = replayDelta(
    turns,
    [100, 0, 0],
    () => 1 / 0.35,
    () => 0,
  )!;
  const extra = 100 * (1 / 0.35 - 1);
  assert.ok(Math.abs(delta.writeUSD - extra * IN * 1.25) < 1e-12);

  assert.ok(Math.abs(delta.readUSD - extra * IN * 0.1) < 1e-12);
});

test('injection-only: stripping injected tokens makes vanilla cheaper on that axis', () => {
  const turns = [
    turn({ outputTokens: 0, cacheWrite5m: 500 }),
    turn({ index: 1, outputTokens: 0, cacheWrite5m: 500, cacheRead: 1000 }),
  ];

  const delta = replayDelta(
    turns,
    [0, 0],
    () => 1 / 0.35,
    (_t, i) => (i === 0 ? -1000 : 0),
  )!;
  assert.equal(delta.outputUSD, 0);
  assert.ok(Math.abs(delta.writeUSD - -1000 * IN * 1.25) < 1e-12);
  assert.ok(Math.abs(delta.readUSD - -1000 * IN * 0.1) < 1e-12);
  assert.ok(delta.totalUSD < 0, 'removing injections must reduce the vanilla path');
});

test('1h TTL writes bill at 2.0x, not 1.25x', () => {
  const t5 = [turn({ outputTokens: 100, cacheWrite5m: 500 }), turn({ index: 1, cacheWrite5m: 500 })];
  const t1h = [turn({ outputTokens: 100, cacheWrite1h: 500 }), turn({ index: 1, cacheWrite1h: 500 })];
  const d5 = replayDelta(
    t5,
    [100, 0],
    () => 1 / 0.35,
    () => 0,
  )!;
  const d1h = replayDelta(
    t1h,
    [100, 0],
    () => 1 / 0.35,
    () => 0,
  )!;
  assert.ok(Math.abs(d1h.writeUSD / d5.writeUSD - 2.0 / 1.25) < 1e-9);
});

test('cold start re-writes the prefix instead of reading it', () => {
  const warm = [
    turn({ outputTokens: 100, cacheWrite5m: 500 }),
    turn({ index: 1, cacheWrite5m: 100, cacheRead: 5000 }),
    turn({ index: 2, cacheWrite5m: 100, cacheRead: 5000 }),
  ];
  const cold = [
    turn({ outputTokens: 100, cacheWrite5m: 500 }),
    turn({ index: 1, cacheWrite5m: 100, cacheRead: 5000 }),
    turn({ index: 2, cacheWrite5m: 5000, cacheRead: 0 }),
  ];
  const dWarm = replayDelta(
    warm,
    [100, 0, 0],
    () => 1 / 0.35,
    () => 0,
  )!;
  const dCold = replayDelta(
    cold,
    [100, 0, 0],
    () => 1 / 0.35,
    () => 0,
  )!;
  assert.ok(dCold.readUSD > dWarm.readUSD, 'expired prefix must cost more than a cache hit');
});

test('ON session models vanilla and leaves actual untouched', () => {
  const session: SessionAnalysis = {
    sessionId: 's1',
    file: 'f1',
    cavemanActive: true,
    turns: [turn({ outputTokens: 100, cacheWrite5m: 500 })],
  };
  const result = replaySession(session, [100], () => PROSE_RATIO, NO_INJECTION, [0]);
  assert.equal(result.actualUSD, observedCost(session.turns).costUSD);
  assert.equal(result.optimizedUSD, result.actualUSD, 'already optimized');
  assert.ok(result.vanillaUSD > result.actualUSD, 'vanilla writes more prose, so costs more');
});

test('OFF session models optimized and leaves vanilla equal to actual', () => {
  const session: SessionAnalysis = {
    sessionId: 's2',
    file: 'f2',
    cavemanActive: false,
    turns: [turn({ outputTokens: 100, cacheWrite5m: 500 })],
  };
  const result = replaySession(session, [100], () => PROSE_RATIO, NO_INJECTION, [0]);
  assert.equal(result.vanillaUSD, result.actualUSD, 'observed IS vanilla');
  assert.ok(result.optimizedUSD < result.actualUSD, 'compressing prose must cost less');
});

test('short OFF session can be net-negative once injection is priced in', () => {
  const session: SessionAnalysis = {
    sessionId: 's3',
    file: 'f3',
    cavemanActive: false,
    turns: [
      turn({ outputTokens: 10, cacheWrite5m: 500 }),
      turn({ index: 1, outputTokens: 10, cacheWrite5m: 500, cacheRead: 1000 }),
    ],
  };
  const profile: InjectionProfile = { oneTimeTokens: 1000, perPromptTokens: 0, sessions: 1, borrowed: false };
  const result = replaySession(session, [10, 10], () => PROSE_RATIO, profile, [0, 0]);
  assert.ok(result.optimizedUSD > result.actualUSD, 'a 2-turn session cannot amortise the one-time block');
});

test('totals use vanilla as the denominator', () => {
  const results = [
    {
      sessionId: 'a',
      file: 'a',
      cavemanActive: true,
      turns: 1,
      proseTokens: 0,
      userPrompts: 0,
      actualUSD: 75,
      paidUSD: 75,
      vanillaUSD: 100,
      optimizedUSD: 75,
      unpriced: false,
      modelled: true,
      delta: null,
    },
  ];
  const totals = totalsOf(results);
  assert.equal(totals.savedUSD, 25);
  assert.equal(totals.savedPct, 0.25, 'must divide by vanilla, not by actual');
  assert.equal(totals.misconfiguredUSD, 0, 'nothing was paid twice, so the two bases agree');
});

test('savings are measured against a correct install, not against what was overpaid', () => {
  const results = [
    {
      sessionId: 'a',
      file: 'a',
      cavemanActive: true,
      turns: 1,
      proseTokens: 0,
      userPrompts: 0,
      actualUSD: 75,
      paidUSD: 80,
      vanillaUSD: 100,
      optimizedUSD: 75,
      unpriced: false,
      modelled: true,
      delta: null,
    },
  ];
  const totals = totalsOf(results);
  assert.equal(totals.misconfiguredUSD, 5, 'the duplicate injection is reported, not hidden');
  assert.equal(totals.savedUSD, 25, 'savings compare vanilla to the corrected cost');
  assert.equal(totals.paidUSD, 80, 'the invoice is still recoverable');
});
