import type { ComponentType, ReactNode } from "react";
import { AlertTriangle, ArrowRight, CircleOff, LoaderCircle } from "lucide-react";

export * from "./gitgraph.js";

export type Tone = "neutral" | "success" | "info" | "warning" | "danger";

export function DashboardShell(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly nav: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return <div className="dsm-app-shell">
    <header className="dsm-topbar">
      <div className="dsm-brand">
        <span className="dsm-brand-mark" aria-hidden="true">SM</span>
        <div>
          <h1>{props.title}</h1>
          <p>{props.subtitle}</p>
        </div>
      </div>
      {props.actions === undefined ? null : <div className="dsm-topbar-actions">{props.actions}</div>}
    </header>
    <nav className="dsm-nav" aria-label="主导航">{props.nav}</nav>
    <main className="dsm-workspace">{props.children}</main>
  </div>;
}

export function NavButton(props: {
  readonly active: boolean;
  readonly icon: ComponentType<{ readonly size?: number }>;
  readonly children: ReactNode;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return <button className="dsm-nav-button" data-active={props.active} type="button" onClick={props.onClick}>
    <Icon size={16} />
    <span>{props.children}</span>
  </button>;
}

export function Button(props: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly type?: "button" | "submit";
}) {
  return <button
    className="dsm-button"
    data-tone={props.tone ?? "secondary"}
    type={props.type ?? "button"}
    disabled={props.disabled}
    onClick={props.onClick}
  >{props.children}</button>;
}

export function Surface(props: { readonly title?: string; readonly action?: ReactNode; readonly children: ReactNode }) {
  return <section className="dsm-surface">
    {props.title === undefined ? null : <header className="dsm-surface-header">
      <h2>{props.title}</h2>
      {props.action}
    </header>}
    {props.children}
  </section>;
}

export function LocalTabs(props: {
  readonly value: string;
  readonly tabs: readonly { readonly id: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}) {
  return <div className="dsm-local-tabs" role="tablist">
    {props.tabs.map((tab) => <button
      key={tab.id}
      type="button"
      role="tab"
      aria-selected={props.value === tab.id}
      onClick={() => props.onChange(tab.id)}
    >{tab.label}</button>)}
  </div>;
}

export function Metric(props: { readonly label: string; readonly value: number | string; readonly tone?: Tone }) {
  return <article className="dsm-metric" data-tone={props.tone ?? "neutral"}>
    <strong>{props.value.toLocaleString()}</strong>
    <span>{props.label}</span>
  </article>;
}

export function Badge(props: { readonly tone?: Tone; readonly children: ReactNode }) {
  return <span className="dsm-badge" data-tone={props.tone ?? "neutral"}>{props.children}</span>;
}

export function EmptyState(props: {
  readonly kind?: "empty" | "offline" | "warning";
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  const Icon = props.kind === "offline" ? CircleOff : props.kind === "warning" ? AlertTriangle : ArrowRight;
  return <div className="dsm-empty-state" data-kind={props.kind ?? "empty"}>
    <span className="dsm-empty-icon"><Icon size={20} /></span>
    <h2>{props.title}</h2>
    <p>{props.description}</p>
    {props.action}
  </div>;
}

export function LoadingState(props: { readonly label?: string }) {
  return <div className="dsm-loading" role="status"><LoaderCircle className="dsm-spin" size={18} />{props.label ?? "正在读取摘要…"}</div>;
}

export function statusTone(status: string): Tone {
  if (["equal", "completed", "restored", "compatible", "safe"].includes(status)) return "success";
  if (["source-ahead", "target-ahead", "prepared", "running"].includes(status)) return "info";
  if (["diverged", "rewritten", "paused", "degraded", "review"].includes(status)) return "warning";
  if (["conflict", "restore-failed", "manual-review", "unsupported", "destructive"].includes(status)) return "danger";
  return "neutral";
}
