# Reproducing the numbers

Every figure in the [README](README.md) came out of one of six commands. This page maps each
one to the figure it regenerates and says what you have to bring.

You cannot reproduce our exact numbers: they were measured on other people's transcripts, which
are not ours to publish. You can run the same instruments against your own and get your own.

## Setup

```bash
npm install
npm run cli -- --help
```

Node 22 or newer. No build step; `tsx` runs the TypeScript directly. Nothing here talks to the
network unless you pass `--exact`, which sends turn text to Anthropic's `count_tokens` endpoint,
or run `trial`, which spends money.

Transcripts are read from `~/.claude/projects` by default. Every command takes `--root` to point
somewhere else, and most take a comma-separated list — one directory per contributor, which is
what produces the per-corpus rows and the leave-one-out spread:

```bash
npm run cli -- compliance --root ~/corpora/alice,~/corpora/bob
```

## The commands

| Command      | Regenerates                                                          |
| ------------ | -------------------------------------------------------------------- |
| `analyze`    | the headline (−0.01%), the sensitivity band, the prose-share ceiling |
| `compliance` | the `p_fire` table, the arm balance, the leave-one-out spread        |
| `corpora`    | the per-corpus money table                                           |
| `breakeven`  | the English-prose-per-prompt table and the crossing                  |
| `trial`      | `R`, the compression ratio — **this one spends real money**          |
| `curves`     | refits `curves/` from `data/` — the CI gate on our own numbers       |
| `anatomy`    | what the bill is made of: billing lanes, content classes, tools      |

### `analyze` — the headline and the band

```bash
npm run cli -- analyze --root <dir> --model claude-opus-5
```

Replays every session with prose scaled by `p_fire × R + (1 − p_fire)`, priced positionally, and
prints the totals with the audit trail. The `--brief` flag drops the band and the audit; do not
use it to read a headline, because the band is what says whether the headline is even signed.

`--model` restricts what `p_fire` is **estimated** from, in both arms. It does not restrict what
is priced — every turn is still replayed and billed. Vanilla terseness spans 28 points between
model families, so a curve fitted across a mixture of them partly measures the mixture.

This is the command behind "prose share of the bill", printed as the ceiling: the bound no
prose-compressing tool can beat.

### `compliance` — how often it fires

```bash
npm run cli -- compliance --root <dir1>,<dir2> --model claude-opus-5 --by-position
```

The `p_fire` table in the post is exactly this output with `--by-position`. Without that flag it
pools closing and mid-run turns, which is not what the replay charges.

It also prints, unasked:

- **arm balance** — the ON/OFF model mix, flagged when the arms differ by more than 20 points.
  Our corpus was 61 points apart on Opus 5, which is why the post restricts to one family.
- **composition** — the leave-one-contributor-out spread. On our corpus that is 44.0% to 54.9%
  around a pooled 47.1%, and the contributor who moves it down most holds none of the
  caveman-live turns. That width _is_ the estimate, not a robustness check it passed.
- **band definition** — what the answer would have been had cells banded on tokens instead of
  words. It records the cost of a choice the numbers cannot settle.

Two subcommands:

- `compliance fit` refits the thresholds in `curves/` straight from the transcripts under
  `--root`, skipping `data/` entirely. Use it when the transcripts are yours to read but not
  yours to publish. It only ever writes the one shipped curve, fitted at 0.25; `--quantile` off
  that default is a sweep, not an asset, so `compliance --quantile <q>` refits cells, floors and
  prior in-process and writes nothing.
