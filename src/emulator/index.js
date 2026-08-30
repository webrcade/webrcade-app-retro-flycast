import {
  RetroAppWrapper,
  DisplayLoop,
  LOG,
  Controller,
  Controllers,
  KeyCodeToControlMapping,
  KCODES,
  CIDS,
} from '@webrcade/app-common';

// WRC - libretro's own standard RETRO_DEVICE_ID_JOYPAD_* bit positions
// (1<<id), used as the "input" bitmask passed to wrc_set_input(). Chosen
// deliberately (rather than an ad-hoc scheme like the N64 apps use) since
// flycast - unlike mupen64plus-next/parallel-n64 - has no hand-patched
// "wrc_on_input"-style glue reading wrc_input_state[] yet. Getting
// controller input actually working requires adding that glue to
// flycast's own Maple controller code (retrostash/flycast-wasm/source),
// matching the pattern in mupen64plus-libretro-nx's
// emulate_game_controller_via_libretro.c. Not done yet - this bit layout
// is forward-looking so that glue, when written, can just mirror standard
// libretro joypad IDs instead of inventing another one-off scheme.
const JOYPAD_B = 1 << 0;
const JOYPAD_Y = 1 << 1;
const JOYPAD_SELECT = 1 << 2;
const JOYPAD_START = 1 << 3;
const JOYPAD_UP = 1 << 4;
const JOYPAD_DOWN = 1 << 5;
const JOYPAD_LEFT = 1 << 6;
const JOYPAD_RIGHT = 1 << 7;
const JOYPAD_A = 1 << 8;
const JOYPAD_X = 1 << 9;
// const JOYPAD_L = 1 << 10;
// const JOYPAD_R = 1 << 11;
const JOYPAD_L2 = 1 << 12;
const JOYPAD_R2 = 1 << 13;

class DreamcastKeyCodeToControlMapping extends KeyCodeToControlMapping {
  constructor() {
    super({
      [KCODES.ENTER]: CIDS.START,
      [KCODES.ESCAPE]: CIDS.ESCAPE,
      [KCODES.ARROW_UP]: CIDS.UP,
      [KCODES.ARROW_DOWN]: CIDS.DOWN,
      [KCODES.ARROW_LEFT]: CIDS.LEFT,
      [KCODES.ARROW_RIGHT]: CIDS.RIGHT,
      [KCODES.Z]: CIDS.A,
      [KCODES.X]: CIDS.B,
      [KCODES.A]: CIDS.X,
      [KCODES.S]: CIDS.Y,
      [KCODES.Q]: CIDS.LBUMP,
      [KCODES.W]: CIDS.RBUMP,
    });
  }
}

// WRC - flycast's own glGetString override (gl_override.js/glsym) calls
// ctx.getParameter(0x1F03) (GL_EXTENSIONS), which is invalid in WebGL (only
// valid in desktop GL) and leaves a pending GL_INVALID_ENUM error that makes
// RetroArch's video driver init fail downstream - confirmed via
// LokiCode404/flycast-wasm v1.0.0's own test-flycast.html, which patches
// exactly this. Must run before flycast_libretro.js creates its GL context,
// so it's applied once here at module load, ahead of anything in onStart().
// (function patchGlExtensionsQuery() {
//   if (window.__wrcFlycastGlExtensionsPatched) return;
//   window.__wrcFlycastGlExtensionsPatched = true;
//   LOG.info('[Flycast GL patch] installed on HTMLCanvasElement.prototype.getContext');

//   const origGetContext = HTMLCanvasElement.prototype.getContext;
//   HTMLCanvasElement.prototype.getContext = function (...args) {
//     const ctx = origGetContext.apply(this, args);
//     const isWebGl =
//       ctx &&
//       typeof WebGLRenderingContext === 'function' &&
//       (ctx instanceof WebGLRenderingContext ||
//         (typeof WebGL2RenderingContext === 'function' && ctx instanceof WebGL2RenderingContext));
//     LOG.info(`[Flycast GL patch] getContext(${args[0]}) called, isWebGl=${!!isWebGl}, got ctx=${!!ctx}`);
//     if (isWebGl) {
//       const origGetParameter = ctx.getParameter.bind(ctx);
//       ctx.getParameter = function (pname) {
//         if (pname === 0x1f03) {
//           // GL_EXTENSIONS
//           LOG.info('[Flycast GL patch] intercepted getParameter(GL_EXTENSIONS)');
//           const exts = ctx.getSupportedExtensions();
//           return Array.isArray(exts) ? exts.join(' ') : '';
//         }
//         return origGetParameter(pname);
//       };
//       if (typeof ctx.getSupportedExtensions !== 'function') {
//         ctx.getSupportedExtensions = function () {
//           return [];
//         };
//       }
//     }
//     return ctx;
//   };
// })();

