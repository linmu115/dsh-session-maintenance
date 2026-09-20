import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { engineConnectionDescriptorSchema } from '@linmu/dsh-session-contracts';
import { MaintenanceExternalLifecycleProvider } from './external-lifecycle-provider.js';
import { inspectConfiguredInstance, readStandaloneInstances } from './integrations/standalone.js';

/** CLI mutations use the running Engine's writer and the same authenticated HTTP contract as the dashboard. */
export async function managedInstanceRequest(root: string, path: string, body?: unknown): Promise<unknown> {
  let connection;
  try { connection = engineConnectionDescriptorSchema.parse(JSON.parse(await readFile(join(root, 'connection.json'), 'utf8'))); }
  catch { throw new Error('请先启动 Maintenance 服务并确认就绪。'); }
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(240_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Maintenance HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

/** No process-name kills or offline fallback: the protocol supplies normal shutdown and crash recovery. */
export async function startStandaloneRuntime(root: string, instanceId: string, profileId: string, write: (text: string) => void): Promise<number> {
  const config = (await readStandaloneInstances(root)).find(item => item.instanceId === instanceId && item.profileId === profileId);
  if (!config) throw new Error('实例尚未登记，请先执行 managed-instance register。');
  const target = await inspectConfiguredInstance(root, config);
  if (target.target.status === 'unsupported' || !target.pluginReady || !target.cliPath) throw new Error(target.target.issues.join(' ') || '实例接入插件尚未就绪。');
  if (config.runtimeVersion === '0.1.5-rc.2') {
    const receipt = JSON.parse(await readFile(join(target.profileRoot!, 'maintenance-runtime-attestation.json'), 'utf8')) as { files: { role: string; path: string }[] };
    const node = receipt.files.find(file => file.role === 'node');
    if (!node || await realpath(node.path) !== await realpath(process.execPath)) throw new Error('CLI 使用的 Node 与宿主验证回执不一致，请使用已验证的 Node 启动。');
  }
  const provider = new MaintenanceExternalLifecycleProvider(root, { requireBinding: true });
  const prepared = await provider.handle({ schemaVersion: 1, phase: 'prepare', instanceId, profileId, runtimeVersion: config.runtimeVersion, web: true, maintenanceRequired: true });
  if (!('enabled' in prepared) || !prepared.enabled || !prepared.handle || !prepared.launch) throw new Error('此实例未完成 Maintenance 注册。');
  const handle = prepared.handle;
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [target.cliPath, ...(prepared.launch.launcherArgs ?? []), '--profile', profileId, ...prepared.launch.args], {
      cwd: config.versionRoot, shell: false, windowsHide: true, detached: true,
      env: { ...process.env, DSH_HOME: config.homeRoot, ...prepared.launch.env }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    await once(child, 'spawn');
  } catch (error) {
    await provider.handle({ schemaVersion: 1, phase: 'abort', handle, reason: 'spawn-failed' });
    throw error;
  }
  // Subscribe before any remote await so an early child exit cannot be lost.
  const exited = once(child, 'exit');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void provider.handle({ schemaVersion: 1, phase: 'beforeStop', handle, runtimeUrl: config.runtimeUrl }).then(result => {
      if ('action' in result && result.action !== 'wait') {
        stopping = false;
        write('正常停止尚未获准；请恢复维护服务后重试。未强制终止实例。\n');
      }
    }).catch(error => { stopping = false; write(`${error instanceof Error ? error.message : error}\n`); });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    try { await provider.handle({ schemaVersion: 1, phase: 'started', handle, processId: child.pid! }); }
    catch (error) { write(`启动进程记录未完成，保留运行并等待正常收尾：${error instanceof Error ? error.message : error}\n`); }
    write(JSON.stringify({ instanceId, profileId, handle, runtimeUrl: config.runtimeUrl, stop: 'managed-instance stop --handle <handle> --runtime-url <origin>' }) + '\n');
    const [exitCode] = await exited as [number | null];
    await provider.handle({ schemaVersion: 1, phase: 'afterExit', handle, exitCode, requestedStop: true, forced: false });
    return exitCode ?? 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
