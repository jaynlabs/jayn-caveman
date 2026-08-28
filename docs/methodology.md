# Methodology

How each number in the [post](blog-caveman.md) and the [README](../README.md) was arrived at, and
what it cannot support.

The code carries no comments. This document is where the reasoning lives instead: every choice
below is one that changes an output, and each names the module that implements it.

caveman is measured **bottom-up** — a model of one channel, fitted offline, then replayed over
real transcripts. There is one A/B trial behind one parameter, and it is stated as such. Nothing
else here is an experiment.

---

## 1. Cost, which is not an estimate

`src/billing/pricing.ts`

The bill is arithmetic, not modelling. Each assistant message in a transcript carries its own
usage object; each is priced at the published API rate for its model, at its timestamp, with the
token classes billed separately (input, output, 5-minute cache write, 1-hour cache write, cache
read). It reconciles with Claude Code's own `total_cost_usd` to the cent.

Two places it cannot:

- **Unpriced, never zero.** A model with no rate-card entry — a research preview, something
  newer than this build — has its tokens counted and reported as unpriced. It is never silently
  treated as free.
- **Duplicated messages.** Resumed and forked sessions re-record earlier turns verbatim into a
  new transcript. A message id is priced once across the whole corpus; first file wins, which is
  the older transcript. `dedupeSessions` in `src/transcript/load.ts`.

### Counting prose tokens

`src/transcript/tokens.ts`

The bill gives token counts per turn, but not how many of them were prose. Prose has to be
counted separately, and the offline counter is a legacy BPE count scaled by a calibration
constant fitted per tokenizer family.

That constant is fitted **per person as well as per model**: `calibrateLocally` splits the
turns that are text-only and fence-free — where `output_tokens` _is_ the prose token count — into
a fit half and a holdout half, and reports the holdout error alongside every figure. Roughly a
tenth of prose tokens are exact for free this way.

The per-person part of that fit is the reason cells band on **words** rather than tokens (§4).
Two people writing the same sentence would otherwise be judged against different cutoffs.

`--exact` swaps the offline counter for Anthropic's `count_tokens` endpoint. It is an opt-in
upgrade rather than the happy path: requiring an API key to compute a savings report would be a
bad dependency for a tool meant to run on other people's machines.

---

## 2. Positional replay — how a counterfactual is priced

`src/transcript/replay.ts`

A token written into the prefix at turn 3 of a 200-turn session is **paid for again by every
later turn**. The same token written at turn 199 is paid for once. A flat "tokens removed ×
price" understates the first and overstates the second, and the error is not small — it scales
with session length.

It is paid for again in one of three ways, and they differ by a factor of twelve:

- a **cache read**, at 0.1× the input rate, while the breakpoint holding it is still warm;
- a **cache write**, at 1.25× or 2.0×, on the turns where its TTL had lapsed and the prefix went
  back up as `cache_creation`;
- **not at all**, once compaction or context editing drops it out of the conversation.

So a counterfactual is priced by replaying the session: change the token count at one position,
then follow that change forward through all three regimes and difference the totals. Three
invariants keep that honest. Whatever share of the prefix the conversation dropped on the way
into a request, the counterfactual delta is dropped in the same proportion. Whatever share of the
prefix came back as `cache_creation`, that share of the delta is billed at the write multiplier
rather than the read one. And the counterfactual prefix cannot be smaller than empty, so a
negative delta is truncated at the request it lives in.

`cacheRead + cacheWrite5m + cacheWrite1h + inputTokens` — the whole input side of a request — is
what makes the second and third computable. That total is invariant to how a TTL expiry splits
tokens between the read lane and the write lane, so its turn-to-turn delta is what genuinely
arrived and anything written beyond it is prefix being re-written. Detecting expiry by
`cacheRead === 0` instead misses the common case entirely: a session with several breakpoints
comes back from an idle gap with a small surviving preamble read and the whole conversation
re-written, and no lane is ever zero.

**What billing cannot identify.** Usage totals say _how much_ of a surviving prefix was written a
second time. They never say _which_ tokens, so they cannot say whether a token this replay
invented would have been among them. `--placement` prices the three readings: `proportional`
spreads the delta through the prefix like everything else and is what every figure quotes, while
`read` and `rewrite` push it entirely out of, or into, the re-written region. On the four
projected corpora that choice is worth ±0.03% of the pooled bill, which is wider than the pooled
answer — so the pooled answer is published as a range and its sign is not claimed.
[`docs/replay-correction.md`](replay-correction.md) derives all of this, and lists what the
correction changed.

