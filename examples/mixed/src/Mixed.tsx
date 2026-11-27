import React from 'react';
import { Audio, Video } from '@remotion/media';
import { AbsoluteFill, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

export type MixedProps = { title: string; hyperframesLayer: string };

/**
 * Remotion is the host. The HyperFrames layer is not HTML here: it was rendered by HyperFrames into a WebM with an
 * alpha channel before this render started, and it is played like any other video. That keeps both renderers
 * exactly as their authors test them, and every chunk on every instance shows the same pixels for the layer.
 */
export const Mixed: React.FC<MixedProps> = ({ title, hyperframesLayer }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const hue = interpolate(frame, [0, durationInFrames], [200, 320]);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${hue + 60} 70% 12%))`, fontFamily: 'sans-serif', color: 'white' }}>
      {Array.from({ length: 12 }, (_, index) => {
        const t = frame / fps + index * 0.7;
        return <div key={index} style={{ position: 'absolute', left: 160 * index + Math.sin(t) * 60, top: 160 + Math.cos(t * 0.8) * 90 + (index % 3) * 120, width: 90, height: 90, borderRadius: 45, background: `hsl(${hue + index * 12} 85% 62%)`, opacity: 0.55 }} />;
      })}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 110 }}>
        <div style={{ fontSize: 88, fontWeight: 800, textShadow: '0 6px 30px rgba(0,0,0,0.5)' }}>{title}</div>
        <div style={{ fontSize: 40, marginTop: 20, opacity: 0.8, fontVariantNumeric: 'tabular-nums' }}>Remotion frame {String(frame).padStart(4, '0')}</div>
      </AbsoluteFill>
      {/* The layer is 6 s long and starts 1 s in. Its own time starts at 0 inside the Sequence. */}
      <Sequence from={fps} durationInFrames={6 * fps}>
        <Video src={staticFile(hyperframesLayer)} muted style={{ width: '100%', height: '100%' }} />
      </Sequence>
      <Audio src={staticFile('tone.wav')} />
    </AbsoluteFill>
  );
};
