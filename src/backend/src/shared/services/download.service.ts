import {Injectable, Logger} from '@nestjs/common';
import {RomEntity} from "../../rom/rom.entity";
import puppeteer, {Browser, CDPSession, Page, Protocol} from "puppeteer";
import {EventEmitter2} from "@nestjs/event-emitter";
import {basename, join} from "path";
import * as fs from "fs";

const CdpEvents = {
    DownloadWillBegin: 'Browser.downloadWillBegin',
    DownloadProgress: 'Browser.downloadProgress',
    SetDownloadBehavior: 'Browser.setDownloadBehavior',
} as const;

type DownloadWillBeginEvent = Protocol.Browser.DownloadWillBeginEvent;
type DownloadProgressEvent = Protocol.Browser.DownloadProgressEvent;

const SELECTORS = {
    cookieButton: '#qc-cmp2-container button[mode="primary"]',
    titleMeta: 'meta[property="og:title"]',
    downloadButton: '#dl_form button',
    acknowledgeButton: 'input[value="Continue"]',
};

const PUPPETEER_SETTINGS = {
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
};

const envMs = (name: string, fallbackSeconds: number): number => {
    const value = Number(process.env[name]);
    return (Number.isFinite(value) && value > 0 ? value : fallbackSeconds) * 1000;
};

/** Timeout for loading the ROM page. */
const PAGE_TIMEOUT_MS = envMs('PAGE_TIMEOUT', 60);
/** Time between clicking "download" and the browser actually starting the download. */
const DOWNLOAD_START_TIMEOUT_MS = envMs('DOWNLOAD_START_TIMEOUT', 90);
/** Abort the download if no progress was reported for this long. */
const DOWNLOAD_STALL_TIMEOUT_MS = envMs('DOWNLOAD_STALL_TIMEOUT', 180);
/** Minimum interval between progress updates written to the DB / pushed to the UI. */
const PROGRESS_THROTTLE_MS = 1000;

export class DownloadCanceledError extends Error {
    constructor() {
        super('Canceled');
        this.name = 'DownloadCanceledError';
    }
}

@Injectable()
export class DownloadService {
    private readonly logger = new Logger(DownloadService.name);

    constructor(private readonly eventEmitter: EventEmitter2) {}

