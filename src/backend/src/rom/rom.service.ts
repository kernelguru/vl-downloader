import {BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap} from '@nestjs/common';
import {Queue} from "bullmq";
import {InjectQueue} from "@nestjs/bullmq";
import {RomEntity, TrackStatusEnum} from "./rom.entity";
import {InjectRepository} from "@nestjs/typeorm";
import {In, Repository} from "typeorm";
import {WebSocketGateway, WebSocketServer} from "@nestjs/websockets";
import {Server} from 'socket.io';
import {UtilsService} from "../shared/services/utils.service";
import {EventEmitter2} from "@nestjs/event-emitter";
import {DownloadCanceledError, DownloadService} from "../shared/services/download.service";
import * as fs from "fs";

enum WsOperation {
    New = 'new',
    Update = 'update',
    Delete = 'delete',
}

/** Same pattern the frontend uses: only single Vimm's Lair vault pages are accepted. */
const ROM_URL_REGEXP = /^https:\/\/vimm\.net\/vault\/\d+\/?$/;

@WebSocketGateway()
@Injectable()
export class RomService implements OnApplicationBootstrap {
    @WebSocketServer() io: Server;
    private readonly logger = new Logger(RomService.name);

    constructor(
        @InjectRepository(RomEntity) private repository: Repository<RomEntity>,
        @InjectQueue('download') private downloadQueue: Queue,
        private readonly eventEmitter: EventEmitter2,
        private readonly utilsService: UtilsService,
        private readonly downloadService: DownloadService,
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

    async remove(id: number, deleteFile = false): Promise<void> {
        const rom = await this.getOrFail(id);
        // Cancel a running download and drop a still-waiting job.
        this.eventEmitter.emit(this.getEventName(id));
        await this.downloadQueue.remove(this.getJobId(id)).catch(() => undefined);
        await this.repository.delete(id);
        if (deleteFile) {
            this.deleteFile(rom);
        }
        this.io.emit(WsOperation.Delete, {id});
    }

    async retry(id: number): Promise<void> {
        const rom = await this.getOrFail(id);
        await this.remove(rom.id);
        await this.create(rom.url);
    }

    async create(url: string): Promise<void> {
        const trimmed = (url ?? '').trim();
        if (!ROM_URL_REGEXP.test(trimmed)) {
            throw new BadRequestException('Expected a Vimm\'s Lair vault URL like https://vimm.net/vault/12345');
        }
        const savedRom = await this.repository.save({url: trimmed, status: TrackStatusEnum.Queued});
        await this.enqueue(savedRom.id);
        this.io.emit(WsOperation.New, savedRom);
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
            await this.downloadService.download(
                rom.url,
                this.getEventName(id),
                this.utilsService.getDownloadFolderPath(),
                (val: Partial<RomEntity>) => this.updatePartial(id, val),
            );
            await this.updatePartial(id, {status: TrackStatusEnum.Completed});
        } catch (error) {
            if (error instanceof DownloadCanceledError) {
                this.logger.debug(`Download of rom ${id} canceled`);
                return;
            }
            this.logger.error(`Download of rom ${id} failed: ${error}`);
            await this.updatePartial(id, {error: error instanceof Error ? error.message : String(error), status: TrackStatusEnum.Error});
        }
    }

    private enqueue(id: number) {
        return this.downloadQueue.add('download', {id}, {
            jobId: this.getJobId(id),
            removeOnComplete: true,
            removeOnFail: true,
        });
    }

    private deleteFile(rom: RomEntity): void {
        if (!rom.fileName) {
            return;
        }
        const path = this.utilsService.getDownloadFolderPath(rom.fileName);
        try {
            fs.existsSync(path) && fs.unlinkSync(path);
        } catch (e) {
            this.logger.warn(`Unable to delete ${path}: ${e}`);
        }
    }

    private getJobId(id: number): string {
        return `id-${id}`;
    }

    private getEventName(id: number): string {
        return `cancel.${id}`;
    }
}
