'use client';

import { useEffect, useRef, useState } from 'react';
import { NeonCityGame, type DriveTelemetry } from '@/lib/neon-city';

const INITIAL_TELEMETRY: DriveTelemetry = {
  speed: 0,
  boost: 1,
  drifting: false,
  boosting: false,
};

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<NeonCityGame | null>(null);
  const [started, setStarted] = useState(false);
  const [telemetry, setTelemetry] = useState(INITIAL_TELEMETRY);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const game = new NeonCityGame(canvas, setTelemetry);
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
    <main className={`game-shell${started ? ' is-driving' : ''}`}>
      <canvas
        ref={canvasRef}
        className="game-canvas"
        tabIndex={0}
        aria-label="Neon city driving game"
      />
      <div className="screen-grade" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />

      <section
        className={`start-screen${started ? ' start-screen-dismissed' : ''}`}
        aria-label={started ? undefined : 'Start game'}
        aria-hidden={started}
        inert={started}
      >
        <div className="title-lockup">
          <h1 className="game-title">
            <span>NEON</span>
            <span className="title-second-line">NOCTURNE</span>
          </h1>
          <button type="button" className="play-button" onClick={play}>
            <span>PLAY</span>
            <span className="play-arrow" aria-hidden="true">↗</span>
          </button>
        </div>
      </section>

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
                  style={{ strokeDashoffset: `${320 - Math.min(telemetry.speed / 300, 1) * 320}px` }}
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
          </div>
        </section>
      )}
    </main>
  );
}
