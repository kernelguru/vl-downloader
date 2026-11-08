import {Component, ElementRef, EventEmitter, OnDestroy, OnInit, Output, ViewChild} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {HttpClient} from '@angular/common/http';

const FRAME_URL = '/api/library/browser/frame';
const INPUT_URL = '/api/library/browser/input';
const FRAME_INTERVAL_MS = 250; // ~4 frames per second
const LONG_PRESS_MS = 550;
const ZOOM_STEPS = [1, 1.5, 2, 3];

/**
 * Phone-friendly remote view of the server's Firefox:
 * live screenshot, tap = click, long press = move the mouse (hover), pinch / buttons to zoom.
 */
@Component({
  selector: 'app-live-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './live-view.component.html',
  styleUrl: './live-view.component.scss',
})
export class LiveViewComponent implements OnInit, OnDestroy {
  @Output() closed = new EventEmitter<void>();
  @ViewChild('screen', {static: true}) screen!: ElementRef<HTMLImageElement>;

  src?: string;
  screenWidth = 0;
  screenHeight = 0;
  zoomIndex = 0;
  text = '';
  error?: string;
  marker?: { x: number; y: number; kind: 'click' | 'move' };
  fps = 0;

  private etag?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private loading = false;
  private frames = 0;
  private fpsTimer?: ReturnType<typeof setInterval>;
  private pressTimer?: ReturnType<typeof setTimeout>;
  private pressStart?: { x: number; y: number };
  private suppressClick = false;
  private markerTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly http: HttpClient) {}

  get zoom(): number {
    return ZOOM_STEPS[this.zoomIndex];
  }

  ngOnInit(): void {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.fpsTimer = setInterval(() => {
      this.fps = this.frames;
      this.frames = 0;
    }, 1000);
    this.loop();
  }

  ngOnDestroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.fpsTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.src) {
      URL.revokeObjectURL(this.src);
    }
  }

  // ---------- frames ----------

  private readonly onVisibility = () => {
    if (!document.hidden) {
      this.refreshSoon(0);
    }
  };

  private loop(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.timer);
    const started = Date.now();
    this.fetchFrame().finally(() => {
      if (this.stopped || document.hidden) {
        return; // resumes on visibilitychange
      }
      this.timer = setTimeout(() => this.loop(), Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
    });
  }

  private refreshSoon(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loop(), delay);
  }

  private async fetchFrame(): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    try {
      const res = await fetch(FRAME_URL, {
        cache: 'no-store',
        headers: this.etag ? {'If-None-Match': this.etag} : {},
      });
      if (res.status === 304) {
        this.error = undefined;
        return;
      }
      if (!res.ok) {
        this.error = res.status === 400 ? 'Browser is not running' : `Error ${res.status}`;
        return;
      }
      this.etag = res.headers.get('ETag') ?? undefined;
      this.screenWidth = Number(res.headers.get('X-Screen-Width')) || this.screenWidth;
      this.screenHeight = Number(res.headers.get('X-Screen-Height')) || this.screenHeight;
      const blob = await res.blob();
      const old = this.src;
      this.src = URL.createObjectURL(blob);
      if (old) {
        setTimeout(() => URL.revokeObjectURL(old), 1000);
      }
      this.frames++;
      this.error = undefined;
    } catch {
      this.error = 'Connection lost – retrying…';
    } finally {
      this.loading = false;
    }
  }

  // ---------- pointer ----------

  /** Maps a point on the shown image to screen pixels of the server display. */
  private toScreen(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const img = this.screen.nativeElement;
    const rect = img.getBoundingClientRect();
    const width = this.screenWidth || img.naturalWidth;
    const height = this.screenHeight || img.naturalHeight;
    if (!rect.width || !rect.height || !width || !height) {
      return undefined;
    }
    const x = Math.round(((clientX - rect.left) / rect.width) * width);
    const y = Math.round(((clientY - rect.top) / rect.height) * height);
    if (x < 0 || y < 0 || x > width || y > height) {
      return undefined;
    }
    return {x, y};
  }

  onTap(event: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const point = this.toScreen(event.clientX, event.clientY);
    if (point) {
      this.showMarker(event, 'click');
      this.send({action: 'click', ...point});
    }
  }

  onDoubleTap(event: MouseEvent): void {
    event.preventDefault();
  }

  onTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      this.cancelPress(); // pinch zoom
      return;
    }
    const touch = event.touches[0];
    this.pressStart = {x: touch.clientX, y: touch.clientY};
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => {
      const start = this.pressStart;
      const point = start && this.toScreen(start.x, start.y);
      if (point) {
        this.suppressClick = true;
        this.showMarkerAt(start!.x, start!.y, 'move');
        this.send({action: 'move', ...point});
      }
    }, LONG_PRESS_MS);
  }

  onTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (!this.pressStart || !touch) {
      return;
    }
    if (Math.hypot(touch.clientX - this.pressStart.x, touch.clientY - this.pressStart.y) > 10) {
      this.cancelPress(); // panning, not a long press
    }
  }

  onTouchEnd(): void {
    clearTimeout(this.pressTimer);
    this.pressStart = undefined;
  }

  private cancelPress(): void {
    clearTimeout(this.pressTimer);
    this.pressStart = undefined;
  }

  onWheel(event: WheelEvent): void {
    if (event.ctrlKey) {
      return; // trackpad pinch
    }
    event.preventDefault();
    const point = this.toScreen(event.clientX, event.clientY);
    this.send({action: 'scroll', dy: Math.sign(event.deltaY) * Math.min(5, Math.ceil(Math.abs(event.deltaY) / 50)), ...point});
  }

  private showMarker(event: MouseEvent, kind: 'click' | 'move'): void {
    this.showMarkerAt(event.clientX, event.clientY, kind);
  }

  private showMarkerAt(clientX: number, clientY: number, kind: 'click' | 'move'): void {
    const wrap = this.screen.nativeElement.parentElement!.getBoundingClientRect();
    this.marker = {x: clientX - wrap.left, y: clientY - wrap.top, kind};
    clearTimeout(this.markerTimer);
    this.markerTimer = setTimeout(() => (this.marker = undefined), 600);
  }

  // ---------- toolbar ----------

  scroll(dy: number): void {
    this.send({action: 'scroll', dy});
  }

  key(key: string): void {
    this.send({action: 'key', key});
  }

  nav(action: 'back' | 'forward' | 'reload'): void {
    this.send({action});
  }

  sendText(): void {
    if (!this.text) {
      return;
    }
    this.send({action: 'type', text: this.text});
    this.text = '';
  }

  zoomIn(): void {
    this.zoomIndex = Math.min(ZOOM_STEPS.length - 1, this.zoomIndex + 1);
  }

  zoomOut(): void {
    this.zoomIndex = Math.max(0, this.zoomIndex - 1);
  }

  private send(body: object): void {
    this.http.post(INPUT_URL, body).subscribe({
      next: () => {
        this.refreshSoon(80);
        setTimeout(() => this.refreshSoon(0), 400);
      },
      error: err => (this.error = err?.error?.message ?? 'Input failed'),
    });
  }
}
