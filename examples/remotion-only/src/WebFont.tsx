import React from 'react';
import { loadFont } from '@remotion/fonts';
import { AbsoluteFill, cancelRender, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from 'remotion';
import type { ExampleProps } from './Root';

// The container has only the fonts its image installs. A font the design needs travels with the project
// (public/fonts) and the render waits for it: no frame is drawn before the font is ready. Every browser tab
// loads this module, so every tab loads the font.
const handle = delayRender('Loading Archivo Black');
loadFont({ family: 'Archivo Black', url: staticFile('fonts/ArchivoBlack-Regular.ttf') })
  .then(() => continueRender(handle))
  .catch((error) => cancelRender(error));

export const WebFont: React.FC<ExampleProps> = ({ title }) => {
  const frame = useCurrentFrame();
  const words = title.split(' ');
  return (
    <AbsoluteFill style={{ background: '#fef3c7', alignItems: 'center', justifyContent: 'center', padding: 120 }}>
      <div style={{ fontFamily: 'Archivo Black', fontSize: 130, lineHeight: 1.1, color: '#1c1917', textAlign: 'center' }}>
        {words.map((word, index) => (
          <span key={index} style={{ display: 'inline-block', marginRight: 34, opacity: interpolate(frame, [index * 6, index * 6 + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            transform: `translateY(${interpolate(frame, [index * 6, index * 6 + 10], [40, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}px)` }}>{word}</span>
        ))}
      </div>
      <div style={{ position: 'absolute', bottom: 80, fontFamily: 'sans-serif', fontSize: 36, color: '#57534e' }}>Archivo Black (SIL Open Font License) from public/fonts · the line below it is the image's default sans-serif</div>
    </AbsoluteFill>
  );
};
