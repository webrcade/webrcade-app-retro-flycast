import React from 'react';
import { Component } from 'react';

import {
  AppDisplaySettingsTab,
  EditorScreen,
  FieldsTab,
  FieldRow,
  FieldLabel,
  FieldControl,
  TelevisionWhiteImage,
  BlurImage,
  TuneWhiteImage,
  Select,
  ShaderSettingsTab,
  WebrcadeContext,
} from '@webrcade/app-common';

import { FRAME_SKIP } from '../emulator/prefs';

// WRC - FRAME_SKIP.FS_AUTO isn't a real reicast_frame_skipping value (it's
// resolved to a concrete disabled/1/2 client-side - see emulator/index.js's
// resolveFrameSkip()/onFpsUpdate()), the rest are exactly what the
// flycast/Dreamcast-only libretro core option accepts (see
// retrostash/flycast-wasm's source-canonical/shell/libretro/
// libretro_core_options.h). Auto is first/default per direct instruction -
// most players never touch this setting even though frame-skip 1 is
// nearly free on capable hardware, so auto is meant to be the sane default
// rather than something opted into.
const FRAME_SKIP_OPTIONS = [
  { value: FRAME_SKIP.FS_AUTO, label: '(auto)' },
  { value: FRAME_SKIP.FS_OFF, label: 'Off' },
  { value: FRAME_SKIP.FS_1, label: '1' },
  { value: FRAME_SKIP.FS_2, label: '2' },
];

export class FlycastSettingsEditor extends Component {
  constructor() {
    super();
    this.state = {
      tabIndex: null,
      focusGridComps: null,
      values: {},
    };
  }

  componentDidMount() {
    const { emulator } = this.props;

    const values = {
      origBilinearMode: emulator.getPrefs().getBilinearMode(),
      bilinearMode: emulator.getPrefs().getBilinearMode(),
      origScreenSize: emulator.getPrefs().getScreenSize(),
      screenSize: emulator.getPrefs().getScreenSize(),
      origFrameSkip: emulator.getPrefs().getFrameSkip(),
      frameSkip: emulator.getPrefs().getFrameSkip(),
      origScreenControls: emulator.getPrefs().getScreenControls(),
      screenControls: emulator.getPrefs().getScreenControls(),
    }

    this.shaderService = this.props.emulator.getShadersService();
    this.shaderService.addEditorValues(values);

    this.setState({
      values: values,
    });
  }

  render() {
    const { emulator, onClose, showOnScreenControls } = this.props;
    const { tabIndex, values, focusGridComps } = this.state;

    const setFocusGridComps = (comps) => {
      this.setState({ focusGridComps: comps });
    };

    const setValues = (values) => {
      this.setState({ values: values });
    };

    return (
      <EditorScreen
        showCancel={true}
        onOk={async () => {
          let updated = false;
          if (values.origBilinearMode !== values.bilinearMode) {
            emulator.getPrefs().setBilinearMode(values.bilinearMode);
            updated = true;
          }
          if (values.origScreenSize !== values.screenSize) {
            emulator.getPrefs().setScreenSize(values.screenSize);
            emulator.updateScreenSize();
            updated = true;
          }
          // WRC - live-apply via the wrc_set_options bridge (same mechanism
          // beetle-psx uses for disk eject/analog mode) - see
          // emulator.applyGameSettings()/getPendingFrameSkip() and the
          // matching wrc_on_set_options()/retro_run() on the core side.
          // Persisted through getPrefs() alongside bilinear/screenSize
          // above, so the next session boots with this choice too.
          let frameSkipChanged = false;
          if (values.origFrameSkip !== values.frameSkip) {
            emulator.getPrefs().setFrameSkip(values.frameSkip);
            updated = true;
            frameSkipChanged = true;
          }
          if (values.origScreenControls !== values.screenControls) {
            emulator.getPrefs().setScreenControls(values.screenControls);
            emulator.updateOnScreenControls();
            updated = true;
          }
          if (updated) {
            emulator.getPrefs().save();
          }
          if (frameSkipChanged) {
            emulator.applyGameSettings();
          }

          // Set the shader
          await this.shaderService.setShader(values.shaderId);
          emulator.updateBilinearFilter();

          onClose();
        }}
        onClose={onClose}
        focusGridComps={focusGridComps}
        onTabChange={(oldTab, newTab) => this.setState({ tabIndex: newTab })}
        tabs={[
          {
            image: TuneWhiteImage,
            label: 'Dreamcast Settings',
            content: (
              <FlycastPerformanceTab
                isActive={tabIndex === 0}
                setFocusGridComps={setFocusGridComps}
                values={values}
                setValues={setValues}
              />
            )
          },
          {
            image: TelevisionWhiteImage,
            label: 'Display Settings',
            content: (
              <AppDisplaySettingsTab
                emulator={emulator}
                isBilinearMode={true}
                isActive={tabIndex === 1}
                showOnScreenControls={showOnScreenControls}
                setFocusGridComps={setFocusGridComps}
                values={values}
                setValues={setValues}
              />
            ),
          },
          {
            image: BlurImage,
            label: 'Shader Settings',
            content: (
              <ShaderSettingsTab
                shaderService={this.shaderService}
                emulator={emulator}
                isActive={tabIndex === 2}
                setFocusGridComps={setFocusGridComps}
                values={values}
                setValues={setValues}
              />
            )
          },
        ]}
      />
    );
  }
}

// WRC (2026-09-08) - flycast/Dreamcast-only performance tuning, kept
// entirely local to this app (same pattern as js7800's AtariSettingsTab -
// see webrcade-app-js7800/src/pause/settings.js) rather than touching
// @webrcade/app-common's shared AppDisplaySettingsTab, since no other core
// has an equivalent option.
class FlycastPerformanceTab extends FieldsTab {
  constructor() {
    super();
    this.frameSkipRef = React.createRef();
    this.gridComps = [
      [this.frameSkipRef],
    ];
  }

  componentDidUpdate(prevProps, prevState) {
    const { gridComps } = this;
    const { setFocusGridComps } = this.props;
    const { isActive } = this.props;

    if (isActive && isActive !== prevProps.isActive) {
      setFocusGridComps(gridComps);
    }
  }

  render() {
    const { frameSkipRef } = this;
    const { focusGrid } = this.context;
    const { setValues, values } = this.props;

    return (
      <FieldRow>
        <FieldLabel>Frame skip</FieldLabel>
        <FieldControl>
          <Select
            ref={frameSkipRef}
            options={FRAME_SKIP_OPTIONS}
            onChange={(value) => {
              setValues({ ...values, ...{ frameSkip: value } });
            }}
            value={values.frameSkip}
            onPad={(e) => focusGrid.moveFocus(e.type, frameSkipRef)}
          />
        </FieldControl>
      </FieldRow>
    );
  }
}
FlycastPerformanceTab.contextType = WebrcadeContext;
