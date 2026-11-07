import {spawn, spawnSync} from 'child_process';
import * as fs from 'fs';
import {extname, join} from 'path';

export const ARCHIVE_EXTENSIONS = ['zip', '7z', 'rar'];

export function isArchive(path: string): boolean {
    return ARCHIVE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase());
}

const has = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`], {stdio: 'ignore'}).status === 0;

function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio: ['ignore', 'ignore', 'pipe']});
        let stderr = '';
        child.stderr.on('data', d => (stderr = (stderr + d).slice(-1000)));
        child.on('error', reject);
        child.on('exit', code => code === 0
            ? resolve()
            : reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)));
    });
}

/** Extracts zip/7z/rar into `dest` with 7-Zip (falls back to unzip for .zip). */
export async function extractArchive(path: string, dest: string): Promise<void> {
    fs.mkdirSync(dest, {recursive: true});
    const sevenZip = ['7z', '7za', '7zz'].find(has);
    if (sevenZip) {
        // 7-Zip drops absolute and ../ paths from archives by default
        await run(sevenZip, ['x', '-y', '-bd', `-o${dest}`, path]);
        return;
    }
    if (extname(path).toLowerCase() === '.zip' && has('unzip')) {
        await run('unzip', ['-o', '-q', path, '-d', dest]);
        return;
    }
    throw new Error('No extractor found (install 7zip)');
}

/** All regular files below `dir`. */
export function listFilesRecursive(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listFilesRecursive(full));
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
    return out;
}

/** Total size in bytes of a file or folder. */
export function sizeOf(path: string): number {
    const stat = fs.statSync(path);
    return stat.isDirectory() ? listFilesRecursive(path).reduce((sum, f) => sum + fs.statSync(f).size, 0) : stat.size;
}
