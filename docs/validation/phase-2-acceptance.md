# Phase 2 验收记录：官方 DSH 写入与正式部署

**日期：** 2026-08-27

**综合分支：** `codex/phase-4-native-mirror`

**支持契约：** 官方 DSH `0.1.1-rc.2` / Cordis `4.0.1`

## 结论

Phase 2 已完成正式部署，不再只是隔离 fixture 验收。版本锁定 Core 扩展、远程 Gateway、可恢复写事务、Codex → DSH 安全快进、独立 Dashboard 与 DSH 入口插件均已安装到官方 `web` profile。旧 `dsh-codex-session-sync` 已从顶层依赖、bundle 与 `node_modules` 退出。

Maintenance 没有 EAC 运行依赖；正式 Engine 位于 `D:\AI\DeepSeek-Harness\dsh-session-maintenance`，状态位于 `%LOCALAPPDATA%\DSH-Session-Maintenance`。

## 最终发布产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `dsh-session-maintenance-engine-0.1.0.tgz` | 321,594 bytes | `425ce0481624fdb8cc089204e4221efc3682e662c281fed3b96294a3bd4c7bd8` |
| `dsh-session-maintenance-0.1.0.tgz` | 97,272 bytes | `056e387ed05a7c53b063f6e13d75ae86834f8a95330ebbbaff6176b36d9eedce` |

`verify:phase2-package` 连续生成三份产物，两个 tgz 均逐字节一致。插件从固定内容地址安装，不依赖源码工作树或临时目录。

## 正式部署事务

- 目标：`D:\AI\DeepSeek-Harness\home\profiles\web`
- 备份：`D:\AI\DeepSeek-Harness\home\profiles\web\.dsh-session-maintenance-backup\formal-phase4-20260827-2158`
- 备份范围：profile package/lock/workspace/Cordis 配置、旧插件物化目录、替换前 Engine。
- 最终插件依赖只登记一次，bundle 只登记一次。
- `dsh-codex-session-sync`：dependency `false`、bundle `false`、物化目录不存在。

部署后结果：

- 官方 DSH 页面 HTTP 200；
- Maintenance client bundle HTTP 200，并含官方 module factory；
- Engine `ready=true`，登记 2 个实例；
- DSH read/write adapter 均为 `compatible`；
- DSH 正式扫描完成，新增绑定、版本和候选均为 0，平台写入为 0；
- 0 个冲突、0 个未解决事务、0 个 manual-review 事务；
- loader 日志无 `Failed to load plugins`、loader entry drift 或 client module 错误。

## 自动门禁

| 门禁 | 结果 |
| --- | --- |
| 全工作区 typecheck | 20/20 通过 |
| 全工作区 build | 20/20 通过 |
| 全量测试 | 66 files / 142 tests 通过 |
| 通用便携性扫描 | 346 个文本文件通过 |
| 三次可复现打包 | 通过 |
| 官方 `web` profile 实际加载 | 通过 |
| 正式 DSH 幂等扫描 | 通过 |
| `git diff --check` | 通过 |

## 保留的安全边界

- Core 扩展只支持锁定的官方 `0.1.1-rc.2` 契约；漂移时失败关闭。
- 会话正文不在安装事务中被迁移、删除或重写。
- 旧包和替换前 Engine 仍在上述备份目录中，可执行整套恢复。
