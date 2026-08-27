import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeSession, lastOfRunFlags, markCavemanLive, stripFences, type Turn } from './session.js';

function writeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-session-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

const USAGE = {
  input_tokens: 10,
  output_tokens: 200,
  cache_read_input_tokens: 5000,
  cache_creation: { ephemeral_1h_input_tokens: 300 },
};

test('unions content blocks across events sharing one message.id', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id: 'm1',
        model: 'claude-opus-4-6',
        usage: USAGE,
        content: [{ type: 'thinking', thinking: '' }],
      },
    },
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-01-01T00:00:01Z',
      message: { id: 'm1', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'hello world' }] },
    },
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-01-01T00:00:02Z',
      message: { id: 'm1', model: 'claude-opus-4-6', content: [{ type: 'text', text: ' and more' }] },
    },
  ]);

  const session = await analyzeSession(file);
  assert.equal(session.turns.length, 1, 'three events, one logical turn');
  assert.equal(session.turns[0]!.proseText, 'hello world and more', 'sibling blocks must be kept');
  assert.equal(session.turns[0]!.outputTokens, 200, 'usage counted once, not three times');
});

test('usage is not double counted when repeated across sibling events', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: { id: 'm1', model: 'claude-opus-4-6', usage: USAGE, content: [{ type: 'text', text: 'a' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      message: { id: 'm1', model: 'claude-opus-4-6', usage: USAGE, content: [{ type: 'text', text: 'b' }] },
    },
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0]!.outputTokens, 200);
  assert.equal(session.turns[0]!.cacheWrite1h, 300);
});

test('fenced code is excluded from prose', () => {
  assert.equal(stripFences('before ```const x = 1;``` after'), 'before  after');
});

test('onlyTextBlocks flags tokenizer ground truth', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id: 'pure',
        model: 'claude-opus-4-6',
        usage: USAGE,
        content: [{ type: 'text', text: 'just prose' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      message: {
        id: 'mixed',
        model: 'claude-opus-4-6',
        usage: USAGE,
        content: [
          { type: 'text', text: 'prose' },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    },
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.turns[0]!.onlyTextBlocks, true);
  assert.equal(session.turns[1]!.onlyTextBlocks, false);
});

const hook = (text: string, hookEvent = 'SessionStart') => ({
  type: 'attachment',
  attachment: { type: 'hook', hookName: 'caveman', hookEvent, content: text },
});

const toolResult = (text: string, toolUseId?: string) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }), content: text },
    ],
  },
  toolUseResult: { stdout: text },
});

test('block detail pairs tool calls and results without retaining result text', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id: 'm1',
        model: 'claude-opus-4-6',
        usage: USAGE,
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      },
    },
    toolResult('the file contents', 'tool-1'),
    assistant('m2', 'done', '2026-01-01T00:00:01Z'),
  ]);

  const session = await analyzeSession(file, { blockDetail: true });
  const call = session.turns[0]!.toolCallDetails[0]!;
  assert.equal(call.name, 'Read');
  assert.equal(session.turns[0]!.toolCallText.slice(call.start, call.end), 'Read{"file_path":"src/a.ts"}');
  assert.deepEqual(session.turns[1]!.incomingToolResults, [
    {
      toolUseId: 'tool-1',
      name: 'Read',
      legacyTokens: session.turns[1]!.incomingToolResults[0]!.legacyTokens,
    },
  ]);
  assert.ok(session.turns[1]!.incomingToolResults[0]!.legacyTokens > 0);
});

const assistant = (id: string, text: string, ts: string) => ({
  type: 'assistant',
  timestamp: ts,
  message: { id, model: 'claude-opus-4-6', usage: USAGE, content: [{ type: 'text', text }] },
});

test('injections are attributed to the turn that follows them', async () => {
  const file = writeTranscript([
    hook('CAVEMAN MODE ACTIVE — level: full\n## Persistence\nblah'),
    assistant('m1', 'a', '2026-01-01T00:00:00Z'),
    hook('CAVEMAN MODE ACTIVE (full). Drop articles.', 'UserPromptSubmit'),
    assistant('m2', 'b', '2026-01-01T00:00:01Z'),
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.cavemanActive, true);
  assert.equal(session.turns[0]!.injectedOneTime.length, 1, 'skill block on turn 0');
  assert.equal(session.turns[0]!.injectedPerTurn.length, 0);
  assert.equal(session.turns[1]!.injectedOneTime.length, 0);
  assert.equal(session.turns[1]!.injectedPerTurn.length, 1, 'reminder on turn 1');
});

test('the model discussing caveman is not billed as an injection', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id: 'm1',
        model: 'claude-opus-4-6',
        usage: USAGE,
        content: [{ type: 'text', text: 'The marker CAVEMAN MODE ACTIVE appears in 42 sessions.' }],
      },
    },
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.cavemanActive, false);
  assert.equal(session.turns[0]!.injectedOneTime.length, 0);
  assert.equal(session.turns[0]!.injectedPerTurn.length, 0);
});

