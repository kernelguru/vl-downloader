import {Injectable, Logger, OnModuleDestroy} from '@nestjs/common';

export interface RommStatus {
    enabled: boolean;
    url?: string;
    lastScan?: { at: string; ok: boolean; message: string };
}

/**
 * Triggers a RomM library scan after downloads finished.
 *
 * Env:
 * - ROMM_URL          e.g. http://192.168.1.10:8080 (enables the integration)
 * - ROMM_API_TOKEN    RomM client API token (rmm_…), needs the "tasks.run" scope
 * - ROMM_USERNAME / ROMM_PASSWORD   alternative: basic auth with a RomM user
 * - ROMM_SCAN_DELAY   seconds to wait after the last finished download before scanning (default 30)
 *
 * Newer RomM versions get `POST /api/tasks/scan` limited to the touched platform folders,
 * older ones fall back to `POST /api/tasks/run/scan_library`.
 */
@Injectable()
export class RommService implements OnModuleDestroy {
    private readonly logger = new Logger(RommService.name);
    private readonly baseUrl = (process.env.ROMM_URL ?? '').trim().replace(/\/+$/, '');
    private readonly delayMs = RommService.seconds(process.env.ROMM_SCAN_DELAY, 30) * 1000;
    private readonly pendingFolders = new Set<string>();
    private timer?: NodeJS.Timeout;
    private lastScan?: RommStatus['lastScan'];

    get enabled(): boolean {
        return !!this.baseUrl && !!this.authHeader();
    }

    status(): RommStatus {
        return {enabled: this.enabled, url: this.baseUrl || undefined, lastScan: this.lastScan};
    }

    /** Remember a platform folder and scan once downloads have been quiet for ROMM_SCAN_DELAY. */
    scheduleScan(platformFolder?: string): void {
        if (!this.enabled) {
            return;
        }
        platformFolder && this.pendingFolders.add(platformFolder);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.delayMs);
    }

    async scanNow(platformFolders: string[] = []): Promise<RommStatus['lastScan']> {
        if (!this.enabled) {
            return this.record(false, 'RomM integration is not configured (ROMM_URL + token or user/password)');
        }
        const folders = [...new Set(platformFolders.filter(Boolean))];
        try {
            let res = await this.post('/api/tasks/scan', folders.length ? {type: 'quick', platform_fs_slugs: folders} : undefined);
            if (res.status === 422 && folders.length) {
                // RomM version knows /tasks/scan but not platform_fs_slugs: scan everything
                res = await this.post('/api/tasks/scan');
            }
            if (res.status === 404 || res.status === 405) {
                res = await this.post('/api/tasks/run/scan_library');
            }
            if (res.status === 409) {
                // A scan is already running; try once more later so new files are picked up.
                folders.forEach(f => this.pendingFolders.add(f));
                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.flush(), Math.max(this.delayMs, 60_000));
                return this.record(true, 'RomM is already scanning, will retry');
            }
            if (!res.ok) {
                return this.record(false, `RomM answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
            }
            return this.record(true, folders.length ? `Scan queued for ${folders.join(', ')}` : 'Scan queued');
        } catch (e) {
            return this.record(false, `RomM not reachable: ${e instanceof Error ? e.message : e}`);
        }
    }

    onModuleDestroy(): void {
        clearTimeout(this.timer);
    }

    private async flush(): Promise<void> {
        const folders = [...this.pendingFolders];
        this.pendingFolders.clear();
        await this.scanNow(folders);
    }

    private post(path: string, body?: unknown): Promise<Response> {
        return fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                Authorization: this.authHeader()!,
                Accept: 'application/json',
                ...(body ? {'Content-Type': 'application/json'} : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15_000),
        });
    }

    private authHeader(): string | undefined {
        const token = process.env.ROMM_API_TOKEN?.trim();
        if (token) {
            return `Bearer ${token}`;
        }
        const user = process.env.ROMM_USERNAME;
        const password = process.env.ROMM_PASSWORD;
        if (user && password) {
            return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
        }
        return undefined;
    }

    private static seconds(value: string | undefined, fallback: number): number {
        const n = value?.trim() ? Number(value) : NaN;
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }

    private record(ok: boolean, message: string): RommStatus['lastScan'] {
        this.lastScan = {at: new Date().toISOString(), ok, message};
        (ok ? this.logger.log : this.logger.warn).call(this.logger, `RomM: ${message}`);
        return this.lastScan;
    }
}
