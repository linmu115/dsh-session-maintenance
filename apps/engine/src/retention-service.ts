import { SessionMaintenanceError, retentionPolicySchema, retentionResourceRegistrationSchema, retentionRootRegistrationSchema, retentionSourceRegistrationSchema, type MaintenanceWriteScope, type RetentionBatch, type RetentionDiscoveryResult, type RetentionPolicy, type RetentionPreviewPlan, type RetentionResource, type RetentionRoot, type RetentionSource } from "@linmu/dsh-session-contracts";
import { DEFAULT_RETENTION_POLICY, RetentionExecutor, RetentionRepository, discoverRetentionResources, planRetention, verifyRetentionResource } from "@linmu/dsh-session-store";

export interface RetentionServiceOptions {
  readonly repository: RetentionRepository;
  readonly writes: MaintenanceWriteScope;
  readonly clock?: () => string;
  readonly executionEnabled?: boolean;
}

/** Engine use cases. Nothing schedules deletion; every state-changing operation is explicit. */
export class RetentionService {
  private readonly plans=new Map<string,RetentionPreviewPlan>();
  private readonly executor: RetentionExecutor;
  private readonly clock: () => string;
  constructor(private readonly options: RetentionServiceOptions) {
    this.clock=options.clock ?? (()=>new Date().toISOString());
    this.executor=new RetentionExecutor({repository:options.repository,writes:options.writes,now:this.clock,executionEnabled:options.executionEnabled ?? false});
  }
  preview(policy: RetentionPolicy=DEFAULT_RETENTION_POLICY):Promise<RetentionPreviewPlan> {
    return this.options.writes.run("retention-preview",async()=>{
      const plan=planRetention(await this.options.repository.capture(this.clock()),retentionPolicySchema.parse(policy));
      this.plans.set(plan.id,plan);
      while (this.plans.size > 64) this.plans.delete(this.plans.keys().next().value!);
      return plan;
    });
  }
  execute(planId:string):Promise<RetentionBatch> {
    const plan=this.plans.get(planId) ?? this.executor.journal.get(planId)?.plan;
    if (!plan) return Promise.reject(new SessionMaintenanceError("PLAN_STALE","Preview expired or Engine restarted; request a new storage governance preview"));
    return this.executor.quarantine(plan);
  }
  restore(batchId:string):Promise<RetentionBatch> {return this.executor.restore(batchId);}
  purge(batchId:string):Promise<RetentionBatch> {return this.executor.purge(batchId);}
  listBatches():readonly RetentionBatch[] {return this.executor.journal.list();}
  registry() {return {roots:this.options.repository.roots(),sources:this.options.repository.sources(),resources:this.options.repository.resources()};}
  registerRoot(input:unknown):Promise<RetentionRoot> {
    const parsed=retentionRootRegistrationSchema.parse(input);
    return this.options.writes.run("retention-register-root",()=>this.options.repository.registerRoot(parsed.id,parsed.path,parsed.purpose));
  }
  registerSource(input:unknown):Promise<RetentionSource> {
    const parsed=retentionSourceRegistrationSchema.parse(input);
    return this.options.writes.run("retention-register-source",()=>{this.options.repository.registerSource(parsed);return parsed;});
  }
  registerResource(input:unknown):Promise<RetentionResource> {
    const parsed=retentionResourceRegistrationSchema.parse(input);
    return this.options.writes.run("retention-register-resource",()=>{
      const resource:RetentionResource={...parsed,verifiedAt:null,verifiedFingerprint:null,lastUsedAt:parsed.kind === "cache" ? this.clock() : null,state:"registered"};
      this.options.repository.registerResource(resource);return resource;
    });
  }
  verify(resourceId:string):Promise<RetentionResource> {return this.options.writes.run("retention-verify",()=>verifyRetentionResource(this.options.repository,resourceId,this.clock()));}
  discover():Promise<RetentionDiscoveryResult> {return this.options.writes.run("retention-discover",()=>discoverRetentionResources(this.options.repository,this.clock()));}
}
