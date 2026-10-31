const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 implementation
function crc32(buf) {
  let table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ (-1)) >>> 0;
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function writePng(width, height, rgbaBuffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8-bit depth
  ihdrData[9] = 6; // RGBA color type
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = createChunk('IHDR', ihdrData);

  const scanlines = [];
  for (let y = 0; y < height; y++) {
    scanlines.push(Buffer.from([0])); // Filter type 0
    scanlines.push(rgbaBuffer.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const idatData = zlib.deflateSync(Buffer.concat(scanlines), { level: 9 });
  const idat = createChunk('IDAT', idatData);
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// Color interpolation helpers
function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function hexToRgb(hex) {
  const num = parseInt(hex.replace('#', ''), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// Distance from point (px, py) to rounded rectangle
function sdRoundRect(px, py, rx, ry, w, h, radius) {
  const dx = Math.abs(px - rx) - (w / 2 - radius);
  const dy = Math.abs(py - ry) - (h / 2 - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  const outside = Math.sqrt(ax * ax + ay * ay);
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

// Point in polygon (triangle)
function pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
  const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
  const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

// Distance to line segment
function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

// Render supersampled icon
function renderOriginxIcon(targetSize = 128) {
  const scale = 4; // 4x supersampling
  const size = targetSize * scale;
  const highBuf = new Float32Array(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;

  // Colors
  const cViolet = hexToRgb('#9333ea'); // #9333ea
  const cIndigo = hexToRgb('#6366f1'); // #6366f1
  const cSky = hexToRgb('#38bdf8');    // #38bdf8
  const cCyan = hexToRgb('#06b6d4');   // #06b6d4
  const cWhite = [255, 255, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // 1. Background squircle
      const dSquircle = sdRoundRect(x, y, cx, cy, size - 16 * scale, size - 16 * scale, 26 * scale);

      if (dSquircle > 1.5) {
        // Outside squircle: transparent
        continue;
      }

      // Background gradient: dark navy to deep space
      const bgT = (x + y) / (size * 2);
      let r = lerp(18, 9, bgT);
      let g = lerp(20, 10, bgT);
      let b = lerp(38, 20, bgT);
      let a = 1.0;

      // Anti-aliased border of squircle
      if (dSquircle > -1.5) {
        const borderAlpha = Math.max(0, Math.min(1, (1.5 - dSquircle) / 3));
        a *= borderAlpha;
      }

      // Squircle border stroke
      if (dSquircle >= -2.5 * scale && dSquircle <= 0.5) {
        const strokeT = (size - x + y) / (size * 2);
        const sr = lerp(79, 6, strokeT);
        const sg = lerp(70, 182, strokeT);
        const sb = lerp(229, 212, strokeT);
        const strokeAlpha = Math.min(1, Math.max(0, 1 - Math.abs(dSquircle + 1 * scale) / (1.5 * scale)));
        r = lerp(r, sr, strokeAlpha * 0.45);
        g = lerp(g, sg, strokeAlpha * 0.45);
        b = lerp(b, sb, strokeAlpha * 0.45);
      }

      // 2. O-Orbit Ring geometry
      const dx = x - cx;
      const dy = y - cy;
      const distFromCenter = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx); // -PI to +PI

      const outerR = 36 * scale;
      const innerR = 21 * scale;

      // Ring angle gradient: sweeps from violet (-PI/2 to PI) to cyan (top right)
      // Angle mapped to 0..1
      const normAngle = (angle + Math.PI) / (2 * Math.PI);
      let ringR, ringG, ringB;
      if (normAngle < 0.5) {
        const t = normAngle / 0.5;
        ringR = lerp(cViolet[0], cIndigo[0], t);
        ringG = lerp(cViolet[1], cIndigo[1], t);
        ringB = lerp(cViolet[2], cIndigo[2], t);
      } else {
        const t = (normAngle - 0.5) / 0.5;
        ringR = lerp(cIndigo[0], cSky[0], t);
        ringG = lerp(cIndigo[1], cSky[1], t);
        ringB = lerp(cIndigo[2], cSky[2], t);
      }

      // Is within Ring?
      if (distFromCenter <= outerR + 2 && distFromCenter >= innerR - 2) {
        // Distance to ring boundaries
        const dOuter = distFromCenter - outerR;
        const dInner = innerR - distFromCenter;
        const dRing = Math.max(dOuter, dInner);
        let ringAlpha = 1.0;
        if (dRing > -1.5) {
          ringAlpha = Math.max(0, Math.min(1, (1.5 - dRing) / 3));
        }

        // Forward triangular cutout from the right side of the ring
        // The cutout points forward rightwards
        const triX1 = cx - 10 * scale;
        const triY1 = cy - 24 * scale;
        const triX2 = cx + 32 * scale;
        const triY2 = cy;
        const triX3 = cx - 10 * scale;
        const triY3 = cy + 24 * scale;

        const inTriCutout = pointInTriangle(x, y, triX1, triY1, triX2, triY2, triX3, triY3);

        if (!inTriCutout) {
          r = lerp(r, ringR, ringAlpha);
          g = lerp(g, ringG, ringAlpha);
          b = lerp(b, ringB, ringAlpha);
        }
      }

      // 3. Forward Delta Needle (Arrowhead inside O)
      const dDeltaX1 = cx - 8 * scale;
      const dDeltaY1 = cy - 20 * scale;
      const dDeltaX2 = cx + 28 * scale;
      const dDeltaY2 = cy;
      const dDeltaX3 = cx - 8 * scale;
      const dDeltaY3 = cy + 20 * scale;

      const inDelta = pointInTriangle(x, y, dDeltaX1, dDeltaY1, dDeltaX2, dDeltaY2, dDeltaX3, dDeltaY3);
      if (inDelta) {
        const deltaT = (x - dDeltaX1) / (36 * scale);
        const dr = lerp(cIndigo[0], cSky[0], Math.max(0, Math.min(1, deltaT)));
        const dg = lerp(cIndigo[1], cSky[1], Math.max(0, Math.min(1, deltaT)));
        const db = lerp(cIndigo[2], cSky[2], Math.max(0, Math.min(1, deltaT)));

        // Inner negative cavity or facet
        const inInnerCavity = pointInTriangle(
          x, y,
          cx - 3 * scale, cy - 11 * scale,
          cx + 17 * scale, cy,
          cx - 3 * scale, cy + 11 * scale
        );

        if (inInnerCavity) {
          r = lerp(r, 16, 0.9);
          g = lerp(g, 18, 0.9);
          b = lerp(b, 34, 0.9);
        } else {
          r = dr;
          g = dg;
          b = db;
        }
      }

      // 4. Central Core / Knowledge Node
      const dCore = Math.hypot(x - (cx - 1 * scale), y - cy);
      const coreR = 5 * scale;
      if (dCore <= coreR + 1.5) {
        let coreAlpha = 1.0;
        if (dCore > coreR - 1.5) {
          coreAlpha = Math.max(0, Math.min(1, (coreR + 1.5 - dCore) / 3));
        }
        r = lerp(r, cWhite[0], coreAlpha);
        g = lerp(g, cWhite[1], coreAlpha);
        b = lerp(b, cWhite[2], coreAlpha);
      }

      highBuf[idx] = r;
      highBuf[idx + 1] = g;
      highBuf[idx + 2] = b;
      highBuf[idx + 3] = a * 255;
    }
  }

  // Downsample 4x to targetSize (128x128)
  const outBuf = Buffer.alloc(targetSize * targetSize * 4);
  for (let oy = 0; oy < targetSize; oy++) {
    for (let ox = 0; ox < targetSize; ox++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const hx = ox * scale + sx;
          const hy = oy * scale + sy;
          const hIdx = (hy * size + hx) * 4;
          const alpha = highBuf[hIdx + 3] / 255;
          rSum += highBuf[hIdx] * alpha;
          gSum += highBuf[hIdx + 1] * alpha;
          bSum += highBuf[hIdx + 2] * alpha;
          aSum += highBuf[hIdx + 3];
        }
      }
      const count = scale * scale;
      const avgA = aSum / count;
      const outIdx = (oy * targetSize + ox) * 4;
      if (avgA > 0) {
        outBuf[outIdx] = Math.round(rSum / (aSum / 255));
        outBuf[outIdx + 1] = Math.round(gSum / (aSum / 255));
        outBuf[outIdx + 2] = Math.round(bSum / (aSum / 255));
        outBuf[outIdx + 3] = Math.round(avgA);
      } else {
        outBuf[outIdx] = 0;
        outBuf[outIdx + 1] = 0;
        outBuf[outIdx + 2] = 0;
        outBuf[outIdx + 3] = 0;
      }
    }
  }

  return writePng(targetSize, targetSize, outBuf);
}

// Write the PNG and SVG
const pngBuffer = renderOriginxIcon(128);
const pngPath = path.join(__dirname, '..', 'assets', 'originx-icon.png');
fs.writeFileSync(pngPath, pngBuffer);
console.log('Saved 128x128 PNG to:', pngPath, 'Size:', pngBuffer.length, 'bytes');

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141529"/>
      <stop offset="50%" stop-color="#0E0F1E"/>
      <stop offset="100%" stop-color="#090A14"/>
    </linearGradient>
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4F46E5" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#06B6D4" stop-opacity="0.3"/>
    </linearGradient>
    <linearGradient id="orbitGrad" x1="15%" y1="85%" x2="85%" y2="15%">
      <stop offset="0%" stop-color="#9333EA"/>
      <stop offset="35%" stop-color="#7C3AED"/>
      <stop offset="70%" stop-color="#3B82F6"/>
      <stop offset="100%" stop-color="#38BDF8"/>
    </linearGradient>
    <linearGradient id="deltaGrad" x1="0%" y1="30%" x2="100%" y2="70%">
      <stop offset="0%" stop-color="#6366F1"/>
      <stop offset="50%" stop-color="#8B5CF6"/>
      <stop offset="100%" stop-color="#06B6D4"/>
    </linearGradient>
    <filter id="subtleGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Dark Rounded Squircle Base -->
  <rect x="4" y="4" width="120" height="120" rx="26" fill="url(#bgGrad)" stroke="url(#borderGrad)" stroke-width="2"/>

  <!-- Stylized O-Orbit with Forward Delta Cutout -->
  <g transform="translate(64, 64)">
    <!-- Ambient Aura -->
    <circle cx="0" cy="0" r="36" fill="none" stroke="url(#orbitGrad)" stroke-width="14" opacity="0.18" filter="url(#subtleGlow)"/>

    <!-- Main Orbit Torus -->
    <path d="M 0 -36
             A 36 36 0 1 0 0 36
             L 16 26
             A 21 21 0 1 1 16 -26
             Z"
          fill="url(#orbitGrad)"/>

    <!-- Forward Delta Wedge (Play/Arrowhead Motif) -->
    <path d="M -8 -20
             L 28 0
             L -8 20
             L -2 0
             Z"
          fill="url(#deltaGrad)"/>

    <!-- Inner Cavity -->
    <path d="M -3 -11
             L 17 0
             L -3 11
             Z"
          fill="#101222"/>

    <!-- Knowledge Node Core -->
    <circle cx="-1" cy="0" r="5" fill="#FFFFFF" opacity="0.95"/>
    <circle cx="-1" cy="0" r="7.5" fill="none" stroke="#38BDF8" stroke-width="1.2" opacity="0.8"/>
  </g>
</svg>`;

const svgPath = path.join(__dirname, '..', 'assets', 'originx-icon.svg');
fs.writeFileSync(svgPath, svgContent);
console.log('Saved SVG to:', svgPath);
