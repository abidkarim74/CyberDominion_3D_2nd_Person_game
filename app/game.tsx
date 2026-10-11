'use client';

import { useEffect, useRef, useState } from 'react';
import { MAX_SPEED_KMH } from '@/lib/vehicle-dynamics';
import CityMinimap, { type CityMinimapHandle } from '@/components/city-minimap';
import { NeonCityGame, type DriveTelemetry, type CameraView } from '@/lib/neon-city';

const INITIAL_TELEMETRY: DriveTelemetry = {
  speed: 0,
  boost: 1,
  drifting: false,
  boosting: false,
  firing: false,
};

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<NeonCityGame | null>(null);
  const minimapRef = useRef<CityMinimapHandle>(null);
  const [started, setStarted] = useState(false);
  const [cameraView, setCameraView] = useState<CameraView>('chase');
  const [telemetry, setTelemetry] = useState(INITIAL_TELEMETRY);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const game = new NeonCityGame(canvas, setTelemetry, setCameraView,
      (x, z, yaw) => minimapRef.current?.update(x, z, yaw));
    gameRef.current = game;
    // Local QA can inspect render/physics state without shipping a debug UI.
    if (import.meta.env.DEV) Object.assign(canvas, { __drive: game, __audio: () => game.audioDiagnostics() });
    return () => {
      game.destroy();
      Reflect.deleteProperty(canvas, '__drive');
      Reflect.deleteProperty(canvas, '__audio');
      gameRef.current = null;
    };
  }, []);

  const play = () => {
    gameRef.current?.setDriving(true);
    setStarted(true);
  };

  return (
    <main className={`game-shell${started ? ' is-driving' : ''}${cameraView === 'driver' ? ' is-driver-view' : ''}${cameraView === 'orbit' ? ' is-orbit-view' : ''}`}>
      <canvas
        ref={canvasRef}
        className="game-canvas"
        tabIndex={0}
        aria-label="Neon city driving game"
      />
      <div className="screen-grade" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />
      <div className="city-ident" aria-hidden="true">
        <span className="city-ident-mark">NN<span>07</span></span>
        <span className="city-ident-copy">NOCTURNE<span>COASTAL GRID / NIGHT DRIVE</span></span>
      </div>

      <section
        className={`start-screen${started ? ' start-screen-dismissed' : ''}`}
        aria-label={started ? undefined : 'Start game'}
        aria-hidden={started}
        inert={started}
      >
        <div className="title-lockup">
          <p className="title-eyebrow"><span /> THE CITY NEVER SLEEPS</p>
          <h1 className="game-title">
            <span>NEON</span>
            <span className="title-second-line">NOCTURNE</span>
          </h1>
          <p className="game-intro">Cold streets. Electric skyline.<br />Take the city after dark.</p>
          <button type="button" className="play-button" onClick={play}>
            <span>PLAY</span>
            <span className="play-arrow" aria-hidden="true">↗</span>
          </button>
          <dl className="control-guide" aria-label="Keyboard controls">
            <div><dt><kbd>W</kbd><span> / </span><kbd>↑</kbd></dt><dd>Accelerate</dd></div>
            <div><dt><kbd>S</kbd><span> / </span><kbd>↓</kbd></dt><dd>Brake / press again to reverse</dd></div>
            <div><dt><kbd>A D</kbd><span> / </span><kbd>← →</kbd></dt><dd>Steer</dd></div>
            <div><dt><kbd>SHIFT</kbd></dt><dd>Boost</dd></div>
            <div><dt><kbd>SPACE</kbd></dt><dd>Drift brake + steer</dd></div>
            <div><dt><kbd>F</kbd></dt><dd>Fire</dd></div>
            <div><dt><kbd>C</kbd><span> / </span><kbd>O</kbd></dt><dd>Camera / inspect car</dd></div>
            <div><dt><kbd>R</kbd></dt><dd>Reset car</dd></div>
          </dl>
        </div>
        <div className="start-world-label" aria-hidden="true"><span>SECTOR 07</span> COASTAL MEGACITY <i /> FREE DRIVE</div>
        <a className="model-credit" href="/models/bugatti/ATTRIBUTION.md" target="_blank" rel="noreferrer">Chiron model · CIORBYN STUDIO</a>
      </section>

      {started && (
        <button type="button" className="camera-toggle" onClick={() => gameRef.current?.toggleCameraView()}
          aria-label={cameraView === 'chase' ? 'Switch to driver view' : 'Switch to chase view'}
          aria-keyshortcuts="C" title="Change camera (C)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="3" /><path d="M8 7l2-3h4l2 3" /><circle cx="12" cy="13.5" r="3.5" /></svg>
          <span>{cameraView === 'chase' ? 'DRIVER VIEW' : 'CHASE VIEW'}</span><kbd>C</kbd>
        </button>
      )}

      {started && (
        <button type="button" className="camera-toggle car-inspect-toggle" onClick={() => gameRef.current?.toggleOrbitView()}
          aria-label={cameraView === 'orbit' ? 'Return to driving camera' : 'Inspect car from all sides'}
          aria-pressed={cameraView === 'orbit'} aria-keyshortcuts="O" title="Inspect every angle (O)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13a9 5 0 1 0 2-5M4 4v5h5" /><path d="M8 12l1-3h6l1 3v4H8zM8 13h8" /></svg>
          <span>{cameraView === 'orbit' ? 'EXIT INSPECT' : '360° CAR'}</span><kbd>O</kbd>
        </button>
      )}

      {started && cameraView === 'orbit' && (
        <p className="car-inspect-help">Drag / arrows to rotate<br />Scroll / pinch / + − to zoom</p>
      )}

      {started && <CityMinimap ref={minimapRef} />}

      {started && (
        <section className="drive-hud" aria-label="Driving information" aria-live="off">
          <div className={`speedometer${telemetry.boosting ? ' speed-boosting' : ''}`}>
            <div className="speed-ring" aria-hidden="true">
              <svg viewBox="0 0 120 120">
                <circle className="speed-ring-track" cx="60" cy="60" r="51" />
                <circle
                  className="speed-ring-value"
                  cx="60"
                  cy="60"
                  r="51"
                  style={{ strokeDashoffset: `${320 - Math.min(telemetry.speed / MAX_SPEED_KMH, 1) * 320}px` }}
                />
              </svg>
            </div>
            <div className="speed-copy">
              <span className="speed-number">{Math.round(telemetry.speed).toString().padStart(3, '0')}</span>
              <span className="speed-unit">KM/H</span>
            </div>
          </div>
          <div className="boost-meter">
            <div className="boost-label-row">
              <span className="boost-label">BOOST</span>
              <span className="boost-value">{Math.round(telemetry.boost * 100).toString().padStart(2, '0')}</span>
            </div>
            <div className="boost-track">
              <span
                className={`boost-fill${telemetry.boosting ? ' boost-fill-active' : ''}`}
                style={{ width: `${telemetry.boost * 100}%` }}
              />
            </div>
            <span className={`drive-state${telemetry.drifting || telemetry.boosting ? ' drive-state-active' : ''}`}>
              {telemetry.boosting ? 'OVERDRIVE' : telemetry.drifting ? 'DRIFT ACTIVE' : 'SHIFT / BOOST'}
            </span>
          </div>
          <div className={`fire-indicator${telemetry.firing ? ' fire-active' : ''}`}>
            <svg className="fire-crosshair" viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="12" />
              <line x1="20" y1="4" x2="20" y2="14" />
              <line x1="20" y1="26" x2="20" y2="36" />
              <line x1="4" y1="20" x2="14" y2="20" />
              <line x1="26" y1="20" x2="36" y2="20" />
            </svg>
            <span className="fire-label">{telemetry.firing ? 'WEAPONS HOT' : 'PRESS F'}</span>
          </div>
        </section>
      )}
    </main>
  );
}
