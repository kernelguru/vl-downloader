import {BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy} from '@nestjs/common';
import {EventEmitter2} from '@nestjs/event-emitter';
import * as fs from 'fs';
import {basename, extname, join} from 'path';
import {UtilsService} from '../shared/services/utils.service';
import {LibraryService} from './library.service';
import {RommService} from './romm.service';
import {extractArchive, isArchive, listFilesRecursive, sizeOf} from './archive';
import {findSystemBySlug, SystemInfo} from './systems';
import {RomService} from '../rom/rom.service';
import {TrackStatusEnum} from '../rom/rom.entity';

export const INBOX_RETRY_EVENT = 'inbox.retry';

export interface InboxStatus {
    path: string;
    /** System applied to all new files, null = detect automatically */
    system: string | null;
    extract: boolean;
    pending: string[];
}

const truthy = (value: string | undefined, fallback: boolean) =>
    value === undefined || value === '' ? fallback : value.toLowerCase() !== 'false';

/**
 * Watches the inbox (download folder of the built-in browser), waits until a download is complete,
 * extracts archives, detects the system and moves the game into the library.
 *
 * While Firefox downloads (it writes "<name>.part"), an entry with the received bytes and the speed is shown.
 *
 * Env: INBOX_PATH (default ./inbox), EXTRACT_ARCHIVES (default true), DELETE_ARCHIVES (default true),
 *      INBOX_POLL (seconds, default 2)
 */
