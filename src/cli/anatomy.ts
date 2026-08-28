import {
  anatomyOf,
  CLASSES,
  CLASS_LABEL,
  LANES,
  LANE_LABEL,
  ORIGINS,
  ORIGIN_LABEL,
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

const SPEC = { value: ['root'], boolean: ['exact', 'tools-only', 'vanilla-only'] } as const;

const USAGE = `jayn-caveman anatomy — what the bill is made of, by billing lane and by content class

${ROOT_HELP}
  --tools-only        print only the separate per-tool call and result bills
  --vanilla-only      drop sessions that ran caveman, leaving an untreated baseline
  --exact             count tokens with Anthropic's count_tokens API instead of the
                      offline BPE counter. Needs ANTHROPIC_API_KEY.

Six sections.

LANES is what Anthropic charges for and comes straight out of the recorded usage, so it is
exact. Cache reads dominate every corpus measured here, which is the single most important
fact about an agent bill: you are not mostly paying to generate tokens, you are paying to
re-read them.

CLASSES is what the OUTPUT was — only the tokens the model wrote. Prose and tool-call JSON are
counted from the transcript; reasoning is the residual of billed output, because Claude Code
stores a summary of the chain of thought and the raw chain is what gets billed. Note that
"tool calls" here is the JSON the model EMITS to call a tool, never the result it reads back.

ORIGINS covers the whole bill, including the input side the classes leave out. Writes are
attributed by differencing cache_creation against the previous turn's output; reads by
carrying the composition of the prefix and splitting each turn's observed cache_read across
it. Nothing is projected forward to the end of the session, so the amplification is the one
that was actually charged. The audit line reports the carried prefix over the billed
cache_read — if that is not near 1.000, the table is wrong and should not be quoted.

TOOL CALLS attributes the model's cost to generate each call plus the observed cache writes and
reads of that call's JSON. TOOL RESULTS separately attributes cache writes and reads to matched
tool_result blocks. Stored result sizes remain an upper bound because Claude Code may truncate
them before sending; the dollar columns are scaled to recorded usage.`;

const usd = (n: number) => `$${n.toFixed(2)}`;
const preciseUSD = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : usd(n));
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
        `cache write and\n  the re-reads it was actually charged are added. Measured against ` +
        `observed cache_read,\n  not projected to the end of the session.`,
    );
  }
  if (report.overflowTokens > 0 && totalOutput > 0) {
    lines.push(
      `! ${tokens(report.overflowTokens)} tokens of counted prose+tool exceeded billed output ` +
        `(${pct(report.overflowTokens / totalOutput)} of output).\n  Calibration noise; the ` +
        `reasoning residual was floored at zero on those turns.`,
    );
  }
  return lines;
}

function originTable(report: Anatomy): string[] {
  const lines = [
    `  ${'origin'.padEnd(28)}${'written'.padStart(9)}${'read'.padStart(9)}${'amp'.padStart(7)}` +
      `${'write $'.padStart(11)}${'read $'.padStart(11)}${'total $'.padStart(11)}${'% bill'.padStart(9)}`,
    `  ${'-'.repeat(95)}`,
  ];
  const order = [...ORIGINS].sort((a, b) => report.originUSD[b] - report.originUSD[a]);
  for (const origin of order) {
    const totals = report.origins[origin];
    const amp = totals.written === 0 ? 0 : totals.read / totals.written;
    lines.push(
      `  ${ORIGIN_LABEL[origin].padEnd(28)}${tokens(totals.written).padStart(9)}${tokens(totals.read).padStart(9)}` +
        `${(amp === 0 ? '—' : `${amp.toFixed(1)}x`).padStart(7)}` +
        `${usd(totals.writeUSD).padStart(11)}${usd(totals.readUSD).padStart(11)}` +
        `${usd(report.originUSD[origin]).padStart(11)}` +
        `${(report.totalUSD === 0 ? '—' : pct(report.originUSD[origin] / report.totalUSD)).padStart(9)}`,
    );
  }

  const written = CLASSES.reduce((sum, c) => sum + report.originUSD[c], 0);
  const outputLane = report.laneUSD.output;
  const read = report.originUSD.fedIn + report.originUSD.preamble;
  lines.push(`  ${'-'.repeat(95)}`);
  lines.push(
    `  ${'what the model WROTE'.padEnd(28)}${''.padStart(48)}${usd(written + outputLane).padStart(11)}` +
      `${(report.totalUSD === 0 ? '—' : pct((written + outputLane) / report.totalUSD)).padStart(9)}`,
  );
  lines.push(
    `  ${'what the model READ'.padEnd(28)}${''.padStart(48)}${usd(read).padStart(11)}` +
      `${(report.totalUSD === 0 ? '—' : pct(read / report.totalUSD)).padStart(9)}`,
  );
  lines.push('');
  lines.push(
    `  audit: the carried prefix is ${report.identityRatio.toFixed(3)}x the billed request` +
      ` (1.000 is exact).\n  ${tokens(report.compactedTokens)} prefix tokens were dropped along the way — compaction and context editing.`,
  );
  lines.push(
    `  "fed in" is everything that is not the preamble or the previous turn's output: tool\n` +
      `  results and your prompts, but also injected reminders and re-writes after a TTL expiry.\n` +
      `  It is an upper bound on tool results, not a measurement of them.`,
  );
  return lines;
}

