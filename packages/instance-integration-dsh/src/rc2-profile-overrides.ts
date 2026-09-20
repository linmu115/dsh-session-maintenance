import { z } from 'zod';
import { inspectDshIntegrationOverrides } from '@linmu/dsh-adapter-dsh';
import { extensionConnectSchema } from '@linmu/dsh-session-contracts';

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u);
const webConfig = z.strictObject({
  host: z.literal('127.0.0.1'), port: z.number().int().min(0).max(65535),
  compression: z.enum(['gzip', 'brotli', 'none']).optional(),
  compressionLevel: z.number().int().min(0).max(11).optional(),
  compressionThresholdBytes: z.number().int().nonnegative().optional(),
});

/** Recognize scoped RC2 onboarding settings, never replacement infrastructure. */
export function inspectRc2ProfileOverrides(layers: readonly unknown[], scope: { runtimeVersion: string; instanceId: string; profileId: string }): string[] {
  if (scope.runtimeVersion !== '0.1.5-rc.2') return inspectDshIntegrationOverrides(layers);
  const maintenance = z.strictObject({ id: z.literal('session-maintenance'), name: z.literal('dsh-session-maintenance').optional(), disabled: z.literal(false).optional(),
    config: z.strictObject({ connectionId: safeId, dshInstanceId: z.literal(scope.instanceId), profileId: z.literal(scope.profileId), sessionSource: z.literal('maintenance'),
      extensionPlugins: extensionConnectSchema.shape.plugins.optional() }) });
  const web = z.strictObject({ id: z.literal('webserver'), name: z.literal('@deepseek-ai/dsh-webserver').optional(), disabled: z.literal(false).optional(), config: webConfig });
  return inspectDshIntegrationOverrides(layers.map(layer => Array.isArray(layer)
    ? layer.filter(patch => !maintenance.safeParse(patch).success && !web.safeParse(patch).success) : layer));
}
