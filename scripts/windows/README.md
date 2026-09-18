# Windows 手动启动 Session Maintenance

双击 `Start-Session-Maintenance.cmd`。它调用同目录的 PowerShell 脚本，按 Launcher 的 `runtime-lifecycle.json` 找到当前引擎、Node.js 和状态目录，以后台进程启动 `serve --recover-dead-owner`，检查带认证的本地接口就绪后返回。无需管理员权限；重复运行会复用已有引擎。关闭启动窗口不会关闭引擎。

脚本可整体复制到任意目录，两个文件应放在一起。可选参数 `-Port 42671` 指定端口；默认由系统选择空闲端口。`-LauncherConfig` 可指定其他 Launcher 生命周期配置。

它不启动 DSH 实例，不修改开机自启，不删除会话或锁文件，也不自动回收尚未确认退出的 DSH 运行。提示“会话未回收”时需另外检查上一运行并通过正式恢复流程收尾。启动失败时保留日志路径，日志位于 Maintenance 状态目录的 `logs` 下。

本机旧 `Start-Maintenance-Web` 启动的是另一套旧工具，请使用本脚本启动 Session Maintenance。
