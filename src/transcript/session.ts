import { readRawEvents, type RawEvent } from './events.js';
import { memoCountTokens } from './tokens.js';

export interface ToolCallDetail {
  id?: string;
  name: string;
  /** Slice of `Turn.toolCallText` occupied by this call. */
  start: number;
  end: number;
}

export interface ToolResultDetail {
  toolUseId?: string;
  name: string;
  /** Legacy-BPE count of the result payload stored in the transcript. */
  legacyTokens: number;
}

export interface Turn {
  index: number;

  id: string;
  model: string;
  timestamp: Date;

  proseText: string;

  onlyTextBlocks: boolean;

  hasToolUse: boolean;

  /**
   * Names of every tool_use block in the turn, in order, with repeats — a turn that calls Read
   * three times contributes three entries. This is the population the tool histogram counts.
   */
  toolCalls: string[];

  /**
   * The serialised `input` of every tool_use block, concatenated. Only populated under
   * `blockDetail`, because it is several times the size of `proseText` and no other command
   * reads it. Counting it is what separates tool-call output from prose output.
   */
  toolCallText: string;

  /** Per-call boundaries retained only under `blockDetail`. */
  toolCallDetails: ToolCallDetail[];

  /**
   * True when the turn carried a `thinking` or `redacted_thinking` block.
   *
   * Deliberately not a token count. The transcript stores the *summary* Claude Code was shown,
   * never the raw chain of thought, and it is the raw one that is billed — measured at 2.6x the
   * summary on turns that have one. Reasoning tokens are therefore recovered as the residual of
   * billed output in `anatomy.ts`, not counted from this text.
   */
  hasThinking: boolean;

  /**
   * Legacy-BPE token count of everything that arrived between the previous turn and this one:
   * tool results and user text. Only populated under `blockDetail`.
   *
   * Stored as a count rather than as text because tool results are the largest thing in a
   * transcript by an order of magnitude. `anatomy` uses it to regress prefix growth on content
   * class, which is how the compounding model gets checked instead of assumed.
   */
  incomingLegacyTokens: number;

  /** Tool results arriving before this turn, matched back to their call by `tool_use_id`. */
  incomingToolResults: ToolResultDetail[];

  hasFence: boolean;
  outputTokens: number;
  inputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;

  injectedOneTime: string[];

  injectedPerTurn: string[];

  cavemanLive: boolean;

  userPromptsBefore: number;
}

export function lastOfRunFlags(turns: readonly Pick<Turn, 'userPromptsBefore'>[]): boolean[] {
  return turns.map((_turn, index) => index === turns.length - 1 || turns[index + 1]!.userPromptsBefore > 0);
}

export function markCavemanLive(turns: Turn[]): void {
  let live = false;
  for (const [index, turn] of turns.entries()) {
    if (index === 0 || turn.userPromptsBefore > 0) {
      live = turn.injectedPerTurn.length > 0 || turn.injectedOneTime.length > 0;
    }
    turn.cavemanLive = live;
  }
}

export interface SessionAnalysis {
  sessionId: string;
  file: string;
  cavemanActive: boolean;
  turns: Turn[];
}

const CAVEMAN_MARKER = 'CAVEMAN MODE ACTIVE';

const SKILL_BLOCK_MARKER = '## Persistence';

export function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function markerStrings(value: unknown, marker: string, found: Set<string>): void {
  if (typeof value === 'string') {
    if (value.includes(marker)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) markerStrings(item, marker, found);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) markerStrings(item, marker, found);
  }
}

function injectionsIn(event: RawEvent): string[] {
  if (event.attachment?.hookName === undefined) return [];
  const found = new Set<string>();
  markerStrings(event.attachment, CAVEMAN_MARKER, found);
  return [...found];
}

/** Every string reachable inside a value, joined — tool results nest text at varying depths. */
function flattenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(flattenText).join('\n');
  return '';
}

