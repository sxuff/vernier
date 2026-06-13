import { vernierOverlayPath } from "./overlay-script";

export function injectVernierOverlay(
  html: string,
  overlayPath = vernierOverlayPath,
): string {
  const scriptTag = `<script type="module" src="${overlayPath}"></script>`;

  if (html.includes(scriptTag)) {
    return html;
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${scriptTag}</body>`);
  }

  return `${html}${scriptTag}`;
}
