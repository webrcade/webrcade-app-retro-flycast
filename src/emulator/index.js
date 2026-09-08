import {
  RetroAppWrapper,
  DisplayLoop,
  LOG,
  Controller,
  Controllers,
  KeyCodeToControlMapping,
  KCODES,
  CIDS,
  Zip,
  storage,
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

// WRC - same ANALOG_BIT convention as the N64 apps (see e.g.
// webrcade-app-retro-mupen64plus-next's index.js): OR'd onto CIDS.UP/DOWN/
// LEFT/RIGHT, it tells the shared Controllers/KeyCodeToControlMapping
// framework (webrcade-app-common) to route that key into the analog stick
// axes (controllers.getAxisValue()) instead of a digital isControlDown()
// direction. pollControls() below already calls getAxisValue() and forwards
// it into sendInput() unconditionally - previously always 0 from keyboard
// since nothing fed it; a real gamepad's stick already worked.
const ANALOG_BIT = 0x8000;
const ANALOG_UP = ANALOG_BIT | CIDS.UP;
const ANALOG_DOWN = ANALOG_BIT | CIDS.DOWN;
const ANALOG_LEFT = ANALOG_BIT | CIDS.LEFT;
const ANALOG_RIGHT = ANALOG_BIT | CIDS.RIGHT;

class DreamcastKeyCodeToControlMapping extends KeyCodeToControlMapping {
  constructor() {
    super({
      [KCODES.ENTER]: CIDS.START,
      [KCODES.ESCAPE]: CIDS.ESCAPE,
      [KCODES.ARROW_UP]: ANALOG_UP,
      [KCODES.ARROW_DOWN]: ANALOG_DOWN,
      [KCODES.ARROW_LEFT]: ANALOG_LEFT,
      [KCODES.ARROW_RIGHT]: ANALOG_RIGHT,
      [KCODES.I]: CIDS.UP,
      [KCODES.J]: CIDS.LEFT,
      [KCODES.K]: CIDS.DOWN,
      [KCODES.L]: CIDS.RIGHT,
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

  // WRC - required by RetroAppWrapper itself (retrowrapper/index.js:914,
  // `this.saveStatePath = ${this.saveStatePrefix}${this.SAVE_NAME}`) to
  // compute saveStatePath at boot - see the same note in
  // webrcade-app-retro-ppsspp's index.js for the full explanation.
  SAVE_NAME = 'sav';

  // WRC - real save data (VMU saves) lives here, confirmed via actual
  // FS.readdir() on a running instance: '.', '..', 'dc_boot.bin',
  // 'dc_flash.bin', 'data', 'vmu_save_A1.bin', 'vmu_save_B1.bin',
  // 'vmu_save_C1.bin', 'vmu_save_D1.bin'. dc_boot.bin/dc_flash.bin are the
  // Dreamcast BIOS/flash images, not save data - excluded below. Whatever
  // is generated dynamically (VMU files, plus anything under data/) gets
  // walked and saved.
  SAVE_DIR = '/home/web_user/retroarch/userdata/system/dc';
  SAVE_EXCLUDE = ['dc_boot.bin', 'dc_flash.bin'];

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

  // WRC POC (cache-dump sizing, 2026-09-01): on an actual pause transition,
  // log the current compiled-cache size via the paired POC export in
  // core/rec-wasm/rec_wasm.cpp (WRC_CACHE_DUMP_POC / wasm_cache_dump_bytes).
  // Measure-only - nothing is persisted here, this is purely to see how big
  // a real per-title warm-start cache would need to be before building one.
  // super.pause()'s return value (only true on a REAL state transition, not
  // a no-op repeat call) is preserved exactly - see AppWrapper.pause() in
  // webrcade-app-common/src/app/wrapper.js.
  pause(p, isMenu) {
    const result = super.pause(p, isMenu);
    if (result && p) {
      try {
        const { Module } = window;
        if (Module && typeof Module._wasm_cache_dump_bytes === 'function') {
          const totalBytes = Module._wasm_cache_dump_bytes();
          LOG.info(`[cache-dump POC] total compiled cache: ${(totalBytes / 1048576).toFixed(2)}MB (see console for the blocks/chains breakdown logged by the native call)`);
        }
      } catch (e) {
        LOG.error('[cache-dump POC] Error reading cache size: ' + e);
      }
    }
    return result;
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

  // WRC - real Dreamcast save data (VMU saves, plus anything under data/)
  // lives in a directory tree, not a single fixed file - same shape as
  // webrcade-app-retro-ppsspp's SAVEDATA handling (see that app's index.js
  // for the original precedent, itself modeled on
  // webrcade-app-retro-dosbox-pure's saveState()). Walks SAVE_DIR
  // recursively (FS.readdir + FS.stat mode-bit checks), skipping anything
  // named in SAVE_EXCLUDE (the BIOS/flash images, not save data), and hands
  // the whole tree to SaveManager as one flat {name, content} array -
  // checkFilesChanged() hashes each file individually to skip saving when
  // nothing changed, and zips the tree using each entry's name (which
  // includes the relative subdirectory path) as its path inside the zip.
  // WRC POC (2026-09-01): flush the JIT's pending-compile buffer (see
  // core/rec-wasm/rec_wasm.cpp's WRC_CACHE_DUMP_POC) into the shared
  // IndexedDB-backed `storage` helper (webrcade-app-common/src/storage) -
  // the same one used all over the app for prefs, etc. Merges onto
  // whatever's already stored under this title's key so earlier sessions'
  // progress isn't discarded, then clears the C++-side pending buffer only
  // once the write actually succeeds - a failed/offline write leaves the
  // pending chunks in place to retry on the next save.
  //
  // Deliberately simple, per direct instruction: no per-address dedup
  // against previously-stored chunks (a re-saved chunk with the same key
  // just overwrites, which is correct - it's the latest compile of that
  // address), no size-threshold trigger, whole pending buffer flushed on
  // every saveState() call. Loading this back and re-priming the live
  // dispatch table with it (skipping recompilation) is NOT implemented -
  // this only writes it to storage.
  async flushJitCacheToStorage() {
    const { Module } = window;
    if (!Module || !Module._flyPendingChunks) return;

    const pending = Module._flyPendingChunks;
    const keys = Object.keys(pending);
    if (keys.length === 0) return;

    const pendingBytes = keys.reduce((sum, k) => sum + pending[k].bytes.byteLength, 0);
    LOG.info(`[WRC persist] flushing ${keys.length} pending JIT chunks (${(pendingBytes / 1024).toFixed(1)}KB) to storage`);

    try {
      // WRC - matches the same /wrc/<appType>/<uid>/... hierarchy saves and
      // prefs already use (see getAppStoragePath() in
      // webrcade-app-common/src/apps/applist.js and saveStatePrefix above),
      // not an ad-hoc key - keeps this entry grouped under the game the
      // same way everything else in IndexedDB already is.
      const storageKey = this.getApp().getStoragePath(`${this.uid}/jitcache`);
      const existing = await storage.get(storageKey);
      const merged = (existing && typeof existing === 'object') ? { ...existing } : {};
      let newCount = 0;
      keys.forEach(k => {
        if (!merged[k]) newCount++;
        merged[k] = pending[k];
      });

      await storage.put(storageKey, merged);

      // Only clear on confirmed success - an offline/failed write keeps
      // the pending chunks around to retry on the next save.
      Module._flyPendingChunks = {};

      const totalKeys = Object.keys(merged).length;
      const totalBytes = Object.values(merged).reduce((sum, v) => sum + v.bytes.byteLength, 0);
      LOG.info(`[WRC persist] saved. total persisted: ${totalKeys} chunks (${(totalBytes / 1048576).toFixed(2)}MB), ${newCount} new this flush`);
    } catch (e) {
      LOG.error('[WRC persist] Error flushing JIT cache to storage: ' + e);
    }
  }

  async saveState() {
    const { saveStatePath, started, SAVE_DIR, SAVE_EXCLUDE } = this;
    const { FS, Module } = window;

    if (!started) {
      return;
    }

    await this.flushJitCacheToStorage();

    Module._cmd_savefiles();

    try {
      const saveFiles = [];

      const walkFiles = (path) => {
        let dir;
        try {
          dir = FS.readdir(path);
        } catch (e) {
          return;
        }
        dir.forEach(entry => {
          if (entry === '.' || entry === '..') return;
          if (path === SAVE_DIR && SAVE_EXCLUDE.includes(entry)) return;
          const fullPath = path + '/' + entry;
          const stat = FS.stat(fullPath);
          const isDirectory = (stat.mode & 0o40000) !== 0;
          const isFile = (stat.mode & 0o100000) !== 0;
          if (isDirectory) {
            walkFiles(fullPath);
          } else if (isFile) {
            const s = FS.readFile(fullPath);
            if (s) {
              saveFiles.push({
                name: fullPath.substring(SAVE_DIR.length + 1),
                content: s,
              });
            }
          }
        });
      };
      walkFiles(SAVE_DIR);

      if (saveFiles.length > 0) {
        if (await this.getSaveManager().checkFilesChanged(saveFiles)) {
          const totalBytes = saveFiles.reduce((sum, f) => sum + f.content.length, 0);
          const toKB = (bytes) => (bytes / 1024).toFixed(1) + 'KB';

          // WRC - SaveManager.save() zips internally but doesn't return the
          // zip or its size, so measuring the actual compressed size means
          // zipping locally too (same Zip helper SaveManager itself uses)
          // just for this log - a real, if small, redundant compression
          // pass on every save. Was useful for checking real-world save
          // sizes during development; commented out rather than removed
          // since it's cheap to re-enable if that's needed again (see the
          // same pattern/note in webrcade-app-retro-ppsspp's index.js).
          // let compressedBytes = null;
          // try {
          //   const zip = new Zip();
          //   const zipBlob = await zip.zipFiles(
          //     saveFiles.map(f => ({
          //       name: f.name,
          //       content: f.content instanceof Blob ? f.content : new Blob([f.content]),
          //     }))
          //   );
          //   compressedBytes = zipBlob.size;
          // } catch (e) {
          //   LOG.error('Error measuring Dreamcast save data zip size: ' + e);
          // }

          LOG.info(
            `Saving Dreamcast save data: ${saveFiles.length} file(s), ` +
            `${toKB(totalBytes)} uncompressed`
            // + (compressedBytes !== null ? `, ${toKB(compressedBytes)} compressed (zip)` : '')
          );
          saveFiles.forEach(f => LOG.info(`  ${f.name}: ${toKB(f.content.length)}`));

          await this.getSaveManager().save(
            saveStatePath,
            saveFiles,
            this.saveMessageCallback,
          );
        }
      }
    } catch (e) {
      LOG.error('Error persisting save state: ' + e);
    }
  }

  // WRC POC (2026-09-01, load side): re-primes previously-compiled blocks
  // persisted by flushJitCacheToStorage() above, so they skip recompilation
  // entirely on this session instead of just sitting unread in storage.
  // Only block chunks ('b'-prefixed keys) are attempted - chain/region/
  // batch chunks are saved but not re-primed yet (see WRC_CACHE_LOAD_POC's
  // definition in rec_wasm.cpp for why). For each block: verify its stored
  // hash against the address's CURRENT live RAM content
  // (wasm_verify_block_hash) BEFORE touching anything else - only on a
  // pass does it get instantiated (wasm_load_block, via a malloc'd scratch
  // buffer since the bytes need to be copied into WASM linear memory
  // first) and wired into the live dispatch table
  // (wasm_try_prime_block, which re-verifies as a second, cheap check). A
  // failed verify at either point just skips that one block silently - it
  // recompiles fresh on its first real dispatch, exactly as if it had
  // never been persisted. Called from loadState() to match where save
  // data itself gets restored - timing not yet confirmed correct by real
  // testing; if the game's boot sequence hasn't finished placing its
  // initial code into RAM by this point, live hashes may not be
  // meaningful yet and legitimate blocks could get skipped as "stale."
  async primeJitCacheFromStorage() {
    const { Module } = window;
    if (!Module || typeof Module._wasm_verify_block_hash !== 'function') return;

    try {
      const storageKey = this.getApp().getStoragePath(`${this.uid}/jitcache`);
      const stored = await storage.get(storageKey);
      if (!stored || typeof stored !== 'object') return;

      // WRC - must be 'b' immediately followed by an optional '-' and
      // digits (the block pc), NOT just "starts with b" - 'batch' + N keys
      // (multi-function batch modules, see rec_wasm.cpp's
      // wasm_compile_block_batch) also start with 'b' and were matching
      // here too. Those export their functions as b0/b1/b2... not a single
      // "b", so wasm_load_block (built for single-block modules) found
      // instance.exports.b undefined and WebAssembly.Table.set() threw -
      // repeatedly, since parseInt() on the mangled "atch5"-style
      // substring returns NaN, which coerces to pc=0 when passed into the
      // WASM call. Confirmed as the cause of a real crash (2026-09-01): 820
      // straight instantiate failures, all logged as pc=0x0.
      //
      // The leading '-?' matters just as much as the digit-only fix above:
      // block_pc crosses the C++->JS boundary as a signed 32-bit number
      // (Emscripten's default for a u32 param), and every Dreamcast RAM
      // address (0x8c000000+) has its high bit set, so essentially every
      // real block key looks like 'b-1945883454', not 'b1945883454' -
      // confirmed directly in the actual stored data (devtools showed
      // exactly this). A digits-only regex silently rejected nearly every
      // real block, which is why the very next thing after fixing the
      // batch-key bug was "0 primed, 100% stale" instead of real numbers.
      const blockKeys = Object.keys(stored).filter(k => /^b-?\d+$/.test(k));
      if (blockKeys.length === 0) return;

      LOG.info(`[WRC persist] attempting to re-prime ${blockKeys.length} persisted blocks from storage`);

      let primed = 0;
      let stale = 0;
      let failed = 0;

      blockKeys.forEach(k => {
        const entry = stored[k];
        if (!entry || !entry.bytes) {
          failed++;
          return;
        }
        const pc = parseInt(k.substring(1), 10);
        const { bytes, hash, nw } = entry;

        if (!Module._wasm_verify_block_hash(pc, hash, nw)) {
          stale++;
          return;
        }

        const ptr = Module._malloc(bytes.length);
        try {
          Module.HEAPU8.set(bytes, ptr);
          const tableIdx = Module._wasm_load_block(ptr, bytes.length, pc);
          if (tableIdx <= 0) {
            failed++;
            return;
          }
          if (Module._wasm_try_prime_block(pc, tableIdx, hash, nw)) {
            primed++;
            // WRC POC: the definitive "is this actually being used" signal.
            // rec_wasm.cpp's compile sites check this set and fire a loud
            // REGRESSION warning if a PC in here ever needs a real
            // recompile - which should never happen unless the game
            // genuinely rewrote that code (SMC), since priming means the
            // dispatch table already has a live, verified-fresh entry for
            // it. If that warning never fires despite the game revisiting
            // this content, priming held. If it fires, priming isn't
            // actually preventing recompiles.
            if (!Module._flyPrimedPcs) Module._flyPrimedPcs = new Set();
            Module._flyPrimedPcs.add(pc);
          } else {
            stale++;
          }
        } finally {
          Module._free(ptr);
        }
      });

      LOG.info(`[WRC persist] re-primed ${primed}/${blockKeys.length} blocks from storage (${stale} stale/skipped, ${failed} failed) - watch for "[WRC persist] REGRESSION" warnings during play to confirm they're actually staying in use`);
    } catch (e) {
      LOG.error('[WRC persist] Error priming JIT cache from storage: ' + e);
    }
  }

  async loadState() {
    const { saveStatePath, SAVE_DIR } = this;
    const { FS } = window;

    try {
      const saveFiles = await this.getSaveManager().load(
        saveStatePath,
        this.loadMessageCallback,
      );

      if (saveFiles) {
        for (let i = 0; i < saveFiles.length; i++) {
          const f = saveFiles[i];
          const outPath = `${SAVE_DIR}/${f.name}`;
          const destDir = outPath.substring(0, outPath.lastIndexOf('/'));
          this.createDirectories(FS, destDir);
          FS.writeFile(outPath, f.content);
        }

        LOG.info(`Restored Dreamcast save data: ${saveFiles.length} file(s)`);

        await this.getSaveManager().checkFilesChanged(saveFiles);
      }
    } catch (e) {
      LOG.error('Error loading save state: ' + e);
    }
  }

  // WRC POC (load side, moved 2026-09-01): primeJitCacheFromStorage() was
  // originally called from loadState(), which runs entirely BEFORE the
  // mainloop starts - meaning the SH4 hadn't executed a single instruction
  // yet, so RAM was still cold-boot/BIOS-only state with nothing
  // matching what was hashed last session (confirmed: 0/9440 primed, ~92%
  // "stale"). RetroAppWrapper's own main loop
  // (webrcade-app-common/src/app/retrowrapper/index.js) already calls
  // Module._emscripten_mainloop() (the real SH4 step) BEFORE calling
  // onFrame() each tick, so by the time onFrame() fires even once, real
  // execution has already happened - mirrors the same delayed-start
  // pattern already used elsewhere in this codebase (a frame-count gate,
  // not a wall-clock wait) rather than inventing a new one.
  jitCachePrimeFrameCount = 0;

  // WRC POC - DISABLED (2026-09-01): commented out alongside the core-side
  // WRC_CACHE_DUMP_POC/WRC_CACHE_LOAD_POC flags (see rec_wasm.cpp). The
  // core's wasm_verify_block_hash is now an unconditional `return 0` stub,
  // so this call could never succeed - but the client doesn't know that in
  // advance, and was still paying for a real storage.get() read of the
  // whole persisted blob plus a loop over every entry, every session, for
  // a guaranteed-zero result. No point paying that until the exception-
  // delivery gap that caused the crash is actually fixed and the core side
  // is re-enabled.
  onFrame() {
    /*
    if (this.jitCachePrimeFrameCount === -1) return;

    if (this.jitCachePrimeFrameCount > 30) {
      this.jitCachePrimeFrameCount = -1;
      this.primeJitCacheFromStorage();
    } else {
      this.jitCachePrimeFrameCount++;
    }
    */
  }

  pollControls() {
    const { controllers, keyToControlMapping } = this;

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

      let axisX = controllers.getAxisValue(i, 0, true);
      let axisY = controllers.getAxisValue(i, 0, false);

      // WRC - getAxisValue() only ever reads a real gamepad's pad.axes (see
      // webrcade-app-common/src/input/controls.js) - it has no idea
      // ANALOG_BIT-tagged keyboard keys exist. Same pattern as the N64
      // apps' pollControls(): the ANALOG_BIT tag just gives those keys a
      // distinct value in the mapping table, and it's this app's own job
      // to check for it directly (via keyToControlMapping.isControlDown(),
      // not controllers.isControlDown()) and override the axis value by
      // hand. Player 1 (keyboard) only, matching the N64 apps.
      if (i === 0) {
        if (keyToControlMapping.isControlDown(ANALOG_RIGHT)) axisX = 1;
        if (keyToControlMapping.isControlDown(ANALOG_LEFT)) axisX = -1;
        if (keyToControlMapping.isControlDown(ANALOG_UP)) axisY = -1;
        if (keyToControlMapping.isControlDown(ANALOG_DOWN)) axisY = 1;
      }

      this.sendInput(i, input, axisX, axisY, 0, 0);
    }
  }
}
