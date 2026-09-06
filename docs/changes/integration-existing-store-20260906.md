# 接入安装沿用既有 pnpm store

既有 rc1 profile 的 `node_modules/.modules.yaml` 可以记录系统 pnpm store。此前插件安装始终传入 Launcher 自有 `.pnpm-store`，导致官方 CLI 以 `ERR_PNPM_UNEXPECTED_STORE` 拒绝已有依赖目录。

安装现在先保留原有配套产物 SHA-256 校验，再读取所选 profile 的既有 `.modules.yaml`。读取使用现有 YAML 依赖，兼容实际 JSON 格式记录；记录中的 `storeDir` 是带 `vN` 后缀的实际目录，传给官方 CLI 的 `--store-dir` 使用其父目录，避免重复追加 `v11`。系统 store 和独立自定义 store 均可沿用，读取阶段不会扫描或访问这些 cache 目录。

无 `.modules.yaml` 的新 profile 保持 `<launcherDataRoot>/.pnpm-store` 回退行为。记录不可读、不是常规文件、过大、YAML/JSON 损坏、重复键、别名、storeDir 缺失/非字符串/非明确绝对路径或版本目录格式无法识别时，返回可解释的 `INTEGRATION_STORE_RECORD_INVALID`，不启动安装。不会删除 `node_modules`、修写原记录或更改全局 pnpm 配置；Hook 和产物校验没有放宽。

专用测试使用带标记临时目录和桩化官方 CLI，不读取或写入真实 store/profile。系统 store 路径也在合成 sandbox 内表达，不需要创建或访问实际缓存。异常记录与正常安装参数生成后，原 `.modules.yaml` 字节和已有依赖哨兵文件均保持不变；额外验证原产物摘要不匹配时仍不得调用安装程序。

验证结果：

- `pnpm exec vitest run apps/engine/test/integration-existing-store.test.ts apps/engine/test/integrations.test.ts --maxWorkers=1 --testTimeout=15000`：2 个文件、40 项全部通过（新增 store 专用测试 14 项，既有接入回归 26 项）。
- `node node_modules/typescript/bin/tsc -p apps/engine/tsconfig.json --noEmit`：通过。
- 针对本次三个文件的 `git diff --check`：通过。

本次只修改安装器、独立测试与本报告，没有修改版本或锁文件。主控统一处理版本、集成与提交。
