import { settingsSchema } from '../../shared/validation';
import type { Settings } from '../../shared/types';

const key = 'covro.session-settings.v1';
/** Tab-scoped proposals survive refresh without becoming global Codex defaults. */
export function readSessionSettings(): Record<string, Settings> {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).flatMap(([scope, value]) => {
        const parsed = settingsSchema.safeParse(value);
        return /^thread:.+/.test(scope) && parsed.success ? [[scope, parsed.data]] : [];
      }),
    );
  } catch {
    return {};
  }
}
export function saveSessionSettings(settings: Record<string, Settings>) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(settings).filter(([scope]) => scope.startsWith('thread:')),
        ),
      ),
    );
  } catch {
    /* Keep in-memory proposals. */
  }
}
