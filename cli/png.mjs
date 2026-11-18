import { crc32, deflateSync } from 'node:zlib';

/** Encodes a Bitmap as a PNG, enlarging each pixel `scale` times. */
export function encodePng(bitmap, scale = 1) {
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height); // every row starts with filter byte 0

  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / scale) * bitmap.width * 4;
    for (let x = 0; x < width; x++) {
      const from = row + Math.floor(x / scale) * 4;
      const to = y * stride + 1 + x * 4;
      const alpha = bitmap.data[from + 3];
      // The bitmap is premultiplied; PNG is not.
      for (let c = 0; c < 3; c++) raw[to + c] = alpha ? Math.min(255, Math.round(bitmap.data[from + c] * 255 / alpha)) : 0;
      raw[to + 3] = alpha;
    }
  }

  const chunk = (type, body) => {
    const data = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const out = Buffer.alloc(data.length + 8);
    out.writeUInt32BE(body.length, 0);
    data.copy(out, 4);
    out.writeUInt32BE(crc32(data), data.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
