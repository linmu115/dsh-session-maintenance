// Compatibility composition for existing callers; all host behavior lives in the adapter.
import { InstanceIntegrationService as HostService, type IntegrationServiceOptions as HostOptions } from '@linmu/dsh-instance-integration-dsh/integration-service';
import { scopedRecoveryRuns } from '../lifecycle-recovery.js';
export type IntegrationServiceOptions = Omit<HostOptions, 'recoveryRuns'> & { readonly recoveryRuns?: HostOptions['recoveryRuns'] };
export class InstanceIntegrationService extends HostService {
  constructor(options: IntegrationServiceOptions) { super({ ...options, recoveryRuns: options.recoveryRuns ?? scopedRecoveryRuns }); }
}
