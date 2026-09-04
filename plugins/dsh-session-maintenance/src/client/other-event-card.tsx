interface ConversationLocation {
  readonly kind: string;
  readonly [key: string]: unknown;
}

interface SessionEventLike {
  readonly type: string;
  readonly seq: number;
  readonly data: unknown;
}

interface ConversationMatch {
  readonly event: SessionEventLike;
  readonly location: ConversationLocation;
}

interface ConversationNodeContext<State> {
  readonly key: string;
  readonly id: string;
  readonly state?: State;
}

export interface MaintenanceOtherCardData {
  readonly label: string;
  readonly summary: string;
  readonly sourceKind: string;
  readonly reason: string;
  readonly evidenceRef: string | null;
  readonly count: number;
  readonly items: readonly MaintenanceOtherCardItem[];
}

export interface MaintenanceOtherCardItem {
  readonly sourceKind: string;
  readonly reason: string;
  readonly label: string;
  readonly summary: string;
  readonly evidenceRef: string | null;
}

interface MaintenanceOtherConversationState extends MaintenanceOtherCardData {
  readonly seq: number;
  readonly sourceLocation: ConversationLocation;
}

interface MaintenanceOtherViewNode {
  readonly key: string;
  readonly kind: "dsh-session-maintenance-other";
  readonly id: string;
  readonly target: "chat";
  readonly anchorSeq: number;
  readonly location: ConversationLocation;
  readonly visibility: "visible";
  readonly data: MaintenanceOtherCardData;
}

interface MaintenanceOtherConversationDefinition {
  readonly kind: "dsh-session-maintenance-other";
  readonly target: "chat";
  match(event: SessionEventLike): { readonly id: string; readonly role: "start" } | null;
  start(context: ConversationNodeContext<MaintenanceOtherConversationState>, match: ConversationMatch): MaintenanceOtherConversationState;
  update(context: ConversationNodeContext<MaintenanceOtherConversationState>): MaintenanceOtherConversationState;
  publication(): "immediate";
  buildViewNode(context: ConversationNodeContext<MaintenanceOtherConversationState>): MaintenanceOtherViewNode | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function cardItem(value: unknown): MaintenanceOtherCardItem | undefined {
  const item = record(value);
  if (
    typeof item?.sourceKind !== "string"
    || typeof item.reason !== "string"
    || typeof item.label !== "string"
    || typeof item.summary !== "string"
    || !(item.evidenceRef === null || typeof item.evidenceRef === "string")
  ) return undefined;
  return {
    sourceKind: item.sourceKind,
    reason: item.reason,
    label: item.label,
    summary: item.summary,
    evidenceRef: item.evidenceRef,
  };
}

/** Decode only the MCSF shape whose Adapter projection is explicitly log-only. */
export function maintenanceOtherEventData(event: SessionEventLike): MaintenanceOtherCardData | undefined {
  if (event.type !== "maintenance/other" || !Number.isSafeInteger(event.seq)) return undefined;
  const data = record(event.data);
  if (data?.presentation !== "tool-card" || data.modelExposure !== "log-only") return undefined;
  const content = record(data.canonicalContent);
  if (
    content?.schemaVersion !== 1
    || content.type !== "other"
    || typeof content.label !== "string"
    || typeof content.summary !== "string"
    || typeof content.sourceKind !== "string"
    || typeof content.reason !== "string"
    || !(content.evidenceRef === null || typeof content.evidenceRef === "string")
  ) return undefined;
  const grouping = record(data.grouping);
  const groupedItems = Array.isArray(grouping?.items)
    ? grouping.items.map(cardItem)
    : [];
  if (groupedItems.some((item) => item === undefined)) return undefined;
  const count = grouping === undefined ? 1 : grouping.count;
  if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) !== groupedItems.length) {
    if (grouping !== undefined) return undefined;
  }
  const items = grouping === undefined
    ? [{
        sourceKind: content.sourceKind,
        reason: content.reason,
        label: content.label,
        summary: content.summary,
        evidenceRef: content.evidenceRef,
      }]
    : groupedItems as MaintenanceOtherCardItem[];
  return {
    label: content.label,
    summary: content.summary,
    sourceKind: content.sourceKind,
    reason: content.reason,
    evidenceRef: content.evidenceRef,
    count: Number(count),
    items,
  };
}

