import React from 'react';

import { ControlsTab } from '@webrcade/app-common';

export class GamepadControlsTab extends ControlsTab {
  render() {
    return (
      <>
        {this.renderControl('start', 'Start')}
        {this.renderControl('dpad', 'D-pad')}
        {this.renderControl('lanalog', 'Analog stick')}
        {this.renderControl('a', 'A')}
        {this.renderControl('b', 'B')}
        {this.renderControl('x', 'X')}
        {this.renderControl('y', 'Y')}
        {this.renderControl('lbump', 'L trigger')}
        {this.renderControl('rbump', 'R trigger')}
      </>
    );
  }
}

export class KeyboardControlsTab extends ControlsTab {
  render() {
    return (
      <>
        {this.renderKey('Enter', 'Start')}
        {this.renderKey('ArrowUp', 'Analog stick (Up)')}
        {this.renderKey('ArrowDown', 'Analog stick (Down)')}
        {this.renderKey('ArrowLeft', 'Analog stick (Left)')}
        {this.renderKey('ArrowRight', 'Analog stick (Right)')}
        {this.renderKey('KeyI', 'D-pad (Up)')}
        {this.renderKey('KeyK', 'D-pad (Down)')}
        {this.renderKey('KeyJ', 'D-pad (Left)')}
        {this.renderKey('KeyL', 'D-pad (Right)')}
        {this.renderKey('KeyZ', 'A')}
        {this.renderKey('KeyX', 'B')}
        {this.renderKey('KeyA', 'X')}
        {this.renderKey('KeyS', 'Y')}
        {this.renderKey('KeyQ', 'L trigger')}
        {this.renderKey('KeyW', 'R trigger')}
      </>
    );
  }
}