The replay is exact on the observed side. The arm that actually happened is never modelled, only
the arm that did not. That is why a session that already ran caveman is replayed **backwards**,
reconstructing the vanilla it would have been, while a vanilla session is replayed forwards.
`replaySession` branches on `cavemanActive` for exactly that reason, and the ratio is inverted in
the ON direction.

---

## 3. Two numbers, not one

`src/effects/caveman/analyze.ts`, `src/effects/caveman/effect.ts`

```
effective_ratio(turn) = p_fire(turn) × R(turn) + (1 − p_fire(turn)) × 1.0
```

Charging `R` to every turn — which is what a scalar ratio does — prices the tool as if it always
fired, and roughly doubles the estimate. Both halves are needed and they are estimated by
different instruments: `p_fire` from observation, `R` from a trial.

Three details in that line change the answer:

- **Language is detected per turn, not per session.** The level is keyed on it, and a French
  developer working in an English codebase mixes constantly. Closing `R` is keyed on the
  language the turn was _written_ in, not the session's or the contributor's.
- **A session where the user switched caveman off mid-way** holds turns that are already
  vanilla. Those get a ratio of 1, which leaves them at their observed length instead of
  inflating them into a counterfactual that never happened. They are also excluded from the
  `p_fire` weighting: a deactivation is not a turn the model declined to fire on.
- **The mean `p_fire` reported is token-weighted**, because that is the weighting the bill uses.
  A 900-token wrap-up and a 12-token acknowledgement do not count the same, and an unweighted
  mean would report the mid-run stratum's low rate as though it drove the money.

### The hard upper bound

Prose is the only thing the tool can move, so the prose share of the bill caps what any
prose-compressing tool could ever save. That share is computed from the transcripts and printed
with every headline. A claimed saving above it is a bug, not a result.

---

## 4. `p_fire` — the detector, the floor, the strata

`src/effects/caveman/{style,compliance,samples,prior}.ts`

A turn counts as caveman-style when its mean sentence length falls below the 25th percentile of
**vanilla** turns in the same cell: language × size band (in words) × bullet-vs-prose shape ×
model family.

### The floor is measured, never assumed

Vanilla turns trip a 25th-percentile detector 25% of the time by construction. That
false-positive floor is measured per (index bin × language × position × model) and subtracted:

```
p_fire = (observed − floor) / (1 − floor)
```

Sensitivity — how often caveman fires and the detector misses — is unknown and taken as 1. That
makes every figure a **lower** bound. Sweeping `--quantile` is the sensitivity check on the 0.25:
were the detector perfect the estimate would not move at all, so how far it moves is how loose
the bound is. Measured, it plateaus from 0.25 upward on well-sampled bins and collapses below it.

Every field of a curve is a function of the quantile it was fitted at — a cutoff _is_ the q-th
percentile, and a q-detector fires on vanilla q of the time, so the floors move with it. Nothing
fitted at 0.25 can be borrowed at 0.5. `compliance --quantile <q>` therefore refits cells, floors
and prior in-process and writes nothing; `curves/` holds exactly one curve, the shipped 0.25.

The sweep buys that at a cost it prints: the baseline borrows shipped cells the local corpus
cannot fit, and a sweep has no curve at its quantile to borrow from, so the two do not score the
same turns. The movement bounds the cutoff choice; part of it is the narrower cell footprint.
The sweep moves this report only — the headline in `analyze` is always read at 0.25.

### Why model family is in the cell

Vanilla terseness spans 28 points between model families, and the two arms are badly unbalanced
on it — in the corpora fitted here the treatment arm was 81% Opus 5 against 20% of the control, a
61-point gap. A cutoff pooled across families judges Opus 5 turns terse against a bar that other
models set.

`compliance` prints the ON/OFF model mix above every curve and flags a gap over 20 points.
`--model <family>` restricts both arms and is the only like-for-like read of a mixed corpus.

A family with too little vanilla writing of its own falls back to a cross-model roll-up, fitted
from the same turns rather than averaged from the per-family rows. Those turns are counted and
reported, not silently borrowed.

### The stratifier is position, not structure