const TOOL_ROWS = 40;
const NAME_WIDTH = 12;

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

function toolCallTable(report: Anatomy): string[] {
  const tools = report.tools
    .filter((tool) => tool.calls > 0 || tool.callTotalUSD > 0)
    .sort((a, b) => b.callTotalUSD - a.callTotalUSD || b.calls - a.calls);
  if (tools.length === 0) return ['  (no tool calls in this corpus)'];
  const total = (rows: readonly Anatomy['tools'][number][]) =>
    rows.reduce((sum, tool) => sum + tool.callTotalUSD, 0);
  const header =
    `  ${'tool'.padEnd(NAME_WIDTH)}${'calls'.padStart(7)}${'% calls'.padStart(9)}` +
    `${'out tok'.padStart(10)}${'p50/p95'.padStart(12)}${'gen $'.padStart(10)}` +
    `${'write $'.padStart(10)}${'read $'.padStart(10)}${'total $'.padStart(11)}${'% bill'.padStart(9)}`;
  const lines = [header, `  ${'-'.repeat(header.length - 2)}`];
  for (const tool of tools.slice(0, TOOL_ROWS)) {
    const sizes = `${tokens(Math.round(tool.callP50Tokens))}/${tokens(Math.round(tool.callP95Tokens))}`;
    lines.push(
      `  ${displayName(tool.name).padEnd(NAME_WIDTH)}${String(tool.calls).padStart(7)}` +
        `${pct(tool.calls / report.toolCallTotal).padStart(9)}` +
        `${tokens(Math.round(tool.callTokens)).padStart(10)}${sizes.padStart(12)}` +
        `${preciseUSD(tool.callOutputUSD).padStart(10)}` +
        `${preciseUSD(tool.callWriteUSD).padStart(10)}` +
        `${preciseUSD(tool.callReadUSD).padStart(10)}` +
        `${preciseUSD(tool.callTotalUSD).padStart(11)}` +
        `${pct(report.toolCallBillUSD === 0 ? 0 : tool.callTotalUSD / report.toolCallBillUSD).padStart(9)}`,
    );
  }
  if (tools.length > TOOL_ROWS) {
    const rest = tools.slice(TOOL_ROWS);
    const calls = rest.reduce((sum, tool) => sum + tool.calls, 0);
    const subtotal = total(rest);
    lines.push(
      `  ${`(${rest.length} more)`.padEnd(NAME_WIDTH)}${String(calls).padStart(7)}` +
        `${pct(calls / report.toolCallTotal).padStart(9)}` +
        `${tokens(Math.round(rest.reduce((sum, tool) => sum + tool.callTokens, 0))).padStart(10)}` +
        `${'—'.padStart(12)}${''.padStart(30)}${preciseUSD(subtotal).padStart(11)}` +
        `${pct(report.toolCallBillUSD === 0 ? 0 : subtotal / report.toolCallBillUSD).padStart(9)}`,
    );
  }
  lines.push(`  ${'-'.repeat(header.length - 2)}`);
  lines.push(
    `  ${`${tools.length} tools`.padEnd(NAME_WIDTH)}${String(report.toolCallTotal).padStart(7)}` +
      `${pct(1).padStart(9)}` +
      `${tokens(Math.round(tools.reduce((sum, tool) => sum + tool.callTokens, 0))).padStart(10)}` +
      `${'—'.padStart(12)}${''.padStart(30)}${preciseUSD(report.toolCallBillUSD).padStart(11)}` +
      `${pct(1).padStart(9)}`,
  );
  lines.push(
    `  total $ = generation + attributed cache writes/reads of tool-call JSON; ` +
      `${pct(report.totalUSD === 0 ? 0 : report.toolCallBillUSD / report.totalUSD)} of the whole bill.`,
  );
  return lines;
}

