import assert from 'node:assert/strict';
import { test } from 'node:test';
import { price } from '../billing/pricing.js';
import { observedCost, replayDelta, replaySession, totalsOf } from './replay.js';
import type { Placement } from './replay.js';
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
  // the request has to be big enough to hold the tokens being taken out of it
  const turns = [
    turn({ outputTokens: 0, cacheWrite5m: 2000 }),
    turn({ index: 1, outputTokens: 0, cacheWrite5m: 500, cacheRead: 2000 }),
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
  assert.ok(dCold.totalUSD > dWarm.totalUSD, 'expired prefix must cost more than a cache hit');

  assert.ok(dCold.writeUSD > dWarm.writeUSD, 'a re-written prefix is billed in the WRITE lane');
  assert.ok(Math.abs(dCold.readUSD) < 1e-12, 'nothing was read back on a full cold start');
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

// --- the partial-expiry correction -------------------------------------------------------------
//
// Everything below this line exists because `cacheRead === 0` is not what a cache TTL expiry
// usually looks like. A partial expiry keeps the preamble breakpoint in the read lane and returns
// the conversation suffix as cache creation. See docs/replay-correction.md.

/** Prose divergence carried by one 100-token turn replayed at ratio 0.35, in tokens. */
const EXTRA = 100 * (1 / 0.35 - 1);

/**
 * A prefix that has already absorbed the counterfactual delta: turn 0 writes the prose, turn 1 is
 * a clean hit that carries it into the cached prefix. Whatever comes next is the transition under
 * test, and by then `inPrefix` is exactly EXTRA.
 */
const SEEDED = [
  turn({ outputTokens: 100, cacheWrite5m: 100_000 }), // requestSize 100_000
  turn({ index: 1, cacheWrite5m: 100, cacheRead: 100_000 }), // requestSize 100_100, nothing rewritten
];
const SEEDED_PROSE = [100, 0, 0];

/** The entry write: EXTRA tokens joining the prefix on turn 1, at the 5m multiplier. */
const ENTRY_WRITE = EXTRA * IN * 1.25;

function carried(turns: Turn[], prose: number[], placement?: Placement) {
  return replayDelta(
    turns,
    prose,
    () => 1 / 0.35,
    () => 0,
    placement,
  )!;
}

test('partial TTL rewrite: a surviving preamble does not make the suffix free', () => {
  // 26.5k of preamble still hits; the rest of the 100.1k prefix comes back as cache creation.
  const delta = carried(
    [...SEEDED, turn({ index: 2, cacheWrite5m: 73_600, cacheRead: 26_500 })],
    SEEDED_PROSE,
  );

  // requestSize is unchanged across the transition, so all 73_600 written tokens are a re-write.
  const share = 73_600 / 100_100;
  assert.ok(Math.abs(delta.writeUSD - (ENTRY_WRITE + EXTRA * share * IN * 1.25)) < 1e-15);
  assert.ok(Math.abs(delta.readUSD - EXTRA * (1 - share) * IN * 0.1) < 1e-15);

  // what that one transition now costs, against what the old all-read rule charged for it
  const crossing = delta.writeUSD - ENTRY_WRITE + delta.readUSD;
  assert.ok(crossing > 9 * (EXTRA * IN * 0.1), 'pricing a 74%-rewritten prefix as a read is 9x too cheap');
});

test('partial TTL rewrite is priced between a clean hit and a full cold start', () => {
  const hit = carried([...SEEDED, turn({ index: 2, cacheWrite5m: 100, cacheRead: 100_100 })], SEEDED_PROSE);
  const partial = carried(
    [...SEEDED, turn({ index: 2, cacheWrite5m: 73_600, cacheRead: 26_500 })],
    SEEDED_PROSE,
  );
  const cold = carried([...SEEDED, turn({ index: 2, cacheWrite5m: 100_100, cacheRead: 0 })], SEEDED_PROSE);

  assert.ok(hit.totalUSD < partial.totalUSD, 'a partial expiry costs more than a clean hit');
  assert.ok(partial.totalUSD < cold.totalUSD, 'a partial expiry costs less than losing the whole prefix');
});

test('regression: the observed 26.5k-read / 741k-write shape', () => {
  // The failure that surfaced the anatomy bug, reduced: a large tracked prefix, cache_read pinned
  // at the surviving preamble breakpoint, 741k coming back as cache creation, 2 tokens of incoming
  // payload. Turn 2 is that transition; the control replaces it with a clean hit of the same
  // prefix. The old replay charged the delta a 0.1x cache read either way, so the two were equal.
  const head = [
    turn({ outputTokens: 1000, cacheWrite5m: 700_000, inputTokens: 2 }), // requestSize   700_002
    turn({ index: 1, cacheWrite5m: 500, cacheRead: 700_000, inputTokens: 2 }), // requestSize 700_502
  ];
  const prose = [1000, 0, 0];
  const expired = turn({
    index: 2,
    outputTokens: 1204,
    cacheWrite5m: 741_117,
    cacheRead: 26_556,
    inputTokens: 2,
  });
  const control = turn({
    index: 2,
    outputTokens: 1204,
    cacheWrite5m: 500,
    cacheRead: 767_175,
    inputTokens: 2,
  });

  const dExpired = carried([...head, expired], prose);
  const dControl = carried([...head, control], prose);

  // requestSize 700_502 -> 767_675, so only 67_173 arrived and 673_944 of the write is prefix.
  const share = 673_944 / (26_556 + 673_944);
  assert.ok(share > 0.96, 'almost the whole surviving prefix was re-written, not read');

  const surcharge = dExpired.totalUSD - dControl.totalUSD;
  const asAllRead = 1000 * (1 / 0.35 - 1) * IN * 0.1;
  assert.ok(surcharge > 0, 'a 96%-rewritten prefix cannot cost the same as a clean cache hit');
  assert.ok(surcharge > 10 * asAllRead, 'the old all-read rule understated this crossing by over 10x');
  assert.ok(dExpired.readUSD > 0, 'the surviving preamble is still billed as a cheap read');
});

test('mixed 5m and 1h writes keep their distinct prices through a rewrite', () => {
  const mixed = carried(
    [...SEEDED, turn({ index: 2, cacheWrite5m: 36_800, cacheWrite1h: 36_800, cacheRead: 26_500 })],
    SEEDED_PROSE,
  );
  const only5m = carried(
    [...SEEDED, turn({ index: 2, cacheWrite5m: 73_600, cacheRead: 26_500 })],
    SEEDED_PROSE,
  );

  // identical tokens re-written, but half of them at 2.0x rather than 1.25x
  const share = 73_600 / 100_100;
  const blended = (1.25 + 2.0) / 2;
  assert.ok(Math.abs(mixed.writeUSD - only5m.writeUSD - EXTRA * share * IN * (blended - 1.25)) < 1e-15);
});

test('compaction stops the compacted delta from accumulating cost', () => {
  const kept = carried([...SEEDED, turn({ index: 2, cacheWrite5m: 100, cacheRead: 100_100 })], SEEDED_PROSE);
  // the prefix collapses to a fifth of its size
  const compacted = carried(
    [...SEEDED, turn({ index: 2, cacheWrite5m: 100, cacheRead: 20_000 })],
    SEEDED_PROSE,
  );

  assert.ok(compacted.readUSD < kept.readUSD, 'a dropped prefix stops being re-read');
  assert.ok(Math.abs(compacted.readUSD - kept.readUSD * (20_000 / 100_100)) < 1e-15);
});

test('compaction and fresh prose on the same transition', () => {
  const turns = [
    ...SEEDED,
    // the prefix compacts to 20.1k AND this turn writes new prose
    turn({ index: 2, outputTokens: 100, cacheWrite5m: 100, cacheRead: 20_000 }), // requestSize 20_100
    turn({ index: 3, cacheWrite5m: 100, cacheRead: 20_200 }), // requestSize 20_300
  ];
  const delta = carried(turns, [100, 0, 100, 0]);

  assert.ok(Math.abs(delta.outputUSD - 2 * EXTRA * OUT) < 1e-15, 'both prose turns are charged output');

  // turn 2 keeps 20_100/100_100 of the old delta and reads back the 20_000 of it that hit; turn 3
  // reads what turn 2 left. Turn 2's own prose is still a write on turn 3, never yet a read.
  const survived = EXTRA * (20_100 / 100_100);
  assert.ok(Math.abs(delta.readUSD - (EXTRA * (20_000 / 100_100) + survived) * IN * 0.1) < 1e-15);
  assert.ok(delta.readUSD < 2 * EXTRA * IN * 0.1, 'the compacted delta is cheaper than an intact one');
});

test('positive delta: reconstructing vanilla across a partial expiry', () => {
  const turns = [
    ...SEEDED.map((t) => ({ ...t, cavemanLive: true })),
    turn({ index: 2, cacheWrite5m: 73_600, cacheRead: 26_500, cavemanLive: true }),
  ];
  const session: SessionAnalysis = { sessionId: 'live', file: 'live', cavemanActive: true, turns };
  const result = replaySession(session, SEEDED_PROSE, () => PROSE_RATIO, NO_INJECTION, [0, 0, 0]);

  assert.equal(result.actualUSD, observedCost(turns).costUSD, 'the observed arm is untouched');
  assert.ok(result.vanillaUSD > result.actualUSD, 'vanilla wrote more prose, so it cost more');
  assert.ok(result.delta!.writeUSD > ENTRY_WRITE, 'the reconstructed prose is re-written, not only entered');
});

test('negative delta: projecting caveman onto a vanilla session across a partial expiry', () => {
  const turns = [...SEEDED, turn({ index: 2, cacheWrite5m: 73_600, cacheRead: 26_500 })];
  const session: SessionAnalysis = { sessionId: 'off', file: 'off', cavemanActive: false, turns };
  const result = replaySession(session, SEEDED_PROSE, () => PROSE_RATIO, NO_INJECTION, [0, 0, 0]);

  assert.equal(result.vanillaUSD, result.actualUSD, 'an inactive session already is vanilla');
  assert.ok(result.optimizedUSD < result.actualUSD, 'removing prose still saves');
  assert.ok(result.delta!.writeUSD < 0, 'the removed prose was going to be re-written, not just re-read');
  assert.ok(result.delta!.readUSD < 0, 'and part of it was going to be re-read');
});

test('a negative delta cannot make the counterfactual prefix negative', () => {
  // 5000 tokens of injection removed from a prefix that only ever holds 1000
  const turns = [
    turn({ cacheWrite5m: 1000 }),
    turn({ index: 1, cacheRead: 1000 }),
    turn({ index: 2, cacheRead: 1000 }),
  ];
  const delta = replayDelta(
    turns,
    [0, 0, 0],
    () => 1,
    (_turn, index) => (index === 0 ? -5000 : 0),
  )!;

  assert.ok(Number.isFinite(delta.totalUSD));
  assert.ok(delta.clampedTurns > 0, 'the impossible segment is reported, not silently priced');
  assert.ok(
    Math.abs(delta.writeUSD) <= 1000 * IN * 1.25 + 1e-15,
    'no more can be un-written than was written',
  );
  assert.ok(
    Math.abs(delta.readUSD) <= 1000 * IN * 0.1 * turns.length,
    'no more can be un-read than was there',
  );
});

test('one-time and per-prompt injections both cross a partial expiry', () => {
  const turns = [
    turn({ cacheWrite5m: 100_000, userPromptsBefore: 1 }),
    turn({ index: 1, cacheWrite5m: 100, cacheRead: 100_000, userPromptsBefore: 1 }),
    turn({ index: 2, cacheWrite5m: 73_600, cacheRead: 26_500, userPromptsBefore: 1 }),
  ];
  const profile: InjectionProfile = { oneTimeTokens: 462, perPromptTokens: 42, sessions: 1, borrowed: false };
  const session: SessionAnalysis = { sessionId: 'inj', file: 'inj', cavemanActive: false, turns };
  const result = replaySession(session, [0, 0, 0], () => 1, profile, [0, 0, 0]);

  // no prose moves, so every cent of this delta is the injected reminder being carried
  assert.ok(result.optimizedUSD > result.actualUSD, 'injecting a reminder costs money');
  assert.ok(result.delta!.writeUSD > 0, 'the reminder is written when it enters and again when rewritten');
  assert.ok(result.delta!.readUSD > 0, 'the part of it that survived the expiry is read back cheaply');

  // the 462-token preamble crosses the expiry; charging it as a pure read would be far cheaper
  const injected = 462 + 42;
  assert.ok(result.delta!.totalUSD > injected * IN * 1.25 + injected * IN * 0.1);
});

test('conservation: an unchanged replay is exactly the observed bill', () => {
  const turns = Array.from({ length: 200 }, (_unused, index) =>
    turn({
      index,
      outputTokens: 120,
      cacheWrite5m: index % 17 === 0 ? 60_000 : 400,
      cacheWrite1h: index % 29 === 0 ? 5_000 : 0,
      cacheRead: index === 0 ? 0 : index % 17 === 0 ? 26_500 : 1000 * index,
    }),
  );
  const prose = turns.map(() => 120);
  const delta = replayDelta(
    turns,
    prose,
    () => 1,
    () => 0,
  )!;
  assert.equal(delta.outputUSD, 0);
  assert.equal(delta.writeUSD, 0);
  assert.equal(delta.readUSD, 0);
  assert.equal(delta.totalUSD, 0);
  assert.equal(delta.clampedTurns, 0);

  const session: SessionAnalysis = { sessionId: 'long', file: 'long', cavemanActive: false, turns };
  const result = replaySession(
    session,
    prose,
    () => 1,
    NO_INJECTION,
    prose.map(() => 0),
  );
  assert.equal(result.optimizedUSD, result.actualUSD, 'no change replays to the observed bill');
});

test('conservation: every lane stays finite over a long session full of expiries', () => {
  const turns = Array.from({ length: 300 }, (_unused, index) =>
    turn({
      index,
      outputTokens: 120,
      // every 11th turn partially expires, every 23rd compacts
      cacheWrite5m: index % 11 === 0 ? 80_000 : 400,
      cacheRead: index === 0 ? 0 : index % 23 === 0 ? 5_000 : index % 11 === 0 ? 26_500 : 900 * index,
    }),
  );
  const prose = turns.map(() => 120);
  const delta = carried(turns, prose);

  for (const lane of [delta.outputUSD, delta.writeUSD, delta.readUSD, delta.totalUSD]) {
    assert.ok(Number.isFinite(lane), 'no NaN or Infinity in any lane');
  }
  assert.ok(delta.totalUSD > 0, 'writing more prose costs more, however the cache behaves');
  assert.ok(delta.readUSD >= 0 && delta.writeUSD >= 0, 'a positive delta cannot produce a credit');
  assert.ok(
    Math.abs(delta.totalUSD - (delta.outputUSD + delta.writeUSD + delta.readUSD)) < 1e-12,
    'the lanes sum to the total',
  );

  // determinism: same input, same output, twice
  assert.deepEqual(carried(turns, prose), delta);
});

test('placement bounds bracket the proportional estimate', () => {
  const turns = [
    turn({ outputTokens: 5000, cacheWrite5m: 100_000 }),
    turn({ index: 1, cacheWrite5m: 100, cacheRead: 100_000 }),
    turn({ index: 2, cacheWrite5m: 73_600, cacheRead: 26_500 }),
    turn({ index: 3, cacheWrite5m: 100, cacheRead: 100_100 }),
  ];
  const prose = [5000, 0, 0, 0];
  const low = carried(turns, prose, 'read');
  const mid = carried(turns, prose, 'proportional');
  const high = carried(turns, prose, 'rewrite');

  assert.ok(low.totalUSD < mid.totalUSD, 'read-concentrated is the cheap corner');
  assert.ok(mid.totalUSD < high.totalUSD, 'rewrite-concentrated is the dear corner');
  assert.equal(mid.totalUSD, carried(turns, prose).totalUSD, 'proportional is the default');
});

test('placement does not matter when the cache never partially expires', () => {
  const turns = [...SEEDED, turn({ index: 2, cacheWrite5m: 100, cacheRead: 100_100 })];
  const read = carried(turns, SEEDED_PROSE, 'read');
  const proportional = carried(turns, SEEDED_PROSE, 'proportional');
  const rewrite = carried(turns, SEEDED_PROSE, 'rewrite');

  assert.equal(read.totalUSD, proportional.totalUSD);
  assert.equal(proportional.totalUSD, rewrite.totalUSD);
});

test('placement does not matter on a full cold start either', () => {
  const turns = [...SEEDED, turn({ index: 2, cacheWrite5m: 100_100, cacheRead: 0 })];
  const read = carried(turns, SEEDED_PROSE, 'read');
  const rewrite = carried(turns, SEEDED_PROSE, 'rewrite');

  assert.equal(read.totalUSD, rewrite.totalUSD, 'nothing survived, so there is nowhere else to put it');
  assert.ok(Math.abs(read.readUSD) < 1e-15);
});
