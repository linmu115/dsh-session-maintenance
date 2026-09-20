import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { registeredInstancePolicySchema } from '@linmu/dsh-session-contracts';
import type { Config } from './config.js';

/** Registration survives provider/Launcher availability; missing runtime metadata is not deregistration. */
export async function assertRegisteredStartup(config: Config, descriptorPath: string | undefined, prepared: boolean): Promise<void> {
  if (prepared) return;
  let required = config.sessionSource === 'maintenance';
  if (descriptorPath) {
    let raw: string | undefined;
    try { raw = await readFile(join(dirname(descriptorPath), 'maintenance-required.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (raw !== undefined) {
      const policy = registeredInstancePolicySchema.parse(JSON.parse(raw));
      required ||= policy.required.some(row => row.instanceId === config.dshInstanceId && row.profileId === config.profileId);
    }
  }
  if (required) throw new Error('此实例已接入 Maintenance，请先启动并确认维护服务就绪，再通过正式生命周期入口启动。');
}
