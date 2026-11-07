import { Injectable } from '@angular/core';
import {createStore} from '@ngneat/elf';
import {
  deleteEntities,
  selectAllEntities,
  selectManyByPredicate,
  upsertEntities,
  withEntities
} from '@ngneat/elf-entities';
import {HttpClient} from '@angular/common/http';
import {Socket} from 'ngx-socket-io';
import {BehaviorSubject, Observable, take} from 'rxjs';

export enum TrackStatusEnum {
  Queued,
  Downloading,
  Completed,
  Error,
}

export interface Rom {
  id: number;
  url: string;
  status: TrackStatusEnum,
  totalBytes?: number;
  receivedBytes?: number;
  name?: string;
  fileName?: string;
  error?: string;
  system?: string | null;
  systemManual?: boolean;
  relativePath?: string | null;
  debugFile?: string | null;
}

export interface BrowserStatus {
  enabled: boolean;
  running: boolean;
  resolution: string;
  inbox: string;
  message?: string;
}

export interface InboxStatus {
  path: string;
  system: string | null;
  extract: boolean;
  pending: string[];
}

export interface QueueStatus {
  paused: boolean;
  reason?: string;
  since?: string;
}

export interface SystemOption {
  slug: string;
  name: string;
  folder: string;
}

export interface OrganizeEntry {
  file: string;
  to?: string;
  system?: string;
  reason?: string;
}

export interface OrganizeReport {
  dryRun: boolean;
  moved: OrganizeEntry[];
  skipped: OrganizeEntry[];
}

export interface RommStatus {
  enabled: boolean;
  url?: string;
  lastScan?: { at: string; ok: boolean; message: string };
}

const STORE_NAME = 'rom';
const ENDPOINT = '/api/rom';
const LIBRARY_ENDPOINT = '/api/library';
enum WsOperation {
  New = 'new',
  Update = 'update',
  Delete = 'delete',
}

@Injectable({
  providedIn: 'root'
})
export class RomService {

  private store = createStore(
    { name: STORE_NAME },
    withEntities<Rom>(),
  );

  all$ = this.store.pipe(selectAllEntities());
  finished$ = this.store.pipe(selectManyByPredicate(rom => rom.status === TrackStatusEnum.Completed));
  failed$ = this.store.pipe(selectManyByPredicate(rom => rom.status === TrackStatusEnum.Error));

  readonly systems$ = new BehaviorSubject<SystemOption[]>([]);
  readonly organizeBySystem$ = new BehaviorSubject<boolean>(true);
  readonly romm$ = new BehaviorSubject<RommStatus>({enabled: false});
  readonly queue$ = new BehaviorSubject<QueueStatus>({paused: false});
  readonly browser$ = new BehaviorSubject<BrowserStatus | undefined>(undefined);
  readonly inbox$ = new BehaviorSubject<InboxStatus | undefined>(undefined);

  constructor(
    private readonly http: HttpClient,
    private readonly socket: Socket,
    ) {
    this.initWsConnection();
  }

  fetch(): void {
    this.http.get<Rom[]>(ENDPOINT).subscribe((data: Rom[]) => this.store.update(upsertEntities(data)));
    this.http.get<{ organizeBySystem: boolean; systems: SystemOption[] }>(`${LIBRARY_ENDPOINT}/systems`)
      .subscribe(({organizeBySystem, systems}) => {
        this.organizeBySystem$.next(organizeBySystem);
        this.systems$.next(systems);
      });
    this.refreshRomm();
    this.http.get<QueueStatus>(`${LIBRARY_ENDPOINT}/queue`).subscribe(status => this.queue$.next(status));
    this.refreshBrowser();
  }

  refreshBrowser(): void {
    this.http.get<BrowserStatus>(`${LIBRARY_ENDPOINT}/browser`).subscribe(status => this.browser$.next(status));
    this.http.get<InboxStatus>(`${LIBRARY_ENDPOINT}/inbox`).subscribe(status => this.inbox$.next(status));
  }

  openInBrowser(url: string): Observable<BrowserStatus> {
    return this.http.post<BrowserStatus>(`${LIBRARY_ENDPOINT}/browser/open`, {url});
  }

  restartBrowser(): void {
    this.http.post<BrowserStatus>(`${LIBRARY_ENDPOINT}/browser/restart`, null).subscribe(status => this.browser$.next(status));
  }

  setInboxSystem(system: string | null): void {
    this.http.post<InboxStatus>(`${LIBRARY_ENDPOINT}/inbox/system`, {system: system || null})
      .subscribe(status => this.inbox$.next(status));
  }

  resumeQueue(): void {
    this.http.post<QueueStatus>(`${LIBRARY_ENDPOINT}/queue/resume`, null).subscribe(status => this.queue$.next(status));
  }

  processUrl(url: string, system?: string | null): void {
    this.http.post(ENDPOINT, {url, system: system || undefined}).subscribe();
  }

  delete(id: number, deleteFile = false): void {
    this.http.delete(`${ENDPOINT}/${id}`, {params: deleteFile ? {deleteFile: 'true'} : {}}).subscribe();
  }

  setSystem(id: number, system: string): void {
    this.http.patch<Rom>(`${ENDPOINT}/${id}/system`, {system})
      .subscribe(rom => this.store.update(upsertEntities(rom)));
  }

  organize(dryRun: boolean, online: boolean): Observable<OrganizeReport> {
    return this.http.post<OrganizeReport>(`${LIBRARY_ENDPOINT}/organize`, null, {
      params: {dryRun: String(dryRun), online: String(online)},
    });
  }

  refreshRomm(): void {
    this.http.get<RommStatus>(`${LIBRARY_ENDPOINT}/romm`).subscribe(status => this.romm$.next(status));
  }

  rommScan(): void {
    this.http.post<RommStatus>(`${LIBRARY_ENDPOINT}/romm/scan`, null).subscribe(status => this.romm$.next(status));
  }

  systemName(slug?: string | null): string | undefined {
    return slug ? this.systems$.value.find(s => s.slug === slug)?.name ?? slug : undefined;
  }

  retry(id: number): void {
    this.http.get(`${ENDPOINT}/retry/${id}`).subscribe();
  }

  deleteCompleted(): void {
    // take(1): otherwise the subscription stays alive and deletes every job that completes later
    this.finished$.pipe(take(1)).subscribe(finished => finished.forEach(item => this.delete(item.id)));
  }

  deleteFailed(): void {
    this.failed$.pipe(take(1)).subscribe(failed => failed.forEach(item => this.delete(item.id)));
  }

  private initWsConnection(): void {
    this.socket.on(WsOperation.Update, (rom: Rom) => this.store.update(upsertEntities(rom)));
    this.socket.on(WsOperation.Delete, ({id}: {id: number}) => this.store.update(deleteEntities(Number(id))));
    this.socket.on('queue', (status: QueueStatus) => this.queue$.next(status));
    this.socket.on(WsOperation.New, (playlist: Rom) => this.store.update(upsertEntities(playlist),));
  }
}
