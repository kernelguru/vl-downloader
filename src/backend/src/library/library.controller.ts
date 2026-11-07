import {Body, Controller, Get, ParseBoolPipe, Post, Query, Res} from '@nestjs/common';
import type {Response} from 'express';
import {InboxService, InboxStatus} from './inbox.service';
import {BrowserService, BrowserStatus, NOVNC_CLIENT_URL} from '../browser/browser.service';
import {LibraryService} from './library.service';
import {RommService, RommStatus} from './romm.service';
import {OrganizeReport, QueueStatus, RomService} from '../rom/rom.service';

@Controller('library')
export class LibraryController {
    constructor(private readonly library: LibraryService,
                private readonly romm: RommService,
                private readonly romService: RomService,
                private readonly inbox: InboxService,
                private readonly browser: BrowserService) {}

    @Get('inbox')
    inboxStatus(): InboxStatus {
        return this.inbox.status();
    }

    /** System for files arriving in the inbox; null/empty = detect automatically. */
    @Post('inbox/system')
    setInboxSystem(@Body() body: { system?: string | null }): InboxStatus {
        return this.inbox.setSystem(body?.system);
    }

    @Get('browser')
    browserStatus(): BrowserStatus {
        return this.browser.status();
    }

    /**
     * For the iOS share sheet / bookmarks: opens the Vimm page in the server's Firefox and
     * redirects to the full-screen browser view. GET so that a plain "Open URL" action is enough.
     */
    @Get('browser/open')
    async openInBrowserAndShow(@Query('url') url: string, @Res() res: Response): Promise<void> {
        await this.browser.openUrl(url);
        res.redirect(302, NOVNC_CLIENT_URL);
    }

    @Post('browser/open')
    openInBrowser(@Body() body: { url: string }): Promise<BrowserStatus> {
        return this.browser.openUrl(body?.url);
    }

    @Post('browser/restart')
    restartBrowser(): BrowserStatus {
        return this.browser.restartFirefox();
    }

    /** Systems that can be selected, with the folder they are stored in. */
    @Get('systems')
    systems() {
        return {organizeBySystem: this.library.organizeEnabled, systems: this.library.listSystems()};
    }

    /**
     * Sort files lying in the root of the download folder into system folders.
     * `?dryRun=true` only reports, `?online=true` also opens the Vimm page of entries
     * whose system can not be derived from the file (one page every few seconds).
     */
    @Post('organize')
    organize(
        @Query('dryRun', new ParseBoolPipe({optional: true})) dryRun?: boolean,
        @Query('online', new ParseBoolPipe({optional: true})) online?: boolean,
    ): Promise<OrganizeReport> {
        return this.romService.organize({dryRun, online});
    }

    @Get('queue')
    queueStatus(): QueueStatus {
        return this.romService.getQueueStatus();
    }

    @Post('queue/resume')
    resumeQueue(): Promise<QueueStatus> {
        return this.romService.resumeQueue();
    }

    @Post('queue/pause')
    pauseQueue(): Promise<QueueStatus> {
        return this.romService.pauseQueue('Paused manually');
    }

    @Get('romm')
    rommStatus(): RommStatus {
        return this.romm.status();
    }

    @Post('romm/scan')
    async rommScan(): Promise<RommStatus> {
        await this.romm.scanNow();
        return this.romm.status();
    }
}
