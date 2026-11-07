import {Component, EventEmitter, Input, Output} from '@angular/core';
import {CommonModule} from '@angular/common';
import {NgxFilesizeModule} from 'ngx-filesize';
import {Rom, TrackStatusEnum} from '../services/rom.service';

@Component({
  selector: 'app-rom',
  imports: [CommonModule, NgxFilesizeModule],
  templateUrl: './rom.component.html',
  standalone: true,
  styleUrl: './rom.component.scss'
})
export class RomComponent {

  @Input() rom!: Rom;
  @Output() remove: EventEmitter<number> = new EventEmitter();
  @Output() retry: EventEmitter<number> = new EventEmitter();
  trackStatusEnum = TrackStatusEnum;

  get percentage(): string {
    const total = this.rom.totalBytes ?? 0;
    if (!total) {
      return this.rom.status === TrackStatusEnum.Completed ? '100.00' : '0.00';
    }
    return Math.min(100, ((this.rom.receivedBytes ?? 0) * 100) / total).toFixed(2);
  }

}
