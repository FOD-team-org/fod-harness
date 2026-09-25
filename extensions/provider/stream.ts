import {
  createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { loadConfig } from '../../src/core/config.ts';
import { runTurn, latestMessage, type TurnOptions } from '../../src/provider/turn.ts';

export function streamClaude(
  model: Model<any>, context: Context, options: SimpleStreamOptions | undefined,
  turnOptions: Omit<TurnOptions, 'model' | 'signal' | 'onText'> & { useConfiguredModel?: boolean },
) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }, stopReason: 'stop', timestamp: Date.now(),
  };
  void (async () => {
    stream.push({ type: 'start', partial: output });
    stream.push({ type: 'text_start', contentIndex: 0, partial: output });
    try {
      const selectedModel = turnOptions.useConfiguredModel ? (await loadConfig(turnOptions.root)).brain.model : model.id;
      output.model = selectedModel;
      const result = await runTurn(latestMessage(context), {
        ...turnOptions, model: selectedModel, signal: options?.signal, onText: delta => {
          const content = output.content[0];
          if (content.type === 'text') content.text += delta;
          stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: output });
        },
      });
      const usage = result.usage ?? {};
      output.usage.input = usage.input_tokens ?? 0;
      output.usage.output = usage.output_tokens ?? 0;
      output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
      output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
      output.usage.totalTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite
        + (result.contextUsage ? 0 : output.usage.output);
      output.stopReason = result.reason;
      const content = output.content[0];
      stream.push({ type: 'text_end', contentIndex: 0, content: content.type === 'text' ? content.text : '', partial: output });
      if (result.reason === 'stop') stream.push({ type: 'done', reason: 'stop', message: output });
      else {
        output.errorMessage = `하네스 실행 중단: ${result.classification}`;
        stream.push({ type: 'error', reason: result.reason, error: output });
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error && /^(configError:|하네스|잠금)/.test(error.message)
        ? error.message : '하네스 실행 실패: 설정과 원장을 확인하세요.';
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    } finally { stream.end(); }
  })();
  return stream;
}
