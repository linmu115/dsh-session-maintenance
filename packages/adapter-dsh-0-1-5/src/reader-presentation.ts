import type { CanonicalEventV1, JsonValue } from "@linmu/dsh-session-contracts";

/** Presentation metadata only; never changes canonical semantics or exposure. */
export interface DshReaderPresentation {
  readonly kind: "runtime-context" | "skill-catalog" | "plugin-context" | "user" | "assistant"
    | "tool-call" | "tool-result" | "reasoning" | "record";
  readonly label: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>> : {};
}

function identity(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

/**
 * Read the adapter-owned native source header, without inspecting message text.
 * Callers may supply a lightweight event containing only these header fields.
 */
export function readDshReaderPresentation(event: CanonicalEventV1): DshReaderPresentation {
  const content = record(event.content);
  const nativeType = event.source.platform === "dsh" ? event.extensions.dshEventType : undefined;

  if (nativeType === "user/message" && event.kind === "user-message" && event.role === "user"
    && content.role === "user") {
    // user/message owns source at the root, unlike assistant and tool messages.
    const source = record(content.source);
    if (source.kind === "plugin" && source.plugin === "@deepseek-ai/dsh-system-prompt") {
      // The native clear event deliberately has no form/sections.
      return { kind: "runtime-context", label: "运行上下文" };
    }
    if (source.kind === "skill-catalog" && source.form === "catalog") {
      return { kind: "skill-catalog", label: "技能目录" };
    }
    if (source.kind === "dsh-native-context-release" && source.plugin === "dsh-annotation-core") {
      return { kind: "plugin-context", label: "上下文释放记录" };
    }
    if (source.kind === "dsh-annotation" && source.schemaVersion === 1
      && typeof source.count === "number" && Number.isSafeInteger(source.count) && source.count >= 0
      && identity(source.setId) !== undefined && identity(source.targetUserMessageId) !== undefined && identity(source.digest) !== undefined) {
      return { kind: "plugin-context", label: "引用上下文" };
    }
    if (source.kind === "plugin" && identity(source.plugin) !== undefined) {
      return { kind: "plugin-context", label: "插件上下文" };
    }
  }

  switch (event.kind) {
    case "user-message": return { kind: "user", label: "用户" };
    case "assistant-message": return { kind: "assistant", label: "助手" };
    case "reasoning": return { kind: "reasoning", label: "推理" };
    case "tool-call": {
      const toolCallId = identity(content.callId);
      const toolName = identity(content.name);
      return {
        kind: "tool-call", label: "工具调用",
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(toolName === undefined ? {} : { toolName }),
      };
    }
    case "tool-result": {
      const source = record(record(content.message).source);
      const toolCallId = nativeType === "tool/result"
        ? source.kind === "tool" ? identity(source.callId) : undefined
        : identity(content.callId);
      return { kind: "tool-result", label: "工具结果", ...(toolCallId === undefined ? {} : { toolCallId }) };
    }
    default: return { kind: "record", label: "原始记录" };
  }
}
