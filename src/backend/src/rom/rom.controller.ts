import {
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    Patch,
    ParseBoolPipe,
    ParseIntPipe,
    Post,
    Query,
    Res,
    StreamableFile,
} from '@nestjs/common';
import {RomService} from "./rom.service";
import {RomEntity} from "./rom.entity";
import {createReadStream, statSync} from 'fs';
import type {Response} from 'express';

@Controller('rom')
export class RomController {
    constructor(private readonly romService: RomService) {}

    @Get()
    getAll(): Promise<RomEntity[]> {
        return this.romService.getAll();
    }

    /** `?deleteFile=true` also removes the downloaded file from disk. */
    @Delete(':id')
    remove(
        @Param('id', ParseIntPipe) id: number,
        @Query('deleteFile', new ParseBoolPipe({optional: true})) deleteFile?: boolean,
    ): Promise<void> {
        return this.romService.remove(id, deleteFile ?? false);
    }

    @Get('retry/:id')
    retry(@Param('id', ParseIntPipe) id: number): Promise<void> {
        return this.romService.retry(id);
    }

    @Post()
    processUrl(@Body() body: { url: string; system?: string }): Promise<void> {
        return this.romService.create(body?.url, body?.system);
    }

    /** Set the system manually; a finished file is moved into the matching folder. */
    @Patch(':id/system')
    setSystem(@Param('id', ParseIntPipe) id: number, @Body() body: { system: string }): Promise<RomEntity> {
        return this.romService.setSystem(id, body?.system);
    }

    /** Screenshot of the Vimm page when the download failed (shown inline). */
    @Get(':id/debug/screenshot')
    async debugScreenshot(@Res({passthrough: true}) res: Response, @Param('id', ParseIntPipe) id: number): Promise<StreamableFile> {
        const rom = await this.romService.getOrFail(id);
        const path = this.romService.debugFilePath(rom, 'png');
        if (!path) {
            throw new NotFoundException('No screenshot for this entry');
        }
        res.set({'Content-Type': 'image/png', 'Content-Disposition': `inline; filename="${rom.debugFile}.png"`});
        return new StreamableFile(createReadStream(path));
    }

    /** HTML of the Vimm page when the download failed (always as download, never rendered here). */
    @Get(':id/debug/html')
    async debugHtml(@Res({passthrough: true}) res: Response, @Param('id', ParseIntPipe) id: number): Promise<StreamableFile> {
        const rom = await this.romService.getOrFail(id);
        const path = this.romService.debugFilePath(rom, 'html');
        if (!path) {
            throw new NotFoundException('No HTML dump for this entry');
        }
        res.set({
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `attachment; filename="${rom.debugFile}.html"`,
        });
        return new StreamableFile(createReadStream(path));
    }

    @Get('download/:id')
    async getFile(
        @Res({passthrough: true}) res: Response,
        @Param('id', ParseIntPipe) id: number,
    ): Promise<StreamableFile> {
        const rom = await this.romService.getOrFail(id);
        const path = this.romService.filePath(rom);
        if (!path) {
            throw new NotFoundException('File not found on disk');
        }
        if (statSync(path).isDirectory()) {
            throw new NotFoundException('This game is a folder with several files – get it from the share');
        }
        const asciiName = rom.fileName.replace(/[^\x20-\x7e]|"/g, '_');
        res.set({
            'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rom.fileName)}`,
            'Content-Length': String(statSync(path).size),
        });
        return new StreamableFile(createReadStream(path));
    }
}
