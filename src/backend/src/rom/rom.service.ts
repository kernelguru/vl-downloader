import {BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap} from '@nestjs/common';
import {Queue} from "bullmq";
import {InjectQueue} from "@nestjs/bullmq";
import {RomEntity, TrackStatusEnum} from "./rom.entity";
import {InjectRepository} from "@nestjs/typeorm";
import {In, Repository} from "typeorm";
import {WebSocketGateway, WebSocketServer} from "@nestjs/websockets";
import {Server} from 'socket.io';
import {EventEmitter2} from "@nestjs/event-emitter";
import {DownloadCanceledError, DownloadService} from "../shared/services/download.service";
import {LibraryService} from "../library/library.service";
import {RommService} from "../library/romm.service";
import {findSystemBySlug, SystemInfo} from "../library/systems";
import * as fs from "fs";
import {basename, dirname, extname, join} from "path";

enum WsOperation {
    New = 'new',
    Update = 'update',
    Delete = 'delete',
}

/** Same pattern the frontend uses: only single Vimm's Lair vault pages are accepted. */
const ROM_URL_REGEXP = /^https:\/\/vimm\.net\/vault\/\d+\/?$/;
/** Pause between page visits when sorting old downloads, to stay gentle with Vimm's Lair. */
const ONLINE_DETECTION_DELAY_MS = 5000;

export interface OrganizeEntry {
    file: string;
    to?: string;
    system?: string;
    reason?: string;
}

export interface OrganizeReport {
    dryRun: boolean;
    moved: OrganizeEntry[];
    skipped: OrganizeEntry[];
}

@WebSocketGateway()
@Injectable()
export class RomService implements OnApplicationBootstrap {
    @WebSocketServer() io: Server;
    private readonly logger = new Logger(RomService.name);
    private organizing = false;

    constructor(
        @InjectRepository(RomEntity) private repository: Repository<RomEntity>,
        @InjectQueue('download') private downloadQueue: Queue,
        private readonly eventEmitter: EventEmitter2,
        private readonly downloadService: DownloadService,
        private readonly library: LibraryService,
        private readonly romm: RommService,
    ) {}

    /**
     * The Redis queue is not persisted, so after a restart queued jobs are gone while the
     * DB still lists them. Re-enqueue everything that was queued or interrupted mid-download.
     */
    async onApplicationBootstrap(): Promise<void> {
        const pending = await this.repository.find({
            where: {status: In([TrackStatusEnum.Queued, TrackStatusEnum.Downloading])},
            order: {id: 'ASC'},
        });
        for (const rom of pending) {
            await this.repository.update(rom.id, {status: TrackStatusEnum.Queued, receivedBytes: 0, error: null});
            await this.enqueue(rom.id);
        }
        if (pending.length) {
            this.logger.log(`Re-queued ${pending.length} unfinished download(s)`);
        }
    }

    get(id: number): Promise<RomEntity | null> {
        return this.repository.findOne({where: {id}});
    }

    async getOrFail(id: number): Promise<RomEntity> {
        const rom = await this.get(id);
        if (!rom) {
            throw new NotFoundException(`Rom ${id} not found`);
        }
        return rom;
    }

    getAll(): Promise<RomEntity[]> {
        return this.repository.find({order: {id: 'ASC'}});
    }

    /** Absolute path of the downloaded file, if it exists. */
    filePath(rom: RomEntity): string | undefined {
        const relativePath = rom.relativePath ?? rom.fileName;
        const abs = relativePath && this.library.toAbsolute(relativePath);
        return abs && fs.existsSync(abs) ? abs : undefined;
    }

    async remove(id: number, deleteFile = false): Promise<void> {
        const rom = await this.getOrFail(id);
        // Cancel a running download and drop a still-waiting job.
        this.eventEmitter.emit(this.getEventName(id));
        await this.downloadQueue.remove(this.getJobId(id)).catch(() => undefined);
        await this.repository.delete(id);
        if (deleteFile) {
            const path = this.filePath(rom);
            try {
                path && fs.unlinkSync(path);
            } catch (e) {
                this.logger.warn(`Unable to delete ${path}: ${e}`);
            }
        }
        this.io.emit(WsOperation.Delete, {id});
    }