// WRC - diagnostic: trace every WebAssembly.Memory growth event (requested
// delta, before/after size, and a JS stack trace at the call site) to find
// what's actually driving heap growth on iOS/Xbox, where the tab silently
// crashes with no other actionable diagnostics. Commented out 2026-08-29
// (memory investigation paused, not resolved) - uncomment to resume.
/*
(function patchWasmMemoryGrow() {
  if (window.__wrcWasmGrowPatched) return;
  window.__wrcWasmGrowPatched = true;
  const origGrow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = function (delta) {
    const before = this.buffer.byteLength;
    try {
      const result = origGrow.call(this, delta);
      const after = this.buffer.byteLength;
      console.log(
        `[WRC-DEBUG] WASM memory grow: delta=${delta} pages (${(
          (delta * 65536) /
          1048576
        ).toFixed(1)}MB) before=${(before / 1048576).toFixed(
          1,
        )}MB after=${(after / 1048576).toFixed(1)}MB`,
      );
      console.trace('[WRC-DEBUG] grow() call site');
      return result;
    } catch (e) {
      console.log(
        `[WRC-DEBUG] WASM memory grow FAILED: delta=${delta} pages (${(
          (delta * 65536) /
          1048576
        ).toFixed(1)}MB) before=${(before / 1048576).toFixed(1)}MB - ${e && e.message}`,
      );
      console.trace('[WRC-DEBUG] grow() FAILED call site');
      throw e;
    }
  };
  LOG.info('[WRC-DEBUG] WebAssembly.Memory.prototype.grow patched for growth tracing');
})();
*/

export class Emulator extends RetroAppWrapper {

  GAME_SRAM_NAME = 'vmu_save.bin';
  SAVE_NAME = 'sav';

  constructor(app, debug = false) {
    super(app, debug);
    window.emulator = this;
    this.analogMode = true;
  }

  getHashFileExtension() {
    return 'chd';
  }

  getScriptUrl() {
    return 'js/flycast_libretro.js';
  }

  getPrefs() {
    return this.prefs;
  }

  createControllers() {
    this.keyToControlMapping = new DreamcastKeyCodeToControlMapping();
    return new Controllers([
      new Controller(this.keyToControlMapping),
      new Controller(),
      new Controller(),
      new Controller(),
    ]);
  }

