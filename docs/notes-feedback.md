# V2 notes feedback

The custom feedback UI is below completed V2 notes. It uses the existing PostHog project and capture key; there is no additional backend, database, or Cloudflare deployment.

- [Dashboard: AutoDoc — V2 Notes](https://us.posthog.com/project/218998/dashboard/2120516)
- [Survey: AutoDoc V2 Notes feedback](https://us.posthog.com/project/218998/surveys/01a0c5be-0a26-0000-e57e-def4047e2196)
- The saved queries and identifiers are in `notes-feedback-dashboard.json`.

## App behavior

Users choose Useful, Somewhat useful, or Not useful, then explicitly send. Detail is optional and limited to 2,000 characters. The payload disclosure is always expanded for both analytics settings. Selection, typing, cancellation and viewing the form do not submit feedback or generate new tracking events.

Sending disables duplicate submissions. The main process validates the request and the sender, reads the actual persisted notes generation, and submits one `survey sent` event. Only a successful PostHog acknowledgement marks it sent. Failures retain the response. A retry sends the identical payload, UUID, survey submission ID and timestamp, including after restart. After an uncertain network result, the original response stays locked to prevent a retry from silently sending different feedback.

The full confirmation stays for the current notes visit with no timer. Switching away and returning shows `✓ Feedback sent`. The receipt persists across restarts. Manual edits and next-step checkbox changes preserve the generated-note identity; regeneration creates a fresh identity even if the content is identical. Historical V2 notes use a local legacy identity and report engine `unknown` rather than guessing.

## Consent and payload

Normal usage analytics still pass through the existing consent-controlled renderer analytics service. Explicit feedback uses a dedicated main-process HTTPS request to the same configured PostHog project, without initializing or opting in the analytics SDK. It never sends analytics or installation identity, meeting IDs, generation IDs, note hashes, titles, notes, transcripts, recordings or logs.

The submitted values are the rating, optional comment, app version, platform and persisted notes engine version. Protocol metadata includes the survey/question IDs, a random submission UUID, timestamp, completion marker and comment-present flag. The UUID identifies one submission, not a person or installation. Person-profile processing and geolocation are disabled. A fixed `0.0.0.0` IP overrides automatic request-IP enrichment; a null IP does not suppress that enrichment. Verified against live ingestion.

Comments exist only in dedicated PostHog survey answer properties; they are not added to the general analytics property allowlist. PostHog project members can read them in the survey and the dashboard comment table. Text may itself contain information users choose to enter, which is why the form asks users to avoid private meeting details. PostHog's configured data retention applies.

Local receipts and pending responses use an encrypted electron-store file (`notes-feedback-receipts.json`) with the existing app encryption key. Pending text is removed after acknowledgement; successful receipts contain only submission ID, timestamp and sent status. No automatic background resend occurs. Encryption initialization remains responsible for checking existing recordings before creating a key.

## Configuration and maintenance

The existing `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` build variables are compiled into both renderer analytics and the main-process explicit feedback transport. An empty key hides the feedback form and disables analytics in both development and packaged builds. Existing release workflows already supply these variables. No new credential or infrastructure is required.

Survey and question IDs live in `src/shared/notes-feedback.ts`. This API survey is the response container for the app's custom UI; it does not launch a PostHog popover. Its dashboard status may be Draft because automatic SDK delivery is not used. HTTP submissions have been verified in its resolved results. If a fork uses another PostHog project, create an equivalent API survey there and replace these IDs.

`NOTES_ENGINE_VERSION` starts at `v2.1`. Bump it when the generation pipeline or prompts change. It is stored when notes are generated and preserved during edits. Existing generation events also report the attempted engine; completions without an observed start remain unknown. Regenerations clear renderer completion deduplication so subsequent attempts are counted.

## Reading the dashboard

All six tiles use a rolling 30-day UTC window. The SQL intentionally defines that window; the dashboard date picker does not override the literal SQL dates.

1. Rating counts include explicit feedback from both analytics settings and deduplicate by the per-submission distinct ID.
2. Engine comparison shows all three ratings, sample sizes, and Useful / all ratings. Nonresponders are not counted as satisfied.
3. Optional comments show the latest 50 responses for manual theme review. No automatic categorization is implied.
4. Outcomes show raw completed, degraded, failed and no-notes events from consented analytics, with historical provenance labelled unknown. This is not an attempt-correlated conversion funnel.
5. Speed shows recorded duration buckets for successful V2 output. Missing durations stay unknown; failures are excluded.
6. Repeat use means an opted-in installation generated V2 notes on at least two distinct UTC days in the window. It is not all-user retention.

Do not divide the all-consent feedback count by consented behavioral events to calculate a response rate. Multiple notes can yield multiple ratings from one person. Interpret small version samples cautiously and review comments alongside changes in usefulness and reliability.

## Verification and cleanup

Unit/integration tests cover consent independence, exact outbound fields, sender/frame validation, local encryption, HTTP failure and acknowledgement handling, retries across service restart, duplicate sends, regeneration, edits, and UI confirmation/revisit behavior. A real-renderer browser check covers the complete visible flow with mocked IPC, independently of the live transport verification.

Live verification used only synthetic submissions tagged by app version `0.0.0-feedback-check-20260921`; this makes `is_test=true`. All feedback dashboard queries exclude that flag. The test manifest is `/private/tmp/notes-feedback-verification.json`. Eight synthetic submissions were created while validating acknowledgements and IP suppression. The final three had no actual IP, location, session or device identity, and all ratings/comments resolved in Surveys.

PostHog's person-deletion API cannot delete profileless events directly. For cleanup only, temporary profiles were created for the eight synthetic submission identities, then their profiles and all associated events were queued for deletion. This does not change the production submission path, which never creates profiles. Check raw event counts for the exact manifest distinct IDs to confirm background deletion, rather than treating dashboard filtering as deletion.

References: [custom survey capture](https://posthog.com/docs/surveys/implementing-custom-surveys), [capture API](https://posthog.com/docs/api/capture), [data deletion](https://posthog.com/docs/privacy/data-storage#data-deletion).