/**
 * What a user-role event contributes to the next request's prefix.
 *
 * This is the transcript's copy, which is an UPPER BOUND on what was actually sent: Claude Code
 * truncates large tool output before the request, and the untruncated version is what gets
 * written to disk. Measured across one corpus, only ~38% of stored tool-result tokens show up as
 * prefix growth. Anything reading this must either restrict to small results or expect the bias.
 */
function incomingTokensIn(event: RawEvent): number {
  if (event.type !== 'user') return 0;
  return memoCountTokens(flattenText(event.message?.content));
}

function toolResultsIn(event: RawEvent, toolNameById: ReadonlyMap<string, string>): ToolResultDetail[] {
  if (event.type !== 'user' || !Array.isArray(event.message?.content)) return [];
  const results: ToolResultDetail[] = [];
  for (const block of event.message.content) {
    if (block?.type !== 'tool_result') continue;
    const toolUseId = block.tool_use_id;
    results.push({
      ...(toolUseId === undefined ? {} : { toolUseId }),
      name: toolUseId === undefined ? 'unknown' : (toolNameById.get(toolUseId) ?? 'unknown'),
      legacyTokens: memoCountTokens(flattenText(block.content)),
    });
  }
  return results;
}

function isUserPrompt(event: RawEvent): boolean {
  if (event.type !== 'user') return false;
  const content = event.message?.content;
  if (!Array.isArray(content)) return true;
  return !content.some((block) => block?.type === 'tool_result');
}

interface Draft {
  order: number;
  model: string;
  timestamp: Date;
  proseParts: string[];
  toolCalls: string[];
  toolCallParts: Array<{ id?: string; name: string; text: string }>;
  hasThinking: boolean;
  kinds: Set<string>;
  hasFence: boolean;
  outputTokens: number;
  inputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  usageSeen: boolean;
}

export interface AnalyzeOptions {
  /**
   * Retain per-block detail: the serialised tool_use inputs, and the token count of everything
   * arriving between turns.
   *
   * Off by default and deliberately so. The tool_use text is hundreds of megabytes on the
   * largest corpus here, and the incoming count runs the tokenizer over every tool result in
   * the corpus. Only `anatomy` reads either, so every other command pays nothing for them.
   */
  blockDetail?: boolean;
}

