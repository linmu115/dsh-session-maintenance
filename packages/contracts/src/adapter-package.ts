import { z } from 'zod';

const localEntry = z.string().min(1).max(500).refine(value => !value.includes('\\') && !value.startsWith('/') && !value.split('/').includes('..') && !value.includes(':'), 'Adapter entries must stay within the installed package');
export const adapterPackageSchema = z.object({
  protocolVersion: z.literal(1),
  packageId: z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/u),
  version: z.string().min(1).max(80),
  entries: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('instance'), id: z.string().min(1).max(100), engine: localEntry, worker: localEntry, dsh: localEntry.optional() }).strict(),
    z.object({ kind: z.literal('business'), id: z.string().min(1).max(100), namespace: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/u), engine: localEntry }).strict(),
  ])).min(1).max(50),
}).strict();
export type AdapterPackage = z.infer<typeof adapterPackageSchema>;
export interface InstalledAdapterEntry {
  readonly packageId: string; readonly version: string; readonly id: string;
  readonly kind: 'instance' | 'business'; readonly namespace?: string;
  readonly enabled: boolean; readonly directory: string; readonly engine: string; readonly worker?: string;
}
