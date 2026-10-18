// Browser-normalized JPEGs only; independently strip metadata before storage.
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
    if (binary.length > MAX_PHOTO_BYTES || byte(0) !== 255 || byte(1) !== 216) throw new Error("Invalid JPEG photo.");
    // Walk every scan, not just the first header: progressive JPEGs can carry
    // metadata between scans. Keep encoded pixels unchanged and omit APP0–APP15
    // (EXIF/GPS, XMP, IPTC, ICC, thumbnails) and COM segments entirely.
    let offset = 2, width = 0, height = 0, scan = false, ended = false;
    const clean = [binary.slice(0, 2)];
    while (offset < binary.length) {
      const start = offset;
      if (byte(offset++) !== 255) throw new Error("Invalid JPEG structure.");
      while (byte(offset) === 255) offset++;
      const marker = byte(offset++);
      if (marker === 217) { clean.push("\xff\xd9"); ended = true; break; }
      if (marker === 0 || marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) throw new Error("Invalid JPEG marker.");
      if (offset + 2 > binary.length) throw new Error("Invalid JPEG segment.");
      const length = (byte(offset) << 8) | byte(offset + 1);
      if (length < 2 || offset + length > binary.length) throw new Error("Invalid JPEG segment.");
      if (marker === 192 || marker === 194) {
        if (length < 8) throw new Error("Invalid JPEG frame.");
        height = (byte(offset + 3) << 8) | byte(offset + 4);
        width = (byte(offset + 5) << 8) | byte(offset + 6);
        if (!width || !height || Math.max(width, height) > MAX_PHOTO_EDGE) throw new Error("Resize photos to at most 1600 pixels before publishing.");
      }
      offset += length;
      if ((marker < 224 || marker > 239) && marker !== 254) clean.push(binary.slice(start, offset));
      if (marker === 218) {
        scan = true;
        const scanStart = offset;
        // Byte-stuffed FF and restart markers belong to the encoded pixels.
        while (offset < binary.length) {
          if (byte(offset) !== 255) { offset++; continue; }
          let next = offset + 1;
          while (byte(next) === 255) next++;
          if (byte(next) === 0 || (byte(next) >= 208 && byte(next) <= 215)) { offset = next + 1; continue; }
          break;
        }
        clean.push(binary.slice(scanStart, offset));
      }
    }
    if (!ended || !scan || !width || !height) throw new Error("Invalid JPEG photo.");
    return { data: btoa(clean.join("")), alt: (photo.alt || "").trim() };
  });
}
