# Hosted storage preparation

The Postgres repository, private Blob adapter, and email/guest auth repository are components for the hosted application. They are not wired to the browser routes yet. The existing local routes and their localhost guard remain unchanged. OAuth consent, the hosted browser adapter, and durable workflow execution are follow-up work.

Provision a Postgres database and a **private** Vercel Blob store. Set `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` through the deployment environment or 1Password. To apply versioned Postgres migrations explicitly, run `bun scripts/hosted-storage.ts migrate`. Application startup does not run migrations.

To prepare a separate local-to-hosted import, first obtain a consistent, frozen copy of the local SQLite database, the asset directory, and, if `COMEX_BUDGET_DB_PATH` was set separately, that budget database. Include the SQLite WAL state when making the snapshot. Run:

```sh
bun scripts/hosted-storage.ts import <sqlite-path> <asset-directory> <batch-id> [budget-sqlite-path]
```

The source files are opened read-only. The same batch may be run again unchanged; reusing its ID for different contents fails. Imported draft ownership stays inaccessible until the separate proof-of-possession and destination-owner handoff is implemented. Imported public editions remain published. The import preserves email/guest/session records and budget reservations; it does not itself authorize access at the hosted origin. Reconcile any running or unknown provider outcomes explicitly; importing never refunds or retries them.

Publication stores page bytes in private Blob objects and exposes them only through the publication repository after the edition is committed. Failed transactions and replaced or withdrawn editions may leave inaccessible private objects; cleanup needs a separate reference-aware maintenance process. A hosted deployment and real private Blob credentials are required to verify the service beyond the local SDK mock.
