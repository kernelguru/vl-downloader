import {Injectable} from '@nestjs/common';
import {ConfigService} from "@nestjs/config";
import {basename, resolve} from "path";
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
}
