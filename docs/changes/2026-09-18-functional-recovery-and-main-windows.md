# 扩展注册恢复与栏目加载 · 2026-09-18

用户要求修复扩展栏目长spinner、GPT/ThoughtDAG栏目缺失与启动顺序问题；与原UI任务协作，后续合并其Dashboard版式提交。

代码证据：扩展连接只初始化一次，失败后服务不发布；所有扩展GET先等待GPT事件索引扫描，故无关栏目和对象请求也被阻塞。修复为先发布实例绑定能力，每次业务调用仍由Engine验证；注册单飞重试，销毁后取消。不重放业务写入。原生上下文每次调用继续校验Adapter配置、版本和作用域。

栏目导航从已登记元数据读取；GPT目录/对象请求才刷新其可重建索引。Dashboard定时重新读取栏目，超时显示可恢复错误，保留已加载页与动作回执；三个已知栏目按GPT兼容插件、Obsidian Bridge、ThoughtDAG命名，Bridge信息标签为Vault绑定。knowledge网络错误返回503/MAINTENANCE_UNAVAILABLE，不伪造成功。

验证：Engine、插件、Dashboard typecheck通过；目录/注册与新增路由测试通过，Dashboard栏目/命名测试通过。合成目录回归10项、业务页2项、重试2项、导航隔离1项、分类4项、页面3项分别检查，非互斥测试组不相加。真实Status确认既有生产boot/run未变。未复现历史创建失败，未停止/重启/激活生产。

依赖隔离：最初workspace链接产生两份branded类型，已给独立树建立本地workspace包链接；未更改原树依赖。插件打包前需要编译dsh-core-extension的受验证host artifact。不能只替换Dashboard：需Engine和Maintenance插件一并更新，依正式停机与指纹流程激活。
