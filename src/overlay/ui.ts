export interface OverlayRoot {
  root: HTMLDivElement;
  toolbar: HTMLDivElement;
  panel: HTMLDivElement;
  panelContent: HTMLPreElement;
  noteInput: HTMLTextAreaElement;
  exportButton: HTMLButtonElement;
  status: HTMLDivElement;
}

export function createOverlayRoot(): OverlayRoot {
  const root = document.createElement("div");
  root.dataset.vernierRoot = "true";
  root.hidden = true;
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "2147483647";
  root.style.pointerEvents = "none";

  const toolbar = document.createElement("div");
  toolbar.dataset.vernierToolbar = "true";
  toolbar.style.position = "fixed";
  toolbar.style.top = "16px";
  toolbar.style.right = "16px";
  toolbar.style.display = "flex";
  toolbar.style.alignItems = "center";
  toolbar.style.gap = "8px";
  toolbar.style.padding = "8px 10px";
  toolbar.style.border = "1px solid rgba(23, 32, 51, 0.16)";
  toolbar.style.borderRadius = "8px";
  toolbar.style.background = "#ffffff";
  toolbar.style.color = "#172033";
  toolbar.style.boxShadow = "0 12px 32px rgba(23, 32, 51, 0.18)";
  toolbar.style.font = "600 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  toolbar.style.pointerEvents = "auto";

  const indicator = document.createElement("span");
  indicator.dataset.vernierIndicator = "true";
  indicator.style.width = "8px";
  indicator.style.height = "8px";
  indicator.style.borderRadius = "999px";
  indicator.style.background = "#18a058";

  const label = document.createElement("span");
  label.textContent = "Vernier active";

  const panel = document.createElement("div");
  panel.dataset.vernierPanel = "true";
  panel.hidden = true;
  panel.style.position = "fixed";
  panel.style.top = "60px";
  panel.style.right = "16px";
  panel.style.width = "320px";
  panel.style.maxHeight = "calc(100vh - 76px)";
  panel.style.overflow = "auto";
  panel.style.padding = "12px";
  panel.style.border = "1px solid rgba(23, 32, 51, 0.16)";
  panel.style.borderRadius = "8px";
  panel.style.background = "#ffffff";
  panel.style.color = "#172033";
  panel.style.boxShadow = "0 12px 32px rgba(23, 32, 51, 0.18)";
  panel.style.font = "12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace";
  panel.style.pointerEvents = "auto";

  const panelContent = document.createElement("pre");
  panelContent.dataset.vernierPanelContent = "true";
  panelContent.style.margin = "0 0 12px";
  panelContent.style.whiteSpace = "pre-wrap";

  const noteInput = document.createElement("textarea");
  noteInput.dataset.vernierNote = "true";
  noteInput.placeholder = "Note";
  noteInput.rows = 3;
  noteInput.style.width = "100%";
  noteInput.style.margin = "0 0 8px";
  noteInput.style.resize = "vertical";

  const exportButton = document.createElement("button");
  exportButton.dataset.vernierExport = "true";
  exportButton.type = "button";
  exportButton.textContent = "Export";
  exportButton.style.width = "100%";
  exportButton.style.padding = "8px 10px";
  exportButton.style.border = "1px solid rgba(23, 32, 51, 0.2)";
  exportButton.style.borderRadius = "6px";
  exportButton.style.background = "#172033";
  exportButton.style.color = "#ffffff";
  exportButton.style.font = "600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const status = document.createElement("div");
  status.dataset.vernierStatus = "true";
  status.style.marginTop = "8px";
  status.style.color = "#5a667a";

  panel.append(panelContent, noteInput, exportButton, status);
  toolbar.append(indicator, label);
  root.append(toolbar, panel);

  return { root, toolbar, panel, panelContent, noteInput, exportButton, status };
}

export function renderMeasurementPanel(panel: HTMLElement, measurement: string): void {
  panel.hidden = false;
  const content = panel.querySelector("[data-vernier-panel-content]");

  if (content) {
    content.textContent = measurement;
  }
}
