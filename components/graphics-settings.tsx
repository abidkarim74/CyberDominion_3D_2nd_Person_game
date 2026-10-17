'use client';

import { useEffect, useRef } from 'react';
import { GRAPHICS_PRESETS, type GraphicsQuality, type GraphicsStatus } from '@/lib/graphics-quality';

const QUALITY_LEVELS: readonly GraphicsQuality[] = ['low', 'medium', 'high', 'ultra'];

interface GraphicsSettingsProps {
  status: GraphicsStatus;
  onQualityChange: (quality: GraphicsQuality) => void;
  onAutomaticChange: (enabled: boolean) => void;
  onClose: () => void;
}

export default function GraphicsSettings({ status, onQualityChange, onAutomaticChange, onClose }: GraphicsSettingsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  const preset = GRAPHICS_PRESETS[status.preset];

  const closeDialog = () => {
    dialogRef.current?.close();
    onClose();
  };

  useEffect(() => {
    closeRef.current = () => {
      dialogRef.current?.close();
      onClose();
    };
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input[name="graphics-quality"]:checked')?.focus();
    // Native radio navigation and dialog focus trapping stay intact, while the
    // window-level driving shortcuts never receive settings keyboard events.
    const containKeys = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.type === 'keydown' && event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.type === 'keydown' && event.key === 'Tab') {
        const controls = dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input[type="radio"]:checked, input[type="checkbox"]');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener('keydown', containKeys, true);
    window.addEventListener('keyup', containKeys, true);
    return () => {
      window.removeEventListener('keydown', containKeys, true);
      window.removeEventListener('keyup', containKeys, true);
      dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      id="graphics-settings"
      className={`graphics-settings${status.preset === 'ultra' ? ' graphics-settings-ultra' : ''}`}
      aria-labelledby="graphics-settings-title"
      aria-describedby="graphics-settings-description"
      onCancel={(event) => { event.preventDefault(); closeDialog(); }}
    >
      <header className="graphics-header">
        <div>
          <p className="graphics-eyebrow">CyberDominion / VISUALS</p>
          <h2 id="graphics-settings-title">Make the night yours.</h2>
        </div>
        <button type="button" className="graphics-close" onClick={closeDialog} aria-label="Close graphics settings" title="Close (Escape)">×</button>
      </header>
      <p id="graphics-settings-description" className="graphics-intro">Four ways to see the city. Choose the detail your computer can carry.</p>

      <fieldset className="graphics-presets">
        <legend>Graphics quality</legend>
        {QUALITY_LEVELS.map((quality, index) => {
          const option = GRAPHICS_PRESETS[quality];
          const selected = status.preset === quality;
          return (
            <label key={quality} className={`graphics-preset${selected ? ' graphics-preset-selected' : ''}${quality === 'ultra' ? ' graphics-preset-ultra' : ''}`}>
              <input
                type="radio"
                name="graphics-quality"
                value={quality}
                checked={selected}
                onChange={() => onQualityChange(quality)}
                aria-label={option.label}
                aria-describedby={`graphics-computer-${quality}`}
              />
              <span className="graphics-preset-topline">
                <span className="graphics-level">0{index + 1}</span>
                <span className="graphics-selection-mark" aria-hidden="true">{selected ? '✓' : quality === 'ultra' ? '◇' : '○'}</span>
              </span>
              <span className="graphics-preset-name">{option.label}</span>
              <span id={`graphics-computer-${quality}`} className="graphics-computer">{option.computer}</span>
              <span className="graphics-preset-tag">{quality === status.recommended ? 'RECOMMENDED' : quality === 'ultra' ? 'THE FULL EXPERIENCE' : quality === 'low' ? 'PERFORMANCE FIRST' : quality === 'medium' ? 'BALANCED' : 'RICH DETAIL'}</span>
            </label>
          );
        })}
      </fieldset>

      <section className="graphics-detail" aria-label={`${preset.label} graphics features`}>
        <div className="graphics-detail-heading"><span>{status.preset === 'ultra' ? '◇' : '↗'}</span><h3>{status.preset === 'ultra' ? 'Every light. Every detail.' : `${preset.label} · your view of the city`}</h3></div>
        <p>{preset.description}</p>
        <ul>{preset.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
      </section>

      <label className="graphics-auto" htmlFor="graphics-automatic" aria-label="Automatic quality">
        <span><span className="graphics-auto-title">Automatic quality</span><span className="graphics-auto-copy">Keep motion smooth as the city gets busy.</span></span>
        <input id="graphics-automatic" type="checkbox" checked={status.automatic} onChange={(event) => onAutomaticChange(event.target.checked)} />
        <span className="graphics-auto-switch" aria-hidden="true" />
      </label>
      <div className="graphics-footer">
        <span className="graphics-performance">{status.fps > 0 ? `${Math.round(status.fps)} FPS` : 'MEASURING FPS'}<span />{Math.round(status.resolutionScale * 100)}% RENDER SCALE</span>
        <span className="graphics-live">APPLIES LIVE · SAVED</span>
      </div>
      <button type="button" className="graphics-done" onClick={closeDialog}>Back to the city <span aria-hidden="true">↗</span></button>
    </dialog>
  );
}
