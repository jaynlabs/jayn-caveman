# The counterfactual replay was priced against a cold-start test that never fires

**Date:** 2026-08-28
**Touches:** `src/transcript/replay.ts`, `src/transcript/transition.ts` (new), `tools/`
**Follows:** the `anatomy` correction of 2026-08-27, written up in
`jayn-headroom/docs/anatomy-correction.md`

---

## 1. What was wrong

`anatomy` was corrected after discovering that a partial cache expiry usually looks like

```text
cache_read     ~= the surviving preamble breakpoint  (~26.5k)
cache_creation ~= the rewritten conversation suffix  (200k - 741k)
```

so a test of `cacheRead === 0` cannot see it. `replayDelta` still carried that test:

```ts
readUSD += inPrefix * rates.input * (isColdStart(turn) ? cw : rates.read);
```

Every counterfactual token accumulated in the prefix was therefore billed a 0.1x cache read on
every later turn, unless the read lane happened to be exactly zero.

Counted across the corpora the blog prices (`tools/transitions.ts`):

| transition                                | vanilla four | caveman-live |
| ----------------------------------------- | -----------: | -----------: |
| full cold start — what `isColdStart` sees |         0.1% |         4.1% |
| partial TTL rewrite                       |        47.0% |        23.5% |
| compaction + rewrite together             |         8.8% |         5.5% |
| **prefix re-written rather than read**    |    **54.1%** |    **31.9%** |

Shares are of all billed cache creation. On the vanilla corpora a full cold start occurs on
**1 transition in 24,650**, while **54% of cache creation is prefix being written a second
time**. The replay charged 0.1x for essentially all of it.

## 2. What the bill can and cannot identify

The usable identity is the one the `anatomy` fix turned on:

```text
requestSize = cache_read + cache_creation_5m + cache_creation_1h + input
```

That total is invariant to how a TTL expiry splits tokens between the read lane and the write
lane, so its turn-to-turn delta is what genuinely **arrived**. Everything written beyond it is
prefix being re-written. From two consecutive turns:

```text
arrived   = requestSize(turn) − requestSize(prev)
rewritten = max(0, written(turn) − max(0, arrived))
present   = cache_read(turn) + rewritten          # of the old prefix, what still exists
```

giving two ratios, both exact:

- `rewriteShare  = rewritten / present` — of the surviving prefix, how much was re-written.
  0 on a clean hit, 1 on a full cold start, strictly between on a partial expiry.
- `survivingShare = present / requestSize(prev)` — how much of the old prefix is still there at
  all. Below 1 only on genuine compaction; a cold start re-writes everything but loses nothing.

**What this cannot identify.** The usage totals say _how much_ of the prefix was re-written.
They do not say _where_ — which byte ranges landed in the read lane and which in the write lane.
A counterfactual delta token is somewhere in that prefix, and its price depends on which region
it is in. Nothing in the recorded usage resolves that, so it is carried as a sensitivity range
(§6) rather than asserted.

Fresh input is excluded from the region model: `input` is 0.0% of the whole request on every
corpus measured, being only the un-cached tail after the last cache breakpoint.

## 3. Invariants

Stated before the implementation, and each one is a test in `src/transcript/replay.test.ts`.

1. **The observed arm's bill is never touched.** `observedCost` is the recorded usage priced by
   `pricing.ts`; the replay only ever adds a modelled delta beside it.
2. **Only the counterfactual token delta is modelled** — never the whole prefix.
3. **Counterfactual output tokens are charged at the output rate**, once, on the turn that
   writes them.
4. **New delta tokens are charged the write multiplier when they enter the cached prefix**,
   blended across the 5m and 1h lanes in the proportion the turn actually used.
5. **Surviving delta tokens receive the observed read/write treatment of their prefix region** —
   `rewriteShare` of them at the write multiplier, the rest at the read rate.
6. **Partial expiry is neither an all-read nor an all-rewrite event.** This is the correction.
7. **Compacted-away delta stops accumulating cost**: the accumulated delta is scaled by
   `survivingShare` before it is priced, so tokens the conversation dropped stop being billed.
8. **A negative delta cannot create a negative cache segment.** The counterfactual prefix is
   `observed prefix + delta`; the delta is clamped so that sum stays at or above zero.
9. **Five-minute and one-hour writes keep their distinct prices** — 1.25x and 2x are blended by
   observed volume, never collapsed to one rate.