    /**
     * Downloads a single ROM from its Vimm's Lair page.
     * Resolves when the file is completely written, rejects on error, timeout or cancel
     * (cancel = `eventName` emitted, rejects with DownloadCanceledError).
     */
    async download(
        romUrl: string,
        eventName: string,
        downloadPath: string,
        updateFn: (val: Partial<RomEntity>) => Promise<void>,
    ): Promise<void> {
        let launching: Promise<Browser> | undefined;
        let fileName: string | undefined;
        let guid: string | undefined;
        let completed = false;

        let rejectCancel: (e: Error) => void;
        const canceled = new Promise<never>((_, reject) => (rejectCancel = reject));
        canceled.catch(() => undefined); // avoid unhandled rejection if nobody awaits it
        const onCancel = () => rejectCancel(new DownloadCanceledError());
        this.eventEmitter.once(eventName, onCancel);

        const withCancel = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, canceled]);

        try {
            this.logger.debug('Starting Chrome');
            launching = puppeteer.launch(PUPPETEER_SETTINGS);
            const browser = await withCancel(launching);
            const browserSession = await browser.target().createCDPSession();
            await browserSession.send(CdpEvents.SetDownloadBehavior, {
                behavior: 'allow',
                downloadPath,
                eventsEnabled: true,
            });

            const page = await browser.newPage();
            this.logger.debug(`Go to ${romUrl}`);
            await withCancel(page.goto(romUrl, {waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS}));

            await this.acceptCookies(page);

            const name = await this.readTitle(page);
            this.logger.debug(`Name of rom is ${name}`);
            if (name) {
                await updateFn({name});
            }

            // Register listeners before clicking so no event is missed.
            const started = this.waitForDownloadStart(browserSession);
            await page.waitForSelector(SELECTORS.downloadButton, {timeout: PAGE_TIMEOUT_MS});
            await page.click(SELECTORS.downloadButton);
            this.logger.debug('Download clicked');

            // Some ROMs show an extra "Continue" prompt; click it if it shows up, ignore otherwise.
            page.waitForSelector(SELECTORS.acknowledgeButton, {timeout: DOWNLOAD_START_TIMEOUT_MS})
                .then(button => button?.click())
                .catch(() => undefined);

            const begin = await withCancel(started);
            guid = begin.guid;
            const {suggestedFilename} = begin;
            fileName = basename(suggestedFilename);
            this.logger.debug(`File name is ${fileName}, saving to ${downloadPath}`);
            await updateFn({fileName});

            await withCancel(this.waitForDownloadEnd(browserSession, guid, updateFn));
            completed = true;
            this.logger.debug('Completed');
        } finally {
            this.eventEmitter.removeListener(eventName, onCancel);
            // Also covers a cancel while Chrome was still starting.
            const browser = launching && await launching.catch(() => undefined);
            if (browser) {
                await browser.close().catch(e => this.logger.warn(`Closing browser failed: ${e}`));
                this.logger.debug('Browser closed');
            }
            if (!completed && (fileName || guid)) {
                this.removePartialFiles(downloadPath, [fileName && `${fileName}.crdownload`, guid]);
            }
        }
    }

    private async acceptCookies(page: Page): Promise<void> {
        try {
            const button = await page.waitForSelector(SELECTORS.cookieButton, {timeout: 3000});
            await button?.click();
        } catch {
            this.logger.debug('Cookie button not found');
        }
    }

    private async readTitle(page: Page): Promise<string | undefined> {
        try {
            return await page.$eval(SELECTORS.titleMeta, el => el.getAttribute('content') ?? undefined);
        } catch {
            return undefined;
        }
    }

    private waitForDownloadStart(session: CDPSession): Promise<DownloadWillBeginEvent> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                session.off(CdpEvents.DownloadWillBegin, handler);
                reject(new Error(`Download did not start within ${DOWNLOAD_START_TIMEOUT_MS / 1000}s`));
            }, DOWNLOAD_START_TIMEOUT_MS);
            const handler = (event: DownloadWillBeginEvent) => {
                clearTimeout(timer);
                session.off(CdpEvents.DownloadWillBegin, handler);
                resolve(event);
            };
            session.on(CdpEvents.DownloadWillBegin, handler);
        });
    }

    private waitForDownloadEnd(
        session: CDPSession,
        guid: string,
        updateFn: (val: Partial<RomEntity>) => Promise<void>,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            let lastUpdate = 0;
            let stallTimer: NodeJS.Timeout;

            const cleanup = () => {
                clearTimeout(stallTimer);
                session.off(CdpEvents.DownloadProgress, handler);
            };
            const armStallTimer = () => {
                clearTimeout(stallTimer);
                stallTimer = setTimeout(() => {
                    cleanup();
                    reject(new Error(`No download progress for ${DOWNLOAD_STALL_TIMEOUT_MS / 1000}s`));
                }, DOWNLOAD_STALL_TIMEOUT_MS);
            };

            const handler = (event: DownloadProgressEvent) => {
                if (event.guid !== guid) {
                    return;
                }
                armStallTimer();
                if (event.state === 'completed') {
                    cleanup();
                    const total = event.totalBytes || event.receivedBytes;
                    updateFn({totalBytes: total, receivedBytes: total}).then(() => resolve(), reject);
                } else if (event.state === 'canceled') {
                    cleanup();
                    reject(new Error('Download was canceled by the browser'));
                } else if (Date.now() - lastUpdate >= PROGRESS_THROTTLE_MS) {
                    lastUpdate = Date.now();
                    updateFn({totalBytes: event.totalBytes, receivedBytes: event.receivedBytes})
                        .catch(e => this.logger.warn(`Progress update failed: ${e}`));
                }
            };

            armStallTimer();
            session.on(CdpEvents.DownloadProgress, handler);
        });
    }

    private removePartialFiles(downloadPath: string, candidates: (string | undefined)[]): void {
        // Chrome writes to "<name>.crdownload" (or a guid-named temp file) until the download is finished.
        for (const candidate of candidates) {
            if (!candidate) {
                continue;
            }
            const partial = join(downloadPath, basename(candidate));
            try {
                if (fs.existsSync(partial)) {
                    fs.unlinkSync(partial);
                    this.logger.debug(`Removed partial file ${partial}`);
                }
            } catch (e) {
                this.logger.warn(`Unable to remove partial file ${partial}: ${e}`);
            }
        }
    }
}
