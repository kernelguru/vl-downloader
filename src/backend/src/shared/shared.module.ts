import { Module } from '@nestjs/common';
import { UtilsService } from './services/utils.service';
import {ConfigModule} from "@nestjs/config";
import {DownloadService} from "./services/download.service";
import {LibraryService} from "../library/library.service";
import {RommService} from "../library/romm.service";

@Module({
  imports: [ConfigModule],
  providers: [UtilsService, DownloadService, LibraryService, RommService],
  controllers: [],
  exports: [UtilsService, DownloadService, LibraryService, RommService],
})
export class SharedModule {}
