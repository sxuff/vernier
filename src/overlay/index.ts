import { createAnnotationLayer } from "./annotation";
import { measureDelta, measureElement } from "./measure";
import { matchesOverlayHotkey } from "./options";
import { createPicker } from "./picker";
import { createSessionController } from "./session";
import { createOverlayRoot, renderIssueList, renderMeasurementPanel, setButtonEnabled } from "./ui";

export function startVernierOverlay(): void {
  if (document.querySelector("[data-vernier-host]")) {
    return;
  }

  const overlay = createOverlayRoot();
  const host = document.createElement("div");
  host.dataset.vernierHost = "true";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  const shadowRoot = host.attachShadow({ mode: "open" });
  const session = createSessionController(overlay.noteInput);
  const teardownController = new AbortController();
  let selectedIssueId: number | null = null;
  let exportWarningAcknowledged = hasAcknowledgedExportWarning();

  window.addEventListener("pagehide", () => teardownController.abort(), { once: true });
  teardownController.signal.addEventListener("abort", () => host.remove(), { once: true });
  updateControls();
  const annotation = createAnnotationLayer(overlay.root, {
    signal: teardownController.signal,
    getLabel() {
      return overlay.annotationLabelSelect.value || undefined;
    },
    onDraft(measured, measurement) {
      renderMeasurementPanel(overlay.panel, measured);
      session.setAnnotationDraft(measured, measurement);
    }
  });
  const picker = createPicker(overlay.root, {
    signal: teardownController.signal,
    onSelect(element) {
      const measurement = measureElement(element);
      renderMeasurementPanel(overlay.panel, measurement.text);
      session.setMeasurementDraft("single", element, measurement.text, measurement.measurement);
    },
    onCompare(firstElement, secondElement) {
      const measurement = measureDelta(firstElement, secondElement);
      renderMeasurementPanel(overlay.panel, measurement.text);
      session.setMeasurementDraft("delta", secondElement, measurement.text, measurement.measurement);
    }
  });
  shadowRoot.append(overlay.root);
  document.documentElement.append(host);

  overlay.modeSelect.addEventListener("change", () => {
    picker.clear();
    annotation.setMode(overlay.modeSelect.value);
  });

  overlay.addIssueButton.addEventListener("click", () => {
    overlay.status.textContent = "Adding...";
    void session
      .addDraftIssue()
      .then((issue) => {
        if (!issue) {
          overlay.status.textContent = "Select or draw an issue first";
          return;
        }

        annotation.clear();
        picker.clear();
        selectedIssueId = issue.id;
        renderIssueList(overlay.issueList, session.getIssues(), selectedIssueId);
        updateControls();
        overlay.status.textContent = `Added issue ${issue.id}`;
      })
      .catch((error: unknown) => {
        overlay.status.textContent = error instanceof Error ? error.message : "Add failed";
      });
  });

  overlay.issueList.addEventListener("click", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const issueId = Number(target.dataset.vernierIssueId);
    const issue = session.getIssues().find((candidate) => candidate.id === issueId);

    if (!issue) {
      return;
    }

    selectedIssueId = issue.id;
    overlay.noteInput.value = issue.note;
    overlay.annotationLabelSelect.value = issue.measurement.kind === "annotation" ? issue.measurement.label ?? "" : "";
    renderMeasurementPanel(overlay.panel, issue.measured);
    renderIssueList(overlay.issueList, session.getIssues(), selectedIssueId);
    updateControls();
    overlay.status.textContent = `Selected issue ${issue.id}`;
  });

  overlay.saveIssueButton.addEventListener("click", () => {
    if (selectedIssueId === null) {
      overlay.status.textContent = "Select an issue first";
      return;
    }

    const issue = session.updateIssueNote(selectedIssueId, overlay.noteInput.value, overlay.annotationLabelSelect.value);
    overlay.status.textContent = issue ? `Saved issue ${issue.id}` : "Selected issue no longer exists";
  });

  overlay.deleteIssueButton.addEventListener("click", () => {
    if (selectedIssueId === null) {
      overlay.status.textContent = "Select an issue first";
      return;
    }

    session.deleteIssue(selectedIssueId);
    selectedIssueId = null;
    overlay.noteInput.value = "";
    overlay.annotationLabelSelect.value = "";
    renderMeasurementPanel(overlay.panel, "No issue selected");
    renderIssueList(overlay.issueList, session.getIssues(), selectedIssueId);
    updateControls();
    overlay.status.textContent = "Deleted issue";
  });

  overlay.clearIssuesButton.addEventListener("click", () => {
    session.clearIssues();
    selectedIssueId = null;
    annotation.clear();
    picker.clear();
    overlay.noteInput.value = "";
    overlay.annotationLabelSelect.value = "";
    renderMeasurementPanel(overlay.panel, "No queued issues");
    renderIssueList(overlay.issueList, session.getIssues(), selectedIssueId);
    updateControls();
    overlay.status.textContent = "Cleared issues";
  });

  overlay.exportButton.addEventListener("click", () => {
    if (!exportWarningAcknowledged) {
      exportWarningAcknowledged = true;
      rememberExportWarning();
      overlay.status.textContent = "Vernier will save local screenshots under .ui-feedback. Review sensitive data before committing.";
      overlay.exportButton.textContent = "Export anyway";
      return;
    }

    overlay.status.textContent = "Exporting...";
    void session
      .exportSession()
      .then(() => {
        overlay.status.textContent = "Exported";
        overlay.exportButton.textContent = "Export";
      })
      .catch((error: unknown) => {
        overlay.status.textContent = error instanceof Error ? error.message : "Export failed";
      });
  });

  overlay.copyPromptButton.addEventListener("click", () => {
    copyText(session.createAgentPrompt(), "Copied prompt");
  });

  overlay.copyMarkdownButton.addEventListener("click", () => {
    copyText(session.createMarkdownPreview(), "Copied markdown");
  });

  function setActive(isActive: boolean): void {
    overlay.root.hidden = !isActive;
    overlay.root.dataset.vernierActive = String(isActive);

    if (!isActive) {
      picker.clear();
      annotation.clear();
    }
  }

  function toggle(): void {
    setActive(overlay.root.hidden);
  }

  window.addEventListener("keydown", (event) => {
    if (!matchesOverlayHotkey(event)) {
      return;
    }

    event.preventDefault();
    toggle();
  }, { signal: teardownController.signal });

  console.info("[vernier] active");

  function updateControls(): void {
    const hasSelectedIssue = selectedIssueId !== null;
    const hasIssues = session.getIssues().length > 0;

    setButtonEnabled(overlay.saveIssueButton, hasSelectedIssue);
    setButtonEnabled(overlay.deleteIssueButton, hasSelectedIssue);
    setButtonEnabled(overlay.clearIssuesButton, hasIssues);
    setButtonEnabled(overlay.exportButton, hasIssues);
    setButtonEnabled(overlay.copyPromptButton, hasIssues);
    setButtonEnabled(overlay.copyMarkdownButton, hasIssues);
  }

  function copyText(text: string, successMessage: string): void {
    if (session.getIssues().length === 0) {
      overlay.status.textContent = "Add an issue before copying";
      return;
    }

    if (navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          overlay.copyFallback.hidden = true;
          overlay.status.textContent = successMessage;
        })
        .catch(() => {
          showCopyFallback(text);
        });
      return;
    }

    showCopyFallback(text);
  }

  function showCopyFallback(text: string): void {
    overlay.copyFallback.hidden = false;
    overlay.copyFallback.value = text;
    overlay.copyFallback.focus();
    overlay.copyFallback.select();
    overlay.status.textContent = "Copy from selected text";
  }

  function hasAcknowledgedExportWarning(): boolean {
    try {
      return window.localStorage.getItem("vernierExportWarningAcknowledged") === "true";
    } catch {
      return false;
    }
  }

  function rememberExportWarning(): void {
    try {
      window.localStorage.setItem("vernierExportWarningAcknowledged", "true");
    } catch {
      // Non-persistent contexts still get the in-memory acknowledgement.
    }
  }
}