  // WRC - flycast's BIOS files (see App.js getBiosMap()) are keyed with a
  // "dc/" prefix since flycast internally appends "/dc/" to whatever
  // RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY returns (core/nvmem.cpp). The
  // generic BIOS-copy loop in RetroAppWrapper.onStart() writes each
  // biosBuffers entry to system/<key> as-is, so it only needs that "dc"
  // subdirectory to already exist - created here the same way the base
  // class creates the cheats directory (FS.mkdir wrapped in try/catch,
  // since Emscripten's FS throws if the directory already exists).
  //
  // Also writes flycast's per-core options file here (same pattern as
  // mupen64plus-next's onWriteAdditionalFiles(): a "<CoreName>.opt" file
  // under config/<CoreName>/, matching retro_get_system_info().library_name
  // - "Flycast" for this core, see shell/libretro/libretro.cpp). This is
  // the ONLY thing that actually reaches flycast's core options: unlike
  // getRaConfigContents() below (which writes RetroArch's *frontend*
  // config, retroarch.cfg), libretro core options are loaded by RetroArch's
  // core_option_manager from this separate per-core file
  // (runloop.c:runloop_init_core_options_path()) - a "reicast_foo = ..."
  // line inside retroarch.cfg itself is silently ignored.
  //
  // Key/value strings verified directly against this pinned fork's own
  // shell/libretro/libretro_core_options.h (commit 2c48c01), NOT copied
  // blindly from outside recommendations - several keys floating around
  // externally don't exist in this build at all (reicast_boot_to_bios,
  // reicast_synchronous_rendering, reicast_enable_purupuru,
  // reicast_framerate - omitted below) or don't accept the values commonly
  // suggested (reicast_anisotropic_filtering has no "1" value - the
  // equivalent "off" is used instead; reicast_frame_skipping is a skip
  // count, not enabled/disabled - "1" used to approximate "on").
  async onWriteAdditionalFiles() {
    const { FS, /*Module*/ } = window;
    try {
      FS.mkdir('/home/web_user/retroarch/userdata/system/dc');
    } catch (e) {}

    const opt =
      'reicast_hle_bios = "disabled"\n'/* +
      'reicast_threaded_rendering = "disabled"\n' +
      'reicast_internal_resolution = "640x480"\n' +
      'reicast_mipmapping = "disabled"\n' +
      'reicast_anisotropic_filtering = "off"\n' +
      'reicast_enable_rttb = "disabled"\n' +
      'reicast_alpha_sorting = "per-strip (fast, least accurate)"\n' +
      'reicast_delay_frame_swapping = "disabled"\n' +
      'reicast_frame_skipping = "1"\n';*/

// const opt =
//       'reicast_hle_bios = "disabled"\n' +
//       'reicast_threaded_rendering = "disabled"\n' +   // MODIFIED — biggest perf lever, but see note below
//       'reicast_internal_resolution = "640x480"\n' +
//       'reicast_mipmapping = "disabled"\n' +
//       'reicast_anisotropic_filtering = "off"\n' +
//       'reicast_enable_rttb = "disabled"\n' +
//       'reicast_alpha_sorting = "per-strip (fast, least accurate)"\n' +
//       'reicast_delay_frame_swapping = "disabled"\n' +
//       'reicast_frame_skipping = "1"\n' +
//       'reicast_enable_dsp = "disabled"\n' +           // ADDED — skips DC audio DSP, real CPU savings
//       'reicast_gdrom_fast_loading = "enabled"\n' +    // ADDED — faster disc reads, helps load stutter
//       'reicast_pvr2_filtering = "disabled"\n' +       // ADDED — skips a texture-filter pass
//       'reicast_synchronous_rendering = "disabled"\n'; // ADDED — no-op unless threaded_rendering=enabled

    try { FS.mkdir('/home/web_user/retroarch/userdata/config/Flycast'); } catch (e) {}
    try {
      FS.writeFile(
        '/home/web_user/retroarch/userdata/config/Flycast/Flycast.opt',
        opt,
      );
      LOG.info('Wrote Flycast.opt');
    } catch (e) {
      LOG.error('Error writing Flycast.opt: ' + e);
    }

    // JIT diagnostic poller
    // let diagCount = 0;
    // let lastMemMB = 0;
    // const poller = setInterval(() => {
    //     if (!Module) { diagCount++; return; }
    //     const M = Module;
    //     const prof = M._prof || {};
    //     const cacheSize = M._wasmBlockCache ? Object.keys(M._wasmBlockCache).length : -1;
    //     const trapCount = M._wasmTrapCount || 0;
    //     const jitReady = M._jitImportsResolved ? true : false;
    //     // WRC - actual current WASM linear memory size (grows via
    //     // ALLOW_MEMORY_GROWTH), to correlate against block cache size and
    //     // see directly whether the compiled-block cache is what's driving
    //     // memory growth, instead of guessing.
    //     const memBytes = (M.HEAPU8 && M.HEAPU8.buffer) ? M.HEAPU8.buffer.byteLength : -1;
    //     const memMB = memBytes >= 0 ? Math.round(memBytes / 1048576) : -1;
    //     const memDelta = memMB - lastMemMB;
    //     lastMemMB = memMB;
    //     console.log("[JIT] blocks=" + cacheSize + " exec=" + (prof.execCount||0) +
    //         " execMs=" + (prof.execMs ? Math.round(prof.execMs) : 0) +
    //         " traps=" + trapCount + " jitReady=" + jitReady +
    //         " memMB=" + memMB + (memDelta !== 0 ? " (delta=" + (memDelta > 0 ? "+" : "") + memDelta + ")" : ""));
    //     diagCount++;
    // }, 2000);

    await super.onWriteAdditionalFiles();
  }

  getRaConfigContents() {
    const AUDIO_LATENCIES = [128, 256, 512];
    const audioLatency = AUDIO_LATENCIES[parseInt(this.getProps().audioLatency, 10)] || AUDIO_LATENCIES[0];

    return (
      "video_vsync = \"false\"\n" +
      `audio_latency = "${audioLatency}"\n` +
      // "video_threaded = \"true\"\n" +
      "audio_buffer_size = \"16384\"\n"
    );
  }

  isEscapeHackEnabled() {
    return false;
  }

  applyGameSettings() {}

  isForceAspectRatio() {
    return false;
  }

  getUseNewResizeStyle() {
    return true;
  }

  getUseNativeMainLoop() {
    return false;
  }

  getDefaultAspectRatio() {
    return 4 / 3;
  }

  resizeScreen(canvas) {
    this.canvas = canvas;
    this.updateScreenSize();
  }