10. **Conservation**: with a ratio of 1 and no injections the delta is exactly zero, and the
    replayed total equals the observed bill.

## 4. The correction

`replayDelta` keeps its shape. The single all-or-nothing line

```ts
readUSD += inPrefix * rates.input * (isColdStart(turn) ? cw : rates.read);
```

becomes a three-step treatment of the accumulated delta, in this order:

```ts
inPrefix *= survivingShare(prev, turn); // 7 — compaction drops delta too
const share = placed(rewriteShare(prev, turn)); // 5, 6 — split, do not choose
writeUSD += inPrefix * share * rates.input * cw;
readUSD += inPrefix * (1 - share) * rates.input * rates.read;
```

`anatomy.ts` was deliberately not copied. It attributes an observed bill across origins, and
must therefore conserve — every token of `cache_creation` has to land on somebody. The replay
prices a delta that is not in the bill at all, so it conserves nothing and instead has to answer
a question `anatomy` never asks: which _region_ of the prefix a hypothetical token sits in. The
shared part — the `requestSize` identity — is factored into `src/transcript/transition.ts` so
the two cannot drift; the attribution rules stay separate.

## 5. Placement, and why it is a range

`rewriteShare` says what fraction of the surviving prefix was re-written. It does not say
whether the delta is in that fraction. Three defensible placements bound it:

| placement                | rewritten fraction of a delta `d` | reads as                                                                   |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------- |
| **read-concentrated**    | `max(0, d − cache_read) / d`      | lower bound: the delta sits in the surviving region and is re-read cheaply |
| **proportional**         | `rewritten / present`             | the delta is spread through the prefix like everything else                |
| **rewrite-concentrated** | `min(d, rewritten) / d`           | upper bound: the delta sits in the expired suffix and is re-written        |

Proportional is the reported point estimate: prose and injected reminders are distributed
through a conversation rather than concentrated at either end, and it is the only one of the
three that does not assume knowledge the usage totals do not contain. The two corners are
reported beside it in §6 rather than discarded.

The spread is not academic. On a partial rewrite the share of the surviving prefix that was
re-written is strongly bimodal — pooled p25 0.4%, p50 7.0%, p75 74.4%, p95 94.1% — so a turn is
usually near one corner or the other, and only the aggregate is near the middle.

## 6. Results

Baseline and corrected runs are in `out/before/` and `out/after/`, each with a `PROVENANCE.txt`
recording the git revision, the node version and the exact roots. Both were run with
`--model claude-opus-5`; the corrected figures below are the `proportional` placement.

### The tests

The suite is 153 tests. Against the **old** replay 12 of them fail
(`out/before/test-new-suite.txt`), including `regression: the observed 26.5k-read / 741k-write
shape` — a prefix already carrying a delta, crossing a turn shaped like the transition §1 opens
with. The old code prices that turn identically to a clean cache hit; the new one charges the
surcharge the write lane actually billed. Two more pin the anatomy side of the same identity — a
partial expiry must not be read as a compaction, and only the growth in `requestSize` is new
content — and both fail against the old attribution. Against the corrected code all 153 pass, and
`format:check`, lint, typecheck and `curves --check` are clean.

### What moved

| figure                               | before                                | after                                 |
| ------------------------------------ | ------------------------------------- | ------------------------------------- |
| always-fire, pooled                  | +$42.93 · +0.79%                      | **+$36.61 · +0.67%**                  |
| measured `p_fire`, pooled            | −$0.34 · −0.01%                       | **−$0.24 · −0.00%**                   |
| gauthier (84% of the bill)           | +$3.34 · +0.07%                       | +$2.94 · +0.06%                       |
| corpus-5                             | −$3.68 · −0.59%                       | −$3.15 · −0.51%                       |
| amplified ceiling, by corpus         | 2.3 / 9.1 / 2.3 / 2.6%                | **2.5 / 4.2 / 2.7 / 2.7%**            |
| amplified ceiling, pooled            | 3.1%                                  | **2.7%**                              |
| break-even crossing                  | 400–600                               | **600–800**                           |
| caveman-live: vanilla / saved        | $755.53 / $4.84                       | $755.46 / $4.74                       |
| savings decomposition (caveman-live) | output $2.00, write $0.02, read $0.01 | output $2.00, write $0.06, read $0.04 |

