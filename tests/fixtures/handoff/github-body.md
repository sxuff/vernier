## Vernier UI Feedback

- Vernier issue ID: i-golden1
- Original issue number: 1
- Status: todo
- Route: /pricing
- URL: http://127.0.0.1:5173/pricing
- Viewport: 1440x900 @1x
- Type: single

## User Note

Button should align with the pricing card CTA.

## Target

- Selector: `[data-testid="checkout-button"]`
- Fallback selector: main > section:nth-of-type(2) > button
- Nearest landmark: main
- Selector confidence: high (unique data-testid)
- Source: src/components/CheckoutButton.tsx:42
- Source confidence: high
- Source resolver: data-vernier-source
- Component: CheckoutButton
- Element context: button data-testid=checkout-button id=checkout-button role=button name=Upgrade now text=Upgrade now

## Evidence

- Selector: [data-testid="checkout-button"]
- Source: src/components/CheckoutButton.tsx:42
- Bbox: x=120, y=240, w=180, h=44
- Styles:
-   padding: 12px 16px
-   background-color: #1f6feb
- Auto-redacted elements: 1
- Manual redaction: no
- Screenshot: `.ui-feedback/latest/screenshots/issue-i-golden1.png`

<details>
<summary>Structured measurement JSON</summary>

```json
{
  "kind": "single",
  "bbox": {
    "x": 120,
    "y": 240,
    "width": 180,
    "height": 44,
    "top": 240,
    "right": 300,
    "bottom": 284,
    "left": 120
  },
  "computedStyle": {
    "padding": "12px 16px",
    "background-color": "#1f6feb",
    "color": "#ffffff",
    "font-size": "16px"
  },
  "text": "Upgrade now",
  "role": "button",
  "accessibleName": "Upgrade now",
  "inlineStyle": {},
  "authoredHints": [
    {
      "selector": ".btn-primary",
      "property": "background-color",
      "value": "var(--color-primary)",
      "source": "src/styles/buttons.css"
    }
  ],
  "classHints": [
    "btn-primary",
    "px-4"
  ],
  "designTokenHints": [
    {
      "property": "background-color",
      "computed": "#1f6feb",
      "token": "--color-primary",
      "value": "#1f6feb",
      "distance": 0
    }
  ]
}
```

</details>

## Reproduction

1. Open `http://127.0.0.1:5173/pricing`.
2. Set the viewport to 1440x900 @1x.
3. Inspect the selector and screenshot above.

## Verification

- Run: `vernier verify i-golden1 --compare --target <local-app-url>`
- Mark fixed: `vernier mark i-golden1 fixed`
