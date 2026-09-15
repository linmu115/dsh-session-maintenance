import type { NativeContextState } from "@linmu/dsh-session-contracts";
import { Badge } from "@linmu/dsh-session-ui";

const materialStates = { retained: "实际保留", "release-pending": "等待释放", released: "已释放", unavailable: "来源不可用" };
const operationStates = { applied: "已生效", "pending-next-step": "等待下一次原生请求", failed: "未生效", unsupported: "当前执行方式不支持" };

/** The extension panel reads the shared durable state; it does not invent live surface success. */
export function NativeContextDetail({ state, onOpenSession }: { state: NativeContextState; onOpenSession(id: string): void }) {
  return <section className="native-context-detail" aria-label="原生上下文使用状态">
    <p>窗口和材料归当前接收会话；历史读取记录仍附属对应主干图。请在该会话的思维图中调整窗口、暂停来源或固定材料。</p>
    {state.sources.map(source => {
      const materials = state.materials.filter(material => material.referenceIds.includes(source.referenceId));
      return <details key={source.referenceId} className="native-context-source"><summary>{source.title || "上下文来源"} · {source.enabled ? "启用" : "暂停"} · {source.authorityState === "revoked" ? "已解除" : source.authorityState === "unavailable" ? "不可用" : source.authorityState === "pending" ? "待发送" : "已授权"}</summary>
        <div className="native-context-layers">
          <section><h4>固定授权上限</h4><p><button className="native-context-session-link" onClick={() => onOpenSession(source.sourceSessionId)}>打开来源会话</button></p><dl><dt>来源版本</dt><dd><code>{source.sourceVersionId}</code></dd><dt>截至完整回复</dt><dd><code>{source.cutoffEventId}</code></dd></dl></section>
          <section><h4>当前披露窗口</h4>{source.window === null ? <p>整个已授权范围，仍按需读取。</p> : source.window.length === 0 ? <p>空窗口，不新增来源正文。</p> : <ul>{source.window.map((range, index) => <li key={index}><code>{range.startEventId}</code> 至 <code>{range.endEventId}</code></li>)}</ul>}<p className="muted">扩大窗口不自动读取全文，缩窗释放以材料回执为准。</p></section>
          <section><h4>实际保留材料</h4>{materials.length === 0 ? <p>尚未登记材料。</p> : <ul>{materials.map(material => <li key={material.materialId}><Badge>{materialStates[material.state]}</Badge> {material.bytes} 字节{material.pinnedByUser ? " · 用户固定保留" : ""}{material.pinnedByModel ? " · 模型保留" : ""}{material.referenceIds.length > 1 ? " · 多个引用共同持有" : ""}{material.releasedReferenceIds.includes(source.referenceId) && material.state === "retained" ? <p>此引用已放弃持有，材料仍由其它引用保留。</p> : null}<details><summary>材料位置</summary>{material.ranges.filter(range => range.referenceId === source.referenceId).map((range, index) => <p key={index}><code>{range.eventId}</code> [{range.start}, {range.end})</p>)}</details></li>)}</ul>}<p className="muted">字节量不等于精确 token 数；已释放不抹去历史已读覆盖，也不返还累计读取额度。</p></section>
        </div>
      </details>;
    })}
    {state.sources.length === 0 ? <p>当前没有已登记的上下文来源。</p> : null}
    <details><summary>操作和实际生效记录 · {state.operations.length}</summary><ul>{state.operations.slice().reverse().map(operation => <li key={operation.operationId}><Badge>{operationStates[operation.state]}</Badge> {operation.actor === "model" ? "模型" : operation.actor === "user" ? "用户" : "运行环境"} · {operation.action}<p>{operation.reason}</p><small>{operation.createdAt}</small>{operation.surfaceEventSeqs?.length ? <p>生效记录：{operation.surfaceEventSeqs.join("、")}</p> : null}</li>)}</ul></details>
    {state.trimmedMaterials > 0 || state.trimmedOperations > 0 ? <p className="muted">早期轻量记录已按容量限制裁剪，原始会话仍由会话真源管理。</p> : null}
  </section>;
}
