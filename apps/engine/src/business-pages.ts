import { join } from "node:path";
import { z } from "zod";
import { businessPageSchema, businessPageRegistrationSchema, businessPageOwnerSchema, businessPageActionRequestSchema,
  businessPageActionReceiptSchema, businessPageActionAckSchema, type BusinessPage, type BusinessPageOwner,
  type BusinessPageRegistration, type BusinessPageActionRequest, type BusinessPageActionReceipt, type BusinessPageActionAck,
  type MaintenanceWriteScope } from "@linmu/dsh-session-contracts";
import { IntegrationError, readJsonIfPresent, writeJsonAtomically } from "./integrations/bindings.js";
const stateSchema = z.strictObject({ schemaVersion: z.literal(1), pages: z.array(businessPageSchema).max(500), actions: z.array(businessPageActionReceiptSchema).max(2000) });
type State = z.infer<typeof stateSchema>;
const key = (owner: BusinessPageOwner) => JSON.stringify([owner.instanceId, owner.profileId, owner.namespace, owner.providerId]);
const sameOwner = (left: BusinessPageOwner, right: BusinessPageOwner) => key(left) === key(right) && left.bootId === right.bootId;
const fail = (code: string, message: string, status = 409): never => { throw new IntegrationError(code, message, status); };
export class BusinessPageRegistry {
  private state: State = { schemaVersion: 1, pages: [], actions: [] };
  private readonly now: () => number;
  private constructor(private readonly options: { stateRoot: string; writes: MaintenanceWriteScope; now?: () => number }) { this.now = options.now ?? Date.now; }
  static async create(options: { stateRoot: string; writes: MaintenanceWriteScope; now?: () => number }): Promise<BusinessPageRegistry> {
    const registry = new BusinessPageRegistry(options);
    const stored = await readJsonIfPresent(join(options.stateRoot, "business-pages.json"));
    if (stored !== undefined) registry.state = stateSchema.parse(stored);
    await registry.mutate(() => {
      for (const page of registry.state.pages) { page.expiresAt = 0; page.online = false; }
      for (const action of registry.state.actions) if (["queued", "running"].includes(action.status)) {
        action.status = "uncertain"; action.message = "维护引擎已重启；请核对业务状态，不会自动重复执行。"; action.updatedAt = registry.now();
      }
    });
    return registry;
  }
  private async mutate<T>(action: () => T): Promise<T> {
    return this.options.writes.run("business-pages", async () => {
      const previous = structuredClone(this.state);
      try { const result = action(); await writeJsonAtomically(join(this.options.stateRoot, "business-pages.json"), stateSchema.parse(this.state)); return structuredClone(result); }
      catch (error) { this.state = previous; throw error; }
    });
  }
  list(): { pages: BusinessPage[] } { return { pages: this.state.pages.map(page => ({ ...structuredClone(page), online: page.expiresAt > this.now() })) }; }
  private page(owner: BusinessPageOwner, online = true): BusinessPage {
    const page = this.state.pages.find(page => sameOwner(page.owner, owner));
    if (!page || online && page.expiresAt <= this.now()) fail("BUSINESS_PAGE_OFFLINE", "信息页提供方已离线或重启，请刷新后重试。");
    return page!;
  }
  private retire(owner: BusinessPageOwner): void {
    for (const action of this.state.actions) if (sameOwner(action.request.owner, owner) && ["queued", "running"].includes(action.status)) {
      action.status = action.status === "running" ? "uncertain" : "failed";
      action.message = "提供方已卸载或重启；旧操作不会转交其他运行。"; action.updatedAt = this.now();
    }
  }
  async register(input: BusinessPageRegistration): Promise<BusinessPage> {
    const value = businessPageRegistrationSchema.parse(input);
    return this.mutate(() => {
      const existing = this.state.pages.find(page => key(page.owner) === key(value.owner));
      if (existing && existing.expiresAt > this.now() && !sameOwner(existing.owner, value.owner)) fail("BUSINESS_PAGE_OWNER_ACTIVE", "不能覆盖仍在线的信息页提供方。");
      if (existing && sameOwner(existing.owner, value.owner) && (value.snapshot.revision < existing.snapshot.revision
        || value.snapshot.revision === existing.snapshot.revision && JSON.stringify(value.snapshot) !== JSON.stringify(existing.snapshot)))
        fail("BUSINESS_PAGE_REVISION_CONFLICT", "信息页内容已改变，请提高快照修订。");
      if (existing && !sameOwner(existing.owner, value.owner)) this.retire(existing.owner);
      const page: BusinessPage = { ...value, online: true, updatedAt: this.now(), expiresAt: this.now() + 20_000 };
      if (existing) this.state.pages[this.state.pages.indexOf(existing)] = page;
      else { if (this.state.pages.length >= 500) fail("BUSINESS_PAGE_LIMIT", "信息页数量已达上限。"); this.state.pages.push(page); }
      return page;
    });
  }
  async unregister(input: BusinessPageOwner): Promise<void> {
    const owner = businessPageOwnerSchema.parse(input);
    await this.mutate(() => { const page = this.state.pages.find(page => sameOwner(page.owner, owner)); if (page) { page.expiresAt = 0; page.online = false; this.retire(owner); } });
  }
  async heartbeat(input: BusinessPageOwner): Promise<void> {
    const owner = businessPageOwnerSchema.parse(input);
    await this.mutate(() => { this.page(owner).expiresAt = this.now() + 20_000; });
  }
  async enqueue(input: BusinessPageActionRequest): Promise<BusinessPageActionReceipt> {
    const request = businessPageActionRequestSchema.parse(input);
    return this.mutate(() => {
      const old = this.state.actions.find(action => key(action.request.owner) === key(request.owner) && action.request.operationId === request.operationId);
      if (old) { if (JSON.stringify(old.request) !== JSON.stringify(request)) fail("BUSINESS_ACTION_CONFLICT", "操作标识已用于不同请求。"); return old; }
      const page = this.page(request.owner);
      const action = page.snapshot.sections.flatMap(section => section.kind === "actions" ? section.actions : []).find(action => action.id === request.actionId);
      if (!action || action.expectedRevision !== request.expectedRevision) fail("BUSINESS_ACTION_STALE", "动作或业务修订已改变，请刷新后重试。");
      const fields = action!.fields;
      if (Object.keys(request.input).some(id => !fields.some(field => field.id === id))) fail("BUSINESS_ACTION_INPUT", "动作包含未声明的字段。", 400);
      for (const field of fields) {
        const value = request.input[field.id];
        if (value === undefined) { if (field.required) fail("BUSINESS_ACTION_INPUT", `请填写${field.label}。`, 400); continue; }
        if (field.kind === "boolean" ? typeof value !== "boolean" : field.kind === "integer" ? typeof value !== "number" || !Number.isInteger(value)
          : typeof value !== "string" || field.required && !value.trim() || field.kind === "select" && !field.options.some(option => option.value === value))
          fail("BUSINESS_ACTION_INPUT", `${field.label}的内容无效。`, 400);
      }
      if (this.state.actions.length >= 2000) fail("BUSINESS_ACTION_LIMIT", "已达到操作回执上限，请由维护管理员归档。", 503);
      const receipt: BusinessPageActionReceipt = { request, status: "queued", message: "等待提供方执行", updatedAt: this.now() };
      this.state.actions.push(receipt); return receipt;
    });
  }
  async poll(input: BusinessPageOwner): Promise<{ actions: BusinessPageActionRequest[] }> {
    const owner = businessPageOwnerSchema.parse(input);
    return this.mutate(() => {
      this.page(owner);
      const pending = this.state.actions.filter(action => sameOwner(action.request.owner, owner) && ["queued", "running"].includes(action.status)).slice(0, 20);
      pending.forEach(action => { action.status = "running"; action.updatedAt = this.now(); });
      return { actions: pending.map(action => action.request) };
    });
  }
  async acknowledge(input: BusinessPageActionAck): Promise<BusinessPageActionReceipt> {
    const ack = businessPageActionAckSchema.parse(input);
    return this.mutate(() => {
      this.page(ack.owner);
      const action = this.state.actions.find(action => sameOwner(action.request.owner, ack.owner) && action.request.operationId === ack.operationId);
      if (!action) return fail("BUSINESS_ACTION_UNKNOWN", "没有找到该提供方的操作。", 404);
      if (["completed", "failed"].includes(action.status)) { if (action.status !== ack.status || action.message !== ack.message) fail("BUSINESS_ACTION_CONFLICT", "操作已有不同回执。"); return action; }
      if (action.status !== "running") fail("BUSINESS_ACTION_UNCERTAIN", "该操作不能自动完成，请核对业务状态。");
      action.status = ack.status; action.message = ack.message; action.updatedAt = this.now(); return action;
    });
  }
  receipt(owner: BusinessPageOwner, operationId: string): BusinessPageActionReceipt {
    businessPageOwnerSchema.parse(owner); z.uuid().parse(operationId);
    const action = this.state.actions.find(action => sameOwner(action.request.owner, owner) && action.request.operationId === operationId);
    if (!action) return fail("BUSINESS_ACTION_UNKNOWN", "没有找到该提供方的操作。", 404);
    return structuredClone(action);
  }
}
