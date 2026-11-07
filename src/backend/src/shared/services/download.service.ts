import {Injectable, Logger} from '@nestjs/common';
import {RomEntity} from "../../rom/rom.entity";
import puppeteer, {Browser, CDPSession, Page, Protocol} from "puppeteer";
import {EventEmitter2} from "@nestjs/event-emitter";
import {basename, dirname, join, resolve} from "path";
import * as fs from "fs";
import {findSystemByName, findSystemByVimmCode, findSystemInTitle, SystemInfo} from "../../library/systems";

export interface DownloadResult {
    fileName: string;
    /** Absolute directory the file was written to */
    dir: string;
    /** System detected on the Vimm page (if any) */
    system?: SystemInfo;
}

export interface DownloadOptions {
    /** System chosen by the user; skips page detection */
    system?: SystemInfo;
    /** Returns the directory to download into, given the detected system */
    chooseDir: (system?: SystemInfo) => string;
    /** Used to name screenshot / HTML dumps when something goes wrong */
    debugName?: string;
}

/** Headless Chrome announces itself as "HeadlessChrome"; use a regular desktop UA instead. */
const USER_AGENT = process.env.USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Raw hints collected inside the page, interpreted in Node (see detectSystem). */
interface PageSystemHints {
    contentCodes: string[];
    navCodes: string[];
    headings: string[];
    titles: string[];
    inputs: string[];
}

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
    /** Tried in this order; the first one found on the page is clicked. */
    downloadButtons: [
        '#dl_form button[type="submit"]',
        '#dl_form button',
        '#dl_form input[type="submit"]',
        'form[action*="download" i] button',
        'form[action*="download" i] input[type="submit"]',
    ],
    acknowledgeButton: 'input[value="Continue"]',
};

