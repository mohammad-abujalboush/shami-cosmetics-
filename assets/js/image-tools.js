// Client-side image preparation for uploads: decode, downscale (longest side) and re-encode as JPEG so
// phone photos stay well under the bucket's 5 MB limit. Errors are AppError codes (Arabic via strings.errors).
import { AppError } from './utils.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function compressImage(file, { maxSide = 1600, quality = 0.85, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const name = String(file.name || '').toLowerCase();
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|avif)$/.test(name)) throw new AppError('FILE_TYPE_INVALID');
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new AppError('IMAGE_READ_FAILED');
  }
  let scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', Math.max(0.5, quality - attempt * 0.1)));
    if (blob && blob.size <= maxBytes) { bmp.close?.(); return blob; }
    scale *= 0.75;
  }
  bmp.close?.();
  throw new AppError('FILE_TOO_LARGE');
}

export function randomName() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
