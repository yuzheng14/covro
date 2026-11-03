# Database compatibility

Application SemVer, DB Schema and backup format are independent. `package.json.covroDatabase` is the release contract. The current release directly reads/writes **Schema 8**, can migrate known schemas **1–8** forward to 8, and defines backup format **1**. Schema 1 maps to migration 0000; Schema 8 maps to 0007. The Drizzle journal's format version is unrelated.

The database stores its ordinal in SQLite `PRAGMA user_version`. Startup checks every applied migration's SHA-256 and timestamp against the packaged migration chain. Legacy databases with user_version 0 are identified only through that chain. SQL, migration history and the public version commit in one transaction. Failed migrations preserve the prior version and data. Unknown tables without a valid journal, contradictory versions and divergent histories are rejected.

A backup from the same schema can be restored when history matches. An older backup needs a complete supported forward migration path; validate this on a temporary copy before replacing live data. A newer schema cannot be opened by an older application. Equal ordinal alone does not prove compatibility. Configuration and backup format must also be valid for the target application.

Downgrading the program while keeping current data requires the target to accept the current schema. Restoring an older backup additionally discards application data written since that backup. There are no automatic reverse migrations. A structural or persisted-data change incompatible with older writers requires a new migration and ordinal, even if the table layout is unchanged.

Add new migrations; never rewrite old migrations. Increment covroDatabase.schemaVersion to the migration count, maintain the minimum restorable version according to tested upgrade paths, and run `node --import tsx scripts/verify-database-contract.ts`. Release notes and npm metadata must report the target tag's contract. Previously published releases without this declaration have no advertised compatibility range; inspect their exact migration chain before attempting a rollback.
