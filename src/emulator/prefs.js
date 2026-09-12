import {
  NewRetroPrefs
} from '@webrcade/app-common';

// WRC (2026-09-09): same convention as @webrcade/app-common's
// SCREEN_CONTROLS/BILINEAR_MODE (prefs.js/newprefs.js) - short-prefixed
// keys mapping to the actual persisted/config string values, so those
// values only ever get typed once. FS_OFF/FS_1/FS_2 are exactly what
// flycast's reicast_frame_skipping libretro core option accepts (see
// retrostash/flycast-wasm's source-canonical/shell/libretro/
// libretro_core_options.h) - FS_AUTO is not a real core value, it's
// resolved client-side (see emulator/index.js's resolveFrameSkip()/
// onFpsUpdate()).
export const FRAME_SKIP = {
  FS_AUTO: 'auto',
  FS_OFF: 'disabled',
  FS_1: '1',
  FS_2: '2',
};

// WRC (2026-09-08): reicast_frame_skipping is a flycast/Dreamcast-only
// libretro core option (see retrostash/flycast-wasm's source-canonical/
// shell/libretro/libretro_core_options.h) - same pattern as
// webrcade-app-beetle-psx/src/emulator/prefs.js's Prefs.getGpuResolution()/
// setGpuResolution() for its own core-specific gpuResolution field.
export class FlycastPrefs extends NewRetroPrefs {
  constructor(emu) {
    super(emu);

    this.emu = emu;
    const app = emu.getApp();

    this.frameSkipPath = app.getStoragePath(`${this.PREFS_PREFIX}.frameSkip`);
    this.frameSkip = FRAME_SKIP.FS_AUTO;
  }

  async load() {
    await super.load();
    this.frameSkip = await super.loadValue(this.frameSkipPath, this.frameSkip);
  }

  async save() {
    await super.save();
    await super.saveValue(this.frameSkipPath, this.frameSkip);
  }

  getFrameSkip() {
    return this.frameSkip;
  }

  setFrameSkip(value) {
    this.frameSkip = value;
  }
}
