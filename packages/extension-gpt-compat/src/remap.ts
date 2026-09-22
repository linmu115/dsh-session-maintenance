import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format';
/** GPT owns checkpoint/operation coordinates; the host codec does not name plugin event types. */
export function remapGptEvent(event: SessionFormatEvent, source: SessionFormatEvent, mapping: readonly (number | undefined)[]): SessionFormatEvent {
  const field = event.type === 'context/checkpoint-commit' ? 'checkpoint' : event.type === 'context/operation-result' ? 'operation' : null;
  if (field === null) return event;
  const data = event.data as Record<string, any>, value = data[field];
  if (!Number.isSafeInteger(value) || value < 0 || value >= source.seq || mapping[value] === undefined)
    throw new Error('GPT reference target is absent from the destination');
  return { ...event, data: { ...data, [field]: mapping[value]! } };
}
