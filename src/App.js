import React from "react";

import {
  WebrcadeRetroApp
} from '@webrcade/app-common';

import { Emulator } from './emulator';
import { EmulatorPauseScreen } from './pause';

import './App.scss';

class App extends WebrcadeRetroApp {
  // WRC - isDiscBased isn't overridden here since - matching the other
  // disc-based cores - it comes from this app's own APP_TYPES entry in
  // applist.js, not per-app React code.
  createEmulator(app, isDebug) {
    return new Emulator(app, isDebug);
  }

  // WRC - flycast has a built-in HLE BIOS ("reios", core/reios/reios.cpp)
  // that it falls back to automatically whenever a real BIOS isn't present
  // (core/emulator.cpp, ~line 599: "if (config::UseReios ||
  // !nvmem::loadFiles()) { nvmem::loadHle(); ..."), but that fallback path
  // is also what triggers a real crash (zip_source_buffer_create, found
  // during flycast-wasm performance debugging) on some builds, and reios
  // has materially worse game compatibility than a real dump. Requiring
  // the real BIOS avoids that fallback path entirely.
  isBiosRequired() {
    return true;
  }

  // WRC - flycast appends "/dc/" to whatever RETRO_ENVIRONMENT_GET_SYSTEM_
  // DIRECTORY returns (see core/nvmem.cpp), so the real BIOS files must land
  // at system/dc/dc_boot.bin + system/dc/dc_flash.bin, not directly under
  // system/. The "dc/" prefix baked into these filenames is what the
  // onWriteAdditionalFiles() override below (see emulator/index.js) creates
  // a directory for before this map's files get written by the generic
  // BIOS-copy loop in RetroAppWrapper.onStart().
  getBiosMap() {
    return {
      // Standard USA/PAL Dreamcast BIOS (HKT-0120 v1.01d)
      'e10c53c2f8b90bab96ead2d368858623': 'dc/dc_boot.bin',
      // Standard USA/PAL Dreamcast flash/nvmem image
      '9338b10ee6f13fbc8bfcd6276e156fad': 'dc/dc_flash.bin',
    };
  }

  getBiosUrls(appProps) {
    return appProps.flycast_bios;
  }

  renderPauseScreen() {
    const { appProps, emulator } = this;

    return (
      <EmulatorPauseScreen
        emulator={emulator}
        appProps={appProps}
        closeCallback={() => this.resume()}
        exitCallback={() => {
          this.exitFromPause();
        }}
        isEditor={this.isEditor}
        isStandalone={this.isStandalone}
      />
    );
  }
}

export default App;
