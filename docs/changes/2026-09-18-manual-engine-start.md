# 手动启动 Session Maintenance

新增 scripts/windows 下可双击启动入口，动态读取 Launcher 当前绑定，后台启动、认证就绪检测及重复启动互斥。无需固定版本和端口。

验证：Windows PowerShell 实际启动服务成功，再次运行复用 PID；旧会话通过正式恢复流程独立收尾。启动脚本不包含会话回收、删除、强制杀进程或开机自启。项目地图历程 HIST-manual-engine-start 记录来源与边界。
