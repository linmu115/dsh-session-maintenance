import { z } from 'zod';
export const registeredInstancePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  required: z.array(z.strictObject({ instanceId: z.string().min(1), profileId: z.string().min(1) })),
});
