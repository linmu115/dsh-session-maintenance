# 发布包 Engine 启动修正

**日期：** 2026-08-27  
**范围：** 阶段二正式部署前置修正

## 发现

正式部署预检首次直接执行发布包中的 `engine/dsh-session-maint.mjs` 时发现两个问题：构建脚本重复写入 Node hashbang，且 ESM bundle 中 CommonJS 依赖无法获得 `require`。两者都会让独立 Engine 在读取命令行参数前退出，而既有隔离验收使用的是 fixture Engine，因此未覆盖这个发布入口。

## 修正

- 保留入口源码本身唯一的 Node hashbang，不再由打包脚本重复注入。
- 为 Node ESM bundle 注入 `createRequire(import.meta.url)`，允许自包含依赖在 ESM 发布文件中正常加载。
- 便携性门禁现在会校验唯一首行 hashbang，并把发布包 Engine 写入带 marker 的临时目录，实际执行一次 `--help`；无法启动即阻止发布。

## 验证

- `pnpm package:phase2`
- `pnpm assert:phase2-portable`
- 结果：19 个发布文件检查通过，发布包 Engine `--help` 退出码为 0。

正式 DSH profile 在本修正期间未被修改，旧同步插件保持启用。
