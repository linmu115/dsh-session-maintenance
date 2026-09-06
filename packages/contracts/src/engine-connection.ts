import { z } from "zod";

/** ACL-protected local discovery file; owner metadata is optional for legacy v1 Engines. */
export const engineConnectionDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/u),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  ownerId: z.uuid().optional(),
});

export type EngineConnectionDescriptor = Readonly<z.infer<typeof engineConnectionDescriptorSchema>>;
