import { useState } from "react";
import type { RetentionRegistry, RetentionRoot } from "@linmu/dsh-session-contracts";
import { Button, Surface } from "@linmu/dsh-session-ui";
import type { StorageGovernanceApi } from "./storage-governance.js";

export function RetentionRegistryPanel({ api, registry, busy, act }: {
  readonly api: StorageGovernanceApi;
  readonly registry: RetentionRegistry;
  readonly busy: boolean;
  readonly act: (operation: (signal?: AbortSignal) => Promise<unknown>, message: string) => Promise<void>;
}) {
  const [rootId, setRootId] = useState("");
  const [path, setPath] = useState("");
  const [purpose, setPurpose] = useState<RetentionRoot["purpose"]>("databases");
  const [sourceId, setSourceId] = useState("");
  const [sourceRoot, setSourceRoot] = useState("engine-state");
  const [sourcePath, setSourcePath] = useState("");
  const [objectRoot, setObjectRoot] = useState("engine-state");
  const [sourceKind, setSourceKind] = useState<"backup-database" | "candidate-database">("backup-database");
  return <Surface title="保护范围与副本登记">
    <div className="storage-panel-body storage-registry">
    <p>外部备份可能仍引用当前正文库。登记数据库及其正文位置后，预览会将这些引用一起保护。外部目录只用于核对引用。</p>
    <details><summary>查看已登记的位置（{registry.roots.length}）</summary>
      <ul>{registry.roots.map((root) => <li key={root.id}><code>{root.id}</code>：{root.path}</li>)}</ul>
    </details>
    <div className="storage-table-scroll" role="region" aria-label="已登记数据库的保护状态" tabIndex={0}><table><thead><tr><th>数据库</th><th>保护状态</th><th>操作</th></tr></thead><tbody>{registry.sources.map((source) => {
      const governed = registry.resources.some((resource) => resource.ownerId === source.id && resource.state !== "purged");
      const root = registry.roots.find((entry) => entry.id === source.rootId);
      return <tr key={source.id}>
        <td><code>{source.id}</code><p>{root?.path}/{source.relativePath}</p><small>正文位置：{registry.roots.find((entry) => entry.id === source.objectRootId)?.path ?? source.objectRootId}</small></td>
        <td>{source.kind === "active-database" ? "当前使用" : !source.retained ? "已完成释放" : governed ? "已纳入副本治理" : "保护引用"}</td>
        <td>{source.retained && ["backup-database", "candidate-database"].includes(source.kind) && !governed ? <Button disabled={busy} onClick={() => void act((signal) => api.registerFlatRetentionCandidate(source.id, signal), "已验证数据库及清单，并纳入候选预览；文件仍在原处。")}>验证并纳入治理</Button> : null}</td>
      </tr>;
    })}</tbody></table></div>
    <details><summary>补充登记现有备份或候选库</summary>
      <p>先登记数据库所在目录；如果正文保存在另一处，也登记那个包含 objects 子目录的位置。只填写已确认的来源。</p>
      <form onSubmit={(event) => { event.preventDefault(); void act((signal) => api.registerRetentionRoot({ id: rootId.trim(), path: path.trim(), purpose }, signal), "位置已登记。请继续登记数据库与正文的对应关系。"); }}>
        <label>位置名称<input required value={rootId} onChange={(event) => setRootId(event.target.value)} placeholder="例如 release-backups" /></label>
        <label>完整目录路径<input required value={path} onChange={(event) => setPath(event.target.value)} /></label>
        <label>用途<select value={purpose} onChange={(event) => setPurpose(event.target.value as RetentionRoot["purpose"])}><option value="databases">备份或候选数据库</option><option value="objects">共享正文库的位置</option></select></label>
        <Button disabled={busy || !rootId.trim() || !path.trim()} type="submit">登记位置</Button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void act((signal) => api.registerRetentionSource({ id: sourceId.trim(), rootId: sourceRoot, relativePath: sourcePath.trim(), objectRootId: objectRoot, kind: sourceKind, retained: true }, signal), "数据库已登记，其引用继续受保护。"); }}>
        <label>数据库名称<input required value={sourceId} onChange={(event) => setSourceId(event.target.value)} /></label>
        <label>所在位置<select value={sourceRoot} onChange={(event) => setSourceRoot(event.target.value)}>{registry.roots.map((root) => <option value={root.id} key={root.id}>{root.id} · {root.path}</option>)}</select></label>
        <label>相对文件路径<input required value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="例如 metadata.old.sqlite" /></label>
        <label>正文位置<select value={objectRoot} onChange={(event) => setObjectRoot(event.target.value)}>{registry.roots.filter((root) => ["state", "objects"].includes(root.purpose)).map((root) => <option value={root.id} key={root.id}>{root.id} · {root.path}</option>)}</select></label>
        <label>类型<select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)}><option value="backup-database">保留的备份</option><option value="candidate-database">未启用的候选库</option></select></label>
        <Button disabled={busy || !sourceId.trim() || !sourcePath.trim()} type="submit">登记并保护引用</Button>
      </form>
    </details>
    </div>
  </Surface>;
}
