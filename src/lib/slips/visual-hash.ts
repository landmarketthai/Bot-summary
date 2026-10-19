import sharp from "sharp";

export interface SlipVisualHashes {
  full: string;
  center: string;
}

const HASH_COLUMNS = 9;
const HASH_ROWS = 8;

/**
 * Small grayscale difference hashes; never proof of a duplicated payment.
 * Use only as a conservative candidate signal with matching amount and time.
 * Two projections preserve information after small crops / recompression.
 */
async function differenceHash(bytes: Uint8Array, center: boolean): Promise<string> {
  let image = sharp(bytes, { failOn: "error", limitInputPixels: 12_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" });

  if (center) {
    // Materialize the normalized frame: sharp pipelines only keep one resize.
    const framed = await image.resize(320, 320, { fit: "contain", background: "#ffffff" }).toBuffer();
    image = sharp(framed).extract({ left: 32, top: 32, width: 256, height: 256 });
  }

  const { data, info } = await image
    .resize(HASH_COLUMNS, HASH_ROWS, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== HASH_COLUMNS || info.height !== HASH_ROWS || info.channels !== 1) {
    throw new Error("Unexpected visual hash dimensions");
  }
  let bits = BigInt(0);
  for (let y = 0; y < HASH_ROWS; y++) {
    for (let x = 0; x < HASH_COLUMNS - 1; x++) {
      const offset = y * HASH_COLUMNS + x;
      bits = (bits << BigInt(1)) | (data[offset] > data[offset + 1] ? BigInt(1) : BigInt(0));
    }
  }
  return bits.toString(16).padStart(16, "0");
}

/**
 * Returns null for unreadable images. Caller logs and leaves them to normal
 * reference/byte-hash controls; never synthesizes a visual fingerprint.
 */
export async function computeSlipVisualHashes(bytes: Uint8Array): Promise<SlipVisualHashes | null> {
  try {
    const [full, center] = await Promise.all([
      differenceHash(bytes, false),
      differenceHash(bytes, true),
    ]);
    return { full, center };
  } catch {
    return null;
  }
}

export function visualHashDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) {
    throw new Error("Visual hash must be exactly 16 lowercase hexadecimal characters");
  }
  let delta = BigInt("0x" + a) ^ BigInt("0x" + b);
  let result = 0;
  while (delta > BigInt(0)) {
    delta &= delta - BigInt(1);
    result++;
  }
  return result;
}
