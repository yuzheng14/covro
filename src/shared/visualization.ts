export const visualizationMessageType = 'covro:visualization';

export interface VisualizationReference {
  path: string;
  title?: string;
  mode?: 'wide';
}

export function parseVisualizationReference(source: string): VisualizationReference | undefined {
  const match = /^\uE200visualize\uE202(\{[^\r\n]*\})\uE201$/.exec(source);
  if (!match?.[1]) return undefined;
  try {
    const { path, title, mode } = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      typeof path !== 'string' ||
      !/^(?:\/(?!\/)|[a-z]:[\\/])/i.test(path) ||
      path.length > 4096 ||
      !/\.html$/i.test(path) ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return undefined;
    return {
      path,
      ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}),
      ...(mode === 'wide' ? { mode } : {}),
    };
  } catch {
    return undefined;
  }
}
