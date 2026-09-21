import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
/** Paths are supplied by the user, then canonicalized by the host adapter. */
export const standaloneInstanceSchema = z.strictObject({
  schemaVersion: z.literal(1), instanceId: id, profileId: id,
  adapterId: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200), runtimeVersion: z.string().min(1),
  homeRoot: z.string().min(1), versionRoot: z.string().min(1),
  runtimeUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  }, 'Use an exact loopback HTTP origin'),
});
export type StandaloneInstance = z.infer<typeof standaloneInstanceSchema>;

/**
 * How an instance binding was established.
 *
 * - `directory`: the user selected the instance's DSH Home folder. Nothing in
 *   the instance is required at launch for Maintenance to read it, so this kind
 *   never installs a Launcher hook and never writes the instance-side startup
 *   gate.
 * - `launcher`: the instance was discovered through a Launcher data directory,
 *   so its external-lifecycle hook is part of the binding.
 * - `legacy`: a binding written before this field existed. Records are read as
 *   `legacy` and are not migrated; its behaviour is inferred from whether the
 *   binding carries a Launcher root, which is exactly how such a binding was
 *   treated before.
 */
export const dshIntegrationConnectionKindSchema = z.enum(['directory', 'launcher', 'legacy']);
export type DshIntegrationConnectionKind = z.infer<typeof dshIntegrationConnectionKindSchema>;