The first split tried was "pure text" versus "carries a tool call", and it produced a clean
result: pure-text compliance flat across the session, tool-carrying compliance collapsing. It was
an artifact. Every pure-text turn in the corpus is the model's closing turn — `P(last | pure)` is
100% — so the flag was measuring position in the answer, not structure.

The replacement is `lastOfRun`: a turn closes a run when the next turn is preceded by a user
prompt, or when nothing follows it (`lastOfRunFlags` in `src/transcript/session.ts`). Closing
turns are 23.6% of turns and 77.6% of prose tokens.

Position-from-the-end as a continuous variable was tested as a substitute and was worse. The
model flips into wrap-up mode on exactly one turn, so the binary flag is the right shape.

Turn type is a **level, not a slope**: both strata decay at the same rate, so the model keeps the
closing-turn intercept and drops the interaction.

### Bands are in words, not tokens

`bandDefinitionSweep` prints what the answer would have been under token banding, so the cost of
this choice is on the record rather than assumed away. Words win on grounds the numbers cannot
settle: the token counter is calibrated per model _and_ per person (§1), so token bands would let
two people writing the same sentence be judged against different cutoffs.

### The shipped prior

`src/effects/caveman/prior.ts`

"What would caveman save me" is a question about a population the asker is not yet a member of,
so for anyone with no caveman sessions it can only be answered by a prior:

```
p_fire = sigma(a_language + c · closesRun + b · ln(1 + turnIndex))
```

Fitted by maximum likelihood over `P(terse) = floor + (1 − floor) · p_fire` — the same
contamination model the bin estimator corrects for, so the two are on one scale.

`c` (the closing-turn gap) and `b` (the decay) transfer between people and carry cluster
bootstrap intervals. **`a` does not transfer.** So the fit also ships the
leave-one-contributor-out width of the whole estimate, and the report prints that band in the
headline rather than behind a flag. On this corpus that width is 44.0% to 54.9% around a pooled
47.1%, and the contributor who moves it down most holds none of the caveman-live turns at all —
they move the estimate entirely through the control.

Resolution order per turn, most specific first: this stratum's own measured bin, the pooled bin
for that depth split by `c`, the nearest earlier bin, then the prior — never 1. Someone with
their own caveman turns is answered from their own turns; the prior is a floor on usefulness,
not a ceiling on accuracy. A report says which of the two priced it, and a prior-priced report
labels itself a projection.

Two limits stay on the record. A language level resting on a single contributor means "the
French level" and "that person's level" are the same number, and the fit records the contributor
count that says so. And the logistic is a smooth approximation of a shape that is not smooth — a
high plateau over the first ten turns, a steady fall, then a floor past 80 that stops falling — so
each build records the largest disagreement between a measured bin and the formula over the same
turns.

---

## 5. `R` — the paired trial

`src/effects/caveman/trial/`

`R` is the one parameter here with an experiment behind it. 90 real interactive coding sessions — 45 matched ON/OFF
pairs across two operators, `claude-opus-5`, English only: two arms against identical prompts and an identical pinned
repository state, differing only in caveman.

| stratum      | R     | basis                                                        |
| ------------ | ----- | ------------------------------------------------------------ |
| closing      | 0.689 | n=45 interactive English pairs, IQR 0.59–0.77                |
| mid-run      | 0.383 | same trial, token-mass over 254/325 turns; per-turn is 0.490 |
| closing-tool | —     | 0 of 45 pairs produced one                                   |

Both strata are measured. An earlier headless pilot of 9 pairs reported closing 0.83 with mid-run
a placeholder; the interactive trial replaced both. Re-derive with
`jayn-caveman trial analyze --root <ledger>,<ledger>`.

Four things about that table are load-bearing.

**The stored value is deconvolved, and here that was free.** The replay computes `p·R + (1−p)`,
so `R` must mean compression _given firing_. The trial measures the ratio over all treated turns,
fired or not; handing that blended figure to a formula that blends again counts the non-firing
turns twice. The trial fires on essentially every closing turn, so `p_trial` is ~1 and the
measured ratio passes through nearly unchanged. On a real corpus, which fires on 44–55% of turns,
the same correction bites hard.

**It is one number, and it is English.** Every prompt and every answer in the trial is English.
An earlier design ran a second, French arm and reported `fr = 0.54` against `en = 0.83`; it was
withdrawn because the French pairs that survived to be estimated from were exactly the ones where
caveman had not drifted the session out of French — conditioning on an outcome the treatment
itself causes — and because matching the prompt sets cut the apparent gap by more than half. The
consequence is stated rather than hidden: a non-English closing turn is priced at an
English-measured ratio, and nothing here has measured whether that is right.

