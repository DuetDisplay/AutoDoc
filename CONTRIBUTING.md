# Contributing to AutoDoc

Thanks for your interest in improving AutoDoc! This project is local-first,
privacy-focused, and built for macOS and Windows. Contributions of all kinds
are welcome — bug reports, features, docs, and fixes.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/DuetDisplay/AutoDoc/issues/new?template=bug.md).
- **Request a feature** — open a [feature request](https://github.com/DuetDisplay/AutoDoc/issues/new?template=feature.md).
- **Improve docs** — typos, clarifications, and examples are always welcome.
- **Submit code** — see the workflow below.

The current [roadmap](ROADMAP.md) lists shipped behavior separately from ideas
that are not commitments.

### Performance reports

A useful local-processing report includes:

- operating system and CPU architecture
- AutoDoc version
- CPU, GPU, and RAM
- notes model and processing profile, if shown
- input duration
- transcription time and notes time, reported separately
- whether the run was cold (first model use) or warm
- the error text, with paths and meeting content removed

Do not attach a real meeting recording to a public issue. Use a synthetic
meeting, or describe the failure without the audio, transcript, or notes.

## Development setup

**Prerequisites**

- macOS 14+ on Apple Silicon or Windows 10+ on x64
- Node.js 20+
- [Ollama](https://ollama.com) and `ffmpeg` are managed by the app at runtime;
  no manual setup needed for normal development.

**Getting started**

```bash
git clone https://github.com/DuetDisplay/AutoDoc.git
cd AutoDoc
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

## Release announcements

For each public release, add `release-notes/vX.Y.Z.md` to the release PR and
bump the version in `package.json`. Start the notes with a short summary; the
README teaser uses the first sentence and is limited to 16 words and fewer
than 120 characters. The **Prepare release README** workflow generates the
announcement on the release branch using the same script as the post-release
sync. The announcement is reviewed with the release PR.

The release workflow uses that file as the GitHub release body when it creates
a release. When a release already exists, its notes are left intact. Keep the
file and any manually created release notes in sync to avoid a follow-up README
PR. The release publisher uses the file from the validated release commit.

The preparation workflow only handles same-repository PRs that increase the
package version and contain the corresponding notes file. It executes scripts
from the trusted base branch and writes only `README.md` to the release branch.
Configure `RELEASE_DOCS_TOKEN` with Contents write access for the bot commit to
trigger normal PR checks; without it, GitHub's default token may not trigger
those checks, and they may need to be run separately.

The **Update README Release** workflow remains a fallback for releases
published or edited outside this process. It reads the latest published stable
release and opens a PR when its announcement differs. A newer prepared README
announcement is retained until that release is published. Drafts and
prereleases do not update it. Both workflows preserve the surrounding README
and use `/releases/latest` for download and release-note links.

Only the text between `latest-release:start` and `latest-release:end` in
`README.md` is managed by the release announcement scripts. Keep feature
descriptions, requirements, known issues, the changelog date, and the website
consistent with each release. To run the sync locally with a release API
response:

```bash
node scripts/sync-readme-release.mjs --release-json /path/to/release.json
npm run test:readme-release-links
```

## Reporting security issues

Please **do not** file public issues for vulnerabilities. Follow
[`SECURITY.md`](SECURITY.md) instead.

## Questions

Open a [discussion or issue](https://github.com/DuetDisplay/AutoDoc/issues),
or email **team@getautodoc.com**.
