# Investigating an unknown MCP provider step

An unknown outcome means that a provider request may have been dispatched, but Comex cannot establish its result. It is not evidence of failure. Investigate the particular request independently using the provider's own records and the operation's timing before changing its state. If the outcome cannot be established, leave the operation blocked.

These commands are for an operator with access to the intended hosted Postgres database. Set `DATABASE_URL` securely in the environment; do not put credentials in command arguments. The commands neither call a provider nor accept a successful result.

```sh
bun scripts/reconcile-operation.ts inspect <operation-id>
```

The read-only report shows the operation status, whether a worker lease is still active, and each unknown step's semantic kind and reservation state. Step identifiers can contain provider-generated text, so the report replaces their variable part with `<id>` and supplies an opaque `step-…` selector. It does not display owners, prompts, credentials, lease tokens, reservation IDs, or the operation ID. The selector is specific to that operation. A report is a snapshot; the repository checks the state again when resolving it.

Only after independently establishing that a particular provider request **failed**, run the following with the step selector from the report (an exact semantic step ID is also accepted):

```sh
bun scripts/reconcile-operation.ts resolve-failed <operation-id> <step-id> --confirm
```

This records the step as failed, retains its provider reservation as a charged call, and never repeats that step. The repository refuses a live worker, an operation or step in the wrong state, a reservation that is not unknown, a missing dispatch intent, or an operation whose draft no longer matches its owner. Reconciliation locks the comic before the operation, consistent with ownership handoff. When other unknown steps remain, the operation stays blocked. Once all are resolved, its dispatch intent is made pending; the scheduler may resume it, and replay observes the saved failure rather than calling that provider step again. A revoked connection or a changed draft can still stop the resumed operation.

An operation marked unknown with **no unknown paid step** cannot be resolved by this command: there is no evidence tying a failure to a reservation. It stays blocked for separate investigation. Likewise, a missing or inconsistent reservation is not repaired by guessing. This procedure does not offer a way to fabricate a successful provider result or refund a call.

The procedure and recovery paths have isolated database and fake-provider test coverage. A deployed scheduler and real provider outcome have not been verified by those tests.
