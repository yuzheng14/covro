import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppDatabase } from './db/index.js';
import { backgroundTasks } from './db/schema.js';

/** Durable operation identity and safe snapshots, independent of any browser or dialog.
 * Executors own lifecycle/recovery; this store intentionally does not schedule or retry work.
 */
export class BackgroundTasks<T extends { id: string }> {
  constructor(
    private readonly database: AppDatabase,
    private readonly kind: string,
  ) {}

  load(): { view: T; fingerprint: string }[] {
    return this.database
      .select()
      .from(backgroundTasks)
      .where(and(eq(backgroundTasks.kind, this.kind), isNotNull(backgroundTasks.snapshot)))
      .all()
      .map((row) => ({ view: row.snapshot as T, fingerprint: row.fingerprint }));
  }

  identity(id: string): string | undefined {
    return this.database
      .select({ fingerprint: backgroundTasks.fingerprint })
      .from(backgroundTasks)
      .where(and(eq(backgroundTasks.kind, this.kind), eq(backgroundTasks.id, id)))
      .get()?.fingerprint;
  }

  forgetSnapshot(id: string): void {
    // Retain the hashed request identity: history expiry must never execute an old POST again.
    this.database
      .update(backgroundTasks)
      .set({ snapshot: null })
      .where(and(eq(backgroundTasks.kind, this.kind), eq(backgroundTasks.id, id)))
      .run();
  }

  save(view: T, fingerprint: string): void {
    this.database
      .insert(backgroundTasks)
      .values({ id: view.id, kind: this.kind, snapshot: view, fingerprint })
      .onConflictDoUpdate({
        target: backgroundTasks.id,
        set: { snapshot: view },
      })
      .run();
  }
}
