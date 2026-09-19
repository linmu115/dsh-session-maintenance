---
id: IF-offline-vault-binding
kind: interface
title: Maintenance 管理 Vault 绑定的独立授权合同
status: current
---

# 使用与边界

用户在Maintenance选择已登记DSH实例后，能够在实例不运行时管理Vault绑定。Obsidian Vault需打开并运行0.7.0-rc2.4兼容桥。历史在线DSH controller通道继续用于运行连接，新通道不能获得Viewer或业务写入权限。

Maintenance拥有管理操作授权及UI，Obsidian桥拥有持久绑定真源。Engine UI接口仍要求已有session/origin/CSRF；实例从持久接入登记核验。配套Engine/Companion必须使用相同本地state root（默认LOCALAPPDATA/DSH-Session-Maintenance，可由双方环境DSH_SESSION_MAINTENANCE_STATE_ROOT指定）。

## 线协议

Engine提供GET /v1/vault-bindings/instances、GET /v1/vault-bindings/vaults，以及POST create/unbind。DTO唯一来源为packages/contracts/src/vault-bindings.ts，local-api-client提供相应方法。

Engine先读取Vault路径证明及身份，再向Vault POST /control/v1/maintenance-binding发送payload（UTF-8 JSON的base64url）及signature（以当前Engine连接token对原payload执行HMAC-SHA256的hex）。domain固定maintenance-vault-binding-v1。授权含操作ID、vaultId、publisherId、bootId、instanceId/profileId、expectedRevision、intent、expiresAt；默认30秒，上限60秒。浏览器不接收token或授权。Companion只从受保护的本地connection.json读取密钥，不接受请求指定密钥路径或网络校验地址。

Companion要求本机host请求及签名/身份/时限正确，复用串行写入；bind必须尚未绑定，unbind必须属于指定实例，CAS必须一致；同操作ID不同语义被拒绝。授权不依赖DSH live candidate，且不会设置verified runtime identity。成功后既有监听器清除controller tokens/leases。

Engine维护的是可重建显示索引及操作日志，不直接写Vault插件配置。回执丢失时保留操作ID，重试核对lastOperationId和revision后补本地索引；状态不确定不能报告成功或自动改绑。旧Companion缺少专用capability时显示升级提示，不回退到无验证写入。

实现和已验证范围见 [[HIST-offline-vault-binding]]，用户来源见 [[REQ-offline-vault-binding]]。
