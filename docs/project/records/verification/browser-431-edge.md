---
id: VER-browser-431-edge
kind: verification
title: Edge 登录恢复与 DSH 请求头修复待安装
status: current
relations:
- relation: verifies
  to:
    record_id: REQ-sync-extension-navigation
sources:
- path: D:/AI/DeepSeekHarness-Plugin/artifacts/browser-431-20260919/report.md
- path: D:/AI/DeepSeekHarness-Plugin/artifacts/browser-431-20260919/prepared.json
---

# Edge 登录恢复与 DSH 请求头修复待安装

2026-09-19，用户要求使用 Browser Use 解决 Edge 和 Launcher 原生窗口无法连接、Maintenance 在 Edge 不可用的问题。

| 对象 | 本次证据 | 边界 |
| --- | --- | --- |
| Edge DSH | 页面原为 HTTP 431；68 个 DSH Cookie 所属端口均未监听；精确清理这些旧登录记录后，正式入口登录、编辑器、工作区与插件脚本恢复 | 未发送模型请求；草稿扩展读取仍有 409 未映射业务状态 |
| Edge Maintenance Engine .53 / Dashboard .13 | 通过当前正式入口签入，真实工作区及 GPT、Obsidian、ThoughtDAG 扩展栏目可读；扩展请求未捕获 HTTP 错误或加载失败 | 旧标签页仍指向旧启动端口；没有修改同步范围、绑定或历史 |
| DSH 请求头容量 | 旧运行 24 KiB 合成 Cookie 返回 431；源码修复后 21 项测试与类型检查通过；实际发行依赖构建包 24 KiB 返回 200，65 KiB 返回 431 | 保持认证、来源与端口隔离；64 KiB 为有限上限，不承诺无限 Cookie 累积 |
| 安装和 Launcher 原生窗口 | 单文件产物、原安装哈希与备份已准备；请求用户从 Launcher 正常停止副本 | 尚未安装；正常 closed 回执、正式 Start、新运行及 Launcher 原生窗口验收待完成 |

证据与继续步骤见[本次报告](D:/AI/DeepSeekHarness-Plugin/artifacts/browser-431-20260919/report.md)。不能将 Edge 恢复或构建测试当作 Launcher 原生窗口已经恢复。

## 本次开发历程草稿

整理者为当前任务主代理，来源为本次用户反馈、Browser Use 页面和网络观测、本机身份查询与合成测试；尚未绑定正式 history 事件索引。本次先复现 Edge 的 431，再核对 Cookie 累积和旧端口状态；通过正式入口恢复 Maintenance、精确清理旧 DSH 登录 Cookie 恢复 Edge，随后补齐 DSH 缺失的有界请求头容量。源码和发行测试通过后保留待安装状态，原因是工作区禁止绕过尚未提供的 Launcher 外部停止流程。全过程未操作 Vault、同步名单、真实历史或模型调用。
