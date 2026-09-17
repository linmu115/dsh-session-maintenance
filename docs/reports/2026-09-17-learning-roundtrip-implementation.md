# 学习会话受控双向交接首版

实现用户已确认的独立实验栏目、显式双端绑定、增量上下文注入与受控回收。Maintenance 接管同一逻辑主线，Codex 普通镜像导入不覆盖绑定会话，DSH 续写不派生。schema 25 随现有数据库维护绑定和回执；首版要求 DSH 正常停止后交接，送达后重新启动 Codex。

实现与边界：[项目地图实现记录](../project/records/implementation/learning-roundtrip.md)。验收范围：[验证记录](../project/records/verification/learning-roundtrip.md)。

## 检查

`pnpm -r --if-present build` 通过。相关回归 57 文件 215 项通过；新功能最终专项 4 文件 19 项通过；真实 CLI 协议与本地模拟模型完成注入、重启、下一轮模型输入及增量读取验证。浏览器合成界面验证冲突提示。未宣称全库测试全绿。

## 交付状态

本轮完成源码、测试与地图更新；不发布安装包，不写真实 Codex/DSH homes，不自动绑定“机试DeepLearning”。只读检查确认原会话身份和来源存在，但 DSH 实例当时处于运行状态。部署后仍应先停止 DSH、核对共同历史再显式加入。
