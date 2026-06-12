# Vernier Reproduction Packet - i-golden1

## Summary
- Status: todo
- Route: /pricing
- URL: http://127.0.0.1:5173/pricing
- Viewport: 1440x900 @1x
- Issue type: single

## User Note
Button should align with the pricing card CTA.

## Target
- Selector: [data-testid="checkout-button"]
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
- Screenshot: <cwd>/.ui-feedback/latest/screenshots/issue-i-golden1.png

## Verify
- Command: vernier verify i-golden1 --compare
- Mark fixed: vernier mark i-golden1 fixed
- Mark todo: vernier mark i-golden1 todo
