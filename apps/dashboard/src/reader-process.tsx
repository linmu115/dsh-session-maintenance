import { useEffect, useRef, useState } from "react";
import type { ReaderEventPage, ReaderMessage, ReaderProcessItem, ReaderProcessPage, ReaderTurn, SessionReaderApi, SessionReaderPage } from "@linmu/dsh-session-contracts";
import { Badge, Button, LoadingState } from "@linmu/dsh-session-ui";
import { SafeMarkdown } from "./safe-markdown.js";
import "./reader-process.css";

interface Scope { api: SessionReaderApi; logicalSessionId: string; snapshot: string; onReload?: () => void }
function errorText(error: unknown) { return error instanceof Error ? error.message : "暂时无法读取，请重试。"; }

/** An open text page only. Collapsing its parent unmounts it and cancels transport. */
function EventPages({ scope, eventId, initial }: { scope: Scope; eventId: string; initial?: ReaderMessage }) {
  const [format, setFormat] = useState<"text" | "raw">("text");
  const [offset, setOffset] = useState(0), [previous, setPrevious] = useState<number[]>([]), [retry, setRetry] = useState(0);
  const [page, setPage] = useState<ReaderEventPage | undefined>(initial ? { schemaVersion: 1, snapshot: scope.snapshot, eventId, format: "text", text: initial.text, totalChars: initial.totalChars, nextOffset: initial.nextOffset, offset: 0 } : undefined);
  const [error, setError] = useState<string>(), [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setError(undefined);
    if (initial && offset === 0 && format === "text") {
      setPage({ schemaVersion: 1, snapshot: scope.snapshot, eventId, format, text: initial.text, totalChars: initial.totalChars, nextOffset: initial.nextOffset, offset: 0 }); setLoading(false); return () => controller.abort();
    }
    setPage(undefined); setLoading(true);
    void scope.api.getSessionReaderEvent(scope.logicalSessionId, eventId, { snapshot: scope.snapshot, format, offset }, controller.signal).then(
      value => { if (!controller.signal.aborted) { setPage(value); setLoading(false); } },
      reason => { if (!controller.signal.aborted) { setError(errorText(reason)); setLoading(false); } });
    return () => controller.abort();
  }, [scope.api, scope.logicalSessionId, scope.snapshot, eventId, offset, format, initial, retry]);
  const changeFormat = () => { setOffset(0); setPrevious([]); setFormat(value => value === "text" ? "raw" : "text"); };
  return <div className="reader-event-pages">
    {!initial ? <Button onClick={changeFormat}>{format === "text" ? "查看原始记录" : "查看可读内容"}</Button> : null}
    {loading ? <LoadingState label="正在读取这一段…" /> : null}
    {error ? <p role="alert">{error} <Button onClick={() => setRetry(value => value + 1)}>重试</Button>{scope.onReload ? <Button onClick={scope.onReload}>重新加载会话</Button> : null}</p> : null}
    {page ? <>{page.format === "raw" ? <pre className="reader-raw"><code>{page.text}</code></pre> : <SafeMarkdown>{page.text}</SafeMarkdown>}
      {page.totalChars > page.text.length || page.offset > 0 ? <p className="muted">第 {page.offset + 1}–{Math.min(page.nextOffset ?? page.totalChars, page.totalChars)} 字，共 {page.totalChars} 字；可逐段读完整记录。</p> : null}
      <div className="reader-page-actions">
        {previous.length ? <Button onClick={() => { setOffset(previous.at(-1)!); setPrevious(value => value.slice(0, -1)); }}>上一段</Button> : null}
        {page.nextOffset !== null ? <Button onClick={() => { setPrevious(value => [...value, offset]); setOffset(page.nextOffset!); }}>继续读取</Button> : null}
      </div></> : null}
  </div>;
}

function ProcessItem({ scope, item }: { scope: Scope; item: ReaderProcessItem }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(0);
  return <li className="reader-process-item">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{item.label}{item.paired ? " · 调用与结果" : ""}</button>
    {open ? <div className="reader-process-body">
      {item.eventIds.length > 1 ? <div className="reader-page-actions">{item.eventIds.map((id, index) => <Button key={id} aria-pressed={selected === index} onClick={() => setSelected(index)}>{index === 0 ? "调用" : `结果 ${index}`}</Button>)}</div> : null}
      <EventPages key={item.eventIds[selected]} scope={scope} eventId={item.eventIds[selected]!} />
    </div> : null}
  </li>;
}