function toolResultTable(report: Anatomy): string[] {
  const tools = report.tools
    .filter((tool) => tool.results > 0 || tool.resultTotalUSD > 0)
    .sort((a, b) => b.resultTotalUSD - a.resultTotalUSD || b.results - a.results);
  if (tools.length === 0) return ['  (no matched tool results in this corpus)'];
  const total = (rows: readonly Anatomy['tools'][number][]) =>
    rows.reduce((sum, tool) => sum + tool.resultTotalUSD, 0);
  const header =
    `  ${'tool'.padEnd(NAME_WIDTH)}${'results'.padStart(8)}${'% results'.padStart(10)}` +
    `${'in tok'.padStart(10)}${'p50/p95'.padStart(12)}${'write $'.padStart(10)}` +
    `${'read $'.padStart(10)}${'total $'.padStart(11)}${'% bill'.padStart(9)}`;
  const lines = [header, `  ${'-'.repeat(header.length - 2)}`];
  for (const tool of tools.slice(0, TOOL_ROWS)) {
    const sizes = `${tokens(Math.round(tool.resultP50Tokens))}/${tokens(Math.round(tool.resultP95Tokens))}`;
    lines.push(
      `  ${displayName(tool.name).padEnd(NAME_WIDTH)}${String(tool.results).padStart(8)}` +
        `${pct(tool.results / report.toolResultTotal).padStart(10)}` +
        `${tokens(Math.round(tool.resultTokens)).padStart(10)}${sizes.padStart(12)}` +
        `${preciseUSD(tool.resultWriteUSD).padStart(10)}` +
        `${preciseUSD(tool.resultReadUSD).padStart(10)}` +
        `${preciseUSD(tool.resultTotalUSD).padStart(11)}` +
        `${pct(report.toolResultBillUSD === 0 ? 0 : tool.resultTotalUSD / report.toolResultBillUSD).padStart(9)}`,
    );
  }
  if (tools.length > TOOL_ROWS) {
    const rest = tools.slice(TOOL_ROWS);
    const results = rest.reduce((sum, tool) => sum + tool.results, 0);
    const subtotal = total(rest);
    lines.push(
      `  ${`(${rest.length} more)`.padEnd(NAME_WIDTH)}${String(results).padStart(8)}` +
        `${pct(results / report.toolResultTotal).padStart(10)}` +
        `${tokens(Math.round(rest.reduce((sum, tool) => sum + tool.resultTokens, 0))).padStart(10)}` +
        `${'—'.padStart(12)}${''.padStart(20)}${preciseUSD(subtotal).padStart(11)}` +
        `${pct(report.toolResultBillUSD === 0 ? 0 : subtotal / report.toolResultBillUSD).padStart(9)}`,
    );
  }
  lines.push(`  ${'-'.repeat(header.length - 2)}`);
  lines.push(
    `  ${`${tools.length} tools`.padEnd(NAME_WIDTH)}${String(report.toolResultTotal).padStart(8)}` +
      `${pct(1).padStart(10)}` +
      `${tokens(Math.round(tools.reduce((sum, tool) => sum + tool.resultTokens, 0))).padStart(10)}` +
      `${'—'.padStart(12)}${''.padStart(20)}${preciseUSD(report.toolResultBillUSD).padStart(11)}` +
      `${pct(1).padStart(9)}`,
  );
  lines.push(
    `  total $ = attributed cache writes/reads of matched results; ` +
      `${pct(report.totalUSD === 0 ? 0 : report.toolResultBillUSD / report.totalUSD)} of the whole bill.`,
  );
  lines.push(`  result token sizes are transcript upper bounds; billed cache totals anchor the cost.`);
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
    console.log('  WHERE THE TOKENS CAME FROM (writes differenced, reads split over the real prefix)');
    for (const line of originTable(report)) console.log(line);
    console.log('');
  }
  console.log('  TOOL CALLS (sorted by call-side cost)');
  for (const line of toolCallTable(report)) console.log(line);
  console.log('');
  console.log('  TOOL RESULTS (sorted by result-side cost)');
  for (const line of toolResultTable(report)) console.log(line);
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

  if (args.has('vanilla-only')) {
    for (const [label, sessions] of byLabel) {
      const kept = sessions.filter((session) => !session.cavemanActive);
      const dropped = sessions.length - kept.length;
      if (dropped > 0) {
        console.error(`${label}: dropped ${dropped} of ${sessions.length} sessions for running caveman.`);
      }
      byLabel.set(label, kept);
    }
  }

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
  summary: 'what the bill is made of: billing lanes, content classes, and per-tool exchange cost',
  usage: USAGE,
  spec: SPEC,
  run,
};
