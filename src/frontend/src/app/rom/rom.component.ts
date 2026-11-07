import {Component, EventEmitter, Input, Output} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {NgxFilesizeModule} from 'ngx-filesize';
import {Rom, RomService, TrackStatusEnum} from '../services/rom.service';

@Component({
  selector: 'app-rom',
  imports: [CommonModule, FormsModule, NgxFilesizeModule],
  templateUrl: './rom.component.html',
  standalone: true,
  styleUrl: './rom.component.scss'
})
export class RomComponent {

  @Input() rom!: Rom;
  @Output() remove: EventEmitter<{ id: number; deleteFile: boolean }> = new EventEmitter();
  @Output() retry: EventEmitter<number> = new EventEmitter();
  @Output() changeSystem: EventEmitter<{ id: number; system: string }> = new EventEmitter();
  trackStatusEnum = TrackStatusEnum;
  editingSystem = false;
  selectedSystem = '';

  constructor(readonly romService: RomService) {}

  get percentage(): string {
    const total = this.rom.totalBytes ?? 0;
    if (!total) {
      return this.rom.status === TrackStatusEnum.Completed ? '100.00' : '0.00';
    }
    return Math.min(100, ((this.rom.receivedBytes ?? 0) * 100) / total).toFixed(2);
  }

  private static readonly STAGE_LABELS: Record<string, string> = {
    downloading: 'Downloading in browser', extracting: 'Extracting', sorting: 'Sorting',
  };
  private static readonly STAGE_ICONS: Record<string, string> = {
    downloading: 'fa-download', extracting: 'fa-box-open', sorting: 'fa-folder-tree',
  };

  get stageLabel(): string {
    const stage = this.rom.stage ?? '';
    return RomComponent.STAGE_LABELS[stage] ?? stage;
  }

  get stageIcon(): string {
    return RomComponent.STAGE_ICONS[this.rom.stage ?? ''] ?? 'fa-spinner';
  }

  get systemName(): string | undefined {
    return this.romService.systemName(this.rom.system);
  }

  startEditSystem(): void {
    this.selectedSystem = this.rom.system ?? '';
    this.editingSystem = true;
  }

  saveSystem(): void {
    if (this.selectedSystem && this.selectedSystem !== this.rom.system) {
      this.changeSystem.emit({id: this.rom.id, system: this.selectedSystem});
    }
    this.editingSystem = false;
  }
}