@Injectable()
export class InboxService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(InboxService.name);
    private readonly extract = truthy(process.env.EXTRACT_ARCHIVES, true);
    private readonly deleteArchives = truthy(process.env.DELETE_ARCHIVES, true);
    private readonly pollMs = Math.max(1, Number(process.env.INBOX_POLL) || 2) * 1000;
    /** path -> last seen size/mtime and how many polls it stayed unchanged */
    private readonly seen = new Map<string, { size: number; mtime: number; stable: number }>();
    /** "path:mtime" of files that failed, so they are not retried in a loop */
    private readonly failed = new Set<string>();
    private timer?: NodeJS.Timeout;
    private busy = false;
    private system: SystemInfo | undefined;
    /** final file name -> entry shown while Firefox is still downloading it */
    private readonly active = new Map<string, { id: number; bytes: number; at: number }>();

    constructor(
        private readonly utils: UtilsService,
        private readonly library: LibraryService,
        private readonly romm: RommService,
        private readonly romService: RomService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    get path(): string {
        return this.utils.getInboxFolderPath();
    }

    onApplicationBootstrap(): void {
        fs.mkdirSync(this.path, {recursive: true});
        this.cleanupWorkDirs();
        this.eventEmitter.on(INBOX_RETRY_EVENT, (file: string) => {
            for (const key of [...this.failed]) {
                key.startsWith(`${join(this.path, basename(file))}:`) && this.failed.delete(key);
            }
        });
        this.timer = setInterval(() => this.poll(), this.pollMs);
        this.logger.log(`Watching inbox ${this.path}`);
    }

    onModuleDestroy(): void {
        clearInterval(this.timer);
    }

    status(): InboxStatus {
        return {
            path: this.path,
            system: this.system?.slug ?? null,
            extract: this.extract,
            pending: this.listCandidates().map(f => basename(f)),
        };
    }

    setSystem(slug: string | null | undefined): InboxStatus {
        if (slug) {
            const system = findSystemBySlug(slug);
            if (!system) {
                throw new BadRequestException(`Unknown system "${slug}"`);
            }
            this.system = system;
        } else {
            this.system = undefined;
        }
        return this.status();
    }

    private listCandidates(): string[] {
        try {
            return fs.readdirSync(this.path, {withFileTypes: true})
                .filter(d => d.isFile() && !d.name.startsWith('.') && !/\.(part|crdownload|tmp)$/i.test(d.name))
                .map(d => join(this.path, d.name));
        } catch {
            return [];
        }
    }

    private async poll(): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            await this.trackPartialDownloads();
            const candidates = this.listCandidates();
            for (const path of [...this.seen.keys()]) {
                !candidates.includes(path) && this.seen.delete(path);
            }
            for (const path of candidates) {
                if (!this.isComplete(path)) {
                    continue;
                }
                await this.process(path);
            }
        } catch (e) {
            this.logger.error(`Inbox poll failed: ${e}`);
        } finally {
            this.busy = false;
        }
    }

    /** Show running Firefox downloads ("<name>.part") with received bytes and speed. */
    private async trackPartialDownloads(): Promise<void> {
        let parts: string[];
        try {
            parts = fs.readdirSync(this.path).filter(name => name.endsWith('.part') && !name.startsWith('.'));
        } catch {
            return;
        }
        const now = Date.now();
        const current = new Set<string>();
        for (const part of parts) {
            const fileName = part.slice(0, -'.part'.length);
            current.add(fileName);
            let bytes: number;
            try {
                bytes = fs.statSync(join(this.path, part)).size;
            } catch {
                continue;
            }
            const entry = this.active.get(fileName);
            if (!entry) {
                const rom = await this.romService.createInboxEntry(basename(fileName, extname(fileName)), fileName, 0, 'downloading');
                this.active.set(fileName, {id: rom.id, bytes, at: now});
                await this.romService.updatePartial(rom.id, {receivedBytes: bytes});
                continue;
            }
            const seconds = (now - entry.at) / 1000;
            if (seconds > 0 && bytes !== entry.bytes) {
                const speed = Math.max(0, Math.round((bytes - entry.bytes) / seconds));
                entry.bytes = bytes;
                entry.at = now;
                await this.romService.updatePartial(entry.id, {receivedBytes: bytes, bytesPerSecond: speed});
            } else if (seconds > 15) {
                await this.romService.updatePartial(entry.id, {bytesPerSecond: 0});
                entry.at = now;
            }
        }
        // .part gone: either finished (final file is complete now) or canceled in Firefox
        for (const [fileName, entry] of [...this.active]) {
            if (current.has(fileName)) {
                continue;
            }
            const finalPath = join(this.path, fileName);
            const finished = fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0;
            if (!finished) {
                this.active.delete(fileName);
                await this.romService.removeEntry(entry.id);
            }
            // finished: the entry is picked up by process()
        }
    }

    /** Firefox keeps "<name>.part" next to an empty "<name>" while downloading; also wait for a stable size. */
    private isComplete(path: string): boolean {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(path);
        } catch {
            return false;
        }
        if (this.failed.has(`${path}:${stat.mtimeMs}`)) {
            return false;
        }
        if (fs.existsSync(`${path}.part`) || stat.size === 0) {
            this.seen.delete(path);
            return false;
        }
        const last = this.seen.get(path);
        if (last && last.size === stat.size && last.mtime === stat.mtimeMs) {
            last.stable++;
        } else {
            this.seen.set(path, {size: stat.size, mtime: stat.mtimeMs, stable: 0});
        }
        return (this.seen.get(path)?.stable ?? 0) >= 1;
    }

    private async process(path: string): Promise<void> {
        const fileName = basename(path);
        const stem = basename(fileName, extname(fileName));
        const mtime = fs.statSync(path).mtimeMs;
        this.seen.delete(path);
        this.logger.log(`Processing ${fileName}`);

        const size = fs.statSync(path).size;
        const running = this.active.get(fileName);
        this.active.delete(fileName);
        const rom = running && await this.romService.get(running.id)
            ? {id: running.id}
            : await this.romService.createInboxEntry(stem, fileName, size, 'extracting');
        await this.romService.updatePartial(rom.id, {
            totalBytes: size, receivedBytes: size, bytesPerSecond: null,
            stage: this.extract && isArchive(path) ? 'extracting' : 'sorting',
        });
        const workDir = join(this.path, `.extract-${rom.id}`);
        try {
            let items: string[];
            const extracted = this.extract && isArchive(path);
            if (extracted) {
                await extractArchive(path, workDir);
                items = listFilesRecursive(workDir);
                if (!items.length) {
                    throw new Error('Archive is empty');
                }
            } else {
                items = [path];
            }

            await this.romService.updatePartial(rom.id, {stage: 'sorting'});
            const system = this.system ?? this.library.detectFromFiles(items) ?? (extracted ? undefined : this.library.detectFromFile(path));
            const target = this.library.targetDir(system?.slug);

            let moved: string;
            if (!extracted) {
                moved = this.library.moveFile(path, target);
            } else {
                const top = fs.readdirSync(workDir);
                if (top.length === 1) {
                    // a single file, or the archive already contains one game folder
                    moved = this.library.moveFile(join(workDir, top[0]), target);
                } else {
                    // several files (e.g. .cue + .bin tracks): one folder per game, as RomM expects
                    const gameDir = join(workDir, stem);
                    fs.mkdirSync(gameDir);
                    top.forEach(entry => fs.renameSync(join(workDir, entry), join(gameDir, entry)));
                    moved = this.library.moveFile(gameDir, target);
                }
                if (this.deleteArchives) {
                    fs.rmSync(path, {force: true});
                }
            }

            await this.romService.updatePartial(rom.id, {
                status: TrackStatusEnum.Completed,
                stage: null,
                system: system?.slug ?? null,
                fileName: basename(moved),
                relativePath: this.library.toRelative(moved),
                totalBytes: sizeOf(moved),
                receivedBytes: sizeOf(moved),
            });
            if (system) {
                const folder = this.library.toRelative(moved).split('/')[0];
                this.romm.scheduleScan(folder);
            }
            this.logger.log(`${fileName} -> ${this.library.toRelative(moved)} (${system?.slug ?? 'system unknown'})`);
        } catch (e) {
            this.failed.add(`${path}:${mtime}`);
            this.logger.error(`Processing ${fileName} failed: ${e}`);
            await this.romService.updatePartial(rom.id, {
                status: TrackStatusEnum.Error,
                stage: null,
                error: `Processing failed: ${e instanceof Error ? e.message : e}`,
            });
        } finally {
            fs.rmSync(workDir, {recursive: true, force: true});
        }
    }

    private cleanupWorkDirs(): void {
        try {
            fs.readdirSync(this.path)
                .filter(name => name.startsWith('.extract-'))
                .forEach(name => fs.rmSync(join(this.path, name), {recursive: true, force: true}));
        } catch {
            // ignore
        }
    }
}
