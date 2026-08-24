import {
  anatomyOf,
  CLASSES,
  CLASS_LABEL,
  LANES,
  LANE_LABEL,
  type Anatomy,
  type ContentClass,
  type Lane,
} from '../corpus/anatomy.js';
import { groupByLabel, loadGrouped } from '../transcript/load.js';
import { calibrateLocally } from '../transcript/load.js';
import type { SessionAnalysis } from '../transcript/session.js';
import { ApiCounter, resolveApiKey, type TokenCounter } from '../transcript/tokens.js';
import type { Args, Command } from './args.js';
import { ROOT_HELP, targetsFrom } from './roots.js';

const SPEC = { value: ['root'], boolean: ['exact', 'tools-only'] } as const;

const USAGE = `jayn-caveman anatomy — what the bill is made of, by billing lane and by content class

${ROOT_HELP}
  --tools-only        print only the tool-call histogram
  --exact             count tokens with Anthropic's count_tokens API instead of the
                      offline BPE counter. Needs ANTHROPIC_API_KEY.

Three questions, three tables.

LANES is what Anthropic charges for and comes straight out of the recorded usage, so it is
exact. Cache reads dominate every corpus measured here, which is the single most important
fact about an agent bill: you are not mostly paying to generate tokens, you are paying to
re-read the ones you already generated.

CLASSES is what those tokens were. Prose and tool-call JSON are counted from the transcript;
reasoning is the residual of billed output, because Claude Code stores a summary of the chain
of thought and the raw chain is what gets billed. Each class is priced twice: at the output
rate alone, and fully loaded — output, then the cache write on the next turn, then a cache
read on every turn after that. The gap between the two columns is the compounding.

TOOLS is every tool_use block by name.

The fully loaded column is a model, and it rests on output staying in the conversation and
being re-read. That assumption is measured, not asserted: the persistence fit at the bottom
regresses prefix growth on each class, with incoming tool results as the control.`;

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function laneTable(report: Anatomy): string[] {
  const lines = [
    `  ${'lane'.padEnd(24)}${'tokens'.padStart(10)}${'cost'.padStart(12)}${'% of bill'.padStart(11)}`,
    `  ${'-'.repeat(55)}`,
  ];
  const order: Lane[] = [...LANES].sort((a, b) => report.laneUSD[b] - report.laneUSD[a]);
  for (const lane of order) {
    lines.push(
      `  ${LANE_LABEL[lane].padEnd(24)}${tokens(report.laneTokens[lane]).padStart(10)}` +
        `${usd(report.laneUSD[lane]).padStart(12)}` +
        `${(report.totalUSD === 0 ? '—' : pct(report.laneUSD[lane] / report.totalUSD)).padStart(11)}`,
    );
  }
  lines.push(`  ${'-'.repeat(55)}`);
  lines.push(`  ${'total'.padEnd(24)}${''.padStart(10)}${usd(report.totalUSD).padStart(12)}`);

  const writes = report.laneTokens.cacheWrite1h + report.laneTokens.cacheWrite5m;
  if (writes > 0) {
    lines.push('');
    lines.push(
      `  cache writes are ${pct(report.laneTokens.cacheWrite1h / writes)} 1h (2x) by token, ` +
        `the rest 5m (1.25x).`,
    );
  }
  const amplification = writes === 0 ? 0 : report.laneTokens.cacheRead / writes;
  if (amplification > 0) {
    lines.push(
      `  every token written to cache is read back ${amplification.toFixed(1)}x on average — ` +
        `that ratio is the\n  compounding, measured rather than modelled.`,
    );
  }
  return lines;
}