export async function analyzeSession(file: string, options: AnalyzeOptions = {}): Promise<SessionAnalysis> {
  const drafts = new Map<string, Draft>();
  const order: string[] = [];
  let sessionId = 'unknown';
  let cavemanActive = false;

  let pendingOneTime: string[] = [];
  let pendingPerTurn: string[] = [];
  let pendingUserPrompts = 0;
  let pendingIncoming = 0;
  let pendingToolResults: ToolResultDetail[] = [];
  const toolNameById = new Map<string, string>();
  const attachedOneTime = new Map<string, string[]>();
  const attachedPerTurn = new Map<string, string[]>();
  const attachedPrompts = new Map<string, number>();
  const attachedIncoming = new Map<string, number>();
  const attachedToolResults = new Map<string, ToolResultDetail[]>();

  for await (const event of readRawEvents(file)) {
    if (event.sessionId) sessionId = event.sessionId;

    for (const text of injectionsIn(event)) {
      cavemanActive = true;
      if (text.includes(SKILL_BLOCK_MARKER)) pendingOneTime.push(text);
      else pendingPerTurn.push(text);
    }
    if (isUserPrompt(event)) pendingUserPrompts++;
    if (options.blockDetail) {
      pendingIncoming += incomingTokensIn(event);
      pendingToolResults.push(...toolResultsIn(event, toolNameById));
    }

    if (event.type !== 'assistant') continue;
    const id = event.message?.id;
    if (!id) continue;

    let draft = drafts.get(id);
    if (!draft) {
      draft = {
        order: order.length,
        model: event.message?.model ?? '',
        timestamp: new Date(event.timestamp ?? Date.now()),
        proseParts: [],
        toolCalls: [],
        toolCallParts: [],
        hasThinking: false,
        kinds: new Set(),
        hasFence: false,
        outputTokens: 0,
        inputTokens: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        usageSeen: false,
      };
      drafts.set(id, draft);
      order.push(id);

      attachedOneTime.set(id, pendingOneTime);
      attachedPerTurn.set(id, pendingPerTurn);
      attachedPrompts.set(id, pendingUserPrompts);
      attachedIncoming.set(id, pendingIncoming);
      attachedToolResults.set(id, pendingToolResults);
      pendingOneTime = [];
      pendingPerTurn = [];
      pendingUserPrompts = 0;
      pendingIncoming = 0;
      pendingToolResults = [];
    }

    const usage = event.message?.usage;
    if (usage) {
      if (!draft.usageSeen || (usage.output_tokens ?? 0) > draft.outputTokens) {
        draft.outputTokens = usage.output_tokens ?? 0;
      }

      if (!draft.usageSeen) {
        draft.inputTokens = usage.input_tokens ?? 0;
        draft.cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        draft.cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        draft.cacheRead = usage.cache_read_input_tokens ?? 0;
      }
      draft.usageSeen = true;
      if (!draft.model) draft.model = event.message?.model ?? '';
    }

    for (const block of event.message?.content ?? []) {
      if (!block.type) continue;
      draft.kinds.add(block.type);
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text.includes('```')) draft.hasFence = true;
        draft.proseParts.push(stripFences(text));
        continue;
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        draft.hasThinking = true;
        continue;
      }
      if (block.type === 'tool_use') {
        const name = block.name ?? 'unknown';
        draft.toolCalls.push(name);
        if (block.id !== undefined) toolNameById.set(block.id, name);
        // The name travels on the wire with the input, so it belongs in the same count.
        if (options.blockDetail) {
          draft.toolCallParts.push({
            ...(block.id === undefined ? {} : { id: block.id }),
            name,
            text: name + JSON.stringify(block.input ?? {}),
          });
        }
      }
    }
  }

  const turns: Turn[] = order
    .map((id, index) => {
      const draft = drafts.get(id)!;
      const toolCallText = draft.toolCallParts.map((part) => part.text).join('');
      let toolOffset = 0;
      const toolCallDetails = draft.toolCallParts.map((part) => {
        const start = toolOffset;
        toolOffset += part.text.length;
        return {
          ...(part.id === undefined ? {} : { id: part.id }),
          name: part.name,
          start,
          end: toolOffset,
        };
      });
      return {
        index,
        id,
        model: draft.model,
        timestamp: draft.timestamp,
        proseText: draft.proseParts.join(''),
        onlyTextBlocks: draft.kinds.size === 1 && draft.kinds.has('text'),
        hasToolUse: draft.kinds.has('tool_use'),
        toolCalls: draft.toolCalls,
        toolCallText,
        toolCallDetails,
        hasThinking: draft.hasThinking,
        incomingLegacyTokens: attachedIncoming.get(id) ?? 0,
        incomingToolResults: attachedToolResults.get(id) ?? [],
        hasFence: draft.hasFence,
        outputTokens: draft.outputTokens,
        inputTokens: draft.inputTokens,
        cacheWrite5m: draft.cacheWrite5m,
        cacheWrite1h: draft.cacheWrite1h,
        cacheRead: draft.cacheRead,
        injectedOneTime: attachedOneTime.get(id) ?? [],
        injectedPerTurn: attachedPerTurn.get(id) ?? [],
        userPromptsBefore: attachedPrompts.get(id) ?? 0,
        cavemanLive: false,
      };
    })
    .filter((turn) => turn.outputTokens > 0);

  turns.forEach((turn, index) => {
    turn.index = index;
  });

  markCavemanLive(turns);

  return {
    sessionId,
    file,
    cavemanActive,
    turns,
  };
}
