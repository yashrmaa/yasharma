// Normalize on the device: smaller uploads, upright pixels, no original EXIF/GPS.
export async function preparePhoto(file) {
  if (file.size > 30 * 1024 * 1024) throw new Error("Choose a photo smaller than 30 MB.");
  if (!file.type.startsWith("image/")) throw new Error("Choose an image from your photo library.");
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    try { await image.decode(); } catch { throw new Error("This photo format cannot be opened here. Choose a JPEG, PNG or WebP, or export the photo as JPEG first."); }
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [.85, .7, .55, .4]) {
      const dataURL = canvas.toDataURL("image/jpeg", quality);
      const data = dataURL.split(",")[1];
      if (dataURL.startsWith("data:image/jpeg;") && atob(data).length <= 500 * 1024) return { data, alt: "" };
    }
    throw new Error("This photo is still too large. Crop it or choose a smaller copy.");
  } finally { URL.revokeObjectURL(url); }
}
