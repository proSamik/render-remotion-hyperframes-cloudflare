import React from 'react';
import { Composition } from 'remotion';
import { Mixed, type MixedProps } from './Mixed';

export const Root: React.FC = () => (
  <Composition id="Mixed" component={Mixed} width={1920} height={1080} fps={30} durationInFrames={240}
    // `hyperframesLayer` is filled in by the render engine (engine.ts): the file name carries a hash of the
    // layer's source and variables. The default is the file `npm run layer` writes, for Studio.
    defaultProps={{ title: 'One video, two frameworks', hyperframesLayer: 'hf/layer-default.webm' } satisfies MixedProps} />
);
