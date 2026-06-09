import { createAnnotationLayer } from "./annotation";
import { measureDelta, measureElement } from "./measure";
import { createPicker } from "./picker";
import { createSessionController } from "./session";
import { createOverlayRoot, renderIssueList, renderMeasurementPanel, setButtonEnabled } from "./ui";

export function startVernierOverlay(): void {
  if (document.querySelector("[data-vernier-root]")) {
    return;
  }

  const overlay = createOverlayRoot();
  const session = createSessionController(overlay.noteInput);
  let selectedIssueId: number | null = null;

  updateControls();
  const annotation = createAnnotationLayer(overlay.root, {
    getLabel() {
      return overlay.annotationLabelSelect.value || undefined;
    },
    onDraft(measured, measurement) {
      renderMeasurementPanel(overlay.panel, measured);
      session.setAnnotationDraft(measured, measurement);
    }
  });
  const picker = createPicker(overlay.root, {
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
  document.documentElement.append(overlay.root);

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
    overlay.status.textContent = "Exporting...";
    void session
      .exportSession()
      .then(() => {
        overlay.status.textContent = "Exported";
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
    const pressedToggle = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f";

    if (!pressedToggle) {
      return;
    }

    event.preventDefault();
    toggle();
  });

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
}
