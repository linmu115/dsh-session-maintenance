# Engine 0.1.18 部署兼容补丁

2026-09-06。在用户授权替换 rc1 看板候选的实际安装检查中，发现两个局部兼容问题：纯配置型 Reference Suite 被误报为无法加载；既有 profile 使用系统 pnpm store，而自动接入安装固定指定 Launcher store。Engine 0.1.18 分别按官方 bundle 清单/补丁契约和 profile 已登记的缓存位置处理。

补丁只修改 Engine 接入检查与安装参数。Maintenance 插件保持 0.2.20，Launcher 保持 0.2.3，SCM 保持 0.3.2；数据库 schema 保持 20。既有会话写入、工作区白名单、回收规则和 Codex 原生回写状态均未扩展。

验证和测试边界分别见 [bundle 检查修复](integration-bundle-entry-20260906.md)和 [既有 store 兼容修复](integration-existing-store-20260906.md)。0.1.17 看板候选的 182 文件 / 655 项完整回归仍是继承基线；本补丁针对改动运行必要的接入回归、Engine 类型检查、构建与归档一致性检查。

部署使用独立发行目录，不覆盖 0.1.16 和 0.1.17 的 Engine 归档。用户的数据库、对象、投影/恢复资料、profile 和旧 Launcher 已在替换前保存。原启动 Hook 保留已验证的兼容调用方式并切换 Engine 路径；新 Launcher 的能力凭据由它实际启动时生成，不在部署脚本中伪造。真实 DSH 启动及用户验收由用户后续进行。
