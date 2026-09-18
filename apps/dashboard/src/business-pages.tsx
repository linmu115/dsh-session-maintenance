import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, LoadingState, Surface } from "@linmu/dsh-session-ui";
import type { BusinessPage, BusinessPageOwner, BusinessPageActionDescriptor, BusinessPageActionRequest, BusinessPageActionReceipt } from "@linmu/dsh-session-contracts";
import "./business-pages.css";
export interface BusinessPagesApi {
  listBusinessPages?(signal?: AbortSignal): Promise<{ pages: BusinessPage[] }>;
  enqueueBusinessPageAction?(input: BusinessPageActionRequest, signal?: AbortSignal): Promise<BusinessPageActionReceipt>;
  getBusinessPageActionReceipt?(owner: BusinessPageOwner, operationId: string, signal?: AbortSignal): Promise<BusinessPageActionReceipt>;
}
const failure = (error: unknown) => error instanceof Error ? error.message : "业务信息页暂不可用";
const pending = (receipt: BusinessPageActionReceipt | undefined) => receipt?.status === "queued" || receipt?.status === "running";
function BusinessAction({ api, page, action }: { api: BusinessPagesApi; page: BusinessPage; action: BusinessPageActionDescriptor }) {
  const [input, setInput] = useState<Record<string, string | boolean | number>>({});
  const [receipt, setReceipt] = useState<BusinessPageActionReceipt>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<BusinessPageActionRequest | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => { const abort = new AbortController(); lifetime.current = abort; return () => abort.abort(); }, []);
  const submit = async () => {
    if (!api.enqueueBusinessPageAction || busy || pending(receipt) || !page.online) return;
    const signal = lifetime.current!.signal;
    setBusy(true); setError(undefined);
    try {
      const values = { ...Object.fromEntries(action.fields.filter(field => field.kind === "boolean").map(field => [field.id, false])), ...input };
      attempt.current ??= { owner: page.owner, operationId: crypto.randomUUID(), actionId: action.id, expectedRevision: action.expectedRevision, input: values };
      const result = await api.enqueueBusinessPageAction(attempt.current, signal);
      if (!signal.aborted) { setReceipt(result); if (!pending(result) && result.status !== "uncertain") attempt.current = undefined; }
    } catch (error) { if (!signal.aborted) setError(failure(error)); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const operationId = receipt?.request.operationId;
  const waiting = pending(receipt);
  useEffect(() => {
    if (!operationId || !waiting || !api.getBusinessPageActionReceipt) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api.getBusinessPageActionReceipt!(page.owner, operationId, abort.signal);
        if (!abort.signal.aborted) { setReceipt(result); if (pending(result)) timer = setTimeout(() => void poll(), 1500); else if (result.status !== "uncertain") attempt.current = undefined; }
      } catch (error) { if (!abort.signal.aborted) setError(failure(error)); }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [api, operationId, waiting, page.owner]);
  return <form className="business-action" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <fieldset disabled={busy || waiting || !page.online}><legend>{action.label}</legend>
      <div className="business-action-fields">{action.fields.map(field => <label className={field.kind === "boolean" ? "business-action-checkbox" : "field"} key={field.id}>
        <span>{field.label}{field.required && field.kind !== "boolean" ? "（必填）" : ""}</span>
        {field.kind === "boolean" ? <input type="checkbox" checked={input[field.id] === true} onChange={event => setInput({ ...input, [field.id]: event.currentTarget.checked })} />
          : field.kind === "select" ? <select required={field.required} value={String(input[field.id] ?? "")} onChange={event => setInput({ ...input, [field.id]: event.currentTarget.value })}><option value="">请选择</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : <input required={field.required} type={field.kind === "integer" ? "number" : "text"} step={field.kind === "integer" ? 1 : undefined} maxLength={2048} value={String(input[field.id] ?? "")} onChange={event => {
            const value = event.currentTarget.value; const next = { ...input }; if (!value) delete next[field.id]; else next[field.id] = field.kind === "integer" ? Number(value) : value; setInput(next);
          }} />}
      </label>)}</div>
      <Button type="submit" disabled={!api.enqueueBusinessPageAction || busy || waiting || !page.online}>{busy ? "正在提交…" : waiting ? "等待提供方回执…" : action.label}</Button>
    </fieldset>
    {error ? <p role="alert" className="inline-error">{error}{attempt.current ? "；再次提交会沿用同一操作编号和原始输入核对回执。" : ""}</p> : null}
    {!page.online && waiting ? <p role="status">提供方离线，执行结果待核验，不会自动转交或重发。</p> : null}
    {receipt ? <p role="status">{receipt.status === "uncertain" ? "执行结果需要核对：" : ""}{receipt.message}</p> : null}
  </form>;
}
export function BusinessPages({ api, renderDirectory, registeredPages, onRefresh }: { api: BusinessPagesApi; renderDirectory(owner: BusinessPageOwner, adapterId: string): ReactNode; registeredPages?: BusinessPage[]; onRefresh?: () => void }) {
  const [pages, setPages] = useState<BusinessPage[]>(); const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0); const [directory, setDirectory] = useState<string>();
  useEffect(() => {
    if (registeredPages) return;
    const abort = new AbortController(); setError(undefined);
    const refresh = () => { if (api.listBusinessPages) void api.listBusinessPages(abort.signal).then(result => { if (!abort.signal.aborted) setPages(result.pages); }, error => { if (!abort.signal.aborted) setError(failure(error)); }); };
    refresh(); const timer = setInterval(refresh, 5000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [api, revision, registeredPages]);
  const visiblePages = registeredPages ?? pages;
  if (!api.listBusinessPages) return null;
  return <div className="page-stack business-pages"><div className="dsm-page-heading"><div><h2>插件信息与接入</h2><p>查看本栏目的插件接入状态，并在对应实例下管理绑定与业务操作。</p></div><Button onClick={() => onRefresh ? onRefresh() : setRevision(value => value + 1)}>刷新信息页</Button></div>
    {error ? <p role="alert" className="inline-error">{error}</p> : !visiblePages ? <LoadingState label="正在读取插件信息页…" /> : visiblePages.length === 0 ? <p className="muted">本栏目尚未注册插件信息页。</p> : null}
    {visiblePages?.map(page => {
      const pageKey = JSON.stringify(page.owner);
      return <Surface key={pageKey} title={page.snapshot.title}><div className="business-page-body"><div className="business-page-owner"><span>{page.owner.instanceId} · {page.owner.profileId}</span><Badge tone={page.online ? "success" : "neutral"}>{page.online ? "提供方在线" : "提供方离线，保留最后信息"}</Badge></div>
        {page.snapshot.sections.map(section => <section className="business-page-section" key={section.id}><h3>{section.title}</h3>
          {section.kind === "summary" ? <p>{section.text}</p> : section.kind === "status" ? <p><Badge tone={section.state === "ready" ? "success" : section.state === "warning" ? "warning" : "neutral"}>{section.label}</Badge></p>
            : section.kind === "key-values" ? <dl className="business-page-values">{section.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
            : section.kind === "data-directory" ? <><button className="dsm-button" type="button" aria-expanded={directory === `${pageKey}:${section.id}`} onClick={() => setDirectory(directory === `${pageKey}:${section.id}` ? undefined : `${pageKey}:${section.id}`)}>{directory === `${pageKey}:${section.id}` ? "收起数据目录" : "查看数据目录"}</button>{directory === `${pageKey}:${section.id}` ? <div className="business-page-directory">{renderDirectory(page.owner, section.adapterId)}</div> : null}</>
            : <div className="business-page-actions">{section.actions.map(action => <BusinessAction key={`${action.id}:${action.expectedRevision}`} api={api} page={page} action={action} />)}</div>}
        </section>)}
      </div></Surface>;
    })}
  </div>;
}
