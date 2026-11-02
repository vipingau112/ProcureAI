// A rangoli drawn with SVG: rings of petals around a centre. Colours come from CSS variables.
export default function Rangoli({ size = 360 }: { size?: number }) {
  const ring = (count: number, scale: number, fill: string, opacity = 1) =>
    Array.from({ length: count }, (_, i) => (
      <g key={`${count}-${i}`} transform={`rotate(${(360 / count) * i}) scale(${scale})`} opacity={opacity}>
        <path d="M0 -14 C 13 -34 13 -62 0 -86 C -13 -62 -13 -34 0 -14Z" fill={fill} />
        <circle cx="0" cy="-93" r="3.6" fill={fill} />
      </g>
    ));
  return (
    <svg viewBox="-100 -100 200 200" width={size} height={size} role="img" aria-label="Rangoli pattern" className="rangoli">
      <circle r="97" fill="none" stroke="var(--marigold)" strokeWidth="1.2" strokeDasharray="2 5" />
      {ring(16, 1, 'var(--rani)', 0.9)}
      {ring(12, 0.78, 'var(--marigold)')}
      {ring(8, 0.52, 'var(--peacock)')}
      {ring(8, 0.3, '#fff', 0.95)}
      <circle r="6" fill="var(--marigold)" />
    </svg>
  );
}
