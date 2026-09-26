import { redact } from './privacy.ts';

export type BrainOutput = 'result' | 'full';
export const RESULT_FOOTER_PREFIX = '— 도구 ';
export const HOOK_DENIAL_PREFIX = '[훅 차단] ';
export function isHarnessDisplayLine(line: string): boolean {
  return line.startsWith(HOOK_DENIAL_PREFIX)
    || line.startsWith(RESULT_FOOTER_PREFIX) && /^\d/u.test(line.slice(RESULT_FOOTER_PREFIX.length));
}
export function toolBlock(value: string): string {
  let longest = 2;
  for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `\n${fence}\n${value}\n${fence}\n`;
}
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
};

// Presentation only: event persistence, auditing and denial decisions stay in runTurn.
export class TurnDisplay {
  private readonly started = Date.now();
  private mainTools = 0;
  private childTools = 0;
  private lastTool = '';
  private lastMain = '';
  private mainFragment = '';
  private lastResult = '';
  private agents = new Set<string>();
  private tasks = new Set<string>();
  private completed = new Set<string>();
  private denials = new Set<string>();
  private denialIds = new Set<string>();
  private lastProgress = '';
  private lastSent = -Infinity;
  private pending?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;
  readonly mode: BrainOutput;
  private onText?: (text: string) => void;
  private onProgress?: (line: string) => void;
  constructor(mode: BrainOutput, onText?: (text: string) => void, onProgress?: (line: string) => void) {
    this.mode = mode; this.onText = onText; this.onProgress = onProgress;
    if (mode === 'result' && onProgress) {
      this.tick = setInterval(() => this.progress(), 5000);
      this.tick.unref();
    }
  }
  text(value: string) {
    if (this.mode === 'full') this.onText?.(redact(value));
  }
  denial(id: string, line?: string) {
    this.denialIds.add(id);
    if (!line) return;
    if (this.mode === 'full') this.text(`\n${line}\n`);
    else this.denials.add(line);
  }
  observe(event: Record<string, any>) {
    if (this.mode !== 'result') return;
    const child = !!event.parent_tool_use_id;
    if (event.type === 'assistant') {
      const content = event.message?.content ?? [];
      if (!child) {
        const text = content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
        if (text.trim()) this.lastMain = text;
      }
      for (const block of content) if (block.type === 'tool_use') {
        if (child) this.childTools++;
        else {
          this.mainTools++;
          this.lastTool = redact(typeof block.input?.description === 'string' && block.input.description.trim()
            ? block.input.description : String(block.name)).replace(/\s+/gu, ' ').slice(0, 60);
          if (block.name === 'Agent' || block.name === 'Task') this.agents.add(block.id);
        }
      }
    } else if (event.type === 'stream_event' && !child) {
      if (event.event?.type === 'message_start') this.mainFragment = '';
      if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
        this.mainFragment += event.event.delta.text;
      }
    } else if (event.type === 'system') {
      const id = event.task_id ?? event.tool_use_id;
      if (id && event.subtype === 'task_started') this.tasks.add(id);
      if (id && (event.subtype === 'task_notification' && ['completed', 'failed', 'killed'].includes(event.status)
        || event.subtype === 'task_updated' && ['completed', 'failed', 'killed'].includes(event.patch?.status))) this.completed.add(id);
    } else if (event.type === 'result') {
      this.lastResult = typeof event.result === 'string' && event.result.trim() ? event.result : '';
    }
    this.progress();
  }
  private agentCount() { return this.tasks.size || this.agents.size; }
  private progress() {
    if (!this.onProgress) return;
    const elapsed = Math.floor((Date.now() - this.started) / 5000) * 5000;
    const line = `작업 중 ${duration(elapsed)} · 도구 ${this.mainTools} · 보조 ${this.completed.size}/${this.agentCount()} · 보조 도구 ${this.childTools}${this.lastTool ? ` · ${this.lastTool}` : ''}`;
    if (line === this.lastProgress) return;
    const wait = 1000 - (Date.now() - this.lastSent);
    if (wait > 0) {
      this.pending ??= setTimeout(() => { this.pending = undefined; this.progress(); }, wait);
      this.pending.unref();
      return;
    }
    this.lastSent = Date.now(); this.lastProgress = line;
    try { this.onProgress(redact(line)); } catch { /* Disposed UI is harmless. */ }
  }
  finish(classification?: string) {
    clearTimeout(this.pending); clearInterval(this.tick);
    if (this.mode !== 'result') return;
    const body = this.lastResult || this.lastMain || this.mainFragment;
    const parts = [body, ...this.denials].filter(Boolean);
    const footer = `${RESULT_FOOTER_PREFIX}${this.mainTools}회 · 보조 에이전트 ${this.agentCount()}개 · ${duration(Date.now() - this.started)}`
      + (this.denialIds.size ? ` · 훅 차단 ${this.denialIds.size}건` : '')
      + (classification ? ` · 중단: ${classification}` : '');
    this.onText?.(redact(parts.join('\n') + '\n\n' + footer));
  }
}
