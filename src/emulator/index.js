import {
  BasicRetroAppWrapper,
  DisplayLoop,
  LOG,
  Controller,
  Controllers,
  KeyCodeToControlMapping,
  KCODES,
  CIDS,
  // Zip,
  storage,
  ScriptAudioProcessor,
} from '@webrcade/app-common';

import { FlycastPrefs, FRAME_SKIP } from './prefs';

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

// WRC - same fine-positioning modifier scheme as the N64 apps
// (webrcade-app-parallel-n64's index.js): Control reduces the analog
// stick to 50% deflection, Shift to 75% (both held stacks to 25%). Unlike
// PSP, Dreamcast has no real Select button for either Shift key to
// collide with, so both tiers are available here.
const ANALOG_50 = 0x2000;
const ANALOG_25 = 0x1000;

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
      [KCODES.CONTROL_RIGHT]: ANALOG_50,
      [KCODES.CONTROL_LEFT]: ANALOG_50,
      [KCODES.SHIFT_RIGHT]: ANALOG_25,
      [KCODES.SHIFT_LEFT]: ANALOG_25,
    });
  }

  // This app maps both Control keys to Analog 50% and both Shift keys to
  // Analog 25% above -- real gameplay modifiers. The shared Ctrl+Shift
  // pause sequence collides with holding both together, so it's disabled
  // for this app only. The literal Escape key (still mapped above) and
  // the gamepad pause combo (SL+X, LT+LA) are unaffected.
  isEscapeKeySequenceEnabled() {
    return false;
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
// (memory investigation paused). Re-enabled 2026-09-09 to chase the Sonic
// Adventure 2 playtime-dependent OOM - findings recorded in memory
// (project_flycast_sonic_adventure2_oom) - re-disabled once that
// investigation concluded (three growth sources identified, no fix
// implemented yet). Re-enable + see that memory file if resuming this.
// (function patchWasmMemoryGrow() {
//   if (window.__wrcWasmGrowPatched) return;
//   window.__wrcWasmGrowPatched = true;
//
//   // WRC (2026-09-09): aggregate by call-site signature instead of dumping
//   // a full trace per event - a long play session can trigger dozens of
//   // these, and scrolling through near-duplicate traces isn't practical.
//   // Each event costs one cheap Error().stack capture (no throw) and a Map
//   // lookup; call window.__wrcDumpGrowthSummary() from the console at any
//   // point to print a table of distinct call sites sorted by total MB
//   // grown, with a sample stack for the top offenders.
//   const growthBySite = new Map(); // signature -> { count, totalBytes, sampleStack }
//   window.__wrcDumpGrowthSummary = function () {
//     const rows = Array.from(growthBySite.entries())
//       .map(([sig, v]) => ({ sig, ...v }))
//       .sort((a, b) => b.totalBytes - a.totalBytes);
//     console.log(`[WRC-DEBUG] ${rows.length} distinct growth call site(s):`);
//     rows.forEach((r, i) => {
//       console.log(
//         `  #${i + 1}: ${r.count}x, ${(r.totalBytes / 1048576).toFixed(1)}MB total`,
//       );
//       console.log(r.sampleStack);
//     });
//     return rows;
//   };
//
//   const origGrow = WebAssembly.Memory.prototype.grow;
//   WebAssembly.Memory.prototype.grow = function (delta) {
//     const before = this.buffer.byteLength;
//     try {
//       const result = origGrow.call(this, delta);
//       const after = this.buffer.byteLength;
//       const deltaBytes = after - before;
//       const stack = new Error('[WRC-DEBUG] grow() call site').stack || '';
//       // Skip the Error's own message line + this wrapper's frame; the next
//       // handful of frames are stable enough to bucket by call site without
//       // needing the full trace on every single event.
//       const sig = stack.split('\n').slice(2, 8).map((l) => l.trim()).join(' <- ');
//       let entry = growthBySite.get(sig);
//       if (!entry) {
//         entry = { count: 0, totalBytes: 0, sampleStack: stack };
//         growthBySite.set(sig, entry);
//       }
//       entry.count++;
//       entry.totalBytes += deltaBytes;
//       console.log(
//         `[WRC-DEBUG] grow: +${(deltaBytes / 1048576).toFixed(1)}MB (total ${(
//           after / 1048576
//         ).toFixed(1)}MB) - site seen ${entry.count}x so far, ${
//           growthBySite.size
//         } distinct site(s) - call __wrcDumpGrowthSummary() for details`,
//       );
//       return result;
//     } catch (e) {
//       console.log(
//         `[WRC-DEBUG] WASM memory grow FAILED: delta=${delta} pages (${(
//           (delta * 65536) /
//           1048576
//         ).toFixed(1)}MB) before=${(before / 1048576).toFixed(1)}MB - ${e && e.message}`,
//       );
//       console.trace('[WRC-DEBUG] grow() FAILED call site');
//       throw e;
//     }
//   };
//   LOG.info(
//     '[WRC-DEBUG] WebAssembly.Memory.prototype.grow patched (aggregated by call site - use window.__wrcDumpGrowthSummary() in the console when ready)',
//   );
// })();

export class Emulator extends BasicRetroAppWrapper {

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
    this.prefs = new FlycastPrefs(this);

    // WRC (2026-09-09): DisplayLoop pacing target, driven by setPalMode()
    // below (same SPG_CONTROL.isPAL() signal already used for the frame-
    // skip threshold) - mirrors retro-snes9x/retro-genplusgx's
    // frequency/lastFrequency + getDisplayLoopReturn() pattern. Without
    // this the loop always paces itself at 60fps, so a real 50Hz PAL game
    // runs fast/high-pitched (loop keeps calling retro_run() ~20% too
    // often relative to the content's actual timing).
    this.frequency = 60;
    this.lastFrequency = 60;

    // WRC (2026-09-08): same pattern as webrcade-app-retro-ppsspp - bypass
    // the emulator core's own JS-side audio sink (flycast's C++ audiostream.cpp
    // called this straight into an AudioWorklet ring buffer, EM_ASM'd from
    // retro_audio_upload() there) and instead call directly into
    // @webrcade/app-common's ScriptAudioProcessor circular queue, matching
    // every other WRC libretro core. Real iOS testing (Crazy Taxi, heavy 3D
    // scenes) showed audible dropped audio chunks with the AudioWorklet sink
    // that this shared, well-tested path doesn't show elsewhere - see the
    // matching C++-side change in retrostash/flycast-wasm's
    // source-canonical/shell/libretro/audiostream.cpp for the reference this
    // mirrors (ppsspp-wasm/libretro/libretro.cpp's
    // upload_output_audio_buffer()).
    this.audioStarted = 0;

    // WRC (2026-09-11): flat-percentage stretch per call, not a fixed
    // target frame count. Two earlier attempts both assumed a STABLE
    // target frame count (derived from sampleRate/frequency, snes9x-
    // style) was the right thing to hit each call - but flycast's real
    // per-call length alternates between two very different sizes
    // (observed: ~1107 then ~365, repeating), so anything chasing a
    // fixed target either flip-flopped between upsampling/downsampling
    // (audible warble) or needed a reservoir+leaky-integrator to smooth
    // that out, which produced periodic pops in practice instead of
    // fixing them. Simpler and it directly follows from what's actually
    // going wrong: whatever length arrives THIS call, stretch it by a
    // flat percentage (frame-walking resample, same technique as
    // retro-snes9x's) to intentionally hand the downstream
    // ScriptAudioProcessor circular queue slightly MORE than it strictly
    // needs, every single call, regardless of whether this particular
    // call was a "big" or "small" one - builds and maintains a real
    // surplus cushion in the queue against momentary supply gaps
    // (that cushion is what actually stops the periodic pops), with no
    // dependency on a fixed target rate at all.
    // Starting point: same ratio as the established +15/44100 pad
    // (~0.034%), not the earlier unjustified 3%. At ~365-1107 frames per
    // call that's only 0.12-0.38 of a frame per call - too small for
    // Math.round to ever act on by itself, so audioStretchCarry banks
    // the fractional remainder across calls (same idea as SNES's
    // fractional carry) instead of it silently rounding away to nothing
    // every time. Increase AUDIO_STRETCH_PCT if pops persist.
    const AUDIO_STRETCH_PCT = 15 / 44100;
    this.audioStretchCarry = 0;
    this.audioCallback = (offset, length) => {
      const input = new Int16Array(
        window.Module.HEAP16.buffer,
        offset,
        length << 1
      );

      const rawOutFrames =
        length * (1 + AUDIO_STRETCH_PCT) + this.audioStretchCarry;
      const outFrames = Math.max(1, Math.floor(rawOutFrames));
      this.audioStretchCarry = rawOutFrames - outFrames;
      const outSamples = outFrames << 1;
      const output = new Int16Array(outSamples);

      // ---- frame walking resampler (no timing drift) ----
      const step = length / outFrames;
      let srcFrame = 0;
      for (let i = 0; i < outFrames; i++) {
        const si = (srcFrame | 0) << 1;
        output[i * 2] = input[si];
        output[i * 2 + 1] = input[si + 1];
        srcFrame += step;
      }

      this.audioProcessor.storeSoundCombinedInput(
        output,
        2,
        outSamples,
        0,
        32768
      );
    };
  }

  getHashFileExtension() {
    return 'chd';
  }

  // WRC (2026-09-08): two distinct values here, on purpose -
  // getPrefs().getFrameSkip() is the PERSISTED preference (auto/disabled/
  // 1/2, whatever's shown/edited in the pause-menu Select), while
  // currentFrameSkip is the actual live level in effect right now (always
  // a plain number, never "auto" - when the preference IS "auto" this is
  // whatever the FPS-driven heuristic below last decided). resolveFrameSkip()
  // is the one place that reconciles the two and is safe to call any time
  // something needs the real current value (boot, live-apply, the debug
  // overlay).
  //
  // WRC (2026-09-09): auto starts at 1, not 0 - deliberately conservative.
  // The two failure modes aren't symmetric: starting at 0 on a weak device
  // means a real audible glitch during its first heavy moment before the
  // heuristic reacts; starting at 1 on a strong device just means a
  // probably-imperceptible frame-skip during whatever's on screen for the
  // first ~20s (often a menu/light intro) before it relaxes to 0. A glitch
  // is a worse first impression than invisible frame-skipping, so bias
  // toward the safe state.
  currentFrameSkip = 1;

  resolveFrameSkip() {
    const persisted = this.getPrefs().getFrameSkip();
    const value = persisted === FRAME_SKIP.FS_AUTO
      ? this.currentFrameSkip
      : (persisted === FRAME_SKIP.FS_OFF ? 0 : parseInt(persisted, 10));
    this.currentFrameSkip = value;
    return value;
  }

  frameSkipValueToOptString(value) {
    return value === 0 ? FRAME_SKIP.FS_OFF : String(value);
  }

  // WRC (2026-09-08): called synchronously FROM the core (retro_run() in
  // libretro.cpp, via EM_ASM_INT) the frame after wrc_set_options(OPT1)
  // flips its pending-change flag - see that file's wrc_on_set_options()/
  // retro_run() for the C++ side. Must return a plain int (0=off matching
  // reicast_frame_skipping's "disabled"), not the prefs string value.
  // Real iOS testing (Crazy Taxi, heavy 3D scenes) showed frame skipping
  // trades an unnoticeable amount of visual smoothness for a real fix to
  // choppy/missing audio chunks (frees up main-thread time the
  // single-threaded core needs to keep audio production on schedule - see
  // PTHREAD=0's own history in Makefile.emscripten.flycast for why this
  // core can't just move audio to its own thread instead).
  getPendingFrameSkip() {
    return this.resolveFrameSkip();
  }

  // WRC (2026-09-09): checking "is FPS good while frame-skip 1 is already
  // active" can't tell us the underlying scene got lighter - skip=1 is
  // what's making it look good. The only way to actually find out is to
  // periodically try dropping back to 0 and see what happens - a real
  // probe, not a confirmation. goodStreakNeeded of 4 (~20s of sustained
  // good FPS, checkFrequency = frequency * 5 in loop.js) is how long we
  // wait before each probe attempt.
  //
  // If a probe fails IMMEDIATELY (bounces back to 1 on its very first
  // check) too many times, giveUpThreshold stops trying for the rest of
  // the session - converges to sticky-1 for a game that's genuinely,
  // reliably too demanding at skip=0 instead of repeat-probing (each
  // failed probe risks a brief real glitch) forever with zero chance of
  // success. 25 (~8-10 min of exploration at ~20s/cycle) instead of no
  // limit at all.
  //
  // WRC (2026-09-09), real-world correction: a game that's mostly fine at
  // 0 with only occasional/rare dips (confirmed live: Sonic Adventure) was
  // wrongly getting sticky-1'd too - every dip while at skip=0 counted
  // against revertCount the same whether it was an immediate probe
  // failure or just ambient bad luck after a long successful run at 0.
  // zeroSurvivedOneWindow tracks whether the CURRENT stint at skip=0 has
  // already lived through at least one good check - if so, a later dip is
  // evidence the scene got briefly heavier, not that skip=0 was the wrong
  // steady-state choice, so it reverts to 1 for that window (still avoids
  // the audible glitch) without spending give-up budget on it.
  goodStreakNeeded = 4;
  goodStreak = 0;
  giveUpThreshold = 25;
  revertCount = 0;
  autoGaveUp = false;
  zeroSurvivedOneWindow = false;

  // WRC (2026-09-09): NTSC by default (Dreamcast's more common case);
  // switched to 48 (matching the same ~2fps margin as 60/58) on real PAL
  // detection via setPalMode() below. Not derived from a hardcoded 60 -
  // this IS the actual per-game threshold now.
  frameSkipFpsThreshold = 58;

  // WRC (2026-09-09): called from the core (libretro.cpp, via EM_ASM) the
  // moment SPG_CONTROL.isPAL() - the same hardware-register-backed
  // detection setAVInfo() itself uses - actually changes, in either
  // direction. A native 50Hz PAL game would otherwise always read as
  // "too slow" against a hardcoded NTSC threshold. Resets all the auto
  // state (streak/revert/give-up) if auto is currently enabled, since
  // everything accumulated so far was measured against the wrong
  // threshold and no longer means anything.
  setPalMode(isPal) {

// TODO: Investigate this more
isPal = false;

    this.frameSkipFpsThreshold = isPal ? 48 : 58;
    this.frequency = isPal ? 50 : 60;

    if (this.getPrefs().getFrameSkip() === FRAME_SKIP.FS_AUTO) {
      this.goodStreak = 0;
      this.revertCount = 0;
      this.autoGaveUp = false;
      this.zeroSurvivedOneWindow = false;
      LOG.info(`[auto frame skip] region changed (PAL=${isPal}), threshold now ${this.frameSkipFpsThreshold}, auto state reset`);
    }
  }

  // WRC (2026-09-08): registered via createDisplayLoop() below on
  // DisplayLoop's new (unconditional, non-debug-gated) setFpsCallback() -
  // fires roughly every 5s (checkFrequency = frequency * 5 in loop.js),
  // already a windowed average, not an instantaneous per-frame reading.
  // Only acts when the persisted preference is actually "auto" - a
  // manually-chosen Off/1/2 is left alone.
  onFpsUpdate(fps) {
    if (this.getPrefs().getFrameSkip() !== FRAME_SKIP.FS_AUTO || this.autoGaveUp) return;

    const isLow = fps < this.frameSkipFpsThreshold;
    let newLevel = this.currentFrameSkip;

    if (isLow) {
      this.goodStreak = 0;
      if (this.currentFrameSkip === 0) {
        if (!this.zeroSurvivedOneWindow) {
          // Failed on the very first check after ascending - a genuine
          // probe failure, not just ambient variance in an otherwise-fine
          // scene. This is the only case that spends give-up budget.
          this.revertCount++;
          if (this.revertCount > this.giveUpThreshold) {
            this.autoGaveUp = true;
            LOG.info('[auto frame skip] repeated immediate bounce-backs, giving up and staying at 1 for the rest of this session');
          }
        }
      }
      newLevel = 1;
    } else if (this.currentFrameSkip === 1) {
      this.goodStreak++;
      if (this.goodStreak >= this.goodStreakNeeded) {
        this.goodStreak = 0;
        newLevel = 0;
        this.zeroSurvivedOneWindow = false;
      }
    } else if (this.currentFrameSkip === 0) {
      // Good window at skip=0 - this stint has now proven itself at least
      // once, so a later dip is ambient, not a failed probe.
      this.zeroSurvivedOneWindow = true;
    }

    if (newLevel !== this.currentFrameSkip) {
      this.currentFrameSkip = newLevel;
      this.applyGameSettings();
    }
  }

  getScriptUrl() {
    return 'js/flycast_libretro.js';
  }

  getPrefs() {
    return this.prefs;
  }

  // WRC (2026-09-08): bigger ring buffer than PPSSPP's 8192+4096/2048
  // (double, on both the main ring buffer and the script-processor chunk
  // size) - deliberately trading a bit more latency for a bigger cushion
  // against the main-thread stalls a heavy 3D Dreamcast scene can cause,
  // which is exactly what was starving the previous AudioWorklet sink's
  // much thinner (~46ms) buffer on iOS.
  createAudioProcessor() {
    return new ScriptAudioProcessor(
      2,
      44100,
      16384 + 8192,
      4096
    ).setDebug(this.debug);
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

    const frameSkip = this.frameSkipValueToOptString(this.resolveFrameSkip());
    const opt =
      'reicast_hle_bios = "disabled"\n' +
      'reicast_enable_dsp = "disabled"\n' +
      `reicast_frame_skipping = "${frameSkip}"\n` /*+
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
    //     const { Module } = window;
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

  // isEscapeHackEnabled() {
  //   return false;
  // }

  // Base class default pauses on any tap anywhere on screen -- redundant
  // (and disruptive) now that there's a dedicated Pause button in the
  // touch overlay. Same override every other TouchOverlay app uses for the
  // same reason.
  createTouchListener() {}

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

  // WRC (2026-09-08): live-apply bridge, same mechanism
  // webrcade-app-beetle-psx uses for disk eject/analog mode/etc - the base
  // class already calls this once during boot (RetroAppWrapper's onStart()
  // sequence), and it's safe to call again any time after (e.g. from the
  // pause-menu settings screen) to re-apply live without a restart. See the
  // matching wrc_on_set_options() in retrostash/flycast-wasm's
  // source-canonical/shell/libretro/libretro.cpp for the core-side half -
  // bits 0-1 (OPT1|OPT2) carry the current frame-skip level.
  applyGameSettings() {
    const { Module } = window;
    if (!Module || typeof Module._wrc_set_options !== 'function') return;

    // OPT1 just flips a pending-change flag on the core side - it calls
    // straight back into getPendingFrameSkip() above (via EM_ASM_INT) on
    // the next retro_run() to fetch the actual current value, rather than
    // encoding it into these bits directly.
    Module._wrc_set_options(this.OPT1);
  }

  // WRC (2026-09-13): true, not false - this app already has
  // getUseNewResizeStyle() returning true (its native build is on the
  // lighter-weight resize path, not the legacy video_driver_reinit() one
  // that's crash-prone in the WASM/WebGL build - see that getter's own
  // comment in retrowrapper/index.js), so there's no crash risk here.
  // Confirmed visually on retro-mupen64plus-next that leaving this false
  // causes real horizontal stretching distortion.
  isForceAspectRatio() {
    return true;
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
    loop.setFpsCallback((fps) => this.onFpsUpdate(fps));
    loop.setDebugCallback((fpsStr) => `${fpsStr}, ${this.getFrameSkipDebugInfo()}`);
    return loop;
  }

  // WRC (2026-09-09): same pattern as retro-snes9x/retro-genplusgx - called
  // every frame by RetroAppWrapper; only returns a value (which DisplayLoop
  // applies live, no restart) when setPalMode() has actually changed the
  // target frequency since the last check.
  // getDisplayLoopReturn() {
  //   if (this.lastFrequency !== this.frequency) {
  //     this.lastFrequency = this.frequency;
  //     return this.frequency;
  //   }
  //   return undefined;
  // }

  // WRC (2026-09-09): visibility into the auto frame-skip state machine
  // (see onFpsUpdate() above) for the debug overlay - streak progress
  // toward the next probe, revert count toward giving up, and whether it's
  // already given up, so it's actually observable during real testing
  // instead of inferring it from behavior.
  getFrameSkipDebugInfo() {
    const persisted = this.getPrefs().getFrameSkip();
    if (persisted !== FRAME_SKIP.FS_AUTO) {
      return `FS: ${this.currentFrameSkip} (manual)`;
    }
    if (this.autoGaveUp) {
      return `FS: ${this.currentFrameSkip} (auto, thresh ${this.frameSkipFpsThreshold}, gave up)`;
    }
    return `FS: ${this.currentFrameSkip} (auto, thresh ${this.frameSkipFpsThreshold}, streak ${this.goodStreak}/${this.goodStreakNeeded}, reverts ${this.revertCount}/${this.giveUpThreshold})`;
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
        // WRC DIAGNOSTIC (2026-09-09): chasing a "LOAD failed" VMU report -
        // logging exact byte sizes on restore to compare against what was
        // actually saved (saveState() below already logs per-file sizes on
        // the save side). A real VMU image must be exactly 131072 bytes -
        // if what's restored here doesn't match that, the stored save data
        // itself is truncated/corrupted, not a timing/code issue.
        saveFiles.forEach(f => LOG.info(`  ${f.name}: ${f.content.length} bytes`));

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

    // WRC (2026-09-08): same delayed-start pattern as
    // webrcade-app-retro-ppsspp/snes9x - wait a couple frames after
    // onFrame() starts firing (real SH4 execution has already begun by
    // then, see RetroAppWrapper's main loop) before starting the
    // ScriptAudioProcessor, then only once.
    if (this.audioStarted !== -1) {
      if (this.audioStarted > 1) {
        this.audioStarted = -1;
        this.audioProcessor.start();
      } else {
        this.audioStarted++;
      }
    }

    // Touch/mouse/keyboard interaction detection + on-screen touch overlay
    // gating is inherited from BasicRetroAppWrapper.
    super.onFrame();
  }

  pollControls() {
    const { controllers, keyToControlMapping } = this;

    controllers.poll();

    // WRC (2026-09-12): only LTRIG/LANALOG are watched here - matches
    // BasicRetroAppWrapper's own pollControls() scoping
    // (webrcade-app-common/src/app/retrowrapper/index.js), flycast just
    // has its own copy since Dreamcast's JOYPAD_* bitmask is a different
    // scheme than the base class's generic INP_*. RTRIG/RANALOG used to
    // be watched too (superseded 2026-09-11 note removed), but neither
    // Start nor Select is ever gated by escapeOk in this app (see below -
    // Dreamcast has no Select button, and flycast doesn't wire up the
    // right analog stick click at all), so nothing downstream ever
    // consults their hold-time. Watching them anyway would just risk the
    // same bug the shared version had: a real, extended RTRIG hold
    // (analog braking) could make the unrelated LT+LA Pause combo
    // temporarily inaccessible while held.
    if (
      controllers.isControlDown(0, CIDS.LTRIG) ||
      controllers.isControlDown(0, CIDS.LANALOG)
    ) {
      this.escapeCount = this.escapeCount === -1 ? 0 : this.escapeCount + 1;
    } else {
      this.escapeCount = -1;
    }

    for (let i = 0; i < 4; i++) {
      let input = 0;

      const escapeOk =
        !this.isEscapeHackEnabled() ||
        this.escapeCount === -1 ||
        this.escapeCount < 60;

      if (controllers.isControlDown(0 /*i*/, CIDS.ESCAPE) && escapeOk) {
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
      // WRC (2026-09-12): no escapeOk-style gate on Start/Select here,
      // matching BasicRetroAppWrapper's own default (isStartEscapeHackEnabled()/
      // isSelectEscapeHackEnabled(), both false unless an app opts in -
      // see webrcade-app-beetle-psx for the one app that does). Dreamcast
      // has no real Select button anyway, and flycast doesn't wire up the
      // right analog stick click at all, so there's no real collision
      // risk to opt into guarding against here. Only the ESCAPE check
      // itself needs escapeOk.
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
        // WRC - fine-positioning modifiers (see ANALOG_50/ANALOG_25's
        // definitions above): each held key reduces the full-deflection
        // multiplier below, same stacking math as the N64 apps'
        // pollControls().
        let multiplier = 1;
        if (keyToControlMapping.isControlDown(ANALOG_50)) multiplier -= 0.50;
        if (keyToControlMapping.isControlDown(ANALOG_25)) multiplier -= 0.25;

        if (keyToControlMapping.isControlDown(ANALOG_RIGHT)) axisX = multiplier;
        if (keyToControlMapping.isControlDown(ANALOG_LEFT)) axisX = -multiplier;
        if (keyToControlMapping.isControlDown(ANALOG_UP)) axisY = -multiplier;
        if (keyToControlMapping.isControlDown(ANALOG_DOWN)) axisY = multiplier;
      }

      // WRC (2026-09-11): real Dreamcast L/R triggers are analog (0-255 on
      // the actual hardware), not just digital buttons - sendInput()'s
      // last two args (analog1x/analog1y) would normally carry a second
      // analog stick, which the Dreamcast controller doesn't have, so
      // they're repurposed here to carry L/R trigger PRESSURE instead
      // (getButtonValue() reads the gamepad's raw button .value, 0.0-1.0,
      // distinct from isControlDown()'s digital pressed/released above).
      // No new plumbing needed - the C++ side (libretro.cpp's
      // wrc_libretro_input_state()) already receives these same two
      // values via wrc_input_state_analog[port][2]/[3]; it just needs to
      // interpret them as trigger pressure for RETRO_DEVICE_INDEX_ANALOG_
      // BUTTON queries instead of a nonexistent right stick. Digital
      // LBUMP/RBUMP above still work standalone (keyboard, or a pad
      // without analog trigger support) - the C++ side gives them
      // priority (full value) over these when pressed.
      const ltrig = controllers.getButtonValue(i, CIDS.LTRIG);
      const rtrig = controllers.getButtonValue(i, CIDS.RTRIG);

      this.sendInput(i, input, axisX, axisY, ltrig, rtrig);
    }
  }
}
