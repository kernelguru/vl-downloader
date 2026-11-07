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

    /** Path relative to the download folder, e.g. "n64/Super Mario 64 (USA).zip" */
    @Column({nullable: true})
    relativePath?: string;

    @Column({ default: TrackStatusEnum.Queued })
    status: TrackStatusEnum;
}