const PUPPETEER_SETTINGS = {
    headless: true,
    args: [
        '--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
    ],
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
        updateFn: (val: Partial<RomEntity>) => Promise<void>,
        options: DownloadOptions,
    ): Promise<DownloadResult> {
        let downloadPath: string | undefined;
        let launching: Promise<Browser> | undefined;
        let fileName: string | undefined;
        let guid: string | undefined;
        let completed = false;

        let rejectCancel: (e: Error) => void;
        const canceled = new Promise<never>((_, reject) => (rejectCancel = reject));
        canceled.catch(() => undefined); // avoid unhandled rejection if nobody awaits it
        const onCancel = () => rejectCancel(new DownloadCanceledError());
        this.eventEmitter.once(eventName, onCancel);

        // The losing promise of a race may reject later (e.g. a timeout after cancel or browser close).
        // Mark it handled so Node does not crash on an unhandled rejection; the race still propagates.
        const withCancel = <T>(promise: Promise<T>): Promise<T> => {
            promise.catch(() => undefined);
            return Promise.race([promise, canceled]);
        };

        try {
            this.logger.debug('Starting Chrome');
            launching = puppeteer.launch(PUPPETEER_SETTINGS);
            const browser = await withCancel(launching);
            const browserSession = await browser.target().createCDPSession();

            const page = await this.newPage(browser);
            this.logger.debug(`Go to ${romUrl}`);
            await withCancel(page.goto(romUrl, {waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS}));

            await this.acceptCookies(page);

            const name = await this.readTitle(page);
            this.logger.debug(`Name of rom is ${name}`);
            if (name) {
                await updateFn({name});
            }

            const system = options.system ?? await this.detectSystem(page, name);
            this.logger.debug(`System is ${system?.slug ?? 'unknown'}`);
            downloadPath = options.chooseDir(system);
            fs.mkdirSync(downloadPath, {recursive: true});
            await browserSession.send(CdpEvents.SetDownloadBehavior, {
                behavior: 'allow',
                downloadPath,
                eventsEnabled: true,
            });

            // Register listeners before clicking so no event is missed.
            const started = this.waitForDownloadStart(browserSession);
            started.catch(() => undefined); // awaited below; may reject if clicking fails first
            const button = await withCancel(this.findDownloadButton(page, options.debugName));
            await button.click();
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
            return {fileName, dir: downloadPath, system};
        } finally {
            this.eventEmitter.removeListener(eventName, onCancel);
            // Also covers a cancel while Chrome was still starting.
            const browser = launching && await launching.catch(() => undefined);
            if (browser) {
                await browser.close().catch(e => this.logger.warn(`Closing browser failed: ${e}`));
                this.logger.debug('Browser closed');
            }
            if (!completed && downloadPath && (fileName || guid)) {
                this.removePartialFiles(downloadPath, [fileName && `${fileName}.crdownload`, guid]);
            }
        }
    }

    /**
     * Opens a Vimm page only to find out which system it belongs to
     * (used when sorting files that were downloaded before this feature existed).
     */
    async detectSystemForUrl(romUrl: string): Promise<SystemInfo | undefined> {
        const browser = await puppeteer.launch(PUPPETEER_SETTINGS);
        try {
            const page = await this.newPage(browser);
            await page.goto(romUrl, {waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS});
            await this.acceptCookies(page);
            return await this.detectSystem(page, await this.readTitle(page));
        } finally {
            await browser.close().catch(() => undefined);
        }
    }

    /**
     * The Vimm page layout is not an API, so several hints are combined, most specific first:
     * 1. links to a system section (/vault/N64) outside of navigation menus
     * 2. headings / form fields whose whole text is a system name
     * 3. "(System)" in the page / og title
     * 4. a single system link anywhere (incl. menus)
     */
    private async detectSystem(page: Page, title?: string): Promise<SystemInfo | undefined> {
        let hints: PageSystemHints;
        try {
            hints = await page.evaluate(() => {
                const navSelector = 'nav, header, footer, #menu, #nav, .menu, .navbar, [class*="menu"], [id*="menu"], [class*="nav"], [id*="nav"]';
                const contentCodes: string[] = [];
                const navCodes: string[] = [];
                document.querySelectorAll('a[href]').forEach(a => {
                    const href = a.getAttribute('href') ?? '';
                    const match = href.match(/(?:^|vimm\.net)\/vault\/([A-Za-z][A-Za-z0-9]*)\/?(?:[?#].*)?$/);
                    if (match) {
                        (a.closest(navSelector) ? navCodes : contentCodes).push(match[1]);
                    }
                });
                const headings = Array.from(document.querySelectorAll('h1, h2, h3, .sectionTitle, [class*="system"], [id*="system"]'))
                    .filter(el => !el.closest(navSelector))
                    .map(el => (el.textContent ?? '').trim())
                    .filter(text => text.length > 0 && text.length < 60);
                const inputs = Array.from(document.querySelectorAll('input[name="system"], select[name="system"] option:checked'))
                    .map(el => (el as HTMLInputElement).value ?? el.textContent ?? '');
                const titles = [document.title, document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? ''];
                return {contentCodes, navCodes, headings, titles, inputs};
            });
        } catch (e) {
            this.logger.debug(`System detection failed: ${e}`);
            return undefined;
        }

        const unique = (systems: (SystemInfo | undefined)[]) => {
            const found = [...new Set(systems.filter(Boolean))];
            return found.length === 1 ? found[0] : undefined;
        };

        return unique(hints.inputs.map(v => findSystemByVimmCode(v) ?? findSystemByName(v)))
            ?? unique(hints.contentCodes.map(findSystemByVimmCode))
            ?? unique(hints.headings.map(findSystemByName))
            ?? [title, ...hints.titles].map(findSystemInTitle).find(Boolean)
            ?? unique(hints.navCodes.map(findSystemByVimmCode));
    }

    private async newPage(browser: Browser): Promise<Page> {
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setExtraHTTPHeaders({'Accept-Language': 'en-US,en;q=0.9'});
        return page;
    }

    /**
     * Waits for one of the known download buttons. If none shows up, the page is analysed
     * (unavailable title, bot protection, …), a screenshot + HTML are saved and a readable error is thrown.
     */
    private async findDownloadButton(page: Page, debugName?: string) {
        const selectors = SELECTORS.downloadButtons;
        try {
            await page.waitForFunction(
                (list: string[]) => list.some(sel => document.querySelector(sel)),
                {timeout: PAGE_TIMEOUT_MS, polling: 500},
                selectors,
            );
            for (const selector of selectors) {
                const button = await page.$(selector);
                if (button) {
                    this.logger.debug(`Download button found via ${selector}`);
                    return button;
                }
            }
        } catch {
            // analysed below
        }
        const reason = await this.explainMissingButton(page);
        const dump = await this.saveDebugDump(page, debugName);
        throw new Error(`Download button not found: ${reason}${dump ? ` (screenshot/HTML: ${dump})` : ''}`);
    }

    private async explainMissingButton(page: Page): Promise<string> {
        try {
            const {title, text, url, hasForm} = await page.evaluate(() => ({
                title: document.title,
                text: (document.body?.innerText ?? '').slice(0, 20000),
                url: location.href,
                hasForm: !!document.querySelector('#dl_form'),
            }));
            const lower = text.toLowerCase();
            if (/just a moment|checking your browser|cf-chl|verify you are human|captcha|attention required/.test(lower + title.toLowerCase())) {
                return `bot protection page ("${title}") – Vimm's Lair blocks the headless browser`;
            }
            if (/unavailable|not available|no longer available|removed at the request|download disabled/.test(lower)) {
                const line = text.split('\n').find(l => /unavailable|not available|removed|disabled/i.test(l))?.trim();
                return `download not available for this title${line ? ` ("${line.slice(0, 160)}")` : ''}`;
            }
            if (/too many|rate limit|try again later|slow down/.test(lower)) {
                return 'Vimm\'s Lair is rate limiting, try again later';
            }
            if (!/vimm\.net\/vault\//.test(url)) {
                return `redirected to ${url}`;
            }
            return hasForm
                ? `#dl_form exists but contains no known button – the page layout probably changed (title "${title}")`
                : `no download form on the page – the page layout probably changed (title "${title}")`;
        } catch (e) {
            return `page could not be analysed (${e})`;
        }
    }

    /** Saves <config>/debug/<name>.png and .html; returns the folder-relative name or undefined. */
    private async saveDebugDump(page: Page, debugName?: string): Promise<string | undefined> {
        try {
            const configDir = dirname(resolve(__dirname, '..', '..', '..', process.env.DB_PATH || './config/db.sqlite'));
            const dir = join(configDir, 'debug');
            fs.mkdirSync(dir, {recursive: true});
            const name = `${(debugName || 'download').replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            await page.screenshot({path: join(dir, `${name}.png`) as `${string}.png`, fullPage: true});
            fs.writeFileSync(join(dir, `${name}.html`), await page.content());
            this.logger.warn(`Saved page dump to ${join(dir, name)}.{png,html}`);
            return `config/debug/${name}`;
        } catch (e) {
            this.logger.warn(`Unable to save debug dump: ${e}`);
            return undefined;
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
