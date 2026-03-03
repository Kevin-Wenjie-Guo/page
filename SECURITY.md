# Security Policy

## Reporting a Vulnerability

If you discover a security issue in this site, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email the maintainer directly or use GitHub's private vulnerability reporting feature on this repository.

## Scope

This is a static website hosted on GitHub Pages. The attack surface is limited to:

- Content injection via pull requests (mitigated by CODEOWNERS and branch protection)
- Supply-chain attacks on GitHub Actions (mitigated by SHA-pinned actions and Dependabot)
- Client-side issues like clickjacking or XSS (mitigated by security headers)