function classTable(report: Anatomy): string[] {
  const totalOutput = CLASSES.reduce((sum, c) => sum + report.classTokens[c], 0);
  const lines = [
    `  ${'class'.padEnd(24)}${'tokens'.padStart(10)}${'% out'.padStart(8)}` +
      `${'output $'.padStart(12)}${'fully loaded'.padStart(14)}${'% of bill'.padStart(11)}`,
    `  ${'-'.repeat(79)}`,
  ];
  const order: ContentClass[] = [...CLASSES].sort(
    (a, b) => report.classLoadedUSD[b] - report.classLoadedUSD[a],
  );
  for (const contentClass of order) {
    lines.push(
      `  ${CLASS_LABEL[contentClass].padEnd(24)}${tokens(report.classTokens[contentClass]).padStart(10)}` +
        `${(totalOutput === 0 ? '—' : pct(report.classTokens[contentClass] / totalOutput)).padStart(8)}` +
        `${usd(report.classOutputUSD[contentClass]).padStart(12)}` +
        `${usd(report.classLoadedUSD[contentClass]).padStart(14)}` +
        `${(report.totalUSD === 0 ? '—' : pct(report.classLoadedUSD[contentClass] / report.totalUSD)).padStart(11)}`,
    );
  }

  const loaded = CLASSES.reduce((sum, c) => sum + report.classLoadedUSD[c], 0);
  const raw = CLASSES.reduce((sum, c) => sum + report.classOutputUSD[c], 0);
  lines.push(`  ${'-'.repeat(79)}`);
  lines.push(
    `  ${'all output'.padEnd(24)}${tokens(totalOutput).padStart(10)}${''.padStart(8)}` +
      `${usd(raw).padStart(12)}${usd(loaded).padStart(14)}` +
      `${(report.totalUSD === 0 ? '—' : pct(loaded / report.totalUSD)).padStart(11)}`,
  );
  if (raw > 0) {
    lines.push('');
    lines.push(
      `  a token of output costs ${(loaded / raw).toFixed(2)}x its output-rate price once the ` +
        `cache write and\n  every subsequent re-read are charged to it.`,
    );
  }
  if (report.overflowTokens > 0 && totalOutput > 0) {
    lines.push(
      `! ${tokens(report.overflowTokens)} tokens of counted prose+tool exceeded billed output ` +
        `(${pct(report.overflowTokens / totalOutput)} of output).\n  Calibration noise; the ` +
        `reasoning residual was floored at zero on those turns.`,
    );
  }
  if (report.modelledSessions < report.sessions) {
    lines.push(
      `! ${report.sessions - report.modelledSessions} of ${report.sessions} sessions could not be ` +
        `replayed (unpriced model); their output is\n  counted in tokens but not in the dollar columns.`,
    );
  }
  return lines;
}

const TOOL_ROWS = 40;
const NAME_WIDTH = 46;

/**
 * MCP tool names are `mcp__<server>__<tool>`, and the server half is often a bare UUID. Trimming
 * from the right therefore collapses every tool on one server into the same visible row, which
 * looks like duplicate lines with different counts. Keep the tail — that is the part that says
 * which tool it actually was.
 */
function displayName(name: string): string {
  if (name.length <= NAME_WIDTH) return name;
  return `…${name.slice(name.length - NAME_WIDTH + 1)}`;
}

function toolTable(report: Anatomy): string[] {
  if (report.tools.length === 0) return ['  (no tool calls in this corpus)'];
  const width = NAME_WIDTH + 40;
  const lines = [
    `  ${'tool'.padEnd(NAME_WIDTH)}${'calls'.padStart(9)}${'% of calls'.padStart(12)}` +
      `${'turns'.padStart(9)}${'sessions'.padStart(10)}`,
    `  ${'-'.repeat(width)}`,
  ];
  for (const tool of report.tools.slice(0, TOOL_ROWS)) {
    lines.push(
      `  ${displayName(tool.name).padEnd(NAME_WIDTH)}${String(tool.calls).padStart(9)}` +
        `${pct(tool.calls / report.toolCallTotal).padStart(12)}` +
        `${String(tool.turns).padStart(9)}${String(tool.sessions).padStart(10)}`,
    );
  }
  if (report.tools.length > TOOL_ROWS) {
    const rest = report.tools.slice(TOOL_ROWS);
    const calls = rest.reduce((sum, tool) => sum + tool.calls, 0);
    lines.push(
      `  ${`(${rest.length} more tools)`.padEnd(NAME_WIDTH)}${String(calls).padStart(9)}` +
        `${pct(calls / report.toolCallTotal).padStart(12)}`,
    );
  }
  lines.push(`  ${'-'.repeat(width)}`);
  lines.push(
    `  ${`${report.tools.length} distinct tools`.padEnd(NAME_WIDTH)}${String(report.toolCallTotal).padStart(9)}`,
  );
  return lines;
}

