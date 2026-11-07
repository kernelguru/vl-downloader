import {Injectable} from '@nestjs/common';
import {ConfigService} from "@nestjs/config";
import {basename, dirname, join, resolve} from "path";
import {EnvironmentEnum} from "../../../environment.enum";

@Injectable()
export class UtilsService {
    constructor(private readonly configService: ConfigService) {
    }

    getDownloadFolderPath(fileName?: string): string {
        return resolve(...[
            __dirname,
            '../../..',
            this.configService.get<string>(EnvironmentEnum.DOWNLOADS_PATH),
            fileName && basename(fileName),
        ].filter(Boolean));
    }

    /** Folder of the database (config volume). */
    getConfigFolderPath(): string {
        return dirname(resolve(__dirname, '../../..', process.env.DB_PATH || './config/db.sqlite'));
    }

    /** <config>/debug – screenshots and HTML of pages where a download failed. */
    getDebugFolderPath(fileName?: string): string {
        const dir = join(this.getConfigFolderPath(), 'debug');
        return fileName ? join(dir, basename(fileName)) : dir;
    }

    /** Where the built-in browser saves downloads; processed by the InboxService. INBOX_PATH, default ./inbox */
    getInboxFolderPath(): string {
        return resolve(__dirname, '../../..', process.env.INBOX_PATH || './inbox');
    }
}
