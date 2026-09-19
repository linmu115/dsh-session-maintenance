import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";
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
  return <Surface title="Vault 绑定管理" action={<Button onClick={() => setRevision(value => value + 1)}>刷新实例</Button>}>
    <p>选择已登记实例，管理它绑定的 Vault。DSH 实例无需启动。</p>
    {error ? <p role="alert">{error}</p> : !instances ? <LoadingState label="正在读取已登记实例…"/> : null}
    {instances?.length === 0 ? <EmptyState title="暂无已登记实例" description="请先在接入管理中登记 DSH 实例。"/> : null}
    <div className="vault-binding-instances">{instances?.map(instance => <button type="button" key={JSON.stringify([instance.instanceId, instance.profileId])} onClick={() => setSelected(instance)}><strong>{instance.name}</strong><span>{instance.profileId}</span></button>)}</div>
    {selected ? <BindingCard key={JSON.stringify([selected.instanceId, selected.profileId])} api={api} instance={selected} onClose={() => setSelected(undefined)}/> : null}
  </Surface>;
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
    <header><div><h2>{instance.name}</h2><p>{instance.profileId} · Vault 绑定</p></div><Button disabled={busy} onClick={onClose}>关闭</Button></header>
    <div className="vault-binding-toolbar"><h3>已绑定 Vault</h3><Button tone="primary" disabled={busy || !!retry.current} onClick={() => void perform()}>新建绑定</Button></div>
    <p className="muted">选择本机 Vault 文件夹后检查桥插件。请在 Obsidian 打开该 Vault 并启用桥插件，DSH 实例可以离线。</p>
    {busy ? <p role="status">正在选择文件夹或处理绑定，请完成选择或取消…</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <div role="alert">{error}{retry.current ? <Button disabled={busy} onClick={() => void perform(undefined, true)}>重试同一操作</Button> : null}</div> : null}
    {!vaults && !error ? <LoadingState label="正在读取此实例的绑定…"/> : null}
    {vaults?.length === 0 ? <EmptyState title="尚未绑定 Vault" description="点击右上角“新建绑定”选择一个 Vault。"/> : null}
    <ul className="vault-binding-rows">{vaults?.map(vault => <li key={vault.vaultId}><div><strong>{vault.name}</strong><small>{vault.root}</small><small>{!vault.online ? "Vault 离线 · 上次已知绑定，请打开后核验" : vault.manageable ? "已绑定" : "请更新桥插件或检查 Vault 身份"}</small></div><Button disabled={busy || !vault.manageable || !!retry.current} onClick={() => void perform(vault)}>解绑</Button></li>)}</ul>
    <Button disabled={busy} onClick={() => { retry.current = undefined; setError(undefined); setRevision(value => value + 1); }}>刷新绑定状态</Button>
  </dialog>;
}
