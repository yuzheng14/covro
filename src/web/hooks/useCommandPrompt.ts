import { useCallback, useEffect, useRef, useState } from 'react';

/** A command's chooser belongs to the navigation/runtime where it was opened. */
export function useCommandPrompt<T>(scope: string) {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const pending = useRef<{ scope: string; resolve: (value: T | undefined) => void }>(undefined);
  const [openedAt, setOpenedAt] = useState<string>();
  const finish = useCallback((value?: T) => {
    const request = pending.current;
    pending.current = undefined;
    setOpenedAt(undefined);
    request?.resolve(request.scope === scopeRef.current ? value : undefined);
  }, []);
  useEffect(() => {
    if (pending.current?.scope !== scope) finish();
  }, [scope, finish]);
  useEffect(
    () => () => {
      pending.current?.resolve(undefined);
      pending.current = undefined;
    },
    [],
  );
  const request = useCallback(
    () =>
      new Promise<T | undefined>((resolve) => {
        pending.current?.resolve(undefined);
        pending.current = { scope: scopeRef.current, resolve };
        setOpenedAt(scopeRef.current);
      }),
    [],
  );
  return { open: openedAt === scope, request, finish };
}
