import { createHmac } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute, basename } from "node:path";
import { z } from "zod";
import { vaultBindingSnapshotSchema, vaultBindingGrantSchema, vaultBindingActionSchema, type VaultBindingInstance, type ManagedVault, type VaultBindingAction } from "@linmu/dsh-session-contracts";
import { readIntegrationBindings, readJsonIfPresent, writeJsonAtomically, IntegrationError } from "./integrations/bindings.js";
import { createWindowsVaultFolderPicker, inspectVaultFolder, readSmallJson } from "./vault-folder.js";
const capability = "maintenance-vault-binding-v1";
const originSchema = z.string().refine(value => { try { const u = new URL(value); return u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname) && u.origin === value && !u.username && !u.password; } catch { return false; } });
const identitySchema = z.object({ kind: z.literal("vault"), vaultId: z.string(), publisherId: z.uuid(), bootId: z.uuid(), origin: originSchema, displayName: z.string(), capabilities: z.array(z.string()), binding: vaultBindingSnapshotSchema });
type Identity = z.infer<typeof identitySchema>;
const locationSchema = z.object({ vaultId: z.string(), publisherId: z.uuid(), bootId: z.uuid(), origin: originSchema, vaultRoot: z.string() });
const savedSchema = z.array(z.object({ instanceId: z.string(), profileId: z.string(), vaultId: z.string(), name: z.string(), root: z.string(), revision: z.number().int().nonnegative() }));
type Saved = z.infer<typeof savedSchema>[number];
const operationSchema = z.object({ input: vaultBindingActionSchema, unbind: z.boolean(), root: z.string(), vaultId: z.string(), expectedRevision: z.number().int().nonnegative(), message: z.string().optional() });
const operationsSchema = z.record(z.string(), operationSchema);
const sameTarget = (a: {instanceId: string; profileId: string} | null, b: {instanceId: string; profileId: string}) => a?.instanceId === b.instanceId && a.profileId === b.profileId;
export class VaultBindingManager {
  private busy = false;
  constructor(private readonly options: { stateRoot: string; token: string; discoveryRoot?: string; picker?: (signal: AbortSignal) => Promise<string | null>; fetch?: typeof fetch; vaultRegistryFile?: string; instances?: () => Promise<VaultBindingInstance[]> }) {}
  async instances(): Promise<VaultBindingInstance[]> {
    if (this.options.instances) return this.options.instances();
    const bindings = (await readIntegrationBindings(this.options.stateRoot)).filter(item => item.kind === "dsh" && item.profileId !== null);
    const names = new Map<string, string>();
    for (const root of new Set(bindings.map(item => item.launcherDataRoot).filter((root): root is string => !!root))) {
      const catalog = z.object({ instances: z.array(z.object({ id: z.string(), name: z.string() })) }).safeParse(await readJsonIfPresent(join(root, "config.json")));
      if (catalog.success) for (const item of catalog.data.instances) names.set(item.id, item.name);
    }
    return [...new Map(bindings.map(item => { const value = { instanceId: item.instanceId, profileId: item.profileId!, name: names.get(item.instanceId) ?? item.instanceId }; return [JSON.stringify([value.instanceId, value.profileId]), value]; })).values()];
  }
  private async requireTarget(target: {instanceId: string; profileId: string}) {
    if (!(await this.instances()).some(item => sameTarget(item, target))) throw new IntegrationError("BINDING_INSTANCE_UNKNOWN", "实例未登记或已移除，请刷新实例名单。", 404);
  }
  private async request(origin: string, path: string, init: RequestInit = {}): Promise<unknown> {
    originSchema.parse(origin);
    const response = await (this.options.fetch ?? fetch)(origin + path, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }).catch(() => { throw new IntegrationError("VAULT_OFFLINE", "Vault 暂时无法连接，请打开 Obsidian 后重试。", 503); });
    if (!response.ok) throw new IntegrationError("VAULT_REQUEST_FAILED", "Vault 操作未完成，请刷新核对；若已有绑定，不会自动改绑。", response.status === 409 ? 409 : 502);
    const reader = response.body?.getReader(); if (!reader) throw new IntegrationError("VAULT_BINDING_INVALID", "Vault 未返回数据");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 262144) throw new IntegrationError("VAULT_BINDING_INVALID", "Vault 响应过大"); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private async discover(): Promise<Identity[]> {
    const root = this.options.discoveryRoot ?? process.env.DSH_OBSIDIAN_DISCOVERY_DIR ?? join(homedir(), ".dsh", "obsidian-bridge", "discovery-v1");
    const names = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const candidates: Identity[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).slice(0, 256)) {
      try { const raw = await readSmallJson(join(root, name)); const parsed = identitySchema.extend({ expiresAt: z.number() }).safeParse(raw); if (parsed.success && parsed.data.expiresAt > Date.now()) candidates.push(parsed.data); } catch { /* Broken discovery entries grant no authority. */ }
    }
    const live: Identity[] = [];
    const deadline = AbortSignal.timeout(2000);
    for (let offset = 0; offset < candidates.length; offset += 8) {
      if (deadline.aborted) break;
      await Promise.all(candidates.slice(offset, offset + 8).map(async candidate => {
        try { const current = identitySchema.parse(await this.request(candidate.origin, "/discovery/v1/identity", {signal:deadline}));
          if (current.vaultId === candidate.vaultId && current.bootId === candidate.bootId && current.publisherId === candidate.publisherId && current.origin === candidate.origin) live.push(current);
        } catch { /* Offline Vaults use the saved display record below. */ }
      }));
    }
    const unique = new Map<string, Identity>();
    for (const item of live) unique.set(JSON.stringify([item.vaultId, item.publisherId, item.bootId]), item);
    return [...unique.values()];
  }
  private async saved(): Promise<Saved[]> { return savedSchema.parse(await readJsonIfPresent(join(this.options.stateRoot, "vault-bindings-index.json")) ?? []); }
  private async knownBindings(): Promise<Saved[]> {
    const saved = await this.saved();
    const paths = new Set(saved.map(item => item.root));
    const registry = this.options.vaultRegistryFile ?? (process.env.APPDATA ? join(process.env.APPDATA, "obsidian", "obsidian.json") : undefined);
    if (registry) {
      try {
        const value = z.object({ vaults: z.record(z.string(), z.object({ path: z.string() })) }).parse(await readSmallJson(registry));
        for (const item of Object.values(value.vaults).slice(0, 256)) if (isAbsolute(item.path)) paths.add(item.path);
      } catch { /* Optional Obsidian registry. Saved paths remain readable. */ }
    }
    const result = new Map(saved.map(item => [item.root, item]));
    // Read only Bridge metadata in known Vaults, never traverse notes or rewrite plugin data.
    await Promise.all([...paths].map(async path => {
      try {
        const root = await realpath(path);
        const data = z.object({vaultId:z.string(), bindingState:z.object({snapshot:vaultBindingSnapshotSchema})}).parse(await readSmallJson(join(root,".obsidian","plugins","obsidian-deepharness-bridge","data.json")));
        result.delete(path);
        const snapshot = data.bindingState.snapshot;
        if (snapshot.vaultId === data.vaultId && snapshot.target) result.set(root, {...snapshot.target,vaultId:data.vaultId,name:basename(root),root,revision:snapshot.revision});
      } catch { /* Keep previously known entries marked offline if their file cannot be verified. */ }
    }));
    return [...result.values()];
  }
  private async location(vault: Identity, signal?: AbortSignal): Promise<string> {
    const proof = locationSchema.parse(await this.request(vault.origin, "/discovery/v1/vault-location", signal ? {signal} : {}));
    if (proof.vaultId !== vault.vaultId || proof.bootId !== vault.bootId || proof.publisherId !== vault.publisherId || proof.origin !== vault.origin || !isAbsolute(proof.vaultRoot)) throw new IntegrationError("VAULT_BINDING_INVALID", "Vault 路径证明与在线身份不一致");
    return realpath(proof.vaultRoot);
  }
  async list(target: {instanceId: string; profileId: string}): Promise<ManagedVault[]> {
    await this.requireTarget(target);
    const [saved, live] = await Promise.all([this.knownBindings(), this.discover()]);
    const result = new Map<string, ManagedVault>();
    for (const item of saved.filter(item => sameTarget(item, target))) result.set(item.vaultId, { vaultId: item.vaultId, name: item.name, root: item.root, revision: item.revision, online: false, manageable: false });
    const deadline = AbortSignal.timeout(2000);
    await Promise.all(live.map(async item => {
      const duplicates = live.filter(other => other.vaultId === item.vaultId).length > 1;
      if (!sameTarget(item.binding.target, target)) { if (!duplicates) result.delete(item.vaultId); return; }
      let root = "";
      try { root = await this.location(item, deadline); } catch { /* Show identity with operations unavailable. */ }
      result.set(item.vaultId, { vaultId: item.vaultId, name: item.displayName, root, revision: item.binding.revision, online: true, manageable: !!root && !duplicates && item.capabilities.includes(capability) });
    }));
    return [...result.values()];
  }
  async change(input: VaultBindingAction, unbind: boolean, signal: AbortSignal): Promise<{message: string; cancelled?: boolean}> {
    await this.requireTarget(input);
    if (this.busy) throw new IntegrationError("BINDING_BUSY", "已有绑定操作进行中，请完成或取消后重试。");
    this.busy = true;
    try {
      const operationsPath = join(this.options.stateRoot, "vault-binding-operations.json");
      const operations = operationsSchema.parse(await readJsonIfPresent(operationsPath) ?? {});
      let operation = operations[input.operationId];
      if (operation && (JSON.stringify(vaultBindingActionSchema.parse(operation.input)) !== JSON.stringify(vaultBindingActionSchema.parse(input)) || operation.unbind !== unbind)) throw new IntegrationError("BINDING_OPERATION_CONFLICT", "此操作编号已用于不同绑定请求。");
      if (operation?.message) return {message: operation.message};
      let folder: {root: string; vaultId: string} | undefined;
      if (!unbind && operation) folder = await inspectVaultFolder(operation.root);
      if (!unbind && !operation) {
        const selected = await (this.options.picker ?? createWindowsVaultFolderPicker())(signal);
        if (selected === null) return { message: "已取消选择，绑定未改变", cancelled: true };
        folder = await inspectVaultFolder(selected);
      }
      const vaultId = operation?.vaultId ?? (unbind ? input.vaultId : folder!.vaultId);
      const live = (await this.discover()).filter(item => item.vaultId === vaultId);
      if (live.length !== 1) throw new IntegrationError("VAULT_UNAVAILABLE", live.length ? "Vault 身份冲突，请检查重复副本。" : "请在 Obsidian 打开此 Vault 并启用桥插件；DSH 实例无需启动。");
      const vault = live[0]!;
      if (!vault.capabilities.includes(capability)) throw new IntegrationError("VAULT_UPGRADE_REQUIRED", "此 Vault 的桥插件尚不支持离线实例绑定，请更新至 0.7.0-rc2.4 或兼容版本。");
      const root = await this.location(vault);
      if (folder && root !== folder.root) throw new IntegrationError("VAULT_BINDING_INVALID", "所选文件夹与在线 Vault 不一致，请检查复制的 Vault");
      const checked = await inspectVaultFolder(root);
      if (checked.vaultId !== vault.vaultId || checked.root !== root) throw new IntegrationError("VAULT_BINDING_INVALID", "Vault 文件夹身份已改变，请重新选择");
      await this.requireTarget(input); signal.throwIfAborted();
      const applied = operation && vault.binding.lastOperationId === input.operationId && vault.binding.revision === operation.expectedRevision + 1 && (unbind ? vault.binding.target === null : sameTarget(vault.binding.target, input));
      if (operation && !applied && vault.binding.revision !== operation.expectedRevision) throw new IntegrationError("BINDING_REVISION_CONFLICT", "绑定已变化，请刷新核对操作结果。");
      if (unbind && !applied && (!sameTarget(vault.binding.target, input) || input.expectedRevision !== vault.binding.revision)) throw new IntegrationError("BINDING_REVISION_CONFLICT", "绑定已在其他入口修改，请刷新卡片后重试。");
      if (!unbind && vault.binding.target && !sameTarget(vault.binding.target, input)) throw new IntegrationError("BINDING_FOREIGN", "此 Vault 已绑定其他实例，请先在原实例卡片中解绑。");
      if (!operation) {
        operation = { input, unbind, root, vaultId: vault.vaultId, expectedRevision: vault.binding.revision };
        operations[input.operationId] = operation;
        await writeJsonAtomically(operationsPath, operations);
      }
      let snapshot = vault.binding;
      if (!applied && (unbind || !sameTarget(snapshot.target, input))) {
        const grant = vaultBindingGrantSchema.parse({ domain: capability, operationId: input.operationId, vaultId: vault.vaultId, bootId: vault.bootId, publisherId: vault.publisherId, instanceId: input.instanceId, profileId: input.profileId, expectedRevision: vault.binding.revision, intent: unbind ? "unbind" : "bind", expiresAt: Date.now() + 30000 });
        const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
        const signature = createHmac("sha256", this.options.token).update(payload).digest("hex");
        snapshot = vaultBindingSnapshotSchema.parse(await this.request(vault.origin, "/control/v1/maintenance-binding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({payload, signature}) }));
        if (snapshot.vaultId !== vault.vaultId || snapshot.lastOperationId !== input.operationId || snapshot.revision !== vault.binding.revision + 1 || (unbind ? snapshot.target !== null : !sameTarget(snapshot.target, input))) throw new IntegrationError("VAULT_BINDING_INVALID", "绑定回执与请求不一致，请刷新核对");
      }
      const saved = (await this.saved()).filter(item => item.vaultId !== vault.vaultId);
      if (!unbind) saved.push({ instanceId: input.instanceId, profileId: input.profileId, vaultId: vault.vaultId, root, name: vault.displayName, revision: snapshot.revision });
      await writeJsonAtomically(join(this.options.stateRoot, "vault-bindings-index.json"), saved);
      operation.message = unbind ? "已解除绑定" : "已绑定此 Vault；DSH 实例无需启动";
      await writeJsonAtomically(operationsPath, operations);
      return { message: operation.message };
    } finally { this.busy = false; }
  }
}
