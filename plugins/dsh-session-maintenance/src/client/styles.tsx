export const ENTRY_STYLES = `
.dsm-entry-launch{position:fixed;right:18px;bottom:18px;z-index:2147483000;border:1px solid #cbd5e1;border-radius:999px;background:#fff;color:#0f172a;padding:8px 12px;box-shadow:0 8px 24px #0f172a22;font:13px system-ui;cursor:pointer}
.dsm-entry-menu{position:fixed;z-index:2147483646;width:260px;padding:6px;border:1px solid #d7dee8;border-radius:10px;background:#fff;box-shadow:0 14px 38px #0f172a2e;display:grid;gap:2px}
.dsm-entry-menu button,.dsm-entry-actions button{border:0;border-radius:7px;background:transparent;color:#172033;padding:8px 10px;text-align:left;cursor:pointer;font:13px system-ui}.dsm-entry-menu button:hover,.dsm-entry-actions button:hover{background:#eef4fb}
.dsm-entry-backdrop{position:fixed;inset:0;z-index:2147483645;background:#0f172a35}.dsm-entry-backdrop[hidden]{display:none}.dsm-entry-panel{position:absolute;right:22px;top:60px;width:min(420px,calc(100vw - 44px));max-height:calc(100vh - 90px);overflow:auto;border:1px solid #d7dee8;border-radius:14px;background:#fff;color:#172033;box-shadow:0 22px 70px #0f172a38;padding:16px;font:13px system-ui}.dsm-entry-panel header{display:flex;justify-content:space-between;align-items:center;font-size:16px}.dsm-entry-panel header button{border:0;background:transparent;font-size:22px}.dsm-entry-fields{display:grid;gap:10px;margin:16px 0}.dsm-entry-fields label{display:grid;gap:5px}.dsm-entry-fields input:not([type=checkbox]),.dsm-entry-fields select{border:1px solid #cbd5e1;border-radius:7px;padding:7px}.dsm-entry-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.dsm-entry-actions button{border:1px solid #d7dee8}.dsm-entry-actions button:disabled{opacity:.45;cursor:not-allowed}.dsm-entry-panel output{display:block;margin-top:12px;padding:9px;border-radius:7px;background:#f6f8fb;color:#475569}
`;

export function installStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.dshSessionMaintenance = "";
  style.textContent = ENTRY_STYLES;
  document.head.appendChild(style);
  return () => style.remove();
}
