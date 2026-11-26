import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  readMigrations,
  inspectDatabase,
  migrateSqlite,
  requireRestorable,
} from '../../src/server/db/history.js';
import { defaultMigrationsFolder } from '../../src/server/db/migrate.js';
import { verifyDatabaseContract } from '../../scripts/verify-database-contract.js';
import { releaseDatabaseNotes, requireReleaseTag } from '../../scripts/release-compatibility.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const open = () => {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
};
const migrations = readMigrations(defaultMigrationsFolder);
it('restores every declared historical schema and stamps its complete migration chain atomically', () => {
  const contract = verifyDatabaseContract();
  for (
    let version = contract.minRestorableSchemaVersion;
    version <= contract.schemaVersion;
    version++
  ) {
    const db = open();
    migrateSqlite(db, migrations.slice(0, version));
    db.prepare(
      "INSERT INTO operations (client_operation_id, kind, target, request_digest, state, created_at, updated_at) VALUES ('kept', 'turn.start', 't', 'digest', 'acknowledged', 1, 1)",
    ).run();
    db.pragma('user_version = 0'); // An installation predating the public version contract.
    expect(inspectDatabase(db, migrations)).toMatchObject({ schemaVersion: version, legacy: true });
    requireRestorable(version, contract);
    migrateSqlite(db, migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(contract.schemaVersion);
    expect(db.prepare('SELECT client_operation_id FROM operations').get()).toEqual({
      client_operation_id: 'kept',
    });
    migrateSqlite(db, migrations);
    expect(inspectDatabase(db, migrations).migrationHashes).toHaveLength(contract.schemaVersion);
  }
});
it('rejects future databases, conflicting ordinals, edited migrations and unidentified data without modifying records', () => {
  const db = open();
  migrateSqlite(db, migrations);
  const before = db.serialize();
  expect(() => migrateSqlite(db, migrations.slice(0, -1))).toThrow('不兼容');
  expect(db.serialize()).toEqual(before);
  db.pragma('user_version = 99');
  expect(() => migrateSqlite(db, migrations)).toThrow('不兼容');
  db.pragma(`user_version = ${migrations.length}`);
  expect(() =>
    inspectDatabase(db, [{ ...migrations[0]!, hash: 'changed' }, ...migrations.slice(1)]),
  ).toThrow('不兼容');
  const unknown = open();
  unknown.exec('CREATE TABLE unknown (value text)');
  expect(() => migrateSqlite(unknown, migrations)).toThrow('不兼容');
});
it('does not advance SQL, history or version if a migration fails', () => {
  const db = open();
  migrateSqlite(db, migrations.slice(0, 1));
  const failing = [
    ...migrations,
    {
      hash: 'broken',
      createdAt: Date.now(),
      sql: ['CREATE TABLE should_rollback (value text)', 'INVALID SQL'],
    },
  ];
  expect(() => migrateSqlite(db, failing)).toThrow();
  expect(inspectDatabase(db, migrations).schemaVersion).toBe(1);
  expect(db.pragma('user_version', { simple: true })).toBe(1);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get(),
  ).toBeUndefined();
});
it('adds tagged database compatibility notes idempotently and refuses unknown declarations', () => {
  const contract = verifyDatabaseContract();
  const notes = releaseDatabaseNotes('## Changes\nExisting notes', contract);
  expect(notes).toContain(`DB Schema: **${contract.schemaVersion}**`);
  expect(releaseDatabaseNotes(notes, contract)).toBe(notes);
  expect(() => releaseDatabaseNotes(notes, undefined)).toThrow();
  expect(() => requireRestorable(contract.schemaVersion + 1, contract)).toThrow('不兼容');
});

it('reads Beta compatibility from its source tag without confusing its unstamped source package version', () => {
  expect(() => requireReleaseTag('v0.3.0-beta.1', '0.2.0')).not.toThrow();
  expect(() => requireReleaseTag('v0.3.0', '0.2.0')).toThrow('does not match');
  expect(() => requireReleaseTag('v0.3.0-dev.1', '0.2.0')).toThrow('Invalid');
});

it('keeps saved fixed schedules and their run identity during the adaptive-loop migration', () => {
  const db = open();
  db.pragma('foreign_keys = ON');
  const beforeAdaptive = migrations.slice(0, 13);
  migrateSqlite(db, beforeAdaptive);
  const operation = db.prepare(
    "INSERT INTO operations (client_operation_id, kind, target, request_digest, state, created_at, updated_at) VALUES (?, ?, 'session', 'digest', 'acknowledged', 1, 1)",
  );
  operation.run('loop', 'loop.create');
  operation.run('run', 'turn.start');
  db.prepare(
    "INSERT INTO session_loops (id, thread_id, workspace_key, settings, prompt, interval_ms, status, runs, next_run_at, last_result, last_turn_id, last_operation_id) VALUES ('loop', 'session', 'workspace', '{}', 'Check CI', 300000, 'active', 3, 123, 'completed', 'turn', 'run')",
  ).run();

  migrateSqlite(db, migrations);
  expect(db.prepare('SELECT * FROM session_loops WHERE id = ?').get('loop')).toMatchObject({
    mode: 'fixed',
    interval_ms: 300_000,
    next_run_at: 123,
    status: 'active',
    runs: 3,
    last_result: 'completed',
    last_turn_id: 'turn',
    last_operation_id: 'run',
    last_decision: null,
  });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
