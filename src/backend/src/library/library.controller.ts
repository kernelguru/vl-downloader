import {Controller, Get, ParseBoolPipe, Post, Query} from '@nestjs/common';
import {LibraryService} from './library.service';
import {RommService, RommStatus} from './romm.service';
import {OrganizeReport, RomService} from '../rom/rom.service';

@Controller('library')
export class LibraryController {
    constructor(private readonly library: LibraryService,
                private readonly romm: RommService,
                private readonly romService: RomService) {}

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
