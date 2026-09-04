export const ENTRY_STYLES = `
.dsm-entry-menu{position:fixed;z-index:2147483646;width:260px;padding:6px;border:1px solid var(--dsw-alias-border-l2,#d7dee8);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 14px 38px #0f172a2e;display:grid;gap:2px}
.dsm-entry-menu button{border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#172033);padding:8px 10px;text-align:left;cursor:pointer;font:13px system-ui}.dsm-entry-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef4fb)}
.dsm-settings-section{display:flex;flex-direction:column;gap:16px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary,#172033);font:13px/1.5 system-ui}
.dsm-settings-intro{margin:0;padding:0 2px;color:var(--dsw-alias-label-tertiary,#64748b)}
.dsm-settings-group{display:flex;flex-direction:column;padding:20px;border:1px solid var(--dsw-alias-border-l2,#d7dee8);border-radius:16px;background:var(--dsw-alias-bg-layer-3,#fff)}
.dsm-settings-group h3{margin:0;padding:0 2px 10px;font-size:13px;line-height:20px;font-weight:600}
.dsm-settings-field,.dsm-settings-toggle{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:52px;padding:10px 2px;border-top:1px solid var(--dsw-alias-border-l1,#e7ebf0)}
.dsm-settings-field>span,.dsm-settings-toggle>span{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}.dsm-settings-field strong,.dsm-settings-toggle strong{font-weight:500}.dsm-settings-field small,.dsm-settings-toggle small{color:var(--dsw-alias-label-tertiary,#64748b);font-size:12px}
.dsm-settings-field input,.dsm-settings-field select{box-sizing:border-box;width:min(270px,45%);min-height:34px;border:1px solid var(--dsw-alias-border-l2,#cbd5e1);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;padding:6px 9px;font:inherit}
.dsm-settings-toggle{justify-content:flex-start}.dsm-settings-toggle>input{flex:none;width:16px;height:16px;accent-color:var(--dsw-alias-button-primary-fill,#2563eb)}
.dsm-settings-actions{display:flex;flex-wrap:wrap;gap:8px}.dsm-settings-actions button{min-height:34px;border:1px solid var(--dsw-alias-border-l2,#d7dee8);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;padding:7px 12px;font:inherit;cursor:pointer}.dsm-settings-actions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eef4fb)}.dsm-settings-actions button:disabled{opacity:.48;cursor:not-allowed}.dsm-settings-actions .dsm-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#2563eb);color:var(--dsw-alias-button-primary-label,#fff)}
.dsm-settings-feedback{display:block;margin-top:12px;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);color:var(--dsw-alias-label-secondary,#475569)}
.dsm-other-row{display:flex;padding:4px 0}.dsm-other-card{max-width:min(720px,100%);border:1px solid var(--dsw-alias-border-l2,#d7dee8);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);color:var(--dsw-alias-label-secondary,#475569);padding:8px 11px;font:12px/1.5 system-ui}.dsm-other-card summary{display:list-item;cursor:pointer;color:var(--dsw-alias-label-primary,#172033);font-weight:500;user-select:none}.dsm-other-card p{margin:8px 0 3px}.dsm-other-card ul{margin:7px 0 0;padding-left:20px}.dsm-other-card li{margin:4px 0}.dsm-other-card li span{margin-right:8px}.dsm-other-card small{color:var(--dsw-alias-label-tertiary,#64748b)}.dsm-other-badge{display:inline-block;margin-right:8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,#e8eef7);padding:1px 7px;font-size:11px;font-weight:600}
@media(max-width:680px){.dsm-settings-field{align-items:stretch;flex-direction:column;gap:7px}.dsm-settings-field input,.dsm-settings-field select{width:100%}}
`;

export function installStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.dshSessionMaintenance = "";
  style.textContent = ENTRY_STYLES;
  document.head.appendChild(style);
  return () => style.remove();
}
