# Contributing

Thanks for helping improve Vernier.

## Local Setup

```bash
npm install
npm test
npm run verify:m0
```

For browser behavior changes, also run:

```bash
npm run test:proxy
npm run test:e2e
```

## Development Notes

- Keep captured `.ui-feedback/` artifacts out of commits.
- Run `npm run build` after overlay changes so the generated overlay bundle stays current.
- Prefer small changes that preserve existing local-only behavior.
- Include tests for CLI output or exported session shapes when changing agent-facing evidence.
