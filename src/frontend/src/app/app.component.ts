import {Component} from '@angular/core';
import {OrganizeReport, Rom, RomService} from './services/rom.service';
import {FormControl, FormsModule, ReactiveFormsModule, Validators} from '@angular/forms';
import {Observable} from 'rxjs';
import {CommonModule} from '@angular/common';
import {RomComponent} from './rom/rom.component';
import {SafeUrlPipe} from './safe-url.pipe';

const REGEXP_URL = /^https:\/\/vimm\.net\/vault\/\d+\/?$/;

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, ReactiveFormsModule, RomComponent, SafeUrlPipe],
  templateUrl: './app.component.html',
  standalone: true,
  styleUrl: './app.component.scss'
})
export class AppComponent {

  form = new FormControl('', {validators: [Validators.required, Validators.pattern(REGEXP_URL)]});
  system = new FormControl<string>('', {nonNullable: true});
  all$: Observable<Rom[]>;

  browserOpen = false;
  readonly browserUrl = 'browser/vnc.html?autoconnect=true&reconnect=true&resize=scale&show_dot=true&path=browser/websockify';

  organizeOnline = false;
  organizeBusy = false;
  organizeReport?: OrganizeReport;
  organizeError?: string;

  constructor(readonly romService: RomService) {
    this.romService.fetch();
    this.all$ = this.romService.all$;
  }

  processUrl(): void {
    this.romService.processUrl(this.form.value!.trim(), this.system.value);
    this.form.reset();
  }

  remove({id, deleteFile}: { id: number; deleteFile: boolean }): void {
    this.romService.delete(id, deleteFile);
  }

  retry(id: number): void {
    this.romService.retry(id);
  }

  changeSystem({id, system}: { id: number; system: string }): void {
    this.romService.setSystem(id, system);
  }

  organize(dryRun: boolean): void {
    this.organizeBusy = true;
    this.organizeError = undefined;
    this.romService.organize(dryRun, this.organizeOnline).subscribe({
      next: report => {
        this.organizeReport = report;
        this.organizeBusy = false;
        if (!dryRun) {
          this.romService.fetch();
        }
      },
      error: err => {
        this.organizeError = err?.error?.message ?? 'Organizing failed';
        this.organizeBusy = false;
      },
    });
  }

  toggleBrowser(): void {
    this.browserOpen = !this.browserOpen;
    this.romService.refreshBrowser();
  }

  trackByFn(_: number, item: Rom): number {
    return item.id;
  }

  deleteCompleted(): void {
    this.romService.deleteCompleted();
  }

  deleteFailed(): void {
    this.romService.deleteFailed();
  }
}
