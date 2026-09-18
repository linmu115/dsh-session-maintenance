import type { BusinessPageSnapshot, BusinessPageActionRequest, BusinessPageActionResult } from "@linmu/dsh-session-contracts";
export type { BusinessPageSnapshot, BusinessPageOwner, BusinessPageActionDescriptor, BusinessPageActionRequest, BusinessPageActionResult } from "@linmu/dsh-session-contracts";
/** Optional host capability. The host supplies identity and credentials; providers supply declarative content only. */
export interface BusinessPageProvider {
  readonly namespace: string;
  readonly providerId: string;
  snapshot(): Promise<BusinessPageSnapshot>;
  handleAction(request: BusinessPageActionRequest, signal: AbortSignal): Promise<BusinessPageActionResult>;
}
export interface MaintenanceBusinessPagesService {
  readonly identity: Readonly<{ instanceId: string; profileId: string }>;
  register(provider: BusinessPageProvider): () => void;
}