function ProcessDirectory({ scope, turnId }: { scope: Scope; turnId: string }) {
  const [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<Array<string | undefined>>([]), [retry, setRetry] = useState(0);
  const [page, setPage] = useState<ReaderProcessPage>(), [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); setPage(undefined); setError(undefined);
    void scope.api.getSessionReaderProcess(scope.logicalSessionId, { snapshot: scope.snapshot, turnId, ...(cursor === undefined ? {} : { cursor }) }, controller.signal).then(
      value => { if (!controller.signal.aborted) setPage(value); }, reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => controller.abort();
  }, [scope.api, scope.logicalSessionId, scope.snapshot, turnId, cursor, retry]);
  if (error) return <p role="alert">{error} <Button onClick={() => setRetry(value => value + 1)}>重试过程</Button>{scope.onReload ? <Button onClick={scope.onReload}>重新加载会话</Button> : null}</p>;
  if (!page) return <LoadingState label="正在读取过程目录…" />;
  return <><ul className="reader-process-list">{page.items.map(item => <ProcessItem key={`${cursor ?? ""}:${item.id}`} scope={scope} item={item} />)}</ul>
    <div className="reader-page-actions">{previous.length ? <Button onClick={() => { setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }}>上一页过程</Button> : null}
      {page.nextCursor !== null ? <Button onClick={() => { setPrevious(value => [...value, cursor]); setCursor(page.nextCursor!); }}>下一页过程</Button> : null}</div></>;
}

export function ReaderTurnView({ api, logicalSessionId, snapshot, turn, onReload }: Scope & { turn: ReaderTurn }) {
  const [open, setOpen] = useState(false);
  const scope = { api, logicalSessionId, snapshot, ...(onReload ? { onReload } : {}) };
  const calls = turn.processKinds.find(item => item.kind === "tool-call")?.count ?? 0;
  const user = turn.messages.filter(message => message.role === "user"), answers = turn.messages.filter(message => message.role === "assistant");
  const message = (value: ReaderMessage) => <article key={value.eventId} className="canonical-event reader-message" data-role={value.role}><header><Badge>{value.role === "user" ? "你" : "助手"}</Badge></header><EventPages scope={scope} eventId={value.eventId} initial={value} /></article>;
  return <section className="reader-turn" aria-label={`第 ${turn.ordinal} 轮`}>
    {user.map(message)}
    {turn.processCount > 0 ? <div className="reader-process"><button className="reader-process-toggle" type="button" aria-expanded={open} title={`${turn.processCount} 条过程记录`} onClick={() => setOpen(value => !value)}>本轮过程（{calls ? `${calls} 次工具调用` : `${turn.processCount} 条记录`}）<span>{turn.processKinds.filter(item => item.kind !== "tool-call" && item.kind !== "tool-result").map(item => `${item.label} ${item.count}`).join(" · ")}</span></button>
      {open ? <ProcessDirectory scope={scope} turnId={turn.id} /> : null}</div> : null}
    {answers.map(message)}
  </section>;
}

export function ReaderTranscript({ api, logicalSessionId, initial, onReload }: { api: SessionReaderApi; logicalSessionId: string; initial: SessionReaderPage; onReload: () => void }) {
  const [page, setPage] = useState(initial), [current, setCurrent] = useState<string>(), [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), [logicalSessionId, initial.snapshot]);
  const load = (cursor: string | undefined, backwards: boolean) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError(undefined);
    void api.getSessionReader(logicalSessionId, { snapshot: initial.snapshot, ...(cursor === undefined ? {} : { cursor }) }, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setPrevious(history => backwards ? history.slice(0, -1) : [...history, current]); setCurrent(cursor); setPage(value); setLoading(false);
    }, reason => { if (!controller.signal.aborted) { setError(errorText(reason)); setLoading(false); } });
  };
  return <div className="reader-transcript" data-reader-api="paged">
    {error ? <p role="alert">{error} <Button onClick={onReload}>重新加载会话</Button></p> : null}
    {loading ? <LoadingState label="正在读取下一页问答…" /> : page.turns.map(turn => <ReaderTurnView key={`${page.snapshot}:${turn.id}`} api={api} logicalSessionId={logicalSessionId} snapshot={page.snapshot} turn={turn} onReload={onReload} />)}
    {!page.turns.length ? <p className="muted">还没有已保存的会话内容。</p> : null}
    <div className="reader-page-actions">{previous.length ? <Button disabled={loading} onClick={() => load(previous.at(-1), true)}>上一页问答</Button> : null}
      {page.nextCursor !== null ? <Button disabled={loading} onClick={() => load(page.nextCursor!, false)}>下一页问答</Button> : null}</div>
  </div>;
}
