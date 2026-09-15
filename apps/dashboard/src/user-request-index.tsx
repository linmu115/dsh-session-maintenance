import { useEffect, useState } from "react";
import type { UserRequestEntry, UserRequestList, UserRequestPage } from "@linmu/dsh-session-contracts";
import { Badge, Button, LoadingState } from "@linmu/dsh-session-ui";
import "./user-request-index.css";

export interface UserRequestIndexApi {
  getUserRequestIndex(id: string, query?: Pick<UserRequestList, "cursor" | "requestId" | "limit" | "maxBytes">, signal?: AbortSignal): Promise<UserRequestPage>;
}
const stateLabels = { pending: "待执行", running: "执行中", completed: "执行已结束", failed: "执行失败", cancelled: "已取消", unknown: "执行状态未知" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "用户请求目录暂时无法读取";

export function UserRequestIndex({ api, logicalSessionId }: { api: UserRequestIndexApi; logicalSessionId: string }) {
  const [open, setOpen] = useState(false);
  return <section className="user-request-index"><button className="reader-process-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>用户请求索引<span>按真实提交定位问答</span></button>{open ? <RequestPage key={logicalSessionId} api={api} logicalSessionId={logicalSessionId}/> : null}</section>;
}
function RequestPage({ api, logicalSessionId }: { api: UserRequestIndexApi; logicalSessionId: string }) {
  const [page, setPage] = useState<UserRequestPage>(), [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<Array<string | undefined>>([]), [retry, setRetry] = useState(0), [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); setPage(undefined); setError(undefined);
    void api.getUserRequestIndex(logicalSessionId, { limit: 10, ...(cursor ? { cursor } : {}) }, controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); }, failure => { if (!controller.signal.aborted) setError(errorText(failure)); });
    return () => controller.abort();
  }, [api, logicalSessionId, cursor, retry]);
  return <div className="user-request-index-content"><p className="muted">只索引已保存的用户提交。运行信息、技能目录、引用材料和工具过程不算请求；执行结束不表示需求已经解决。</p>
    {error ? <p role="alert">{error} <Button onClick={() => { setCursor(undefined); setPrevious([]); setRetry(value => value + 1); }}>重新加载索引</Button></p> : null}
    {!page && !error ? <LoadingState label="正在读取用户请求索引…"/> : null}
    {page ? <><ol className="user-request-list">{page.items.map(item => <RequestEntry key={`${page.snapshot}:${item.requestId}`} api={api} logicalSessionId={logicalSessionId} item={item}/>)}</ol>{page.items.length === 0 ? <p>当前版本还没有可索引的用户请求。</p> : null}
      <div className="reader-page-actions">{previous.length ? <Button onClick={() => { setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }}>上一页请求</Button> : null}{page.nextCursor ? <Button onClick={() => { setPrevious(value => [...value, cursor]); setCursor(page.nextCursor!); }}>下一页请求</Button> : null}</div></> : null}
  </div>;
}
function RequestEntry({ api, logicalSessionId, item }: { api: UserRequestIndexApi; logicalSessionId: string; item: UserRequestEntry }) {
  const [text, setText] = useState(item), [cursor, setCursor] = useState<string>(), [error, setError] = useState<string>(), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!cursor) return;
    const controller = new AbortController(); setLoading(true); setError(undefined);
    void api.getUserRequestIndex(logicalSessionId, { requestId: item.requestId, cursor }, controller.signal).then(value => { if (!controller.signal.aborted) { if (value.items[0]) setText(value.items[0]); setLoading(false); } }, failure => { if (!controller.signal.aborted) { setError(errorText(failure)); setLoading(false); } });
    return () => controller.abort();
  }, [api, logicalSessionId, item.requestId, cursor]);
  return <li className="user-request-entry"><header><strong>请求 {item.ordinal}</strong><Badge>{stateLabels[item.state]}</Badge>{item.relation === "supplement" ? <Badge>执行中补充</Badge> : null}{item.sourceTrust !== "verified" ? <Badge tone="warning">来源待核验</Badge> : null}</header>
    <p className="user-request-text">{item.sourceTrust !== "verified" ? "提交来源待核验" : text.text || (item.attachmentRefs.length ? "仅附件请求" : "无文本内容")}</p>
    {item.attachmentRefs.length ? <p className="muted">附件：{item.attachmentRefs.map(value => value.name || value.type).join("、")}{item.attachmentsOmitted ? ` · 另有 ${item.attachmentsOmitted} 项` : ""}</p> : null}
    {text.textOffset > 0 ? <small>当前从第 {text.textOffset + 1} 字开始，共 {text.totalChars} 字。</small> : null}
    {error ? <p role="alert">{error}</p> : null}{text.nextTextCursor ? <Button disabled={loading} onClick={() => setCursor(text.nextTextCursor!)}>继续读取这条长请求</Button> : null}
    <details><summary>对应执行与稳定位置</summary><dl><dt>请求消息</dt><dd><code>{item.eventId}</code></dd><dt>关联执行</dt><dd>{item.executionRefs.length ? item.executionRefs.map(value => value.id).join("、") : "尚未确认"}</dd><dt>关联回复</dt><dd>{item.replyRefs.length ? item.replyRefs.map(value => value.eventId).join("、") : "尚未确认"}</dd><dt>关联状态</dt><dd>{item.associationState === "verified" ? "已核验" : item.associationState === "partial" ? "部分核验" : "未知"}</dd></dl></details>
  </li>;
}
