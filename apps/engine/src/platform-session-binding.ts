import { createHash } from 'node:crypto';
import type { AdapterContractRef, PlatformBinding, PlatformSessionKey } from '@linmu/dsh-session-contracts';
import { IntegrationError } from '@linmu/dsh-session-contracts';

/** Bind identity independently from advancing a common version. Existing versions remain intact. */
export async function ensurePlatformSessionBinding(input: {
  readonly repository: { findBinding(key: PlatformSessionKey): Promise<PlatformBinding | undefined>; bindPlatformSession(binding: PlatformBinding): Promise<boolean> };
  readonly key: PlatformSessionKey; readonly logicalSessionId: string; readonly contract: AdapterContractRef;
  readonly checkOnly?: boolean;
}): Promise<void> {
  const existing = await input.repository.findBinding(input.key);
  if (existing) {
    if (existing.logicalSessionId !== input.logicalSessionId) throw new IntegrationError('IDENTITY_CONFLICT', '平台会话已绑定到另一逻辑会话。');
    return;
  }
  if (input.checkOnly) return;
  const id = `binding-${createHash('sha256').update(JSON.stringify(input.key)).digest('hex').slice(0, 32)}`;
  await input.repository.bindPlatformSession({ id, key: input.key, logicalSessionId: input.logicalSessionId,
    adapterContract: input.contract, lastCommonVersionId: null, status: 'writable' });
}
