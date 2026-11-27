import React from 'react';
import { ThreeCanvas } from '@remotion/three';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ExampleProps } from './Root';

/** A three.js scene. The rotation is computed from the frame number, never from a clock or useFrame(). */
export const Cube: React.FC<ExampleProps> = ({ title }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ background: '#020617' }}>
      <ThreeCanvas width={width} height={height} camera={{ position: [0, 0, 6], fov: 45 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[4, 6, 5]} intensity={2.2} />
        <mesh rotation={[t * 0.9, t * 1.3, 0]}>
          <boxGeometry args={[2, 2, 2]} />
          <meshStandardMaterial color="#38bdf8" metalness={0.3} roughness={0.35} />
        </mesh>
        <mesh rotation={[t * 0.5, 0, t * 0.7]}>
          <torusGeometry args={[2.4, 0.08, 24, 120]} />
          <meshStandardMaterial color="#f97316" />
        </mesh>
      </ThreeCanvas>
      <div style={{ position: 'absolute', bottom: 90, width: '100%', textAlign: 'center', color: 'white', fontFamily: 'sans-serif', fontSize: 64, fontWeight: 700 }}>{title}</div>
    </AbsoluteFill>
  );
};