test('a tool result carrying the marker is not an injection and does not arm the session', async () => {
  const file = writeTranscript([
    toolResult('CAVEMAN MODE ACTIVE            42 files\n## Persistence appears too'),
    assistant('m1', 'a', '2026-01-01T00:00:00Z'),
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.cavemanActive, false, 'reading about caveman is not running caveman');
  assert.equal(session.turns[0]!.injectedOneTime.length, 0);
  assert.equal(session.turns[0]!.injectedPerTurn.length, 0);
});

test('tool results are not counted as user prompts', async () => {
  const file = writeTranscript([
    { type: 'user', message: { role: 'user', content: 'a real prompt' } },
    toolResult('some tool output'),
    toolResult('more tool output'),
    assistant('m1', 'a', '2026-01-01T00:00:00Z'),
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.turns[0]!.userPromptsBefore, 1, 'one prompt, two tool results');
});

test('the same hook text in content and stdout is one injection, not two', async () => {
  const text = 'CAVEMAN MODE ACTIVE — level: full\n## Persistence\nblah';
  const file = writeTranscript([
    {
      type: 'attachment',
      attachment: {
        type: 'hook',
        hookName: 'caveman',
        hookEvent: 'SessionStart',
        content: text,
        stdout: text,
      },
    },
    assistant('m1', 'a', '2026-01-01T00:00:00Z'),
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.turns[0]!.injectedOneTime.length, 1, 'one firing, one injection');
});

test('one string containing the marker twice counts once', async () => {
  const file = writeTranscript([
    hook('CAVEMAN MODE ACTIVE ... ## Persistence ... CAVEMAN MODE ACTIVE again'),
    assistant('m1', 'a', '2026-01-01T00:00:00Z'),
  ]);
  const session = await analyzeSession(file);
  assert.equal(session.turns[0]!.injectedOneTime.length, 1, 'one string, one injection');
});

test('turns without usage are dropped and indices stay contiguous', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: { id: 'm1', model: 'claude-opus-4-6', usage: USAGE, content: [{ type: 'text', text: 'a' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      message: { id: 'noUsage', content: [{ type: 'text', text: 'x' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:02Z',
      message: { id: 'm2', model: 'claude-opus-4-6', usage: USAGE, content: [{ type: 'text', text: 'b' }] },
    },
  ]);
  const session = await analyzeSession(file);
  assert.deepEqual(
    session.turns.map((t) => t.index),
    [0, 1],
    'position drives read amplification, so it must be contiguous',
  );
});

const run = (...counts: number[]) => counts.map((userPromptsBefore) => ({ userPromptsBefore }));

const live = (...spec: [number, boolean][]) => {
  const turns = spec.map(([userPromptsBefore, reminded]) => ({
    userPromptsBefore,
    injectedPerTurn: reminded ? ['CAVEMAN MODE ACTIVE (full)'] : [],
    injectedOneTime: [],
    cavemanLive: false,
  })) as unknown as Turn[];
  markCavemanLive(turns);
  return turns.map((t) => t.cavemanLive);
};

test('caveman goes off mid-session when the per-prompt reminder stops arriving', () => {
  assert.deepEqual(
    live([1, true], [0, false], [1, false], [0, false], [1, true], [0, false]),
    [true, true, false, false, true, true],
    'the flag is read at run boundaries and carried across the turns of that run',
  );
});

test("a mid-run turn carries its run's flag, not its own missing reminder", () => {
  assert.deepEqual(live([1, true], [0, false], [0, false]), [true, true, true]);
});

test('the SessionStart block activates without a prompt of its own', () => {
  const turns = [
    { userPromptsBefore: 0, injectedPerTurn: [], injectedOneTime: ['## Persistence'], cavemanLive: false },
  ] as unknown as Turn[];
  markCavemanLive(turns);
  assert.deepEqual(
    turns.map((t) => t.cavemanLive),
    [true],
    'the ruleset arrives before the first prompt, so turn 0 cannot require a reminder',
  );
});

test('a run ends at the turn before the next user prompt', () => {
  assert.deepEqual(lastOfRunFlags(run(1, 0, 0, 1, 0)), [false, false, true, false, true]);
});

test("the session's final turn closes a run even though nothing follows it", () => {
  assert.deepEqual(lastOfRunFlags(run(1, 0, 0)), [false, false, true]);
  assert.deepEqual(lastOfRunFlags(run(1)), [true], 'one turn is one run');
  assert.deepEqual(lastOfRunFlags([]), []);
});

test('a run of length 1 is closing, not mid-run', () => {
  assert.deepEqual(lastOfRunFlags(run(1, 1, 1)), [true, true, true]);
});

test('several prompts before one turn still open a single run', () => {
  assert.deepEqual(lastOfRunFlags(run(2, 0, 3, 0)), [false, true, false, true]);
});
