import {Processor, WorkerHost} from "@nestjs/bullmq";
import {Job} from "bullmq";
import {RomService} from "./rom.service";

// Concurrency stays at 1 on purpose: one ROM at a time, to be gentle with Vimm's Lair.
@Processor('download')
export class RomConsumer extends WorkerHost {
    constructor(private readonly romService: RomService) {
        super();
    }

    async process(job: Job<{ id: number }>): Promise<void> {
        if (job.name === 'download') {
            await this.romService.download(job.data.id);
        }
    }
}
