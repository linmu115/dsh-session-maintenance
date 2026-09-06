import type { RetentionBatch, RetentionBatchItem, RetentionResource, RetentionSource } from "@linmu/dsh-session-contracts";
import { RetentionRepository } from "./retention-repository.js";

/** Journal and registry pointer changes commit together, while Engine still owns the exclusive scope. */
export class RetentionJournal {
  constructor(readonly repository: RetentionRepository) {}
  list(): readonly RetentionBatch[] { return this.repository.database.prepare("SELECT batch_json FROM retention_batches ORDER BY id").all().map((row)=>JSON.parse(String(row.batch_json)) as RetentionBatch); }
  get(id: string): RetentionBatch | undefined { return this.list().find((batch)=>batch.id === id || batch.plan.id === id); }
  create(batch: RetentionBatch): void { this.repository.database.prepare("INSERT INTO retention_batches(id,plan_id,batch_json) VALUES (?,?,?)").run(batch.id,batch.plan.id,JSON.stringify(batch)); }
  update(batch: RetentionBatch): void { this.repository.database.prepare("UPDATE retention_batches SET batch_json=? WHERE id=?").run(JSON.stringify(batch),batch.id); }
  transition(batch: RetentionBatch, item: RetentionBatchItem, state: "quarantined" | "restored" | "purged"): RetentionBatch {
    const db=this.repository.database;
    db.exec("SAVEPOINT retention_transition");
    try {
      const resource=this.repository.resources().find((entry)=>entry.id === item.resourceId);
      if (!resource) throw new Error("Governed resource registration disappeared");
      const from=resource.relativePath, to=state === "restored" ? item.originalPath : item.quarantinePath;
      const next: RetentionResource={...resource,relativePath:to,state:state === "restored" ? "registered" : state};
      db.prepare("UPDATE retention_resources SET resource_json=? WHERE id=?").run(JSON.stringify(next),resource.id);
      for (const source of this.repository.sources()) if (source.rootId === resource.rootId && (source.relativePath === from || source.relativePath.startsWith(`${from}/`))) {
        const updated: RetentionSource={...source,relativePath:`${to}${source.relativePath.slice(from.length)}`,retained:state === "purged" ? false : source.retained};
        db.prepare("UPDATE retention_sources SET source_json=? WHERE id=?").run(JSON.stringify(updated),source.id);
      }
      const result: RetentionBatch={...batch,items:batch.items.map((entry)=>entry.resourceId === item.resourceId ? {...item,state,error:null} : entry)};
      this.update(result); db.exec("RELEASE retention_transition"); return result;
    } catch(error) { db.exec("ROLLBACK TO retention_transition; RELEASE retention_transition"); throw error; }
  }
}
