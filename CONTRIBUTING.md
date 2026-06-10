# Contributing to AutoDoc

Thanks for your interest in improving AutoDoc! This project is local-first,
privacy-focused, and macOS-first (Windows coming soon). Contributions of
all kinds are welcome — bug reports, features, docs, and fixes.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/DuetDisplay/AutoDoc-Local/issues/new?template=bug.md).
- **Request a feature** — open a [feature request](https://github.com/DuetDisplay/AutoDoc-Local/issues/new?template=feature.md).
- **Improve docs** — typos, clarifications, and examples are always welcome.
- **Submit code** — see the workflow below.

## Development setup

**Prerequisites**

- macOS 14+ (primary development target)
- Node.js 20+
- [Ollama](https://ollama.com) and `ffmpeg` are managed by the app at runtime;
  no manual setup needed for normal development.

**Getting started**

```bash
git clone https://github.com/DuetDisplay/AutoDoc-Local.git
cd AutoDoc-Local
npm ci
cp .env.example .env   # fill in values as needed; see docs/SELF_HOSTING.md
npm run dev
```

Calendar OAuth and downloadable runtimes require self-hosting config — see
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md). Core features work without them.

## Development workflow

1. **Fork** the repo and create a branch from `main`:
   `git checkout -b fix/short-description`
2. **Make your change** with clear, focused commits.
3. **Keep it green** before pushing:
   ```bash
   npm run lint
   npm run typecheck
   npm run test:run
   ```
4. **Add tests** for new behavior where practical. The suite uses Vitest
   (unit/component) and Playwright (e2e).
5. **Open a Pull Request** against `main` using the PR template. Describe what
   changed and why, and link any related issue.

## Pull request guidelines

- Keep PRs focused and reasonably small — easier to review, faster to merge.
- Match the existing code style (ESLint + Prettier are configured;
  `npm run format` applies Prettier).
- Update docs (`README.md`, `PRODUCT.md`, etc.) when behavior changes.
- All status checks must pass before review.
- By contributing, you agree your contributions are licensed under the project's
  [AGPL-3.0 license](LICENSE).

## Reporting security issues

Please **do not** file public issues for vulnerabilities. Follow
[`SECURITY.md`](SECURITY.md) instead.

## Questions

Open a [discussion or issue](https://github.com/DuetDisplay/AutoDoc-Local/issues),
or email **chris@duetdisplay.com**.
