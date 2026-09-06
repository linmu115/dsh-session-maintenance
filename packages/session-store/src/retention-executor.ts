import { lstat, mkdir, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { SessionMaintenanceError, type MaintenanceWriteEvidence, type MaintenanceWriteScope, type RetentionBatch, type RetentionBatchItem, type RetentionInventory, type RetentionPreviewPlan, type RetentionRoot } from "@linmu/dsh-session-contracts";
import { RetentionRepository } from "./retention-repository.js";
import { RetentionJournal } from "./retention-journal.js";
import { assertRetentionPlanCurrent, planRetention } from "./retention-policy.js";
import { checkedRetentionDestination, checkedRetentionPath, inventoryRetentionTree, isMissing, retentionDigest } from "./retention-paths.js";

export interface RetentionExecutorOptions {
  readonly repository: RetentionRepository;
  readonly writes: MaintenanceWriteScope;
  readonly now?: () => string;
  /** Composition enables this only after every writer uses the same owner/scope protocol. */
  readonly executionEnabled?: boolean;
  /** Fault injection is only used by marked synthetic crash/recovery tests. */
  readonly fault?: (stage: "after-journal" | "after-quarantine-move" | "after-restore-move" | "after-unlink", item?: RetentionBatchItem) => void;
}

export class RetentionExecutor {
  readonly journal: RetentionJournal;
  private readonly now: () => string;
  constructor(private readonly options: RetentionExecutorOptions) { this.journal=new RetentionJournal(options.repository);this.now=options.now ?? (()=>new Date().toISOString()); }
  private get repository(): RetentionRepository { return this.options.repository; }
  private otherResources(inventory:RetentionInventory,resourceId:string):string {return retentionDigest(inventory.resources.filter((entry)=>entry.resource.id !== resourceId).map((entry)=>({resource:entry.resource,fingerprint:entry.fingerprint,files:entry.files})));}
  private checkOwner(): MaintenanceWriteEvidence {
    this.options.writes.assertInScope();
    if (!this.options.executionEnabled) throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE","Storage governance execution has not been enabled by the coordinated Engine composition");
    const evidence=this.options.writes.captureEvidence();
    if (!this.repository.roots().some((root)=>root.purpose === "state" && root.realPath === evidence.stateRoot)) throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE","Write owner does not own this registered state root");
    return evidence;
  }
  private root(item: RetentionBatchItem, evidence: MaintenanceWriteEvidence): RetentionRoot {
    const root=this.repository.roots().find((entry)=>entry.id === item.rootId);
    if (!root || ["objects","state"].includes(root.purpose)) throw new SessionMaintenanceError("RECOVERY_REQUIRED","Resource root is not governed");
    const rel=relative(evidence.stateRoot,root.realPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE","External governance roots need their own coordinated owner; they remain read-only references");
    return root;
  }
  private assert(evidence: MaintenanceWriteEvidence): void { this.options.writes.assertEvidence(evidence); }
  private async exists(root: RetentionRoot, path: string): Promise<boolean> {
    try { await checkedRetentionPath(root,path);return true; } catch(error) { if (isMissing(error)) return false;throw error; }
  }
  private async sameTree(root: RetentionRoot, path: string, item: RetentionBatchItem): Promise<void> {
    if (retentionDigest(await inventoryRetentionTree(root,path)) !== item.fingerprint) throw new SessionMaintenanceError("PLAN_STALE","Governed resource contents or file identity changed");
  }
  private async destination(root: RetentionRoot, path: string): Promise<string> {
    const parts=path.split("/"); parts.pop();
    for (let i=1;i<=parts.length;i++) {
      const part=parts.slice(0,i).join("/");
      if (!await this.exists(root,part)) await mkdir(await checkedRetentionDestination(root,part));
      await checkedRetentionPath(root,part);
    }
    if (await this.exists(root,path)) throw new SessionMaintenanceError("PLAN_STALE","Destination is already occupied");
    return checkedRetentionDestination(root,path);
  }
  private failure(batch: RetentionBatch, item: RetentionBatchItem, error: unknown): never {
    this.journal.update({...batch,items:batch.items.map((entry)=>entry.resourceId === item.resourceId ? {...entry,error:error instanceof SessionMaintenanceError ? error.code : "RECOVERY_REQUIRED"} : entry)});
    throw error instanceof SessionMaintenanceError ? error : new SessionMaintenanceError("RECOVERY_REQUIRED","Storage governance stopped with a durable recovery record",{cause:error});
  }
  private async eligible(batch: RetentionBatch, item: RetentionBatchItem): Promise<RetentionInventory> {
    const inventory=await this.repository.capture(this.now()), plan=planRetention(inventory,batch.plan.policy);
    if (plan.blockers.length || plan.items.find((entry)=>entry.id === item.resourceId)?.disposition !== "candidate") throw new SessionMaintenanceError("PLAN_STALE","Resource gained protection or recovery coverage is incomplete");
    return inventory;
  }
  private async reconcile(batch: RetentionBatch, evidence: MaintenanceWriteEvidence): Promise<RetentionBatch> {
    for (const item of batch.items) {
      if (!["planned","quarantined"].includes(item.state)) continue;
      const root=this.root(item,evidence), original=await this.exists(root,item.originalPath), quarantined=await this.exists(root,item.quarantinePath);
      if (original && quarantined) throw new SessionMaintenanceError("PLAN_STALE","Both original and quarantine locations exist; recovery will not overwrite either");
      if (!original && !quarantined) throw new SessionMaintenanceError("RECOVERY_REQUIRED","Both governed resource locations are missing");
      this.assert(evidence);
      if (item.state === "planned" && quarantined) { await this.sameTree(root,item.quarantinePath,item);batch=this.journal.transition(batch,item,"quarantined"); }
      else if (item.state === "quarantined" && original) { await this.sameTree(root,item.originalPath,item);batch=this.journal.transition(batch,item,"restored"); }
    }
    return batch;
  }

  async quarantine(plan: RetentionPreviewPlan): Promise<RetentionBatch> {
    return this.options.writes.run("retention-execution",async()=>{
      const evidence=this.checkOwner();
      let batch=this.journal.get(plan.id);
      if (!batch) {
        const inventory=await this.repository.capture(plan.asOf);assertRetentionPlanCurrent(plan,inventory);
        const createdAt=this.now(); if (Date.parse(createdAt) < Date.parse(plan.asOf)) throw new SessionMaintenanceError("PLAN_STALE","Local clock moved before the preview instant");
        const id=`retention_${plan.id.slice(7,39)}`;
        const byId=new Map(inventory.resources.map((entry)=>[entry.resource.id,entry]));
        const items:RetentionBatchItem[]=plan.items.filter((entry)=>entry.executable).map((entry)=>{
          const resource=byId.get(entry.id); if (!resource || entry.kind === "content-object") throw new Error("Only registered directory resources can execute");
          return {resourceId:entry.id,rootId:entry.rootId,originalPath:entry.relativePath,quarantinePath:`.retention-quarantine/${id}/${retentionDigest(entry.id).slice(7,31)}`,fingerprint:resource.fingerprint,bytes:resource.bytes,files:resource.files,state:"planned",error:null,purgeGuard:null};
        });
        for (const item of items) this.root(item,evidence);
        batch={schemaVersion:1,id,plan,createdAt,purgeAfter:new Date(Date.parse(createdAt)+plan.policy.quarantineHours*3600000).toISOString(),items};
        this.assert(evidence);this.journal.create(batch);this.options.fault?.("after-journal");
      }
      batch=await this.reconcile(batch,evidence);
      for (const originalItem of batch.items) {
        const item=batch.items.find((entry)=>entry.resourceId === originalItem.resourceId)!;
        if (item.state !== "planned") continue;
        try {
          await this.eligible(batch,item);
          const root=this.root(item,evidence);await this.sameTree(root,item.originalPath,item);
          const target=await this.destination(root,item.quarantinePath), source=await checkedRetentionPath(root,item.originalPath);
          this.assert(evidence); await rename(source,target);this.options.fault?.("after-quarantine-move",item);
          await this.sameTree(root,item.quarantinePath,item);this.assert(evidence);batch=this.journal.transition(batch,item,"quarantined");
        } catch(error) { this.failure(batch,item,error); }
      }
      return batch;
    });
  }

  async restore(id: string): Promise<RetentionBatch> {
    return this.options.writes.run("retention-restore",async()=>{
      const evidence=this.checkOwner();let batch=this.journal.get(id);if (!batch) throw new SessionMaintenanceError("TRANSACTION_NOT_FOUND","Storage governance batch was not found");
      batch=await this.reconcile(batch,evidence);
      // Positive restoration may resolve an unrelated coverage blocker. It still captures current refs,
      // validates path identities and refuses every existing destination; no unique data is deleted.
      await this.repository.capture(this.now());
      for (const originalItem of batch.items) {
        const item=batch.items.find((entry)=>entry.resourceId === originalItem.resourceId)!;
        if (item.state === "restored") continue;
        if (item.state === "purging" || item.state === "purged") throw new SessionMaintenanceError("TRANSACTION_NOT_RESTORABLE","This resource has entered final release");
        try {
          const root=this.root(item,evidence);
          if (item.state === "planned") {await this.sameTree(root,item.originalPath,item);this.assert(evidence);batch=this.journal.transition(batch,item,"restored");continue;}
          await this.sameTree(root,item.quarantinePath,item);const target=await this.destination(root,item.originalPath), source=await checkedRetentionPath(root,item.quarantinePath);
          this.assert(evidence);await rename(source,target);this.options.fault?.("after-restore-move",item);
          await this.sameTree(root,item.originalPath,item);this.assert(evidence);batch=this.journal.transition(batch,item,"restored");
        } catch(error) {this.failure(batch,item,error);}
      }
      return batch;
    });
  }

  async purge(id: string): Promise<RetentionBatch> {
    return this.options.writes.run("retention-purge",async()=>{
      const evidence=this.checkOwner();let batch=this.journal.get(id);if (!batch) throw new SessionMaintenanceError("TRANSACTION_NOT_FOUND","Storage governance batch was not found");
      if (Date.parse(this.now()) < Date.parse(batch.purgeAfter)) throw new SessionMaintenanceError("CONFIRMATION_REQUIRED","The quarantine recovery grace period has not elapsed");
      batch=await this.reconcile(batch,evidence);
      for (const originalItem of batch.items) {
        let item=batch.items.find((entry)=>entry.resourceId === originalItem.resourceId)!;
        if (item.state === "restored" || item.state === "purged") continue;
        if (item.state === "planned") throw new SessionMaintenanceError("RECOVERY_REQUIRED","Quarantine must finish before final release");
        try {
          const root=this.root(item,evidence);
          if (await this.exists(root,item.originalPath)) throw new SessionMaintenanceError("PLAN_STALE","Original resource path was reused");
          if (item.state !== "purging") {
            const inventory=await this.eligible(batch,item);await this.sameTree(root,item.quarantinePath,item);
            const excludedSourceIds=inventory.sources.filter((source)=>source.rootId === item.rootId && source.relativePath.startsWith(`${item.quarantinePath}/`)).map((source)=>source.id);
            item={...item,state:"purging",purgeGuard:{sourceRevisions:Object.fromEntries(Object.entries(inventory.sourceRevisions).filter(([source])=>!excludedSourceIds.includes(source))),excludedSourceIds,registryFingerprint:inventory.registryFingerprint,otherResourceFingerprint:this.otherResources(inventory,item.resourceId)}};
            batch={...batch,items:batch.items.map((entry)=>entry.resourceId === item.resourceId ? item : entry)};this.assert(evidence);this.journal.update(batch);
          } else {
            const inventory=await this.repository.capture(this.now()),guard=item.purgeGuard;
            if (!guard || inventory.blockers.some((blocker)=>blocker.source !== item.resourceId && !guard.excludedSourceIds.includes(blocker.source)) || retentionDigest(Object.fromEntries(Object.entries(inventory.sourceRevisions).filter(([source])=>!guard.excludedSourceIds.includes(source)))) !== retentionDigest(guard.sourceRevisions) || inventory.registryFingerprint !== guard.registryFingerprint || this.otherResources(inventory,item.resourceId) !== guard.otherResourceFingerprint) throw new SessionMaintenanceError("PLAN_STALE","References changed during an interrupted final release; manual recovery review is required");
          }
          // A known manifest of exact files is reused after a crash. New entries are never recursively removed.
          let remaining:Awaited<ReturnType<typeof inventoryRetentionTree>>=[];
          if (await this.exists(root,item.quarantinePath)) remaining=await inventoryRetentionTree(root,item.quarantinePath);
          const expected=new Map(item.files.map((file)=>[file.relativePath,file]));
          for (const file of remaining) {
            const old=expected.get(file.relativePath);
            if (!old || old.identity !== file.identity || old.bytes !== file.bytes || (file.identity.endsWith(":f") && old.mtimeMs !== file.mtimeMs)) throw new SessionMaintenanceError("PLAN_STALE","Quarantined files changed during final release");
          }
          for (const file of [...remaining].sort((a,b)=>b.relativePath.split("/").length-a.relativePath.split("/").length || b.relativePath.localeCompare(a.relativePath))) {
            const path=file.relativePath ? `${item.quarantinePath}/${file.relativePath}` : item.quarantinePath;
            const target=await checkedRetentionPath(root,path),info=await lstat(target,{bigint:true});
            const identity=`${info.dev}:${info.ino}:${info.birthtimeNs}:${info.isDirectory() ? "d" : "f"}`;
            if (identity !== file.identity) throw new SessionMaintenanceError("PLAN_STALE","File identity changed immediately before release");
            this.assert(evidence);
            if (info.isDirectory()) await rmdir(target); else await unlink(target);
            this.options.fault?.("after-unlink",item);
          }
          this.assert(evidence);batch=this.journal.transition(batch,item,"purged");
        } catch(error) {this.failure(batch,item,error);}
      }
      return batch;
    });
  }
}
