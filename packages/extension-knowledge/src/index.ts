export * from "@linmu/dsh-session-adapter-lynn/legacy";
import { lynnExtensionAdapters } from "@linmu/dsh-session-adapter-lynn/legacy";
import { gptCompatExtensionAdapter } from "@linmu/dsh-session-extension-gpt-compat";
export const builtInExtensionAdapters = [...lynnExtensionAdapters, gptCompatExtensionAdapter];
