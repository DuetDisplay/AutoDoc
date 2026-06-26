# Security Policy

We take the security of AutoDoc and its users seriously. Because AutoDoc handles
sensitive meeting recordings, we appreciate responsible disclosure of any
vulnerabilities.

## Supported versions

AutoDoc is distributed as an auto-updating desktop app. Security fixes are
shipped in the latest release, and we recommend always running the most recent
version.

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately through either channel:

- **Email:** chris@duetdisplay.com
- **GitHub:** open a private [security advisory](https://github.com/DuetDisplay/AutoDoc/security/advisories/new)

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected version(s) and platform.

## What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity rating shortly after.
- Coordinated disclosure: we'll keep you updated on the fix and agree on a
  disclosure timeline. We're happy to credit you unless you prefer to remain
  anonymous.

## Scope

In scope:

- The AutoDoc desktop application (`src/`).
- The calendar OAuth worker (`worker/`).
- Build and release tooling that could affect distributed artifacts.

Out of scope:

- Vulnerabilities in third-party dependencies (please report upstream; let us
  know if AutoDoc is affected).
- Issues requiring physical access to an unlocked machine.

Thank you for helping keep AutoDoc users safe.
