import { describe, expect, it } from "vitest";
import type { ProjectionRun } from "@linmu/dsh-session-contracts";
import { runtimeWritebackLabel, versionMetadataLabel } from "../src/maintenance-status.js";
import { importJobPresentation } from "../src/import-jobs.js";

describe("Maintenance user-visible state", () => {
  it("shows durable cancellation separately from a failed import and preserves progress units", () => {
    const base = { job: { id: "fixture", status: "running" as const }, request: { kind: "codex-import" as const, operationId: "fixture", mode: "content" as const, instanceIds: ["source"] }, updatedAt: "2026-09-06T00:00:00.000Z" };
    expect(importJobPresentation({ ...base, latestEvent: { type: "progress", jobId: "fixture", at: base.updatedAt, sequence: 2, current: 4, message: "internal cursor" } })).toEqual({ label: "正在导入", detail: "已处理 4 项", active: true });
    expect(importJobPresentation({ ...base, job: { ...base.job, status: "failed" }, latestEvent: { type: "failed", code: "JOB_CANCELLED", message: "cancelled", jobId: "fixture", sequence: 3, at: base.updatedAt } })).toMatchObject({ label: "已取消", active: false });
  });
  it("distinguishes projection preparation from run writeback and incomplete recovery", () => {
    expect(runtimeWritebackLabel({ state: "preparing" } as ProjectionRun, 0)).toContain("准备会话");
    expect(runtimeWritebackLabel({ state: "running" } as ProjectionRun, 3)).toContain("3 项运行变动");
    expect(runtimeWritebackLabel({ state: "recovery-required" } as ProjectionRun, 0)).toContain("不代表恢复已经完成");
    expect(runtimeWritebackLabel({ state: "closed" } as ProjectionRun, 0)).toContain("完成收尾");
  });

  it("never presents unavailable metadata as a saved historical snapshot", () => {
    expect(versionMetadataLabel({ metadata: null, metadataAvailability: "unknown", metadataProvenance: "unavailable", firstPersistedAt: null })).toMatchObject({ warning: true, label: "历史元数据不可用" });
    expect(versionMetadataLabel({ metadata: null, metadataAvailability: "corrupt", metadataProvenance: "unavailable", firstPersistedAt: null })).toMatchObject({ warning: true, label: "版本元数据校验失败" });
    expect(versionMetadataLabel(null).warning).toBe(false);
    expect(versionMetadataLabel({ metadata: { title: "历史" }, metadataAvailability: "available", metadataProvenance: "captured", firstPersistedAt: null }).label).toBe("版本元数据已保存");
  });
});
