import * as fs from 'fs';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_ENTRY_SIG = 0x02014b50;
const MAX_CD_BYTES = 16 * 1024 * 1024;

function read(fd: number, position: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytes);
}

/**
 * Lists the file names inside a ZIP archive by reading only its central directory
 * (no extraction, works for multi-GB archives incl. ZIP64). Returns [] if the file
 * is not a readable ZIP.
 */
export function listZipEntries(path: string): string[] {
    let fd: number | undefined;
    try {
        fd = fs.openSync(path, 'r');
        const size = fs.fstatSync(fd).size;
        const tailLength = Math.min(size, 65557); // max comment (65535) + EOCD (22)
        const tailStart = size - tailLength;
        const tail = read(fd, tailStart, tailLength);

        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === EOCD_SIG) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) {
            return [];
        }

        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);
        let entries = tail.readUInt16LE(eocd + 10);

        if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
            const locator = eocd - 20;
            if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) {
                return [];
            }
            const zip64EocdOffset = Number(tail.readBigUInt64LE(locator + 8));
            const zip64 = read(fd, zip64EocdOffset, 56);
            if (zip64.length < 56 || zip64.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
                return [];
            }
            entries = Number(zip64.readBigUInt64LE(32));
            cdSize = Number(zip64.readBigUInt64LE(40));
            cdOffset = Number(zip64.readBigUInt64LE(48));
        }

        if (cdSize > MAX_CD_BYTES || cdOffset + cdSize > size) {
            return [];
        }

        const cd = read(fd, cdOffset, cdSize);
        const names: string[] = [];
        let p = 0;
        for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
            if (cd.readUInt32LE(p) !== CD_ENTRY_SIG) {
                break;
            }
            const nameLength = cd.readUInt16LE(p + 28);
            const extraLength = cd.readUInt16LE(p + 30);
            const commentLength = cd.readUInt16LE(p + 32);
            names.push(cd.toString('utf8', p + 46, p + 46 + nameLength));
            p += 46 + nameLength + extraLength + commentLength;
        }
        return names;
    } catch {
        return [];
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}
