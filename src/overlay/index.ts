import { measureDelta, measureElement } from "./measure";
import { createPicker } from "./picker";
import { createSessionController } from "./session";
import { createOverlayRoot, renderMeasurementPanel } from "./ui";

export function startVernierOverlay(): void {
  if (document.querySelector("[data-vernier-root]")) {
    return;
  }

  const overlay = createOverlayRoot();
  const session = createSessionController(overlay.noteInput);
  const picker = createPicker(overlay.root, {
    onSelect(element) {
      const measurement = measureElement(element);
      renderMeasurementPanel(overlay.panel, measurement);
      session.recordIssue("single", element, measurement);
    },
    onCompare(firstElement, secondElement) {
      const measurement = measureDelta(firstElement, secondElement);
      renderMeasurementPanel(overlay.panel, measurement);
      session.recordIssue("delta", secondElement, measurement);
    }
  });
  document.documentElement.append(overlay.root);

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

  function setActive(isActive: boolean): void {
    overlay.root.hidden = !isActive;
    overlay.root.dataset.vernierActive = String(isActive);

    if (!isActive) {
      picker.clear();
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
}
