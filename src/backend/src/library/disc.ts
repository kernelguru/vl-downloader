import * as fs from 'fs';
import {extname} from 'path';
import {findSystemBySlug, SystemInfo} from './systems';

/** Bytes read from the start of an image; enough for headers, volume descriptors and SYSTEM.CNF. */
const SNIFF_BYTES = 8 * 1024 * 1024;

export const DISC_EXTENSIONS = ['iso', 'bin', 'img', 'gcm', 'mdf'];

function readHead(path: string, length = SNIFF_BYTES): Buffer {
    const fd = fs.openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(Math.min(length, fs.fstatSync(fd).size));
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytes);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Identifies the console of a CD/DVD image by its content
 * (Vimm's file names do not contain the system, and .iso/.bin are used by many consoles).
 */
export function detectDiscImage(path: string): SystemInfo | undefined {
    if (!DISC_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) {
        return undefined;
    }
    let head: Buffer;
    try {
        head = readHead(path);
    } catch {
        return undefined;
    }
    if (head.length < 0x40) {
        return undefined;
    }

    // Nintendo optical discs: magic words in the disc header
    if (head.readUInt32BE(0x1c) === 0xc2339f3d) {
        return findSystemBySlug('ngc');
    }
    if (head.readUInt32BE(0x18) === 0x5d1c9ea3) {
        return findSystemBySlug('wii');
    }

    const text = head.toString('latin1');
    const has = (needle: string) => text.includes(needle);

    if (has('SEGA SEGASATURN')) {
        return findSystemBySlug('saturn');
    }
    if (has('SEGA SEGAKATANA')) {
        return findSystemBySlug('dc');
    }
    if (has('SEGADISCSYSTEM')) {
        return findSystemBySlug('segacd');
    }
    if (has('PC Engine CD-ROM SYSTEM')) {
        return findSystemBySlug('turbografx-cd');
    }
    if (has('CD-RTOS')) {
        return findSystemBySlug('philips-cd-i');
    }
    if (has('PS3_GAME') || has('PS3VOLUME')) {
        return findSystemBySlug('ps3');
    }
    if (has('PSP GAME') || has('UMD_DATA')) {
        return findSystemBySlug('psp');
    }
    // SYSTEM.CNF: "BOOT2 = cdrom0:\..." on PS2, "BOOT = cdrom:\..." on PS1
    if (/BOOT2\s*=\s*cdrom0:/i.test(text)) {
        return findSystemBySlug('ps2');
    }
    if (/BOOT\s*=\s*cdrom:/i.test(text)) {
        return findSystemBySlug('psx');
    }
    return undefined;
}
