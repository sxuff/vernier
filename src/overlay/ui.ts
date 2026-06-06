export interface OverlayRoot {
  root: HTMLDivElement;
  toolbar: HTMLDivElement;
  panel: HTMLDivElement;
  panelContent: HTMLPreElement;
  noteInput: HTMLTextAreaElement;
  modeSelect: HTMLSelectElement;
  addIssueButton: HTMLButtonElement;
  exportButton: HTMLButtonElement;
  issueList: HTMLOListElement;
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
  toolbar.style.zIndex = "3";
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

  const modeSelect = document.createElement("select");
  modeSelect.dataset.vernierMode = "true";
  modeSelect.style.pointerEvents = "auto";
  modeSelect.style.padding = "4px 6px";
  modeSelect.style.borderRadius = "6px";
  modeSelect.style.border = "1px solid rgba(23, 32, 51, 0.18)";

  for (const [value, text] of [
    ["measure", "Measure"],
    ["pen", "Pen"],
    ["box", "Box"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    modeSelect.append(option);
  }

  const panel = document.createElement("div");
  panel.dataset.vernierPanel = "true";
  panel.hidden = true;
  panel.style.position = "fixed";
  panel.style.zIndex = "3";
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

  const addIssueButton = document.createElement("button");
  addIssueButton.dataset.vernierAddIssue = "true";
  addIssueButton.type = "button";
  addIssueButton.textContent = "Add issue";
  addIssueButton.style.width = "100%";
  addIssueButton.style.padding = "8px 10px";
  addIssueButton.style.margin = "0 0 8px";
  addIssueButton.style.border = "1px solid rgba(23, 32, 51, 0.2)";
  addIssueButton.style.borderRadius = "6px";
  addIssueButton.style.background = "#f6f7f9";
  addIssueButton.style.color = "#172033";
  addIssueButton.style.font = "600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

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

  const issueList = document.createElement("ol");
  issueList.dataset.vernierIssueList = "true";
  issueList.style.margin = "0 0 12px 18px";
  issueList.style.padding = "0";
  issueList.style.color = "#5a667a";
  issueList.style.font = "12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const status = document.createElement("div");
  status.dataset.vernierStatus = "true";
  status.style.marginTop = "8px";
  status.style.color = "#5a667a";

  panel.append(panelContent, noteInput, addIssueButton, issueList, exportButton, status);
  toolbar.append(indicator, label, modeSelect);
  root.append(toolbar, panel);

  return { root, toolbar, panel, panelContent, noteInput, modeSelect, addIssueButton, exportButton, issueList, status };
}

export function renderMeasurementPanel(panel: HTMLElement, measurement: string): void {
  panel.hidden = false;
  const content = panel.querySelector("[data-vernier-panel-content]");

  if (content) {
    content.textContent = measurement;
  }
}

export function renderIssueList(list: HTMLElement, issues: Array<{ id: number; kind: string; selector: string }>): void {
  list.textContent = "";

  for (const issue of issues) {
    const item = document.createElement("li");
    item.textContent = `${issue.id}. ${issue.kind} ${issue.selector}`;
    list.append(item);
  }
}