Everything measured rather than replayed is unchanged, which is the check that the correction
touched only pricing: the bills ($4578.70 / $623.58 / $131.84 / $97.65 / $5431.76), the session
counts (504 English, 108 caveman-live of which 98 ran the tool), mean `p_fire` per corpus
(48.9 / 24.7 / 30.7 / 43.5 / 45.4%), the token-weighted 50.6%, the 1,269 excluded sessions worth
$48.96, and the output-only prose share (1.0 / 0.8 / 0.4 / 1.1 / 0.9%).

### Which part of the correction did what

`tools/ablation.ts` prices the amplified ceiling with each half switched on alone. The `old`
column reproduces the published figures exactly, which is what makes the rest readable
(`out/after/ceiling-ablation.txt`):

```text
  corpus                 old     + rewrite  + compaction       + clamp     corrected
  gauthier              2.3%          2.5%          2.3%          2.3%          2.5%
  corpus-5              9.1%         11.6%          3.5%          6.0%          4.2%
  corpus-6              2.3%          2.7%          2.3%          2.3%          2.7%
  jrigal                2.6%          3.0%          2.3%          2.6%          2.7%
  all                   3.1%          3.6%          2.4%          2.7%          2.7%
```

The three corrections pull in opposite directions, which is why the headline barely moved while
one corpus halved. Pricing partial rewrites raises every figure. Scaling the accumulated delta by
`survivingShare` lowers them, and it dominates: corpus-5's 9.1% ceiling was mostly a delta that
never shrank when the conversation compacted, compounded by a delta allowed to grow past the
prefix it lived in. Correcting only the thing that started this investigation would have pushed
that corpus to 11.6% — the wrong direction, confidently.

### Sensitivity across placements

| figure                    | read                | proportional        | rewrite             |
| ------------------------- | ------------------- | ------------------- | ------------------- |
| always-fire, pooled       | +$34.02 · +0.63%    | +$36.61 · +0.67%    | +$36.25 · +0.67%    |
| measured `p_fire`, pooled | **+$1.03 · +0.02%** | **−$0.24 · −0.00%** | **−$1.57 · −0.03%** |
| break-even crossing       | 400–600             | 600–800             | 600–800             |
| caveman-live, saved       | $4.59               | $4.74               | $4.82               |
| ceiling, pooled           | 2.5%                | 2.7%                | 2.7%                |

**The sign of the pooled measured-`p_fire` figure is not identified.** It runs from +0.02% to
−0.03% across the corners the usage totals allow, and the published claim is therefore the
magnitude and not the sign: the measured effect is zero to within ±0.03% of the bill. Everything
else is robust. The always-fire figure holds at +0.63% to +0.67%, the ceiling at 2.3%–4.3%, the
caveman-live measurement at $4.59–$4.82 (0.6% at every corner), and the break-even crossing at
400–800 prose tokens per prompt.

The conclusion of the post survives intact, and one of its numbers got smaller: caveman as it
actually fires returns nothing, and the ceiling it is competing for is 2.5%–4.2% of the bill
rather than 2.3%–9.1%. The corpus that looked like the outlier case for a prose compressor was
largely an artefact of the replay.

## 7. What is still open

**Placement is a modelling choice and will stay one.** Nothing in the recorded `usage` says which
byte ranges of a prefix landed in which lane. Resolving it needs data the API does not return —
per-breakpoint read/write accounting — so the honest form is the range in §6, not a better
estimator. It is the widest single uncertainty on the pooled projection: ±0.03% against a point
estimate of −0.00%.

**`rewriteShare` is bimodal, and the aggregate hides that.** Pooled p25 0.4% / p50 7.0% /
p75 74.4% / p95 94.1%. A turn is usually near a corner, so `proportional` is right on average and
wrong nearly everywhere — which is fine for a corpus total and would not be for a single session.
Anyone quoting a per-session figure should run all three placements.

**The clamp is a floor, not a model.** A negative delta larger than the request it lives in is
truncated, and the count is reported as `clampedTurns`. That is enough to stop the replay
inventing negative cache segments; it is not a claim about what a session with 40% less prose
would actually have looked like — it would have compacted at different turns, and nothing here
models that. It binds on the prose ceiling, where the whole of prose is removed, far more often
than on any caveman scenario.

**Thinking tokens are still assumed untouched**, and they are ~89% of billed output. That
assumption dominates every number in the post by an order of magnitude more than anything
corrected here. Unchanged by this work, and unresolved.
