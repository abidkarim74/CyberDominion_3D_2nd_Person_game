'use client';

import { forwardRef, memo, useImperativeHandle, useRef } from 'react';
import {
  CITY_SPAN,
  ROAD_COORDS,
  ROAD_STEP,
  ROAD_WIDTH,
} from '@/lib/city-layout';
import { carMapTransform } from '@/lib/city-map';
import { ISLAND_OUTLINE } from '@/lib/island-layout';
import type { TrafficMarker } from '@/lib/ai-traffic';

export type CityMinimapHandle = {
  update: (x: number, z: number, yaw: number, traffic?: readonly TrafficMarker[], parked?: TrafficMarker) => void;
};

const half = CITY_SPAN / 2;
const islandPath =
  ISLAND_OUTLINE.map(
    ([x, z], i) => `${i ? 'L' : 'M'} ${x + half} ${z + half}`,
  ).join(' ') + ' Z';
const roadPath = ROAD_COORDS.map((road) => {
  const at = road + half;
  return `M 0 ${at} H ${CITY_SPAN} M ${at} 0 V ${CITY_SPAN}`;
}).join(' ');
const blockPath = ROAD_COORDS.slice(0, -1)
  .flatMap((xRoad) =>
    ROAD_COORDS.slice(0, -1).map((zRoad) => {
      const x = xRoad + ROAD_STEP / 2 + half - 13;
      const z = zRoad + ROAD_STEP / 2 + half - 13;
      return `M ${x} ${z} h 26 v 26 h -26 Z`;
    }),
  )
  .join(' ');

const CityMinimap = memo(
  forwardRef<CityMinimapHandle, { onFoot?: boolean }>(function CityMinimap({ onFoot = false }, ref) {
    const markerRef = useRef<SVGGElement>(null);
    const trafficRefs = useRef<(SVGGElement | null)[]>([]);
    const parkedRef = useRef<SVGGElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        // The simulation moves just this SVG group each frame, without React rerenders.
        update(x, z, yaw, traffic = [], parked) {
          markerRef.current?.setAttribute(
            'transform',
            carMapTransform(x, z, yaw),
          );
          traffic.forEach((car, i) => {
            trafficRefs.current[i]?.setAttribute('transform', carMapTransform(car.x, car.z, car.yaw));
            trafficRefs.current[i]?.setAttribute('fill', car.color);
            trafficRefs.current[i]?.setAttribute('visibility', 'visible');
          });
          parkedRef.current?.setAttribute('visibility', parked ? 'visible' : 'hidden');
          if (parked) parkedRef.current?.setAttribute('transform', carMapTransform(parked.x, parked.z, parked.yaw));
        },
      }),
      [],
    );

    return (
      <section className="city-minimap" aria-label="City map" aria-live="off">
        <div className="minimap-header">
          <span>SECTOR 07</span>
          <span className="minimap-live">
            <i aria-hidden="true" />
            NAV
          </span>
        </div>
        <div className="minimap-map">
          <span className="minimap-north" aria-hidden="true">
            ↑ N
          </span>
          <svg
            className="minimap-svg"
            viewBox={`-64 -64 ${CITY_SPAN + 128} ${CITY_SPAN + 128}`}
            role="img"
            aria-label={onFoot ? 'City streets with your walking position, parked car, and traffic. North is up.' : 'City streets with your car and traffic. North is up.'}
          >
            <rect
              className="minimap-water"
              x="-64"
              y="-64"
              width={CITY_SPAN + 128}
              height={CITY_SPAN + 128}
            />
            <path className="minimap-city" d={islandPath} />
            <path className="minimap-grid-axis" d={`M 0 ${half} H ${CITY_SPAN} M ${half} 0 V ${CITY_SPAN}`} />
            <path
              className="minimap-roads"
              d={roadPath}
              strokeWidth={ROAD_WIDTH}
            />
            <path className="minimap-road-centers" d={roadPath} />
            <path className="minimap-blocks" d={blockPath} />
            {[0, 1, 2, 3].map(i => (
              <g key={i} ref={element => { trafficRefs.current[i] = element; }} data-traffic-marker visibility="hidden">
                <circle r="10" stroke="#08101b" strokeWidth="4" />
                <path d="M 0 -17 L 5 -9 L -5 -9 Z" />
              </g>
            ))}
            <g ref={parkedRef} data-parked-car-marker visibility="hidden" fill="#ffcc7a" stroke="#08101b" strokeWidth="3">
              <rect x="-12" y="-16" width="24" height="32" rx="5" />
              <path d="M -6 -5 H 6 M -6 7 H 6" stroke="#51351b" strokeWidth="3" />
            </g>
            <g
              ref={markerRef}
              className="minimap-car"
              data-car-marker
              transform={carMapTransform(-22, -22, 0)}
            >
              <circle className="minimap-car-halo" r="27" />
              <path
                className="minimap-car-arrow"
                d="M 0 -22 L 15 15 L 0 9 L -15 15 Z"
              />
            </g>
          </svg>
        </div>
        <div className="minimap-footer">
          <span className="minimap-you">
            <span aria-hidden="true">▲</span> {onFoot ? 'YOU · CAR' : 'YOUR CAR'}
          </span>
          <span>COASTAL GRID</span>
        </div>
      </section>
    );
  }),
);

export default CityMinimap;