const SESSION_LOCATION: ConversationLocation = Object.freeze({ kind: "session" });

export const maintenanceOtherConversationDefinition: MaintenanceOtherConversationDefinition = {
  kind: "dsh-session-maintenance-other",
  target: "chat",
  match(event) {
    return maintenanceOtherEventData(event) === undefined
      ? null
      : { id: `maintenance-other:${event.seq}`, role: "start" };
  },
  start(_context, match) {
    const data = maintenanceOtherEventData(match.event);
    if (data === undefined) throw new TypeError("Maintenance other card received a non-MCSF event");
    return Object.freeze({ ...data, seq: match.event.seq, sourceLocation: match.location });
  },
  update(context) {
    if (context.state === undefined) throw new TypeError("Maintenance other card state is missing");
    return context.state;
  },
  publication: () => "immediate",
  buildViewNode(context) {
    const state = context.state;
    if (state === undefined) return null;
    return Object.freeze({
      key: context.key,
      kind: "dsh-session-maintenance-other",
      id: context.id,
      target: "chat",
      anchorSeq: state.seq,
      location: SESSION_LOCATION,
      visibility: "visible",
      data: {
        label: state.label,
        summary: state.summary,
        sourceKind: state.sourceKind,
        reason: state.reason,
        evidenceRef: state.evidenceRef,
        count: state.count,
        items: state.items,
      },
    });
  },
};

function nodeData(node: unknown): MaintenanceOtherCardData | undefined {
  const data = record(record(node)?.data);
  if (
    typeof data?.label !== "string"
    || typeof data.summary !== "string"
    || typeof data.sourceKind !== "string"
    || typeof data.reason !== "string"
    || !(data.evidenceRef === null || typeof data.evidenceRef === "string")
    || !Number.isSafeInteger(data.count)
    || !Array.isArray(data.items)
  ) return undefined;
  const items = data.items.map(cardItem);
  if (items.some((item) => item === undefined) || items.length !== data.count) return undefined;
  return {
    label: data.label,
    summary: data.summary,
    sourceKind: data.sourceKind,
    reason: data.reason,
    evidenceRef: data.evidenceRef,
    count: data.count as number,
    items: items as MaintenanceOtherCardItem[],
  };
}

export function MaintenanceOtherNodeView(props: { readonly node: unknown }) {
  const data = nodeData(props.node);
  if (data === undefined) return null;
  return <div className="dsm-other-row">
    <details className="dsm-other-card">
      <summary><span className="dsm-other-badge">维护记录</span>{data.label}</summary>
      <p>{data.summary}</p>
      {data.count === 1
        ? <small>{data.sourceKind}</small>
        : <ul>{data.items.map((item, index) => <li key={`${item.sourceKind}:${index}`}>
            <span>{item.label}</span><small>{item.sourceKind}</small>
          </li>)}</ul>}
    </details>
  </div>;
}

export interface MaintenanceOtherClientContext {
  readonly uiConversation: { readonly events: { register(definition: unknown): () => void } };
  readonly slots: {
    inject(name: string, callback: () => () => void): () => void;
    register(registration: {
      readonly name: "conversation.chat.node";
      readonly key: string;
    }, component: unknown): () => void;
  };
}

export function registerMaintenanceOtherCards(ctx: MaintenanceOtherClientContext): () => void {
  const unregisterDefinition = ctx.uiConversation.events.register(maintenanceOtherConversationDefinition);
  const unregisterSlot = ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "dsh-session-maintenance-other",
  }, MaintenanceOtherNodeView));
  return () => {
    unregisterSlot();
    unregisterDefinition();
  };
}
