# 首次接入插件发行包 — 2026-09-06

Engine 发行包现在携带同一次构建产出的 Maintenance 插件，供首次接入流程调用官方 `plugin add`。本变更仅负责打包与校验，不执行安装，也不修改版本。

## 产物约定

- Engine tgz 内的 `dsh-session-maintenance/engine/dsh-session-maintenance.tgz` 与发行目录中的独立插件 tgz 逐字节相同。
- 同目录的 `integration-package.json` 为 `{ "schemaVersion": 1, "file": "dsh-session-maintenance.tgz", "sha256": "<64 位小写十六进制>" }`；摘要没有 `sha256:` 前缀。
- 插件压缩包只生成一次，然后写入 Engine staging。沿用确定性的 tar/gzip 与稳定 JSON 序列化，不加入时间戳、随机标识或机器路径。
- `verify-phase2-package.mjs` 对两次可复现构建和最终发行目录均检查内嵌文件存在、插件字节一致、清单版本与文件名、摘要格式及内容。原有三个发行输出的可复现比较继续保留。

## 验证

- `node --test --test-isolation=none scripts/verify-phase2-package.test.mjs`：6/6 通过。覆盖正确包、相同输入的确定性归档、不同内嵌包、自洽但不匹配的内嵌摘要、错误摘要、错误版本与文件名、带前缀或大写或非字符串摘要、空清单，以及缺少包或清单。
- 合成夹具仅创建在本工作区 `.artifacts/synthetic-integration-package-*` 下，带 `SYNTHETIC-FIXTURE` 标记；测试完成后校验目录边界并清理。
- `node scripts/package-phase2.mjs --skip-build --out .artifacts/integration-packaging-check`：成功。随后直接调用导出的校验函数检查实际 Engine 与插件 tgz，通过逐字节一致性和摘要验证。
- `git diff --check`：通过。

上述首次真实打包复用当时工作区已有构建输出，用于验证新增的嵌入封装。完整 `pnpm verify:phase2-package` 在最终源码提交后由主控执行，内部比较两次打包，并检查最终发行目录。最终版本、源提交、包摘要和该次结果记录于外层候选交付清单；本报告不将首次复用输出的检查表述为完整发行验收。普通 Node 测试进程在沙箱中出现 `spawn EPERM`，以同进程测试选项完成；真实打包获得子进程执行权限后通过。

未写入真实 Codex/DSH home，未生产安装，未创建 Git 提交；主控统一提交。
