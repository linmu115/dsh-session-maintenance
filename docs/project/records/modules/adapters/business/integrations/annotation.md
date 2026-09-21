---
{
  "id": "INT-annotation",
  "kind": "implementation",
  "title": "Core 的固定引用、镜像与原生接入",
  "status": "current",
  "summary": "Core 持有实时引用事务，Maintenance 提供固定来源、镜像和原生状态。",
  "relations": [
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-graph"
      },
      "reason": "Core 固定引用捕获、读取、绑定和交付回执"
    },
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-native-context"
      },
      "reason": "Core 原生工具及 Agent surface"
    },
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-core-directory",
        "project_id": "ddcdd580-5275-5eef-9578-6de0e81fa887"
      },
      "reason": "Maintenance 镜像消费 Core 的只读条目目录"
    },
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-core-host",
        "project_id": "ddcdd580-5275-5eef-9578-6de0e81fa887"
      },
      "reason": "可选 Core 宿主服务协作"
    }
  ],
  "sources": [
    {
      "path": "../changes/2026-09-15-native-context-management.md"
    },
    {
      "path": "../../plugins/dsh-session-maintenance/src/session-context.ts"
    },
    {
      "path": "../../plugins/dsh-session-maintenance/src/annotation-mirror.ts"
    },
    {
      "path": "../../plugins/dsh-session-maintenance/src/native-context.ts"
    }
  ]
}
---

# Core 的固定引用、镜像与原生接入

- **固定来源**：Core 使用 maintenanceSessionContext.capture/inspect/read/bind/settleRead/endExecution，Maintenance 固定版本、截止与目标；真实发送/准备归 Core。技术合同返回 [[IF-graph]]。
- **镜像目录**：Maintenance 消费 Core referenceDirectory protocol 1 的 listSessions/listEntries/subscribe，向 annotation-sync 提交有界条目。Core aggregate/journal/outbox 留原处，annotation-records 看板只读。
- **原生上下文**：Core 工具调用 [[IF-native-context]]，真实 Agent pre-step 追加 surface 替代；Maintenance 管状态及证据核验。仅声明 namespace 不代表释放成功。

本仓调用点 [固定引用宿主服务](../../../../../../../plugins/dsh-session-maintenance/src/session-context.ts)、[Core 目录消费/重试队列](../../../../../../../plugins/dsh-session-maintenance/src/annotation-mirror.ts)、[受限原生桥](../../../../../../../plugins/dsh-session-maintenance/src/native-context.ts)。镜像要显式配置 annotation-records 才注入 Core 服务，未映射或离线保留重试。

公共对象 [[IF-extension]]，接入列表 [[INT-business-directory]]。外部 Suite 地图的 IF-core-host 与 IF-core-directory 是唯一 Core 宿主/目录合同；本页不复制其定义，Suite 不是本项目父级。
