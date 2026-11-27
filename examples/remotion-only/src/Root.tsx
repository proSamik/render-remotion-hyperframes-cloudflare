import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { Cube } from './Cube';
import { Shapes } from './Shapes';
import { WebFont } from './WebFont';

export type ExampleProps = { title: string; durationInSeconds: number };

const FPS = 30;
// The length comes from the input props, so one deployed site renders any length.
const calculateMetadata: CalculateMetadataFunction<ExampleProps> = ({ props }) => ({
  durationInFrames: Math.max(1, Math.round(props.durationInSeconds * FPS)),
});

export const Root: React.FC = () => (
  <>
    {/* Text and shapes with a sound track. No WebGL: renders with Remotion's default GL setting. */}
    <Composition id="Shapes" component={Shapes} width={1920} height={1080} fps={FPS} durationInFrames={300}
      defaultProps={{ title: 'Rendered on Cloudflare Containers', durationInSeconds: 10 }} calculateMetadata={calculateMetadata} />
    {/* A font file shipped with the project, loaded before the first frame. */}
    <Composition id="WebFont" component={WebFont} width={1920} height={1080} fps={FPS} durationInFrames={150}
      defaultProps={{ title: 'Fonts come with the project', durationInSeconds: 5 }} calculateMetadata={calculateMetadata} />
    {/* three.js: needs WebGL. Render it with `webgl: true` (see docs/gl-backends.md). */}
    <Composition id="Cube" component={Cube} width={1920} height={1080} fps={FPS} durationInFrames={150}
      defaultProps={{ title: 'WebGL without a GPU', durationInSeconds: 5 }} calculateMetadata={calculateMetadata} />
  </>
);