  createDisplayLoop(debug) {
    const loop = new DisplayLoop(
      60,
      false, // vsync
      debug, // debug
      true,
      true
    );
    loop.setAdjustTimestampEnabled(true);
    return loop;
  }

  getShotAspectRatio() { return this.getDefaultAspectRatio(); }

  // WRC - unverified: flycast's own VMU/save file naming/path hasn't been
  // confirmed against an actual save produced by the core (needs a real
  // BIOS + game to test against). Modeled on the N64 apps' saveState()
  // shape (RetroArch's _cmd_savefiles() flush, then read back whatever
  // ends up in the saves directory) as a reasonable starting point, not a
  // confirmed-correct implementation.
  async saveState() {
    const { saveStatePath, started } = this;
    const { FS, Module } = window;

    try {
      if (!started) {
        return;
      }

      Module._cmd_savefiles();

      const files = [];
      const path = `/home/web_user/retroarch/userdata/saves/${this.GAME_SRAM_NAME}`;
      LOG.info('Checking: ' + path);
      try {
        const s = FS.readFile(path);
        if (s) {
          files.push({ name: this.SAVE_NAME, content: s });
        }
      } catch (e) {}

      if (files.length > 0) {
        if (await this.getSaveManager().checkFilesChanged(files)) {
          await this.getSaveManager().save(
            saveStatePath,
            files,
            this.saveMessageCallback,
          );
        }
      } else {
        await this.getSaveManager().delete(path);
      }
    } catch (e) {
      LOG.error('Error persisting save state: ' + e);
    }
  }

  async loadState() {
    const { saveStatePath } = this;
    const { FS } = window;

    try {
      const files = await this.getSaveManager().load(
        saveStatePath,
        this.loadMessageCallback,
      );

      if (files) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (f.name === this.SAVE_NAME) {
            FS.writeFile(
              `/home/web_user/retroarch/userdata/saves/${this.GAME_SRAM_NAME}`,
              f.content,
            );
          }
        }
        await this.getSaveManager().checkFilesChanged(files);
      }
    } catch (e) {
      LOG.error('Error loading save state: ' + e);
    }
  }

  pollControls() {
    const { controllers } = this;

    controllers.poll();

    if (
      controllers.isControlDown(0, CIDS.LTRIG) ||
      controllers.isControlDown(0, CIDS.LANALOG) ||
      controllers.isControlDown(0, CIDS.RANALOG)
    ) {
      this.escapeCount = this.escapeCount === -1 ? 0 : this.escapeCount + 1;
    } else {
      this.escapeCount = -1;
    }

    for (let i = 0; i < 4; i++) {
      let input = 0;

      if (
        controllers.isControlDown(0 /*i*/, CIDS.ESCAPE) &&
        (this.escapeCount === -1 || this.escapeCount < 60)
      ) {
        if (this.pause(true)) {
          controllers
            .waitUntilControlReleased(0 /*i*/, CIDS.ESCAPE)
            .then(() => this.showPauseMenu());
          return;
        }
      }

      if (controllers.isControlDown(i, CIDS.UP, false)) input |= JOYPAD_UP;
      else if (controllers.isControlDown(i, CIDS.DOWN, false)) input |= JOYPAD_DOWN;
      if (controllers.isControlDown(i, CIDS.LEFT, false)) input |= JOYPAD_LEFT;
      else if (controllers.isControlDown(i, CIDS.RIGHT, false)) input |= JOYPAD_RIGHT;
      if (controllers.isControlDown(i, CIDS.START)) input |= JOYPAD_START;
      if (controllers.isControlDown(i, CIDS.A)) input |= JOYPAD_A;
      if (controllers.isControlDown(i, CIDS.B)) input |= JOYPAD_B;
      if (controllers.isControlDown(i, CIDS.X)) input |= JOYPAD_X;
      if (controllers.isControlDown(i, CIDS.Y)) input |= JOYPAD_Y;
      if (controllers.isControlDown(i, CIDS.LBUMP)) input |= JOYPAD_L2;
      if (controllers.isControlDown(i, CIDS.RBUMP)) input |= JOYPAD_R2;
      // if (controllers.isControlDown(i, CIDS.LTRIG)) input |= JOYPAD_L2;
      // if (controllers.isControlDown(i, CIDS.RTRIG)) input |= JOYPAD_R2;
      if (controllers.isControlDown(i, CIDS.SELECT)) input |= JOYPAD_SELECT;

      const axisX = controllers.getAxisValue(i, 0, true);
      const axisY = controllers.getAxisValue(i, 0, false);

      this.sendInput(i, input, axisX, axisY, 0, 0);
    }
  }
}
