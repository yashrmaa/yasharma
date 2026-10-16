// Only browser-normalized JPEGs. No URLs, client filenames, SVG, or HTML uploads.
export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 500 * 1024;
export const MAX_PHOTO_EDGE = 1600;

export function validatePhotos(input = []) {
  if (!Array.isArray(input) || input.length > MAX_PHOTOS) throw new Error("Add up to 3 photos.");
  return input.map(photo => {
    if (!photo || typeof photo !== "object" || Object.keys(photo).some(key => !["data", "alt"].includes(key))) throw new Error("Invalid photo fields.");
    if (typeof photo.data !== "string" || photo.data.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 || photo.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(photo.data)) throw new Error("Photos must be JPEGs under 500 KiB each.");
    if (photo.alt !== undefined && (typeof photo.alt !== "string" || photo.alt.length > 300 || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(photo.alt))) throw new Error("Photo descriptions must be single-line text under 300 characters.");
    const binary = atob(photo.data);
    const byte = index => binary.charCodeAt(index < 0 ? binary.length + index : index);
    if (binary.length > MAX_PHOTO_BYTES || byte(0) !== 255 || byte(1) !== 216 || byte(-2) !== 255 || byte(-1) !== 217) throw new Error("Invalid JPEG photo.");
    // Inspect JPEG segments for dimensions and a scan, bounding decoded size too.
    let offset = 2, width = 0, height = 0, scan = false;
    while (offset < binary.length - 2) {
      if (byte(offset++) !== 255) throw new Error("Invalid JPEG structure.");
      while (byte(offset) === 255) offset++;
      const marker = byte(offset++);
      const length = (byte(offset) << 8) | byte(offset + 1);
      if (length < 2 || offset + length > binary.length - 2) throw new Error("Invalid JPEG segment.");
      if (marker === 192 || marker === 194) {
        if (length < 8) throw new Error("Invalid JPEG frame.");
        height = (byte(offset + 3) << 8) | byte(offset + 4);
        width = (byte(offset + 5) << 8) | byte(offset + 6);
      }
      if (marker === 218) { scan = true; break; }
      offset += length;
    }
    if (!scan || !width || !height || Math.max(width, height) > MAX_PHOTO_EDGE) throw new Error("Resize photos to at most 1600 pixels before publishing.");
    return { data: photo.data, alt: (photo.alt || "").trim() };
  });
}