function persistenceLines(report: Anatomy): string[] {
  const fit = report.persistence;
  if (!fit) return ['  (not enough clean turn pairs to fit)'];
  const c = fit.coefficients;
  const lines = [
    `  fitted on ${fit.pairs} turn pairs, R² ${fit.rSquared.toFixed(3)}`,
    `    incoming tool results (control, expect ~1) ${c.incoming.toFixed(3)}`,
    `    prose                                      ${c.prose.toFixed(3)}`,
    `    tool calls                                 ${c.toolCalls.toFixed(3)}`,
    `    reasoning                                  ${c.reasoning.toFixed(3)}`,
    `    per-turn fixed growth                      ${c.intercept.toFixed(0)} tokens`,
  ];
  if (Math.abs(c.incoming - 1) > 0.25) {
    lines.push(
      `! the control landed at ${c.incoming.toFixed(2)} rather than ~1, so this fit is not ` +
        `identifying what it\n  claims to. Read the reasoning coefficient as unmeasured.`,
    );
  } else if (c.reasoning < 0.5) {
    lines.push(
      `! reasoning does NOT survive into the prefix at this corpus's rate, so its fully loaded\n` +
        `  column above is an overestimate — it is closer to the output-rate column.`,
    );
  }
  return lines;
}

function render(report: Anatomy, toolsOnly: boolean): void {
  console.log('');
  console.log(`${report.label} — ${report.sessions} sessions, ${report.turns} assistant turns`);
  console.log('');
  if (!toolsOnly) {
    console.log('  WHERE THE MONEY GOES (exact, from recorded usage)');
    for (const line of laneTable(report)) console.log(line);
    console.log('');
    console.log('  WHAT THE OUTPUT WAS (prose and tools counted, reasoning by residual)');
    for (const line of classTable(report)) console.log(line);
    console.log('');
  }
  console.log('  TOOL CALLS');
  for (const line of toolTable(report)) console.log(line);
  if (!toolsOnly) {
    console.log('');
    console.log('  DOES OUTPUT STAY IN THE PREFIX? (regression of prefix growth on content class)');
    for (const line of persistenceLines(report)) console.log(line);
  }
  if (report.unpriced) {
    console.log('');
    console.log('! some turns used a model with no rate in billing/pricing.ts and were skipped.');
  }
}

function counterFor(
  args: Args,
  sessions: SessionAnalysis[],
): { counter: TokenCounter; calibration: number; flush: () => void } {
  const local = calibrateLocally(sessions);
  const calibration = local.counter.calibrationFor('claude-opus-5').factor;
  if (!args.has('exact')) return { counter: local.counter, calibration, flush: () => {} };

  const key = resolveApiKey();
  if (!key) {
    console.error('--exact needs ANTHROPIC_API_KEY; falling back to the offline counter.\n');
    return { counter: local.counter, calibration, flush: () => {} };
  }
  const api = new ApiCounter(key);
  return { counter: api, calibration, flush: () => api.flush() };
}

async function run(args: Args): Promise<void> {
  const targets = targetsFrom(args);
  const owned = await loadGrouped(targets, { blockDetail: true });
  const byLabel = groupByLabel(owned, targets);

  const reports: Anatomy[] = [];
  for (const [label, sessions] of byLabel) {
    if (sessions.length === 0) {
      const target = targets.find((entry) => entry.label === label);
      console.error(`No transcripts under ${target?.roots.join(', ')}.`);
      continue;
    }
    const counting = counterFor(args, sessions);
    try {
      reports.push(await anatomyOf(label, sessions, counting.counter, counting.calibration));
    } finally {
      counting.flush();
    }
  }
  if (reports.length === 0) throw new Error('No transcripts found.');

  for (const report of reports) render(report, args.has('tools-only'));

  if (reports.length > 1) {
    const all = [...byLabel.values()].flat();
    const counting = counterFor(args, all);
    try {
      render(
        await anatomyOf('all corpora pooled', all, counting.counter, counting.calibration),
        args.has('tools-only'),
      );
    } finally {
      counting.flush();
    }
  }
}

export const anatomyCommand: Command = {
  name: 'anatomy',
  summary: 'what the bill is made of: billing lanes, content classes, and the tool histogram',
  usage: USAGE,
  spec: SPEC,
  run,
};
