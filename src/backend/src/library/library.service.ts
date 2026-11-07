import {Injectable, Logger} from '@nestjs/common';
import * as fs from 'fs';
import {basename, dirname, extname, join, relative, resolve, sep} from 'path';
import {UtilsService} from '../shared/services/utils.service';
import {findSystemByExtension, findSystemBySlug, SystemInfo, SYSTEMS} from './systems';
import {listZipEntries} from './zip';

/**
 * Knows where files go inside the download folder.
 *
 * Env:
 * - ORGANIZE_BY_SYSTEM  (default true)   put downloads into one folder per system
 * - FOLDER_LAYOUT       (default {system}) e.g. "{system}" for RomM structure A when the
 *                       download folder is mounted as <library>/roms, or "{system}/roms"
 *                       for RomM structure B when it is mounted as <library>
 * - SYSTEM_FOLDERS      optional overrides "psx=ps,genesis=megadrive"
 */
@Injectable()
export class LibraryService {
    private readonly logger = new Logger(LibraryService.name);
    private readonly organize = (process.env.ORGANIZE_BY_SYSTEM ?? 'true').toLowerCase() !== 'false';
    private readonly layout = (process.env.FOLDER_LAYOUT || '{system}').replace(/^[/\\]+|[/\\]+$/g, '');
    private readonly overrides = LibraryService.parseOverrides(process.env.SYSTEM_FOLDERS);

    constructor(private readonly utils: UtilsService) {}

    get root(): string {
        return this.utils.getDownloadFolderPath();
    }

    get organizeEnabled(): boolean {
        return this.organize;
    }

    listSystems(): Array<Pick<SystemInfo, 'slug' | 'name'> & { folder: string }> {
        return SYSTEMS
            .map(s => ({slug: s.slug, name: s.name, folder: this.folderName(s)}))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Folder name for a system: override > already existing (legacy) folder > RomM slug. */
    folderName(system: SystemInfo): string {
        const override = this.overrides.get(system.slug);
        if (override) {
            return override;
        }
        const candidates = [system.slug, ...(system.legacySlugs ?? [])];
        const existing = candidates.find(c => fs.existsSync(this.layoutDir(c)));
        return existing ?? system.slug;
    }

    /** Absolute target directory for a system slug (download root if unknown / disabled). */
    targetDir(systemSlug?: string | null): string {
        const system = findSystemBySlug(systemSlug);
        if (!this.organize || !system) {
            return this.root;
        }
        return this.layoutDir(this.folderName(system));
    }

    /** Path relative to the download root, as stored in the DB. */
    toRelative(absPath: string): string {
        return relative(this.root, absPath).split(sep).join('/');
    }

    /** Absolute path for a stored relative path, refusing anything outside the root. */
    toAbsolute(relativePath: string): string | undefined {
        const abs = resolve(this.root, relativePath);
        return abs === this.root || abs.startsWith(this.root + sep) ? abs : undefined;
    }

    /** Detect a system from a file name, or from the file names inside a ZIP. */
    detectFromFile(absPath: string): SystemInfo | undefined {
        const direct = findSystemByExtension(basename(absPath));
        if (direct) {
            return direct;
        }
        if (extname(absPath).toLowerCase() !== '.zip') {
            return undefined;
        }
        const counts = new Map<SystemInfo, number>();
        for (const entry of listZipEntries(absPath)) {
            const system = findSystemByExtension(basename(entry));
            system && counts.set(system, (counts.get(system) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    }

    /** Move a file into `destDir` without overwriting anything. Returns the new absolute path. */
    moveFile(srcAbs: string, destDir: string): string {
        if (dirname(srcAbs) === destDir) {
            return srcAbs;
        }
        fs.mkdirSync(destDir, {recursive: true});
        const ext = extname(srcAbs);
        const stem = basename(srcAbs, ext);
        let dest = join(destDir, basename(srcAbs));
        for (let i = 1; fs.existsSync(dest); i++) {
            dest = join(destDir, `${stem} (${i})${ext}`);
        }
        try {
            fs.renameSync(srcAbs, dest);
        } catch (e: any) {
            if (e?.code !== 'EXDEV') {
                throw e;
            }
            fs.copyFileSync(srcAbs, dest);
            fs.unlinkSync(srcAbs);
        }
        this.logger.log(`Moved ${this.toRelative(srcAbs)} -> ${this.toRelative(dest)}`);
        return dest;
    }

    /** Regular files directly in the download root (not yet sorted). */
    listRootFiles(): string[] {
        try {
            return fs.readdirSync(this.root, {withFileTypes: true})
                .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.crdownload'))
                .map(d => join(this.root, d.name));
        } catch {
            return [];
        }
    }

    private layoutDir(folder: string): string {
        const sub = this.layout.split('{system}').join(folder);
        const abs = resolve(this.root, sub);
        // never leave the download root, whatever the env says
        return abs.startsWith(this.root + sep) ? abs : join(this.root, folder);
    }

    private static parseOverrides(value?: string): Map<string, string> {
        const map = new Map<string, string>();
        for (const pair of (value ?? '').split(',')) {
            const [key, folder] = pair.split('=').map(v => v?.trim());
            const system = findSystemBySlug(key);
            if (system && folder && /^[\w.\- ]+$/.test(folder)) {
                map.set(system.slug, folder);
            }
        }
        return map;
    }
}
