export const MAX_IMAGES = 4;
/** Overall JSON request budget, including base64 images and task text. */
export const IMAGE_REQUEST_BYTES = 64 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Accept only inline raster images; never fetch URLs or read server paths. */
export function imageDataBytes(value: string): number | undefined {
  const comma = value.indexOf(',');
  if (!/^data:image\/(png|jpeg|webp|gif);base64$/.test(value.slice(0, comma))) return;
  const data = value.slice(comma + 1);
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}
