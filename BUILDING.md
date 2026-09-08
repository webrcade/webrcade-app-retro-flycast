# Building the Flycast (Dreamcast) core

This app links `retrostash/flycast-wasm`'s libretro core against `retrostash/RetroArch`
(the WRC fork) to produce `flycast_libretro.js`/`.wasm`, then copies those into this
app's `public/js/`.

All commands run inside the `emsdk-3.1.74` Docker container, which has `f:/work`
mounted at `/work`.

## Prerequisites

- The `emsdk-3.1.74` container running (`emscripten/emsdk:3.1.74`).
- `retrostash/flycast-wasm` and `retrostash/RetroArch` checked out as siblings of
  this repo under `retrostash/`.
- Flycast's source lives at `retrostash/flycast-wasm/source-canonical` (a
  checkout of upstream flyinghead/flycast with WRC patches applied — including
  the FLYCAST_WRC_INPUT controller wiring and the flycast_-prefixed
  libretro-common/rcheevos symbol renames that avoid ABI collisions with
  RetroArch's differently-aged vendored copies). **This is the real, actively
  maintained source tree** — `retrostash/flycast-wasm/source` (no
  `-canonical` suffix) is a stale/older copy missing these patches; building
  from it produces a core that links but fails at runtime with
  `RuntimeError: null function` errors, since the symbol collisions aren't
  resolved and the input glue doesn't exist. Always build from
  `source-canonical`.

## 1. Build the Flycast core (CMake)

