# So, caveman or no caveman ?

Caveman, headroom, rtk... do any of these actually save tokens? Truly save them, not just on a benchmark?
Both my cofounder and I have [caveman](https://github.com/JuliusBrussee/caveman) installed.
As [several](https://codepointer.dev/p/cutting-llm-token-costs-with-rtk) [benchmarks](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-to-save-tokens/) reported before us, caveman should cut tokens. My problem with those numbers is that they are final results I cannot apply to myself. I want to know what it would save _me_, not what it saved on average over 86 tasks.

So we measured it. And yes, it depends lol. Let's deep dive in the numbers.

---

## TL;DR

On most corpora caveman cannot save more than 4% of the bill.
If it fired on every turn, it would save **+0.67%**.
Taking into account how it actually fires as a session grows, it returns somewhere between **+0.02% and −0.03%** aka nothing.
Caveman costs more than it saves below roughly 700 English prose tokens per prompt you send.

<svg viewBox="0 0 640 260" role="img" aria-label="Prose is 4.1 to 7.0 percent of output tokens and 2.5 to 4.2 percent of the bill; caveman returns plus 0.67 percent if it always fired and, as it really fires, between plus 0.02 and minus 0.03 percent" style="width:100%;height:auto;color:inherit">
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
    <text x="0" y="34" opacity=".7">prose, share of output tokens</text>
    <rect x="287" y="42" width="139" height="16" opacity=".25"/>
    <text x="287" y="72" font-size="11" opacity=".7">4.1%</text><text x="402" y="72" font-size="11" opacity=".7">7.0%</text>
    <text x="0" y="104" opacity=".7">ceiling: prose as a share of the bill, cache re-reads included</text>
    <rect x="210" y="112" width="82" height="16" opacity=".45"/>
    <text x="210" y="142" font-size="11" opacity=".7">2.5%</text><text x="268" y="142" font-size="11" opacity=".7">4.2%</text>
    <text x="0" y="174" opacity=".7">if caveman fired on every turn</text>
    <rect x="90" y="182" width="32" height="16" opacity=".45"/>
    <text x="128" y="195" font-size="11" opacity=".7">+0.67%</text>
    <text x="0" y="234" opacity=".7">what caveman actually returned</text>
    <rect x="89" y="242" width="2" height="16"/>
    <text x="96" y="255" font-size="11" font-weight="600">+0.02% to −0.03%</text>
  </g>
  <line x1="90" y1="20" x2="90" y2="260" stroke="currentColor" stroke-width="1" opacity=".3"/>
</svg>
<!-- fig: The ceiling, and what was left of it -->

---

## Why the obvious benchmarks don't transfer

First problem: caveman compresses model prose and nothing else. So first let's compute what share of prose our bill is.

Across the four corpora priced, prose is 4.1% to 7.0% of output tokens, and 0.4% to 1.1% of the bill counting only the turn that wrote it.

But prose is not paid for once. It stays in the prefix, and every later turn pays for it again — cheaply while the cache holds it, at the full write price whenever the cache lapsed and the prefix had to be sent up again. Accounting for that raises the ceiling to 2.5% to 4.2% of the bill.
The corpus topping that range does not write more prose than the rest: its sessions are simply long enough for the same tokens to be paid for hundreds of times.

On most sessions, prose is less than 3% of the bill, hence even with perfect compression, caveman cannot save more than that.

Second problem: benchmarks measure the tool under the conditions it likes (aka a fresh session and a short task).
Real sessions run for hundreds of turns, so our model needs to take that into account.

So we went bottom-up: model how caveman behaves, then replay it over the vanilla transcripts we already had.
That needed us to measure some parameters.

---

## Two numbers, not one

Most benchmarks measure only how much caveman compresses a turn. But caveman doesn't always trigger, the model may judge the detail important or simply forget. Our model accounts for that:

```
effective_ratio(turn) = p_fire × R + (1 − p_fire) × 1.0
```

- **`p_fire`** — how often the model actually writes in caveman style. It can ignore the instruction, and it does.
- **`R`** — how much shorter a turn gets, given that it fired.

Every published caveman figure we found reports something in the neighbourhood of `R` and implicitly assumes `p_fire = 1`. On a single-turn benchmark that is nearly true. On a real session it's not.

---

## Measuring how often it fires

There's no flag in a transcript saying "caveman fired here", so we need a detector.

On vanilla sessions, we measure the distribution of words per sentence (per turn) and set a threshold at the 25th percentile.
A "terse" turn is one below that threshold. We then compare the share of terse turns when caveman is on vs caveman is off.

### Accounting for the fact that terse turns happen anyway

By construction, about 25% of vanilla turns are terse. So we measure caveman's fire rate by comparing the caveman-on rate against the caveman-off rate. That off rate is the detector's **floor**, caveman-on rates should never sit below it.
The floor is not assumed to be 25%: it is measured per bin with one bin per language x size band x shape x model family.

```
p_fire = (observed − floor) / (1 − floor)
```

**Sensitivity** is how often caveman fires _and the detector catches it_. We cannot measure that, so we take it as 1, clearly a generous assumption, but the best we can do here. Hence every `p_fire` we report is a **lower bound**.

### Restricting to one model and one language

Vanilla "terseness" spans 28 percentage points between model families, so we can't just say every model acts the same. Worse, caveman's deletion rules name English function words, and we measured them not firing on French prose at all.

So everything below is restricted to **Opus 5 and English**: 2,313 turns, 2,257 of them scoreable, 1,070 with caveman live, across three corpora. One thing worth keeping in mind: that's a small base to have a stable `p_fire` estimation.

### Splitting turns by position, not by content

We first split turns into "pure text" versus "carries a tool call" and got a clean result: pure-text compliance stayed flat across the session while tool-carrying turns collapsed.
But we were missing something that this table over all the turns carrying prose shows us:

```
             last=0   last=1
  pure=0       1737      313
  pure=1          0      225   <- P(last | pure) = 100%
```

**Every pure-text turn is the model's closing turn.** "Pure text" was never measuring text-versus-tools; it was a proxy for position in the answer. That matters more than a variable rename, because of where the money is:

|               | share of turns | share of prose tokens | mean prose tokens/turn |
| ------------- | -------------- | --------------------- | ---------------------- |
| closing turns | 23.6%          | **77.6%**             | 799                    |
| mid-run turns | 76.4%          | 22.4%                 | 72                     |

<svg viewBox="0 0 640 150" role="img" aria-label="Closing turns are 23.6 percent of turns but 77.6 percent of prose tokens" style="width:100%;height:auto;color:inherit">
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
    <text x="0" y="34" opacity=".7">share of turns</text>
    <rect x="130" y="22" width="120" height="26"/>
    <rect x="250" y="22" width="390" height="26" opacity=".18"/>
    <text x="136" y="40" font-size="11" font-weight="600" opacity=".95">23.6%</text>
    <text x="0" y="100" opacity=".7">share of prose tokens</text>
    <rect x="130" y="88" width="396" height="26"/>
    <rect x="526" y="88" width="114" height="26" opacity=".18"/>
    <text x="136" y="106" font-size="11" font-weight="600" opacity=".95">77.6%</text>
    <text x="130" y="140" font-size="11" opacity=".6">■ closing turns</text>
    <text x="240" y="140" font-size="11" opacity=".4">■ mid-run turns</text>
  </g>
</svg>
<!-- fig: Three quarters of the prose you pay for is in one turn -->

Three quarters of the prose you pay for sits in a single turn per run. We tested position-from-the-end as a continuous variable and substituting it for the binary flag was worse: the model flips into wrap-up mode on exactly one turn.

Here are the measured `p_fire` values. Bins are half-open (`10–20` means turn 10 up to but not including turn 20).

| turn index | closing turns | mid-run turns |
| ---------- | ------------- | ------------- |
| 0–10       | 93%           | 39%           |
| 10–20      | 80%           | 37%           |
| 20–40      | 66%           | 21%           |
| 40–80      | 42%           | 11%           |
| 80+        | **41%**       | **13%**       |

Every cell above is measured directly.

<svg viewBox="0 0 600 260" role="img" aria-label="p_fire decays with turn index: closing turns 93 to 41 percent, mid-run turns 39 to 13 percent" style="width:100%;height:auto;color:inherit">
  <g stroke="currentColor" opacity=".2" stroke-width="1">
    <line x1="55" y1="40" x2="580" y2="40"/><line x1="55" y1="130" x2="580" y2="130"/><line x1="55" y1="220" x2="580" y2="220"/>
  </g>
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" opacity=".6">
    <text x="20" y="44">100%</text><text x="28" y="134">50%</text><text x="36" y="224">0%</text>
    <text x="42" y="242">0–10</text><text x="161" y="242">10–20</text><text x="280" y="242">20–40</text>
    <text x="399" y="242">40–80</text><text x="524" y="242">80+</text>
  </g>
  <polyline fill="none" stroke="currentColor" stroke-width="2.5" points="60,52.6 179,76 298,101.2 417,144.4 536,146.2"/>
  <polyline fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="5 4" opacity=".55" points="60,149.8 179,153.4 298,182.2 417,200.2 536,196.6"/>
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
    <text x="545" y="143" font-weight="600">closing</text>
    <text x="545" y="200" opacity=".55">mid-run</text>
  </g>
</svg>
<!-- fig: Compliance decays with depth — the regime benchmarks never reach -->

This is the biggest reason benchmarks overstate the tool. By turn 80 the model is firing on 13% of mid-run turns and 41% of closing ones. A benchmark that never runs past turn 20 measures a regime real sessions mostly don't use.

The instructions themselves do not decay though. Caveman's hook injects the full ruleset at every session start, including after a compaction, and the per-prompt reminders keep arriving however deep the session goes.
What decays is the model's output style.

Caveman was sometimes switched off mid-session. The following turns then arrive without a reminder. They are written at a median of **12.00 words per sentence, identical to sessions that never ran caveman at all** against 10.50 when the reminder was present.

---

## Caveman does compress, just not as advertised

Now `R`, or how much shorter a turn gets when caveman does fire.

We built paired trials with the same prompt, both arms, same model, same pinned repository state, arms isolated so nothing differs except caveman.

**90 real, interactive coding sessions: 45 matched ON/OFF pairs**, run by two operators with the same prompt pasted into each arm.

| stratum | token-mass R | spread             | basis                        |
| ------- | ------------ | ------------------ | ---------------------------- |
| closing | **0.689**    | pair IQR 0.59–0.77 | 45 pairs, 39,178/56,885 tok  |
| mid-run | **0.383**    | pair IQR 0.15–0.93 | 254/325 turns, 961/2,512 tok |

<svg viewBox="0 0 640 150" role="img" aria-label="Interactive paired trial: closing token-mass R 0.689 and mid-run token-mass R 0.383" style="width:100%;height:auto;color:inherit">
  <line x1="320" y1="20" x2="320" y2="118" stroke="currentColor" stroke-width="1" stroke-dasharray="4 4" opacity=".45"/>
  <text x="326" y="32" fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" opacity=".6">1.0 — no change</text>
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
    <text x="0" y="62" opacity=".7">closing</text><rect x="213" y="50" width="47" height="14" opacity=".3"/><circle cx="239" cy="57" r="5"/><text x="266" y="62" font-size="11" font-weight="600">0.689</text>
    <text x="0" y="104" opacity=".7">mid-run</text><rect x="99" y="92" width="203" height="14" opacity=".15"/><circle cx="160" cy="99" r="5" opacity=".55"/><text x="172" y="104" font-size="11" font-weight="600">0.383</text>
  </g>
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" opacity=".5"><text x="57" y="140">0</text><text x="182" y="140">0.5</text><text x="312" y="140">1.0</text><text x="442" y="140">1.5</text></g>
</svg>
<!-- fig: R measured in interactive coding sessions, not headless one-shots -->

The mid-run per-turn ratio is 0.490 but we price the lower token-mass ratio of 0.383, because bills are paid in tokens rather than in turns.
Interesting fact: with caveman on, 81% of mid-run turns produced no prose at all against 71% in control.

---

## When a token was written matters as much as whether

A token written at turn 3 of a 200-turn session is paid for by every later turn — usually as a cheap cache read, at the full write price on the turns where the cache had lapsed and the whole prefix went up again, and not at all once compaction drops it. "Tokens saved × price" misprices all three, and the error grows with session length.

So we replay the sessions: change the token count at one position, then follow that change through every later turn — read while it is cached, re-written when the cache expired, gone when the conversation compacts — and difference the totals.

Billing says how much of a prefix was written a second time, never which tokens those were, so it cannot say whether a token we invented would have been among them. Every figure below is the estimate that spreads the change evenly through the prefix, and where the two corners of what billing allows move it, they are quoted alongside.

This is also where caveman's own cost appears. Measured on the corpora that ran it, the SessionStart ruleset costs around **462 tokens** and the per-prompt reminder **42 tokens on every user turn**. That cost is charged in every projection below.

---

## What it actually did, and what it would do

**Where caveman actually ran** — 98 caveman-live sessions out of 108, $755.46 of bill. It saved **$4.74, or 0.6%**.
The token-weighted fire rate on those turns is 50.6%.

| scenario                                          | saved            |
| ------------------------------------------------- | ---------------- |
| caveman's advertised 0.35, charged to both strata | $12.64 · 1.7%    |
| lower pair quartile (closing 0.59 / mid-run 0.15) | $6.92 · 0.9%     |
| **pooled interactive trial (0.689 / 0.383)**      | **$4.74 · 0.6%** |
| upper pair quartile (closing 0.77 / mid-run 0.93) | $2.72 · 0.4%     |

<svg viewBox="0 0 640 200" role="img" aria-label="Sensitivity band on the sessions that ran caveman: 0.4 to 1.7 percent saved, all positive" style="width:100%;height:auto;color:inherit">
  <line x1="300" y1="18" x2="300" y2="166" stroke="currentColor" stroke-width="1" opacity=".45"/>
  <text x="284" y="186" fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" opacity=".6">0%</text>
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
    <text x="0" y="34" opacity=".7">caveman's advertised 0.35</text><circle cx="504" cy="30" r="5" opacity=".45"/><text x="514" y="34" opacity=".6">1.7%</text>
    <text x="0" y="70" opacity=".7">lower pair quartile</text><circle cx="408" cy="66" r="5" opacity=".45"/><text x="418" y="70" opacity=".6">0.9%</text>
    <text x="0" y="106" opacity=".7">pooled interactive trial</text><circle cx="372" cy="102" r="6"/><text x="382" y="106" font-weight="600">0.6%</text>
    <text x="0" y="142" opacity=".7">upper pair quartile</text><circle cx="348" cy="138" r="5" opacity=".45"/><text x="358" y="142" opacity=".6">0.4%</text>
  </g>
</svg>
<!-- fig: Positive across the band, and small throughout -->

Caveman's own advertised 0.35 saves nearly three times what the measurement does.
Unfortunately, we're not in the ideal situation their benchmarks seem to assume.

### What it would do to people who never installed it

These sessions never carried caveman's injections, so the projection adds them back at the cited rates:

| corpus   | bill         | if it always fired   | with `p_fire` wired in |
| -------- | ------------ | -------------------- | ---------------------- |
| corpus A | $4578.70     | +$30.60 · +0.67%     | **+$2.94 · +0.06%**    |
| corpus B | $623.58      | +$4.25 · +0.68%      | **−$3.15 · −0.51%**    |
| corpus C | $131.84      | +$1.00 · +0.76%      | **−$0.10 · −0.08%**    |
| corpus D | $97.65       | +$0.80 · +0.82%      | **+$0.08 · +0.08%**    |
| **all**  | **$5431.76** | **+$36.61 · +0.67%** | **−$0.24 · −0.00%**    |

<svg viewBox="0 0 640 250" role="img" aria-label="Projected savings per corpus, priced twice: if caveman always fired every corpus gains between 0.67 and 0.82 percent; with p_fire wired in corpus B falls to minus 0.51 percent, corpus C to minus 0.08 percent, and the pooled result is zero to within three hundredths of a percent" style="width:100%;height:auto;color:inherit">
  <line x1="250" y1="18" x2="250" y2="204" stroke="currentColor" stroke-width="1" opacity=".45"/>
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif">
    <g font-size="12">
      <text x="0" y="42" opacity=".8">corpus A</text><text x="0" y="78" opacity=".8">corpus B</text>
      <text x="0" y="114" opacity=".8">corpus C</text><text x="0" y="150" opacity=".8">corpus D</text>
      <text x="0" y="186" font-weight="600">all</text>
    </g>
    <g font-size="10" opacity=".5">
      <text x="64" y="42">$4,579</text><text x="64" y="78">$624</text><text x="64" y="114">$132</text>
      <text x="64" y="150">$98</text><text x="64" y="186">$5,432</text>
    </g>
    <g opacity=".22">
      <rect x="250" y="26" width="194" height="11"/><rect x="250" y="62" width="197" height="11"/>
      <rect x="250" y="98" width="220" height="11"/><rect x="250" y="134" width="238" height="11"/>
      <rect x="250" y="170" width="194" height="11"/>
    </g>
    <g opacity=".8">
      <rect x="250" y="39" width="17" height="11"/><rect x="102" y="75" width="148" height="11"/>
      <rect x="227" y="111" width="23" height="11"/><rect x="250" y="147" width="23" height="11"/>
      <rect x="241" y="183" width="15" height="11"/>
    </g>
    <g font-size="11" opacity=".55">
      <text x="450" y="35">+0.67%</text><text x="453" y="71">+0.68%</text><text x="476" y="107">+0.76%</text>
      <text x="494" y="143">+0.82%</text><text x="450" y="179">+0.67%</text>
    </g>
    <g font-size="11" font-weight="600">
      <text x="273" y="48">+$2.94 · +0.06%</text><text x="256" y="84">−$3.15 · −0.51%</text>
      <text x="256" y="120">−$0.10 · −0.08%</text><text x="279" y="156">+$0.08 · +0.08%</text>
      <text x="262" y="192">−$1.57 to +$1.03 · ±0.03%</text>
    </g>
    <g font-size="11" opacity=".5">
      <text x="90" y="218">−0.5%</text><text x="243" y="218">0</text><text x="380" y="218">+0.5%</text><text x="527" y="218">+1%</text>
    </g>
    <rect x="250" y="232" width="14" height="9" opacity=".22"/>
    <text x="270" y="241" font-size="11" opacity=".6">if it always fired</text>
    <rect x="390" y="232" width="14" height="9" opacity=".8"/>
    <text x="410" y="241" font-size="11" opacity=".6">with p_fire wired in</text>
  </g>
</svg>
<!-- fig: The same four corpora, priced twice -->

Four corpora, 504 English sessions. Two come out positive and two negative, and the pooled result is indistinguishable from zero. The whole point of this post is the difference between a tool that always fires and the same tool as it actually behaves.
And it goes from +0.67% to nothing at all for caveman.

Three caveats. Corpus A is 84% of that pooled bill, so read the rows rather than the total. 1,269 sessions worth $48.96 were dropped for not being entirely English. And the pooled `p_fire` column is smaller than what the billing data can pin down: pushing the counterfactual tokens into the re-written part of the prefix or out of it moves that cell from **−$1.57 (−0.03%)** to **+$1.03 (+0.02%)**. We cannot tell you its sign. We can tell you its size — zero, to within three hundredths of a percent of the bill — and that is the claim. The always-fired column does not have this problem: it runs +0.63% to +0.67% across the same corners.

---

## The one thing that predicts whether it pays

A corpus average is still useless, to me and to you. So we looked for the variable that correlates the best with caveman winning or losing you money.

Drumroll...
It's **English prose tokens per prompt you send** ! Aka how much English tokens the model answers for each thing you ask it.

No coincidence there, only arithmetic. Caveman's cost is charged per prompt with 42 tokens of reminder every time you hit enter (and the ruleset once).
Its benefit is a fraction of the English prose in the answer. It pays exactly when the answer is long enough to cover the reminder that asked for it.

| English prose per prompt | sessions | share of bill | share that gain | money-weighted |
| ------------------------ | -------- | ------------- | --------------- | -------------- |
| 0–200                    | 92       | 2.7%          | 0%              | −0.428%        |
| 200–400                  | 123      | 30.6%         | 10%             | −0.260%        |
| 400–600                  | 112      | 28.2%         | 39%             | −0.002%        |
| 600–800                  | 71       | 16.1%         | 54%             | **+0.161%**    |
| 800–1000                 | 44       | 7.9%          | 57%             | **+0.187%**    |
| 1000–1500                | 38       | 10.8%         | 63%             | **+0.291%**    |
| 1500–2500                | 18       | 2.8%          | 78%             | **+0.462%**    |
| 2500+                    | 6        | 0.9%          | 100%            | **+0.261%**    |

<svg viewBox="0 0 620 260" role="img" aria-label="Share of sessions where caveman gains money rises from zero to one hundred percent as English prose per prompt rises, crossing between 600 and 800" style="width:100%;height:auto;color:inherit">
  <g stroke="currentColor" opacity=".18" stroke-width="1">
    <line x1="62" y1="210" x2="592" y2="210"/><line x1="62" y1="125" x2="592" y2="125"/><line x1="62" y1="40" x2="592" y2="40"/>
  </g>
  <line x1="136" y1="30" x2="136" y2="220" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 4" opacity=".55"/>
  <text x="142" y="48" fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" font-weight="600">breaks even ≈ 700</text>
  <g fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" opacity=".6">
    <text x="16" y="44">100%</text><text x="24" y="129">50%</text><text x="32" y="214">0%</text>
    <text x="54" y="232">0</text><text x="160" y="232">1k</text><text x="266" y="232">2k</text><text x="372" y="232">3k</text><text x="478" y="232">4k</text>
    <text x="150" y="252" opacity=".85">English prose tokens per prompt</text>
  </g>
  <polyline fill="none" stroke="currentColor" stroke-width="2.5" points="73,210 94,193 115,143 136,119 157,113 195,103 274,78 354,40"/>
  <g fill="currentColor">
    <circle cx="73" cy="210" r="3.5"/><circle cx="94" cy="193" r="3.5"/><circle cx="115" cy="143" r="3.5"/>
    <circle cx="136" cy="119" r="3.5"/><circle cx="157" cy="113" r="3.5"/><circle cx="195" cy="103" r="3.5"/>
    <circle cx="274" cy="78" r="3.5"/><circle cx="354" cy="40" r="3.5"/>
  </g>
  <text x="370" y="52" fill="currentColor" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" opacity=".75">share of sessions where caveman gains</text>
</svg>
<!-- fig: The break-even line sits near 700 prose tokens per prompt -->

Below a few hundred English prose tokens per prompt, no session gains. Above 1,000 most do.
The crossing lands between 600 and 800 — call it 700. It is 400 to 600 at the friendliest reading of the cache accounting, which is the same answer with a wider error bar, not a different one.

---

## What to actually do with this

If you want to know whether a token-saving tool is worth running:

**Get your own baseline before you install anything.** We can't do this for you.

**Randomize.** One session with the tool on, one without, same kind of work.

**Look at where your bill actually is.** A prose compressor is pointless if prose is not where your money goes. On the corpora here, thinking is roughly 89% of _billed output_, with prose never exceeding 4.3% of the bill even in the best case.

**Or just count.** Divide the English prose your model writes by the number of prompts you send. Well under 700 tokens, don't bother. Well over, it might pay.

And be suspicious of any single percentage, including ours.

---

_The measurement code is open at [jaynapp/jayn-caveman](https://github.com/jaynapp/jayn-caveman): the detector, the replay, the pricing, the trial harness. Every figure here is reproducible with the commands in that repository's README. The transcripts are not and will not be published: they are other people's work._

_Feel free to contact us if you have any question about our work, or if you just wanna chat about anything related._

_Thanks to everyone who trusted us with their transcripts. This analysis does not exist without you, and the most valuable contribution turned out to come from someone who never ran caveman at all._
