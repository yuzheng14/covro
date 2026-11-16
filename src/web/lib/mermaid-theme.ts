/** Read the application's resolved styles, rather than choosing a separate OS theme. */
export function readMermaidTheme() {
  const styles = getComputedStyle(document.documentElement);
  // Mermaid's theme engine requires hex colors; CSS can resolve to rgb()/color-mix().
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d')!;
  const hex = (color: string) => {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return (
      '#' +
      [...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
    );
  };
  const token = (name: string) => hex(styles.getPropertyValue(name).trim());
  const background = hex(styles.backgroundColor);
  const channels = background
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16));
  return {
    dark: channels[0]! * 0.299 + channels[1]! * 0.587 + channels[2]! * 0.114 < 128,
    background,
    text: hex(styles.color),
    border: token('--border'),
    muted: token('--muted'),
    panel: token('--sidebar'),
    accent: token('--accent'),
    accentSoft: token('--accent-soft'),
    fontFamily: styles.fontFamily,
  };
}

export type MermaidTheme = ReturnType<typeof readMermaidTheme>;
