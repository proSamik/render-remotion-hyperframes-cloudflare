import React from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ExampleProps } from './Root';

const COLORS = ['#f97316', '#22d3ee', '#a3e635', '#f472b6', '#facc15'];

/** A flash in the corner on the first two frames of every second. The sound track beeps at the same moments. */
export const SecondFlash: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <div style={{ position: 'absolute', right: 60, top: 60, width: 60, height: 60, borderRadius: 12, background: frame % fps < 2 ? '#ffffff' : '#1e293b' }} />;
};

export const Shapes: React.FC<ExampleProps> = ({ title }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const seconds = frame / fps;
  const enter = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ background: '#0f172a', fontFamily: 'sans-serif', color: 'white' }}>
      {/* Every position is a function of the frame number: a chunk that starts at frame 900 draws frame 900. */}
      {COLORS.map((color, index) => {
        const angle = seconds * (0.6 + index * 0.15) + index * 1.3;
        const radius = 260 + index * 45;
        return (
          <div key={color} style={{ position: 'absolute', left: 960 + Math.cos(angle) * radius - 60, top: 540 + Math.sin(angle) * radius * 0.55 - 60, width: 120, height: 120,
            borderRadius: index % 2 ? 60 : 20, background: color, transform: `rotate(${angle * 40}deg)`, opacity: 0.9 }} />
        );
      })}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 84, fontWeight: 800, textAlign: 'center', transform: `scale(${interpolate(enter, [0, 1], [0.8, 1])})`, opacity: enter, textShadow: '0 6px 30px rgba(0,0,0,0.6)' }}>{title}</div>
        <div style={{ fontSize: 44, marginTop: 30, fontVariantNumeric: 'tabular-nums', opacity: 0.85 }}>
          frame {String(frame).padStart(5, '0')} / {durationInFrames} · {seconds.toFixed(2)} s
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, bottom: 0, height: 14, width: `${((frame + 1) / durationInFrames) * 100}%`, background: '#22d3ee' }} />
      <SecondFlash />
      <Audio src={staticFile('tone.wav')} loop />
    </AbsoluteFill>
  );
};