    async retry(id: number): Promise<void> {
        const rom = await this.getOrFail(id);
        await this.remove(rom.id);
        await this.create(rom.url, rom.systemManual ? rom.system : undefined);
    }

    async create(url: string, system?: string | null): Promise<void> {
        const trimmed = (url ?? '').trim();
        if (!ROM_URL_REGEXP.test(trimmed)) {
            throw new BadRequestException('Expected a Vimm\'s Lair vault URL like https://vimm.net/vault/12345');
        }
        const systemInfo = this.parseSystem(system);
        const savedRom = await this.repository.save({
            url: trimmed,
            status: TrackStatusEnum.Queued,
            system: systemInfo?.slug ?? null,
            systemManual: !!systemInfo,
        });
        await this.enqueue(savedRom.id);
        this.io.emit(WsOperation.New, savedRom);
    }

    /** Change the system of an entry; a finished download is moved to the matching folder. */
    async setSystem(id: number, system: string): Promise<RomEntity> {
        const rom = await this.getOrFail(id);
        const systemInfo = this.parseSystem(system);
        if (!systemInfo) {
            throw new BadRequestException('Unknown system');
        }
        const update: Partial<RomEntity> = {system: systemInfo.slug, systemManual: true};
        const current = this.filePath(rom);
        if (current && rom.status === TrackStatusEnum.Completed) {
            const moved = this.library.moveFile(current, this.library.targetDir(systemInfo.slug));
            update.relativePath = this.library.toRelative(moved);
            update.fileName = basename(moved);
            this.romm.scheduleScan(this.platformFolder(moved));
        }
        await this.updatePartial(id, update);
        return this.getOrFail(id);
    }

    async update(id: number, rom: RomEntity): Promise<void> {
        await this.repository.update(id, rom);
        this.io.emit(WsOperation.Update, rom);
    }

    async updatePartial(id: number, partialRom: Partial<RomEntity>): Promise<void> {
        const dbRom = await this.get(id);
        if (dbRom) {
            await this.update(id, {...dbRom, ...partialRom});
        }
    }

    async download(id: number): Promise<void> {
        const rom = await this.get(id);
        if (!rom) {
            return; // removed while waiting in the queue
        }
        await this.updatePartial(id, {status: TrackStatusEnum.Downloading, error: null, receivedBytes: 0});
        try {
            const manual = rom.systemManual ? findSystemBySlug(rom.system) : undefined;
            const result = await this.downloadService.download(
                rom.url,
                this.getEventName(id),
                (val: Partial<RomEntity>) => this.updatePartial(id, val),
                {system: manual, chooseDir: (system?: SystemInfo) => this.library.targetDir(system?.slug)},
            );

            let path = this.locateDownloadedFile(result.dir, result.fileName);
            let system = result.system;
            if (!system && path) {
                // Page did not tell us, maybe the file does (extension / ZIP content)
                system = this.library.detectFromFile(path);
                const target = this.library.targetDir(system?.slug);
                if (system && target !== result.dir) {
                    path = this.library.moveFile(path, target);
                }
            }

            await this.updatePartial(id, {
                status: TrackStatusEnum.Completed,
                system: system?.slug ?? null,
                fileName: path ? basename(path) : result.fileName,
                relativePath: path ? this.library.toRelative(path) : null,
            });
            if (path && system) {
                this.romm.scheduleScan(this.platformFolder(path));
            }
        } catch (error) {
            if (error instanceof DownloadCanceledError) {
                this.logger.debug(`Download of rom ${id} canceled`);
                return;
            }
            this.logger.error(`Download of rom ${id} failed: ${error}`);
            await this.updatePartial(id, {error: error instanceof Error ? error.message : String(error), status: TrackStatusEnum.Error});
        }
    }

