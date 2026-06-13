# Security Policy

Vernier is local-first developer tooling. It proxies local apps and writes local feedback artifacts under `.ui-feedback/` or the configured output directory.

## Supported Versions

Security fixes target the latest released version.

## Reporting A Vulnerability

Please report security issues privately by opening a GitHub security advisory or contacting the repository owner directly.

Do not include private application screenshots, session exports, API keys, or customer data in public issues.

## Local Data Model

- Screenshots and session JSON are written only to local disk.
- Vernier does not upload screenshots or session data.
- The session endpoint accepts only validated PNG data URLs and safe filenames.
- Session writes are confined to the configured project output directory.
