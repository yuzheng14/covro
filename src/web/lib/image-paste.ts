import { t } from '../i18n';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from '../../shared/images';

export interface DraftImage {
  id: string;
  name: string;
  size: number;
  dataUrl?: string;
  failed?: boolean;
}
export interface MessageDraft {
  text: string;
  images: DraftImage[];
  error?: string;
}
export const emptyDraft: MessageDraft = { text: '', images: [] };

export function imagePasteError(files: File[], images: DraftImage[]): string | undefined {
  if (files.some((file) => !IMAGE_TYPES.includes(file.type)))
    return t('composer:paste_a_png_jpeg_webp_or_gif_image');
  if (files.some((file) => file.size === 0))
    return t('composer:the_image_is_empty_copy_and_paste_it');
  if (files.length + images.length > MAX_IMAGES)
    return t('composer:up_to_images_per_message', { count: MAX_IMAGES, v0: MAX_IMAGES });
  if ([...files, ...images].reduce((sum, file) => sum + file.size, 0) > MAX_IMAGE_BYTES)
    return t('composer:images_per_message_cannot_exceed_2_mib_in');
}

export function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(t('common:could_not_read_the_image_please_paste_it')));
    };
    reader.onerror = reader.onabort = () =>
      reject(new Error(t('common:could_not_read_the_image_please_paste_it')));
    reader.readAsDataURL(file);
  });
}
