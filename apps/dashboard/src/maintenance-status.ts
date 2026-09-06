import type { ProjectionRun, VersionMetadataSnapshot } from "@linmu/dsh-session-contracts";

export const RUN_STATE_LABELS: Readonly<Record<ProjectionRun["state"], string>> = {
  preparing: "正在准备投影", running: "运行中", draining: "正在收尾", verifying: "正在核对提交",
  closed: "已结束", "recovery-required": "需要恢复", recovering: "正在恢复", recovered: "已恢复",
  quarantined: "待核查的运行", "cleanup-pending": "等待清理运行副本",
};

export function runtimeWritebackLabel(run: ProjectionRun, pending: number): string {
  if (run.state === "preparing") return "正在为本次启动准备会话，尚未进入运行回写。";
  if (pending > 0) return `${pending} 项运行变动等待保存到 Maintenance。`;
  if (["recovery-required", "quarantined", "recovering"].includes(run.state)) return "仍有恢复状态需要核查，待提交计数为零不代表恢复已经完成。";
  if (["closed", "recovered"].includes(run.state)) return "本次运行已完成收尾。";
  return "当前没有等待提交的运行变动。";
}

export function versionMetadataLabel(snapshot: VersionMetadataSnapshot | null | undefined): { readonly label: string; readonly detail: string; readonly warning: boolean } {
  if (snapshot === null) return { label: "尚无版本快照", detail: "生成首个稳定版本后会记录元数据。", warning: false };
  if (snapshot?.metadataAvailability === "available") return { label: "版本元数据已保存", detail: "该版本的标题、标签和归档状态有独立快照。", warning: false };
  if (snapshot?.metadataAvailability === "corrupt") return { label: "版本元数据校验失败", detail: "当前目录信息仍可查看；需要该历史元数据的比较和派生会被阻止。", warning: true };
  return { label: "历史元数据不可用", detail: "这个旧版本缺少可验证的元数据快照。正文仍可读取，历史标题与标签显示为未知。", warning: true };
}
