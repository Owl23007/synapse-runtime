# Channel protocol fixtures

These fixtures are versioned contract-test assets for Channel adapters. They
belong in Git because tests and protocol validation depend on them; they are not
documentation-site content.

Each fixture must use `channel-protocol-fixture/v1`, match the channel and
direction encoded by its directory, and use one of the evidence statuses
accepted by `fixtures/channel-protocol-fixture.schema.json`.

Before committing:

1. Replace reusable credentials, signatures, cookies, tokens, and secrets with
   `[REDACTED]`.
2. Replace account, conversation, message, filename, and URL identifiers with
   stable placeholders such as `<user-1>` or `<message-1>`.
3. Keep only purpose-written test content; never commit real user messages.
4. Mark documentation-derived contract seeds as `documented`. Only real,
   reproducible captures may use `tested-*` or `unstable`.
5. Record the source, environment, redactions, conclusion, and limitations.
6. Run `pnpm fixtures:validate`.

The validator provides structural and basic credential checks; it does not
replace manual privacy review.