**Silent turns are inside `R`, on purpose.** Caveman produced no prose at all on 206 of 254
mid-run turns, against 232 of 325 in control. Silence is a treatment outcome, not a turn to drop,
so both the token-mass and per-turn figures include it.

**Arms are isolated by `CLAUDE_CONFIG_DIR`.** `--settings` merges rather than replaces and leaks
the host's own hooks into the control arm; running bare kills the hooks the treatment arm needs.
Each run's arm is then re-derived from the injections in its own transcript rather than trusted
from the launcher, so a leak discards a pair instead of quietly biasing it.

**Mid-run `R` is measured now, and it is wide.** The headless pilot could not reach it: headless
agents barely narrate between tool calls, averaging 2.0 (treated) and 3.6 (control) prose tokens
against 71 in the real corpus, and leave-one-prompt-out on that pilot spanned 0.31 to 1.42,
straddling 1.0. More headless budget would not have fixed it — the instrument does not reproduce
the phenomenon. The interactive round does: 0.383 token-mass over 961/2,512 prose tokens on
254/325 turns, pair IQR 0.15–0.93. That IQR is still most of the interval below 1.0, so the
stratum is measured rather than settled.

`closing-tool` as a stratum does not exist: 0 of 45 pairs, 0.4% of the corpus. An earlier
estimate that it was 47.9% of turns was an artifact of `onlyTextBlocks`, which every thinking
block makes false.

### The band, not the point

`src/effects/caveman/sensitivity.ts`

Totals are recomputed across four scenarios, and every one of them carries two ratios, because
the strata are far apart and collapsing them into one number is the error the band exists to
expose:

| scenario                  | closing | mid-run |
| ------------------------- | ------- | ------- |
| caveman's advertised 0.35 | 0.35    | 0.35    |
| lower pair quartile       | 0.59    | 0.15    |
| pooled interactive trial  | 0.689   | 0.383   |
| upper pair quartile       | 0.77    | 0.93    |

The 0.35 row is caveman's own published figure rather than a stale assumption of ours, kept so a
reader can see how far measuring the thing moved the answer. It is charged to both strata, so it
saves _more_ than either pair quartile: the quartiles leave closing turns at 0.59–0.77 where the
trial found them, and closing turns carry 78% of the prose.

On the sessions that actually ran caveman the whole band is positive — 0.4% to 1.7%, small
everywhere. On the projection onto corpora that never ran it the sign flips inside the band and
between corpora, and a headline whose sign is not settled is reported as indeterminate.

---

## 6. The cost side

`src/transcript/injection.ts`

caveman injects tokens: a ruleset block at session start, and a reminder per user prompt. Both
are counted from the transcripts of sessions where it actually ran — 457 to 467 tokens once per
session, 34 to 50 tokens per user turn.

A corpus that never ran caveman has no profile of its own, and `median([])` is 0 — so the
projection would price the ruleset and every reminder at nothing, and report a saving with the
cost side missing. `SHIPPED_PROFILE` stands in with the midpoint of the two correctly configured
installs, 462 tokens once and 42 per prompt, and the report labels the profile borrowed wherever
it used one. That term decides the sign: charge nothing for injections and the same replay
reports **+0.41%**; charge them and it reports **−0.00%**. `tools/injection-term.ts` prices both
at each placement — the free column runs +0.37% to +0.42%, the charged one +0.02% to −0.03%.

The two streams are kept apart rather than summed. A block at prefix position 0 is carried by
every later turn; a per-prompt reminder arriving at turn 20 of 25 is carried by five. A combined
total misprices both. Short sessions can come out **net negative** once injection is priced in, and the
report says so.

The SessionStart block re-fires at a compaction boundary, so caveman survives compaction. That is
already in the transcripts and needs no separate term.

### Deduplication, and why savings are measured against a correct install

An injection delivered more than once on the same turn is priced once. This is not a rounding
decision.

Both machines this was run from registered each caveman hook twice — once in `settings.json`,
once via the enabled plugin, both binding the same scripts to the same events — so the same
reminder was delivered twice on 95% of injection-carrying turns, $2.67 in total. On the corpus
where it mattered most that is 269 of 273 turns: 96,184 injected tokens where 48,244 were needed,
205 tokens per prompt where 103 were.

