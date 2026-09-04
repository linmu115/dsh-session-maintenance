import { useEffect, useMemo, useState } from "react";

import type { AdapterDashboardRecord, AdapterExperimentalSelectionResponse, DashboardOverview } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface, statusTone } from "@linmu/dsh-session-ui";

export interface AdapterPageApi {
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  listCanonicalAdapters(signal?: AbortSignal): Promise<readonly AdapterDashboardRecord[]>;
  selectExperimentalAdapter(instanceId: string, adapterId: string, signal?: AbortSignal): Promise<AdapterExperimentalSelectionResponse["selection"]>;
}

export function AdapterPage(props: { readonly api: AdapterPageApi }) {
  const [adapters, setAdapters] = useState<readonly AdapterDashboardRecord[]>();
  const [overview, setOverview] = useState<DashboardOverview>();
  const [instanceId, setInstanceId] = useState<string>();
  const [selection, setSelection] = useState<AdapterExperimentalSelectionResponse["selection"]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([props.api.listCanonicalAdapters(controller.signal), props.api.overview(controller.signal)]).then(([nextAdapters, nextOverview]) => { setAdapters(nextAdapters); setOverview(nextOverview); setInstanceId(nextOverview.instances.find((item) => item.platform === "dsh")?.id); }, (reason: unknown) => setError(reason instanceof Error ? reason.message : "Adapter 页面不可用"));
    return () => controller.abort();
  }, [props.api]);
  const dshInstances = useMemo(() => overview?.instances.filter((item) => item.platform === "dsh") ?? [], [overview]);
  const choose = async (adapterId: string) => {
    if (instanceId === undefined) return;
    setBusy(true); setError(undefined);
    try { setSelection(await props.api.selectExperimentalAdapter(instanceId, adapterId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Adapter 探测失败"); }
    finally { setBusy(false); }
  };
  if (adapters === undefined && error === undefined) return <Surface><LoadingState label="正在读取 Adapter 注册表…" /></Surface>;
  return <>
    <div className="dsm-page-heading"><div><h2>DSH Adapter</h2><p>tested versions 是验证记录，不是安装锁；实验选择仍会执行隔离能力探测。</p></div></div>
    <Surface>
      {dshInstances.length === 0 ? <EmptyState title="没有 DSH 实例" description="先在 Launcher 登记实例，再进行适配器探测。" /> : <label className="field"><span>目标 DSH 实例</span><select value={instanceId} onChange={(event) => setInstanceId(event.target.value)}>{dshInstances.map((instance) => <option key={instance.id} value={instance.id}>{instance.displayName} · {instance.id}</option>)}</select></label>}
      {error === undefined ? null : <p className="inline-error">{error}</p>}
      <div className="adapter-list">{adapters?.map((adapter) => <article key={adapter.manifest.id} data-testid={`adapter-${adapter.manifest.id}`}>
        <div><strong>{adapter.manifest.displayName}</strong><code>{adapter.manifest.id}</code><small>{adapter.sourceLabel}</small></div>
        <div><Badge>{adapter.manifest.packageVersion}</Badge><Badge>{adapter.manifest.declaredDshRange}</Badge>{adapter.manifest.testedDshVersions.map((version) => <Badge key={version} tone="success">已测 {version}</Badge>)}</div>
        <Button disabled={busy || instanceId === undefined || !adapter.enabled} onClick={() => void choose(adapter.manifest.id)}>实验选择并探测</Button>
      </article>)}</div>
      {selection === undefined ? null : <div className="adapter-selection"><Badge tone={statusTone(selection.probe.status)}>{selection.probe.status}</Badge><strong>{selection.manifest.displayName}</strong><span>选择理由：{selection.reason}</span><code>{selection.verificationRunId}</code></div>}
    </Surface>
  </>;
}
