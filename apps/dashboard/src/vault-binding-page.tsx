import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, LoadingState } from "@linmu/dsh-session-ui";
import { ChevronRight, Folder, Info, Plus, RefreshCw, Server, X } from "lucide-react";
import type { ManagedVault, VaultBindingInstance, VaultBindingAction } from "@linmu/dsh-session-contracts";
export interface VaultBindingApi {
  listVaultBindingInstances?(signal?: AbortSignal): Promise<VaultBindingInstance[]>;
  listManagedVaults?(target: {instanceId: string; profileId: string}, signal?: AbortSignal): Promise<ManagedVault[]>;
  createVaultBinding?(input: VaultBindingAction, signal?: AbortSignal): Promise<{message: string; cancelled?: boolean | undefined}>;
  removeVaultBinding?(input: VaultBindingAction, signal?: AbortSignal): Promise<{message: string}>;
}
const message = (reason: unknown) => reason instanceof Error ? reason.message : "绑定管理暂时不可用，请刷新后重试。";
export function VaultBindingPage({api}: {api: VaultBindingApi}) {
  const [instances, setInstances] = useState<VaultBindingInstance[]>();
  const [selected, setSelected] = useState<VaultBindingInstance>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setError(undefined);
    if (!api.listVaultBindingInstances) { setError("当前维护引擎尚未提供独立绑定管理，请更新引擎。"); return; }
    void api.listVaultBindingInstances(abort.signal).then(value => { if (!abort.signal.aborted) setInstances(value); }, reason => { if (!abort.signal.aborted) setError(message(reason)); });
    return () => abort.abort();
  }, [api, revision]);
  return <section className="vault-binding-page" aria-label="Vault 绑定管理">
    <header className="vault-binding-page-heading">
      <div><h2>Vault 绑定管理</h2><p>选择实例，管理它绑定的 Vault。DSH 实例无需启动。</p></div>
      <Button onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden="true"/>刷新实例</Button>
    </header>
    {error ? <p className="vault-binding-feedback" role="alert">{error}</p> : !instances ? <LoadingState label="正在读取已登记实例…"/> : null}
    {instances?.length === 0 ? <EmptyState title="暂无已登记实例" description="请先在接入管理中登记 DSH 实例。"/> : null}
    {!!instances?.length && <div className="vault-binding-instance-list">
      <div className="vault-binding-columns" aria-hidden="true"><span>已登记实例 <span className="vault-binding-count">{instances.length}</span></span><span>配置</span><span/></div>
      {instances.map(instance => <button className="vault-binding-instance" type="button" aria-label={`${instance.name} · ${instance.profileId}，管理 Vault 绑定`} key={JSON.stringify([instance.instanceId, instance.profileId])} onClick={() => setSelected(instance)}>
        <span className="vault-binding-instance-name"><span className="vault-binding-icon"><Server size={17} aria-hidden="true"/></span><strong>{instance.name}</strong></span>
        <span className="vault-binding-profile">{instance.profileId}</span>
        <span className="vault-binding-instance-action">管理绑定<ChevronRight size={16} aria-hidden="true"/></span>
      </button>)}
    </div>}
    {selected ? <BindingCard key={JSON.stringify([selected.instanceId, selected.profileId])} api={api} instance={selected} onClose={() => setSelected(undefined)}/> : null}
  </section>;
}
function BindingCard({api, instance, onClose}: {api: VaultBindingApi; instance: VaultBindingInstance; onClose(): void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [vaults, setVaults] = useState<ManagedVault[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController>(new AbortController());
  const retry = useRef<{input: VaultBindingAction; unbind: boolean} | undefined>(undefined);
  useEffect(() => { const abort = new AbortController(); lifetime.current = abort; const node = dialog.current!; if (!node.open) { if (typeof node.showModal === "function") node.showModal(); else node.setAttribute("open", ""); } return () => abort.abort(); }, []);
  useEffect(() => {
    const abort = new AbortController(); setVaults(undefined);
    if (!api.listManagedVaults) { setError("当前引擎不支持读取绑定，请更新。"); return; }
    void api.listManagedVaults(instance, abort.signal).then(value => { if (!abort.signal.aborted) setVaults(value); }, reason => { if (!abort.signal.aborted) setError(message(reason)); });
    return () => abort.abort();
  }, [api, instance, revision]);
  const perform = async (vault?: ManagedVault, repeat = false) => {
    if (busy) return;
    const action = repeat ? retry.current : { input: { instanceId: instance.instanceId, profileId: instance.profileId, operationId: crypto.randomUUID(), ...(vault ? {vaultId: vault.vaultId, expectedRevision: vault.revision} : {}) }, unbind: !!vault };
    if (!action) return;
    const invoke = action.unbind ? api.removeVaultBinding : api.createVaultBinding;
    if (!invoke) { setError("当前引擎不支持此操作，请更新。"); return; }
    retry.current = action; setBusy(true); setError(undefined); setNotice(undefined);
    try { const result = await invoke.call(api, action.input, lifetime.current.signal); if (lifetime.current.signal.aborted) return; retry.current = undefined; setNotice(result.message); setRevision(value => value + 1); }
    catch (reason) { if (!lifetime.current.signal.aborted) setError(message(reason)); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  return <dialog ref={dialog} className="vault-binding-card" aria-label={instance.name + "的 Vault 绑定"} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="vault-binding-card-heading">
      <div><p className="vault-binding-eyebrow">Vault 绑定</p><div className="vault-binding-title"><h2>{instance.name}</h2><span className="vault-binding-profile">{instance.profileId}</span></div></div>
      <button type="button" className="vault-binding-icon-button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={18} aria-hidden="true"/></button>
    </header>
    <div className="vault-binding-card-body">
      <div className="vault-binding-toolbar">
        <h3>已绑定 Vault{vaults ? <span className="vault-binding-count">{vaults.length}</span> : null}</h3>
        <div className="vault-binding-actions">
          <button type="button" className="vault-binding-icon-button" aria-label="刷新绑定状态" title="刷新绑定状态" disabled={busy} onClick={() => { retry.current = undefined; setError(undefined); setRevision(value => value + 1); }}><RefreshCw size={15} aria-hidden="true"/></button>
          <Button tone="primary" disabled={busy || !!retry.current} onClick={() => void perform()}><Plus size={15} aria-hidden="true"/>新建绑定</Button>
        </div>
      </div>
      {busy ? <p className="vault-binding-feedback" role="status">正在选择文件夹或处理绑定，请完成选择或取消…</p> : null}
      {notice ? <p className="vault-binding-feedback" role="status">{notice}</p> : null}
      {error ? <div className="vault-binding-feedback" role="alert">{error}{retry.current ? <Button disabled={busy} onClick={() => void perform(undefined, true)}>重试同一操作</Button> : null}</div> : null}
      {!vaults && !error ? <LoadingState label="正在读取此实例的绑定…"/> : null}
      {vaults?.length === 0 ? <EmptyState title="尚未绑定 Vault" description="点击“新建绑定”，选择本机的 Vault 文件夹。"/> : null}
      {!!vaults?.length && <ul className="vault-binding-rows">{vaults.map(vault => <li key={vault.vaultId}>
        <span className="vault-binding-icon"><Folder size={18} aria-hidden="true"/></span>
        <div className="vault-binding-vault-info">
          <div className="vault-binding-vault-name"><strong>{vault.name}</strong><span className="vault-binding-status" data-state={!vault.online ? "offline" : vault.manageable ? "ready" : "attention"}>{!vault.online ? "离线" : vault.manageable ? "已绑定" : "需要检查"}</span></div>
          <span className="vault-binding-path" title={vault.root}>{vault.root}</span>
          {!vault.online || !vault.manageable ? <span className="vault-binding-detail">{!vault.online ? "显示上次已知绑定，打开 Obsidian 后可管理。" : "请更新桥插件或检查 Vault 身份。"}</span> : null}
        </div>
        <button type="button" className="vault-binding-unbind" disabled={busy || !vault.manageable || !!retry.current} onClick={() => void perform(vault)}>解绑</button>
      </li>)}</ul>}
    </div>
    <footer className="vault-binding-card-note"><Info size={15} aria-hidden="true"/><p>绑定时需在 Obsidian 中打开 Vault 并启用桥插件，DSH 实例无需启动。</p></footer>
  </dialog>;
}