    /**
     * Sorts already downloaded files that still sit in the root of the download folder.
     * - DB entries: known system > file extension / ZIP content > (online) Vimm page
     * - other files in the root: file extension / ZIP content only
     */
    async organize(options: { dryRun?: boolean; online?: boolean } = {}): Promise<OrganizeReport> {
        if (!this.library.organizeEnabled) {
            throw new BadRequestException('ORGANIZE_BY_SYSTEM is disabled');
        }
        if (this.organizing) {
            throw new BadRequestException('Already organizing');
        }
        this.organizing = true;
        const report: OrganizeReport = {dryRun: !!options.dryRun, moved: [], skipped: []};
        const touched = new Set<string>();
        try {
            const roms = await this.repository.find({where: {status: TrackStatusEnum.Completed}, order: {id: 'ASC'}});
            const handled = new Set<string>();
            let visitedPages = 0;

            for (const rom of roms) {
                const path = this.filePath(rom);
                if (!path) {
                    continue;
                }
                handled.add(path);
                if (dirname(path) !== this.library.root) {
                    continue; // already sorted
                }
                let system = findSystemBySlug(rom.system) ?? this.library.detectFromFile(path);
                if (!system && options.online) {
                    if (visitedPages++ > 0) {
                        await new Promise(r => setTimeout(r, ONLINE_DETECTION_DELAY_MS));
                    }
                    system = await this.downloadService.detectSystemForUrl(rom.url).catch(e => {
                        this.logger.warn(`Detecting system for ${rom.url} failed: ${e}`);
                        return undefined;
                    });
                }
                const entry = this.applyOrganize(path, system, !!options.dryRun, report, touched);
                if (entry && !options.dryRun) {
                    await this.updatePartial(rom.id, {
                        system: system.slug,
                        fileName: basename(entry),
                        relativePath: this.library.toRelative(entry),
                    });
                }
            }

            for (const path of this.library.listRootFiles()) {
                if (!handled.has(path)) {
                    this.applyOrganize(path, this.library.detectFromFile(path), !!options.dryRun, report, touched);
                }
            }
        } finally {
            this.organizing = false;
        }
        if (!options.dryRun && touched.size) {
            touched.forEach(folder => this.romm.scheduleScan(folder));
        }
        return report;
    }

    /** Returns the new absolute path if the file was (or would be) moved. */
    private applyOrganize(path: string, system: SystemInfo | undefined, dryRun: boolean,
                          report: OrganizeReport, touched: Set<string>): string | undefined {
        const file = this.library.toRelative(path);
        if (!system) {
            report.skipped.push({file, reason: 'System not detected – set it manually'});
            return undefined;
        }
        const target = this.library.targetDir(system.slug);
        if (dryRun) {
            report.moved.push({file, to: this.library.toRelative(join(target, basename(path))), system: system.slug});
            return undefined;
        }
        try {
            const moved = this.library.moveFile(path, target);
            report.moved.push({file, to: this.library.toRelative(moved), system: system.slug});
            touched.add(this.platformFolder(moved));
            return moved;
        } catch (e) {
            report.skipped.push({file, system: system.slug, reason: `Move failed: ${e}`});
            return undefined;
        }
    }

    /** Chrome renames to "name (1).ext" if the file already exists; find what was actually written. */
    private locateDownloadedFile(dir: string, fileName: string): string | undefined {
        const expected = join(dir, fileName);
        if (fs.existsSync(expected)) {
            return expected;
        }
        const ext = extname(fileName);
        const stem = basename(fileName, ext);
        try {
            return fs.readdirSync(dir)
                .filter(f => f.startsWith(stem) && f.endsWith(ext) && !f.endsWith('.crdownload'))
                .map(f => join(dir, f))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        } catch {
            return undefined;
        }
    }

    /** First path segment below the download root = RomM platform folder (structure A). */
    private platformFolder(absPath: string): string {
        const rel = this.library.toRelative(absPath).split('/');
        return rel.length > 1 ? rel[0] : '';
    }

    private parseSystem(system?: string | null): SystemInfo | undefined {
        if (!system) {
            return undefined;
        }
        const info = findSystemBySlug(system);
        if (!info) {
            throw new BadRequestException(`Unknown system "${system}"`);
        }
        return info;
    }

    private enqueue(id: number) {
        return this.downloadQueue.add('download', {id}, {
            jobId: this.getJobId(id),
            removeOnComplete: true,
            removeOnFail: true,
        });
    }

    private getJobId(id: number): string {
        return `id-${id}`;
    }

    private getEventName(id: number): string {
        return `cancel.${id}`;
    }
}