**The `-DCMAKE_C_FLAGS`/`-DCMAKE_CXX_FLAGS` values below are not optional
extras — they are required for a working build.** They do two things that
nothing else in `CMakeLists.txt` does:
- `-DFLYCAST_WRC_INPUT=1` compiles in the `wrc_libretro_input_state()`
  override in `shell/libretro/libretro.cpp` that reads
  `wrc_input_state[]`/`wrc_input_state_analog[]` (populated by
  `wrc_set_input()` in RetroArch's `frontend/drivers/platform_emscripten.c`)
  instead of RetroArch's normal input driver stack. Without this flag the
  core links and runs, but there is no input at all.
- The long list of `-D<name>=flycast_<name>` flags renames flycast's own
  vendored `libretro-common` (`file_path.c`, `stdstring.c`'s `word_wrap`)
  and `glsym` (`rglgen_*`) symbols so they don't collide with RetroArch's
  differently-aged vendored copies of the same files. Without these, the
  link still succeeds (wasm-ld is invoked with
  `--allow-multiple-definition`, so colliding symbols don't hard-fail) but
  produces `RuntimeError: null function` at runtime when something calls
  through the wrong/unresolved copy.

Neither of these lives in `CMakeLists.txt` — they only exist as this
command line. If you ever need to reconstruct it from scratch, the
authoritative source is the git-committed
`build-wasm-prod/CMakeFiles/flycast_libretro.dir/flags.make` from a known
working build (`git show HEAD:.../flags.make`), not this doc from memory.

```
docker exec emsdk-3.1.74 sh -c "cd /work/webrcade/retrostash/flycast-wasm/source-canonical && mkdir -p build-wasm-prod && cd build-wasm-prod && emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DLIBRETRO=ON -DUSE_GLES=ON -DCMAKE_C_FLAGS='-DJIT_PROD_BUILD=1 -DFLY_RELEASE_BUILD=1 -DFLYCAST_WRC_INPUT=1 -Dfill_dated_filename=flycast_fill_dated_filename -Dfill_pathname=flycast_fill_pathname -Dfill_pathname_abbreviate_special=flycast_fill_pathname_abbreviate_special -Dfill_pathname_application_dir=flycast_fill_pathname_application_dir -Dfill_pathname_application_path=flycast_fill_pathname_application_path -Dfill_pathname_base=flycast_fill_pathname_base -Dfill_pathname_base_ext=flycast_fill_pathname_base_ext -Dfill_pathname_base_noext=flycast_fill_pathname_base_noext -Dfill_pathname_basedir=flycast_fill_pathname_basedir -Dfill_pathname_basedir_noext=flycast_fill_pathname_basedir_noext -Dfill_pathname_dir=flycast_fill_pathname_dir -Dfill_pathname_expand_special=flycast_fill_pathname_expand_special -Dfill_pathname_home_dir=flycast_fill_pathname_home_dir -Dfill_pathname_join=flycast_fill_pathname_join -Dfill_pathname_join_concat=flycast_fill_pathname_join_concat -Dfill_pathname_join_concat_noext=flycast_fill_pathname_join_concat_noext -Dfill_pathname_join_delim=flycast_fill_pathname_join_delim -Dfill_pathname_join_delim_concat=flycast_fill_pathname_join_delim_concat -Dfill_pathname_join_noext=flycast_fill_pathname_join_noext -Dfill_pathname_join_special_ext=flycast_fill_pathname_join_special_ext -Dfill_pathname_noext=flycast_fill_pathname_noext -Dfill_pathname_parent_dir=flycast_fill_pathname_parent_dir -Dfill_pathname_parent_dir_name=flycast_fill_pathname_parent_dir_name -Dfill_pathname_resolve_relative=flycast_fill_pathname_resolve_relative -Dfill_pathname_slash=flycast_fill_pathname_slash -Dfill_short_pathname_representation=flycast_fill_short_pathname_representation -Dfill_short_pathname_representation_noext=flycast_fill_short_pathname_representation_noext -Dfill_str_dated_filename=flycast_fill_str_dated_filename -Dfind_last_slash=flycast_find_last_slash -Dis_path_accessible_using_standard_io=flycast_is_path_accessible_using_standard_io -Dpath_basedir=flycast_path_basedir -Dpath_basedir_wrapper=flycast_path_basedir_wrapper -Dpath_get_size=flycast_path_get_size -Dpath_is_absolute=flycast_path_is_absolute -Dpath_is_character_special=flycast_path_is_character_special -Dpath_is_compressed_file=flycast_path_is_compressed_file -Dpath_is_directory=flycast_path_is_directory -Dpath_is_valid=flycast_path_is_valid -Dpath_mkdir=flycast_path_mkdir -Dpath_parent_dir=flycast_path_parent_dir -Dpath_relative_to=flycast_path_relative_to -Dpath_remove_extension=flycast_path_remove_extension -Dpath_resolve_realpath=flycast_path_resolve_realpath -Dpath_stat=flycast_path_stat -Dpath_vfs_init=flycast_path_vfs_init -Dword_wrap=flycast_word_wrap -Drglgen_resolve_symbols=flycast_rglgen_resolve_symbols -Drglgen_resolve_symbols_custom=flycast_rglgen_resolve_symbols_custom -Drglgen_symbol_map=flycast_rglgen_symbol_map' -DCMAKE_CXX_FLAGS='-DJIT_PROD_BUILD=1 -DFLY_RELEASE_BUILD=1 -DFLYCAST_WRC_INPUT=1 -Dfill_dated_filename=flycast_fill_dated_filename -Dfill_pathname=flycast_fill_pathname -Dfill_pathname_abbreviate_special=flycast_fill_pathname_abbreviate_special -Dfill_pathname_application_dir=flycast_fill_pathname_application_dir -Dfill_pathname_application_path=flycast_fill_pathname_application_path -Dfill_pathname_base=flycast_fill_pathname_base -Dfill_pathname_base_ext=flycast_fill_pathname_base_ext -Dfill_pathname_base_noext=flycast_fill_pathname_base_noext -Dfill_pathname_basedir=flycast_fill_pathname_basedir -Dfill_pathname_basedir_noext=flycast_fill_pathname_basedir_noext -Dfill_pathname_dir=flycast_fill_pathname_dir -Dfill_pathname_expand_special=flycast_fill_pathname_expand_special -Dfill_pathname_home_dir=flycast_fill_pathname_home_dir -Dfill_pathname_join=flycast_fill_pathname_join -Dfill_pathname_join_concat=flycast_fill_pathname_join_concat -Dfill_pathname_join_concat_noext=flycast_fill_pathname_join_concat_noext -Dfill_pathname_join_delim=flycast_fill_pathname_join_delim -Dfill_pathname_join_delim_concat=flycast_fill_pathname_join_delim_concat -Dfill_pathname_join_noext=flycast_fill_pathname_join_noext -Dfill_pathname_join_special_ext=flycast_fill_pathname_join_special_ext -Dfill_pathname_noext=flycast_fill_pathname_noext -Dfill_pathname_parent_dir=flycast_fill_pathname_parent_dir -Dfill_pathname_parent_dir_name=flycast_fill_pathname_parent_dir_name -Dfill_pathname_resolve_relative=flycast_fill_pathname_resolve_relative -Dfill_pathname_slash=flycast_fill_pathname_slash -Dfill_short_pathname_representation=flycast_fill_short_pathname_representation -Dfill_short_pathname_representation_noext=flycast_fill_short_pathname_representation_noext -Dfill_str_dated_filename=flycast_fill_str_dated_filename -Dfind_last_slash=flycast_find_last_slash -Dis_path_accessible_using_standard_io=flycast_is_path_accessible_using_standard_io -Dpath_basedir=flycast_path_basedir -Dpath_basedir_wrapper=flycast_path_basedir_wrapper -Dpath_get_size=flycast_path_get_size -Dpath_is_absolute=flycast_path_is_absolute -Dpath_is_character_special=flycast_path_is_character_special -Dpath_is_compressed_file=flycast_path_is_compressed_file -Dpath_is_directory=flycast_path_is_directory -Dpath_is_valid=flycast_path_is_valid -Dpath_mkdir=flycast_path_mkdir -Dpath_parent_dir=flycast_path_parent_dir -Dpath_relative_to=flycast_path_relative_to -Dpath_remove_extension=flycast_path_remove_extension -Dpath_resolve_realpath=flycast_path_resolve_realpath -Dpath_stat=flycast_path_stat -Dpath_vfs_init=flycast_path_vfs_init -Dword_wrap=flycast_word_wrap -Drglgen_resolve_symbols=flycast_rglgen_resolve_symbols -Drglgen_resolve_symbols_custom=flycast_rglgen_resolve_symbols_custom -Drglgen_symbol_map=flycast_rglgen_symbol_map' && emmake make -j7"
```

This produces `libflycast_libretro_emscripten.a` and its dependency archives
(libchdr, lzma, zstd, zlib, libzip, libelf, miniupnpc, tinygettext, nowide,
xxHash) under `retrostash/flycast-wasm/source-canonical/build-wasm-prod/` —
the exact set `Makefile.emscripten.flycast`'s `FLYCAST_LIBS` expects (see
that file, ~line 289).

For an incremental rebuild after touching flycast's C++ source, just re-run the
`emmake make -j7` from inside `build-wasm-prod` — no need to reconfigure with
`emcmake cmake` again unless `CMakeLists.txt` itself changed.

## 2. Relink against RetroArch

```
docker exec emsdk-3.1.74 sh -c "cd /work/webrcade/retrostash/RetroArch && rm -rf obj-emscripten2 flycast_libretro.js flycast_libretro.wasm flycast_libretro.wasm.map && emmake make -f Makefile.emscripten.flycast LIBRETRO=flycast -j7"
```

The `rm -rf obj-emscripten2 ...` clean is needed before relinking after a core
rebuild — RetroArch's own object dir is otherwise reused stale. Produces
`flycast_libretro.js`/`.wasm` in `retrostash/RetroArch/`.

## 3. Deploy

```
docker exec emsdk-3.1.74 sh -c "cp /work/webrcade/retrostash/RetroArch/flycast_libretro.js /work/webrcade/webrcade-app-retro-flycast/public/js/flycast_libretro.js && cp /work/webrcade/retrostash/RetroArch/flycast_libretro.wasm /work/webrcade/webrcade-app-retro-flycast/public/js/flycast_libretro.wasm"
```

## Notes

- To verify a link is free of `libretro-common`/`rcheevos` ABI collisions between
  flycast's and RetroArch's differently-aged vendored copies (a real, previously
  hit bug class — see `file_path.c`/`stdstring.c`'s `flycast_`-prefixed renames
  in flycast's own CMake build), check the linked `.wasm`'s `name` custom section
  for any `signature_mismatch:` strings — there should be none. Note this only
  works on a build with `-g`/debug symbols; a normal production build (the
  commands above) strips the name section entirely, so there's nothing to check
  without a separate debug rebuild.
- `ASYNCIFY=0` in `Makefile.emscripten.flycast` is intentional — flycast's own
  SH4 JIT uses a non-blocking `WebAssembly.instantiate(...).then(...)` pattern
  with an interpreter fallback, so it doesn't need Asyncify's synchronous-blocking
  support, and disabling it keeps the binary smaller/faster. This was the fix for
  a real iOS/Xbox tab-crash bug (previously `ASYNCIFY=1`) — don't re-enable it.
- `MEMORY_GROWTH_GEOMETRIC_STEP=0.05` (also in `Makefile.emscripten.flycast`,
  next to `ASYNCIFY=0`) shipped alongside the Asyncify fix but was later shown
  (byte-identical memory-growth traces with/without it) to not actually matter —
  it's harmless and stayed in, but `ASYNCIFY=0` is the change that fixed the
  crash.
- `FLYCAST_SRC` in `Makefile.emscripten.flycast` defaults to
  `../flycast-wasm/source-canonical` — if that ever needs to be overridden
  (e.g. a temporary test build from a different checkout), pass
  `FLYCAST_SRC=...` on the `make` command line rather than editing the default.
