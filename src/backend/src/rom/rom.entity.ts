import {Column, Entity, PrimaryGeneratedColumn} from "typeorm";

export enum TrackStatusEnum {
    Queued,
    Downloading,
    Completed,
    Error,
}

@Entity()
export class RomEntity {
    @PrimaryGeneratedColumn()
    id?: number;

    @Column()
    url: string;

    @Column({default: 0})
    totalBytes?: number;

    @Column({default: 0})
    receivedBytes?: number;

    @Column({nullable: true})
    name?: string;

    @Column({nullable: true})
    fileName?: string;

    @Column({nullable: true})
    error?: string;

    /** RomM platform slug, e.g. "n64" */
    @Column({nullable: true})
    system?: string;

    /** true if the user picked the system instead of auto detection */
    @Column({default: false})
    systemManual?: boolean;

    /** "vimm" = automatic download of a Vimm URL, "inbox" = file from the built-in browser / inbox folder */
    @Column({default: 'vimm'})
    source?: string;

    /** Original file name in the inbox (archive) */
    @Column({nullable: true})
    sourceFile?: string;

    /** Current step for inbox files: downloading, extracting, sorting */
    @Column({nullable: true})
    stage?: string;

    /** Download speed while the built-in browser is downloading */
    @Column({nullable: true})
    bytesPerSecond?: number;

    /** Name of the page dump in <config>/debug (without .png/.html) if the download failed */
    @Column({nullable: true})
    debugFile?: string;

    /** Path relative to the download folder, e.g. "n64/Super Mario 64 (USA).zip" */
    @Column({nullable: true})
    relativePath?: string;

    @Column({ default: TrackStatusEnum.Queued })
    status: TrackStatusEnum;
}