- `compliance record --contributor <handle> --consent` exports your own turns as a batch under
  `data/caveman/`. See [Data](#data) for exactly what that writes.

### `corpora` — what it would do to someone who never installed it

```bash
npm run cli -- corpora --root <dir1>,<dir2>,<dir3>
```

One row per directory plus a pooled row, each priced twice over the same transcripts: once
charging the ratio to every turn (the number a single-turn benchmark reports), once with the
measured `p_fire` wired in. The sign flip between those two columns is the post's central claim.

Sessions that already ran caveman are excluded and reported separately — they carry its
injections, so replaying them reconstructs rather than projects. Sessions are restricted to
English by default; `--mixed-languages` lifts that, and the command will then be measuring an
instrument rather than the tool.

A corpus that never ran caveman has no injection profile to measure either, so the replay borrows
the shipped one — 462 tokens once per session, 42 per prompt — and the report says `borrowed`
where it did. That term decides the sign: charge nothing for injections and the pooled projection
reads +0.42% instead of −0.01%.

The command flags it when one corpus holds more than half the pooled bill. Ours held 84%.

### `breakeven` — the only number that transfers

```bash
npm run cli -- breakeven --root <dir1>,<dir2>
```

Buckets every session by prose tokens written per prompt sent, and reports share of bill, share
of sessions that gain, and the money-weighted result per bucket. Default edges are the post's;
`--buckets` takes your own!

This is the one output worth running on yourself before installing anything. Well under the
crossing, a per-prompt reminder cannot pay for itself; well over, it might.

### `trial` — measuring R

**This command spends money.** It launches Claude Code runs, two per pair. The headless pilot was
18 runs for 9 pairs; the interactive trial the shipped ratios come from is 90 runs for 45 pairs
across two operators, all English. `trial analyze --root <a>,<b>` pools several ledgers.

```bash
npm run cli -- trial init  --root <ledger dir>
npm run cli -- trial plan  --repeats 3
npm run cli -- trial run   --root <ledger dir> --sandbox <pinned repo>
npm run cli -- trial analyze --root <ledger dir>
```

Both arms get the same prompt, the same model and the same pinned repository state. They are
isolated by `CLAUDE_CONFIG_DIR`, not by `--settings`, which merges rather than replaces and
leaks the host's hooks into the control arm. Each run's arm is re-derived from the injections in
its own transcript rather than trusted from the launcher, so a leak shows up as a discarded pair
instead of a quiet bias.

`trial run` is resumable: completed runs are keyed in a ledger and skipped. It halts rather than
grinding on when the failure is fatal (no credit, bad key, blown quota).

The mid-run stratum is **not** measurable headlessly and the command says so. Headless agents
barely narrate between tool calls — 2.0 prose tokens on the treated arm against 71 in a real
corpus. The shipped mid-run ratio comes from the interactive round below instead: 0.383
token-mass, pair IQR 0.15–0.93.

### `trial` by hand — the interactive round

Headless is the wrong instrument for mid-run `R`, and one repeat per cell is too few to tell
within-prompt noise from between-prompt variation. Both are fixed by running the sessions
interactively, which no launcher can do for you. So the same ledger accepts sessions a person
ran by hand:

```bash
npm run cli -- trial sheet  --root <ledger dir>            # every outstanding cell, ready to paste
npm run cli -- trial next   --root <ledger dir>            # just the next one
#   ... run that session by hand, in the pinned sandbox ...
npm run cli -- trial import --root <ledger dir> --since 2026-08-20
npm run cli -- trial analyze --root <ledger dir>
```

Nothing about the session has to be written down. `import` scans your transcripts and recovers
what the launcher would otherwise have known:

| fact         | recovered from                                                                |
| ------------ | ----------------------------------------------------------------------------- |
| which prompt | the session's first human message, matched on collapsed whitespace            |
| which arm    | the caveman injections in the transcript, through the same `admissible` check |
| which repeat | completion order within (prompt, model, arm)                                  |

Two consequences worth stating. **Do not edit the prompt text** — it is the key the importer
matches on, so an edited prompt is a run you paid for and cannot use. And **the k-th ON session
pairs with the k-th OFF session**, so run the arms alternately in the order the sheet prints
rather than doing all of one arm first.

An import is idempotent: a session already in the ledger is skipped by its id. Sessions where
rtk or context-mode were live are rejected by name rather than counted, because both move prose
length by a path that is not caveman.

### `curves` — refitting the shipped thresholds

```bash
npm run cli -- curves          # rewrite curves/ from every batch in data/
npm run cli -- curves --check  # fail if the committed file is stale; writes nothing
```

`curves/` is generated and `data/` is the asset. `--check` runs in CI, so the thresholds in this
repository are provably the ones the shipped observations produce — that is the one number here
you can reproduce exactly, without any transcripts of your own.

### `anatomy` — what the bill is made of

```bash
npm run cli -- anatomy --root $C/cofounder,$C/gauthier    # one block per corpus, plus a pooled one
npm run cli -- anatomy --root $C/gustave --tools-only     # just the tool histogram
```

Not a caveman number — a property of the corpus. Three tables per corpus.

**Lanes** is exact, straight out of the recorded `usage`: fresh input, cache read, cache write at
each TTL, output. **Classes** splits billed output into reasoning, prose and tool-call JSON, and
prices each of them twice — at the output rate alone, and fully loaded with the cache write and
every subsequent re-read charged back to it. **Tools** is every `tool_use` block by name.

Two things to know before quoting it.

Reasoning tokens are a **residual**, not a count. Claude Code stores a summary of the chain of
thought while the raw chain is what gets billed, so turns carrying a thinking block bill ~2.6x
their transcribed text against ~1.45x — the calibration factor — for turns without one. Counting
the summary would undercount reasoning about fourfold. Prose and tool JSON are counted; reasoning
is what is left of billed output, and only on turns that actually carried a thinking block.

The fully loaded column assumes output stays in the conversation and is re-read on every later
turn. The command **measures that instead of asserting it**: the persistence fit at the bottom
regresses prefix growth on each content class, using incoming tool results as a control whose
coefficient is known to be ~1. Across the ten corpora the control lands at 0.86–1.15 and reasoning
at 0.90–1.02 on nine of them, so reasoning does compound. Read the per-corpus fits, not the pooled
one — pooling mixes corpora with different per-turn fixed overheads and the pooled fit is looser.

Because the fit needs it, `anatomy` is the one command that loads transcripts with
`blockDetail: true`, which retains tool-call text and tokenizes every tool result. It is
substantially slower and hungrier than the others; `gauthier` wants `--max-old-space-size`.

## Data

`data/caveman/` holds the observations the shipped thresholds in `curves/` were fitted from.
Each batch is a `.jsonl` of one record per assistant turn plus a `.meta.json` sidecar.

A record is exactly this:

```json
{
  "lang": "en",
  "band": 0,
  "shape": "prose",
  "sentLen": 5,
  "index": 3,
  "last": false,
  "model": "claude-opus-4-8",
  "caveman": true,
  "batch": "b20260814-130601-hgyrh3"
}
```

Language, size band, bullet-vs-prose shape, mean sentence length, position in the session,
whether the turn closed a run, model family, and whether caveman was live. **No prose, no
paths, no repo or project names, no timestamps, no session ids.** Nothing in a batch can be
turned back into what anyone was working on — but it does describe how a person writes, which is
why `compliance record` refuses to run without an explicit `--consent`.

Contributors are named by handle in the sidecar and by opaque id in `curves/`. That is the
attribution CC BY 4.0 asks a citer to honour; see [LICENSE-DATA](LICENSE-DATA).

## What you should not conclude from a clean run

The commands print their own caveats and mean them. The short version:

- Sensitivity is taken as 1, so every `p_fire` is a **lower** bound.
- Mid-run `R` is measured, but its pair IQR runs 0.15 to 0.93 — most of the interval below 1.0.
- Thinking tokens are assumed untouched, and that assumption is untested — they are ~89% of
  billed output, so if caveman does compress them every figure here understates it.
- A pooled percentage describes the heaviest spender while appearing to describe everyone.

[docs/methodology.md](docs/methodology.md) states each of these in full, with what it would take
to settle them.
