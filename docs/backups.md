# Backups and recovery

Managed upgrades use the same versioned backup engine as manual snapshots. Before replacing the installation or running candidate migrations, the gateway waits for tasks, approvals and unresolved operations, closes admission, stops the service, obtains its data-directory lock, and creates and verifies a backup. Failure keeps the existing installation and restarts it. A maintenance lock excludes competing backup/update/restore operations.

Backups live on the server under `$COVRO_HOME/backups/<data-directory-key>/<backup-id>/` (default COVRO_HOME: `~/.covro`). Directories use 0700, copied data and configuration use 0600. A completed snapshot contains app.sqlite, config.json and snapshot.json. The manifest records creation time, trigger, application version/commit, schema version, immutable migration hashes, per-file sizes and SHA-256, and the update operation protecting it. SQLite's backup API produces a consistent standalone database including committed WAL data. Configuration saving shares a file lock with snapshot creation; external configuration changes during copying invalidate the snapshot. Completion is published only after config validation, SQLite integrity/foreign-key checks and durable file writes. Record metadata is outside the application database.

| Data                                                                                                                          | Included                       | Recovery                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Covro service configuration                                                                                                   | Yes                            | Restore the saved config at its original path                                                                |
| Projects registered in Covro, preferences, operation/execution records, thread associations and locally observed token totals | Yes, in app.sqlite             | Restore the application database                                                                             |
| Codex conversation bodies and history                                                                                         | No                             | Back up and restore the configured Codex home separately while its writers are stopped                       |
| Codex credentials and external authentication/keychain entries                                                                | No                             | Use the original credential provider or sign in again                                                        |
| Uploaded images, attachments and generated artifacts outside app.sqlite                                                       | No                             | Back up their actual source/storage paths separately; a database association does not preserve file contents |
| Project working trees, Git repositories and generated project files                                                           | No                             | Use Git and a separate filesystem backup                                                                     |
| Installed npm package                                                                                                         | Separate upgrade rollback copy | The upgrade worker keeps the previous installation; a data backup is not a program installer                 |

Snapshots are retained without automatic rotation. Do not delete an upgrade-protected snapshot or its previous installation while repair may still reference it. Disk-full, permission, cancellation and verification failures do not overwrite previous backups; directories without a valid completion manifest are not restorable. Failure messages exclude configuration contents and secrets.

Automatic rollback is limited to activation, before business writes resume. `covro update repair` verifies backup identity and refuses to overwrite a service that has resumed writing. Legacy upgrade snapshots are not advertised as verified modern backups; repair validates their database and config before restoring them. See [database compatibility](database.md) for schema, forward migrations and downgrade rules.

## Manual backups and offline recovery

Use `covro backup create` against a running instance to wait for its safe point and create a snapshot without interrupting a task. The command waits for completion; use the webpage to cancel a queued snapshot. When the instance is stopped, the same command creates an offline snapshot while owning the instance and maintenance locks. `covro backup list` lists persisted records; `covro backup verify ID` rechecks file hashes, SQLite and target compatibility. Commands accept `--config /absolute/path/config.json`.

Recovery is an offline operation:

```sh
covro backup restore BACKUP_ID --config /absolute/path/config.json
covro stop --config /absolute/path/config.json
covro backup restore BACKUP_ID --confirm BACKUP_ID --config /absolute/path/config.json
covro start --config /absolute/path/config.json
```

The first command is a read-only preflight showing the exact overwritten files, source/target schema and data-loss scope. Confirmation must repeat the exact backup ID. Restore validates the backup again under exclusive ownership, validates configuration at its original path, migrates a temporary database copy and checks integrity before replacement. A backup from another config/data directory is refused. There is no automatic program downgrade or automatic restart after data restoration.

Before replacing any live file, recovery preserves the original database, WAL/SHM and config byte-for-byte under `dataDir/.covro-restore-<operation-id>/original/`. These are recovery copies, not advertised healthy backups: damaged current data can be preserved while a healthy backup is restored. Keep them until satisfied with the result; they consume additional disk space and are not automatically rotated. Backup data is never modified during restoration.

A durable restore journal blocks gateway startup and `db:migrate` if replacement is interrupted. Stop any instance using the config, then run `covro backup repair --config ...` to verify the recovery copies and restore the exact original file set. Committed restores are never automatically reverted after writes resume. If the current config is damaged or points at a changed directory, add `--data-dir /absolute/original/data` to offline backup commands to identify the original catalog and acquire its lock. This does not redirect restored config: its data directory still has to match the backup's original instance. An invalid recovery copy is refused and retained for inspection.

## Web interface

Open **Settings → Backups and recovery** from the sidebar. The page shows the target schema, completed snapshot count/size, host storage directory and each record's trigger, application/schema version, state and path. **立即备份** waits for a safe point; **取消备份** cancels a queued/incomplete snapshot without interrupting a task. Closing the page does not cancel server work. **重新验证** rechecks the backup against its files and the running version. Expand **恢复方式** for the exact backup-ID preflight command; apply recovery only from the stopped host's CLI. Failed, cancelled, interrupted and corrupt records remain distinguishable from completed backups.

Pending user-message snapshots (including submitted image data) live in Covro’s database until a matching native message confirms delivery. Database backups therefore include these snapshots; they do not include the separate Codex conversation history.
