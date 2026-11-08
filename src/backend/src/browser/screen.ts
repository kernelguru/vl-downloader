import {spawn} from 'child_process';
import {createHash} from 'crypto';
import {encodeJpeg} from '../vendor/jpeg-encoder';

export interface Frame {
    jpeg: Buffer;
    etag: string;
    width: number;
    height: number;
    at: number;
}

/** Runs `xwd -root` on the display and returns the raw XWD dump. */
function captureXwd(display: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('xwd', ['-root', '-silent', '-display', display], {stdio: ['ignore', 'pipe', 'pipe']});
        const chunks: Buffer[] = [];
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.stdout.on('data', c => chunks.push(c));
        child.stderr.on('data', d => (stderr += d));
        child.on('error', reject);
        child.on('exit', code => {
            clearTimeout(timer);
            code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`xwd exited with ${code}: ${stderr.trim()}`));
        });
    });
}

const shiftOf = (mask: number) => {
    let shift = 0;
    while (mask && !(mask & 1)) {
        mask >>>= 1;
        shift++;
    }
    return shift;
};

/** Converts an XWD ZPixmap (TrueColor, 24/32 bpp) to RGBA. */
export function xwdToRgba(xwd: Buffer): { width: number; height: number; data: Buffer } {
    const u32 = (i: number) => xwd.readUInt32BE(i * 4);
    const headerSize = u32(0);
    const format = u32(2);
    const width = u32(4);
    const height = u32(5);
    const byteOrder = u32(7); // 0 = LSBFirst
    const bitsPerPixel = u32(11);
    const bytesPerLine = u32(12);
    const [redMask, greenMask, blueMask] = [u32(14), u32(15), u32(16)];
    const ncolors = u32(19);
    if (format !== 2 || (bitsPerPixel !== 32 && bitsPerPixel !== 24)) {
        throw new Error(`Unsupported XWD format ${format}/${bitsPerPixel}bpp`);
    }
    const offset = headerSize + ncolors * 12;
    const bytesPerPixel = bitsPerPixel / 8;
    const [rs, gs, bs] = [shiftOf(redMask), shiftOf(greenMask), shiftOf(blueMask)];
    const out = Buffer.alloc(width * height * 4);

    for (let y = 0; y < height; y++) {
        let src = offset + y * bytesPerLine;
        let dst = y * width * 4;
        for (let x = 0; x < width; x++, src += bytesPerPixel, dst += 4) {
            let pixel: number;
            if (bytesPerPixel === 4) {
                pixel = byteOrder === 0 ? xwd.readUInt32LE(src) : xwd.readUInt32BE(src);
            } else {
                pixel = byteOrder === 0
                    ? xwd[src] | (xwd[src + 1] << 8) | (xwd[src + 2] << 16)
                    : (xwd[src] << 16) | (xwd[src + 1] << 8) | xwd[src + 2];
            }
            out[dst] = (pixel & redMask) >>> rs;
            out[dst + 1] = (pixel & greenMask) >>> gs;
            out[dst + 2] = (pixel & blueMask) >>> bs;
            out[dst + 3] = 255;
        }
    }
    return {width, height, data: out};
}

/**
 * Screenshots of the virtual display as JPEG for the live view.
 * Concurrent viewers share one capture; frames younger than `maxAgeMs` are reused.
 */
export class ScreenGrabber {
    private last?: Frame;
    private pending?: Promise<Frame>;

    constructor(private readonly display: string, private readonly quality = 60, private readonly maxAgeMs = 150) {}

    async frame(): Promise<Frame> {
        if (this.last && Date.now() - this.last.at < this.maxAgeMs) {
            return this.last;
        }
        if (!this.pending) {
            this.pending = this.capture().finally(() => (this.pending = undefined));
        }
        return this.pending;
    }

    private async capture(): Promise<Frame> {
        const xwd = await captureXwd(this.display);
        const etag = `"${createHash('sha1').update(xwd).digest('base64url').slice(0, 20)}"`;
        if (this.last && this.last.etag === etag) {
            this.last = {...this.last, at: Date.now()};
            return this.last; // unchanged screen: no re-encoding
        }
        const rgba = xwdToRgba(xwd);
        const jpeg = encodeJpeg(rgba, this.quality);
        this.last = {jpeg, etag, width: rgba.width, height: rgba.height, at: Date.now()};
        return this.last;
    }
}
