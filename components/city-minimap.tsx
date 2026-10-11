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

export type CityMinimapHandle = {
  update: (x: number, z: number, yaw: number) => void;
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
  forwardRef<CityMinimapHandle>(function CityMinimap(_, ref) {
    const markerRef = useRef<SVGGElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        // The simulation moves just this SVG group each frame, without React rerenders.
        update(x, z, yaw) {
          markerRef.current?.setAttribute(
            'transform',
            carMapTransform(x, z, yaw),
          );
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
            aria-label="Island coastline and city streets with your car's live position and heading. North is up."
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
            <span aria-hidden="true">▲</span> YOUR CAR
          </span>
          <span>COASTAL GRID</span>
        </div>
      </section>
    );
  }),
);

export default CityMinimap;
