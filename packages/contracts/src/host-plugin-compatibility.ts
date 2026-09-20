import { z } from 'zod';

/** Package metadata, distinct from the adapter catalog's manifest protocol. */
export const hostPluginDeclarationSchema = z.object({
  schemaVersion: z.literal(1),
  protocol: z.object({ id: z.string().min(1), version: z.number().int().positive() }),
  adapterId: z.string().min(1),
  hostVersions: z.array(z.string().min(1)).min(1),
  sessionFormats: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string().min(1)).min(1),
});
export type HostPluginDeclaration = z.infer<typeof hostPluginDeclarationSchema>;
export interface HostPluginIssue { readonly code: string; readonly message: string }