Charging that to caveman answers the wrong question. The report exists to decide whether to _run_
the tool, and nobody chooses to run it misconfigured. It is not cosmetic either: on that corpus
the duplicate cost $1.70 against a $3.58 prose gain, so charging it would take the headline from
+0.7% to +0.4% — more than the width of every other uncertainty on the page.

The consequence is accepted deliberately and surfaced rather than buried: **totals no longer
reconcile with the invoice.** `Totals.paidUSD` keeps what was actually billed,
`Totals.misconfiguredUSD` is the gap, and the report prints `paid twice for nothing` with its
cause without being asked. A reader who spotted the discrepancy unaided would otherwise conclude
the tool is miscounting rather than that their config is.

Deduplication is **per turn**. The same reminder arriving on many turns is exactly what a
per-prompt hook is for; counting across turns would report a correct install as broken. And
because the correction is a positional delta rather than a flat subtraction, a duplicate landing
at turn 2 of 200 is credited with every later turn that carried it, at whatever mix of read and
re-write those turns were billed at.

---

## 7. What none of this can answer

Stated plainly, because the numbers above are otherwise easy to over-read.

**Behavioural effects.** Compressed output changes what the agent does next. A retry caused by
over-compression is a negative saving, and nothing measured offline can see it. Only a randomized
trial can, and this project does not run one over real work.

**How wide the mid-run ratio is.** Both strata are measured in the interactive trial now, but the
mid-run pair IQR runs 0.15 to 0.93 — most of the interval below 1.0. It is banded at both
quartiles rather than reported as a point, and 961 prose tokens over 254/325 turns is a thin base
for a stratum holding 22% of the prose.

**Whether caveman moves thinking tokens.** Assumed not, and the assumption was tested rather than
waved through. Transcripts store thinking blocks with empty text, so the only available estimator
is a residual — billed output minus visible text minus tool arguments — and nothing validates it.
It stays positive across the interactive pairs, which is not evidence that it works: it went
**negative** on pairs of the earlier pilot, and an estimator that can return an impossible value is
not made sound by a set where it happened not to. This matters more than its position in this
list suggests: thinking is ~89% of billed output on this corpus, so if caveman does compress it,
every figure here understates the saving by a large factor.

**Whether the trial's instrument matches the corpus it prices.** Closer than it was, and the
remaining gap is stated rather than closed. The trial is 45 pairs of real interactive coding
sessions across two operators, so it no longer measures a headless one-shot regime the corpus
never enters. It is still one model and English only, against a corpus that is multi-model,
multi-language and runs hundreds of turns deep. Applying the first to the second is an
extrapolation, and the trial establishes a ratio rather than a verdict.

**How much any of this generalises.** Any single pooled percentage describes the heaviest spender
while appearing to describe everyone, which is why per-corpus rows are the result and the pooled
line is a footnote. Savings are convex in `p_fire`: halving the fire rate cut savings elevenfold,
so a prediction should be compared against a measured fire rate, not against dollars.

---

## 8. Where each thing lives

| Path                                 | What it is                                         |
| ------------------------------------ | -------------------------------------------------- |
| `src/adapters/`                      | Claude Code transcript reader                      |
| `src/transcript/session.ts`          | turns, injections, run boundaries                  |
| `src/transcript/replay.ts`           | positional pricing of a counterfactual             |
| `src/transcript/injection.ts`        | measuring caveman's own token cost                 |
| `src/transcript/tokens.ts`           | prose token counting and its calibration           |
| `src/billing/pricing.ts`             | the rate card                                      |
| `src/effects/caveman/style.ts`       | the detector: language, shape, sentence length     |
| `src/effects/caveman/compliance.ts`  | cells, cutoffs, floors, `p_fire` by bin            |
| `src/effects/caveman/prior.ts`       | the shipped logistic prior                         |
| `src/effects/caveman/analyze.ts`     | the replay that produces the headline              |
| `src/effects/caveman/sensitivity.ts` | the band and the leave-one-out spread              |
| `src/effects/caveman/trial/`         | the paired A/B that measures `R`                   |
| `src/cli/`                           | one file per command                               |
| `curves/`                            | the one shipped curve: cutoffs, floors, prior      |
| `data/caveman/`                      | the contributed observations they were fitted from |
