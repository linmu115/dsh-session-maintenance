---
{
  "id": "IMP-launcher-sync-directory",
  "kind": "implementation",
  "title": "同步实例使用 Launcher 当前名称",
  "status": "current",
  "summary": "当前 Launcher 实例作为日常列表，历史运行和未关联登记单独折叠，保留原同步策略。",
  "sources": []
}
---

2026-09-19 用户反馈同步页面出现大量无法辨认的实例，要求显示 Launcher 正常使用的名字。只读核对确认旧目录将 projection_runs 的全部历史实例 ID 与静态注册项合并，默认用 ID 当名字；当前接口 6 项，Launcher 当前 4 项，未运行的新测试实例缺席。

要求：按稳定 ID 读取 Launcher 当前名称，新增、改名和移除在刷新时体现；历史及未关联实例折叠保留，其同步配置和历史数据不删除。名称只用于显示，不用作路由身份。同名实例以 ID 区分，目录损坏明确报错，不猜目标。

实现：新增仅读取 Launcher config 的轻量目录入口，不做接入扫描或运行探测；同步目录区分当前实例和历史实例；策略、有效范围及可用性仍能按旧 ID 查回。未发现 Launcher 时给出提示并保留历史入口。

开发历程草稿：从用户反馈与真实只读 API 比对定位到目录来源错误，而不是 Launcher 丢失名称；改为当前目录与历史展示分离。来源索引待绑定。构建、测试和实际安装结果将在交付记录中补充。

实现验证已完成：22 项针对性测试与 32 项发行接入测试通过，生产构建/打包成功；真实只读预览返回 4 个当前 Launcher 名称及 3 个历史/未关联项。Engine rc2.54 / Dashboard 0.1.14 尚未替换运行版本，等待副本通过 Launcher 正常停止。详见 `docs/reports/2026-09-19-launcher-sync-instance-names.md`；UI 实机未验收。
