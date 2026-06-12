Template: codex

Codex instructions:
- Treat the Vernier issue as concrete UI repair evidence.
- Inspect the existing code before editing.
- Prefer small, local changes and run relevant checks.

Fix the UI issue captured by Vernier.

Vernier issue ID: i-golden1
Original issue number: 1
Status: todo
Target route: /pricing
Captured viewport: 1440x900 @1x
Issue type: single

User note:
Button should align with the pricing card CTA.

Evidence:
- Selector: [data-testid="checkout-button"]
- Source: src/components/CheckoutButton.tsx:42
- Bbox: x=120, y=240, w=180, h=44
- Styles:
-   padding: 12px 16px
-   background-color: #1f6feb
- Structured measurement JSON: {"kind":"single","bbox":{"x":120,"y":240,"width":180,"height":44,"top":240,"right":300,"bottom":284,"left":120},"computedStyle":{"padding":"12px 16px","background-color":"#1f6feb","color":"#ffffff","font-size":"16px"},"text":"Upgrade now","role":"button","accessibleName":"Upgrade now","inlineStyle":{},"authoredHints":[{"selector":".btn-primary","property":"background-color","value":"var(--color-primary)","source":"src/styles/buttons.css"}],"classHints":["btn-primary","px-4"],"designTokenHints":[{"property":"background-color","computed":"#1f6feb","token":"--color-primary","value":"#1f6feb","distance":0}]}
- Auto-redacted elements: 1
- Manual redaction: no
- Selector: [data-testid="checkout-button"]
- Fallback selector: main > section:nth-of-type(2) > button
- Nearest landmark: main
- Selector confidence: high (unique data-testid)
- Source: src/components/CheckoutButton.tsx:42
- Source confidence: high
- Source resolver: data-vernier-source
- Component: CheckoutButton
- Element context: button data-testid=checkout-button id=checkout-button role=button name=Upgrade now text=Upgrade now
- Screenshot: <cwd>/.ui-feedback/latest/screenshots/issue-i-golden1.png

Please inspect the related UI code, make the smallest safe fix, and verify at the captured viewport size.
In your summary, map the code change back to this Vernier issue ID.

Template-specific output:
- List files changed.
- Map each change to the Vernier issue ID.
- Include the check command and result.
