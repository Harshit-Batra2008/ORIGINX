const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function zipFiles(fileMap, outputPath) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const [archivePath, fullPath] of fileMap) {
    const rawData = fs.readFileSync(fullPath);
    const uncompressedSize = rawData.length;
    const crc = zlib.crc32(rawData);

    // Compress
    const compressedData = zlib.deflateRawSync(rawData);
    const compressedSize = compressedData.length;
    const pathBuf = Buffer.from(archivePath.replace(/\\/g, '/'), 'utf8');

    // Local Header (30 bytes + name)
    const localHeader = Buffer.alloc(30 + pathBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6);  // flags
    localHeader.writeUInt16LE(8, 8);  // method 8 = deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(pathBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    pathBuf.copy(localHeader, 30);

    localChunks.push(localHeader, compressedData);

    // Central Directory Header (46 bytes + name)
    const centralHeader = Buffer.alloc(46 + pathBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8);  // flags
    centralHeader.writeUInt16LE(8, 10); // method 8
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(pathBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attr
    centralHeader.writeUInt32LE(0, 38); // external attr
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    pathBuf.copy(centralHeader, 46);

    centralChunks.push(centralHeader);

    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const c of centralChunks) {
    centralDirSize += c.length;
  }

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk num
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(fileMap.length, 8); // entries on disk
  eocd.writeUInt16LE(fileMap.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  const allBuffers = [...localChunks, ...centralChunks, eocd];
  const finalZipBuffer = Buffer.concat(allBuffers);
  fs.writeFileSync(outputPath, finalZipBuffer);
  console.log(`[ZIP] Successfully created ${outputPath} (${finalZipBuffer.length} bytes, ${fileMap.length} files)`);
}

function collectFiles(dir, baseDir = '') {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.join(baseDir, ent.name);
    if (ent.isDirectory()) {
      results.push(...collectFiles(full, rel));
    } else {
      results.push([rel, full]);
    }
  }
  return results;
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const fileMap = [];

  // 1. Collect src
  fileMap.push(...collectFiles(path.join(rootDir, 'src'), 'src'));

  // 2. Collect assets
  fileMap.push(...collectFiles(path.join(rootDir, 'assets'), 'assets'));

  // 3. Collect scripts
  fileMap.push(...collectFiles(path.join(rootDir, 'scripts'), 'scripts'));

  // 4. Root config files
  const rootFiles = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'README.md',
    'LICENSE',
    'SUBMISSION_CHECKLIST.md',
    '.vscodeignore',
    '.gitignore',
    '.env.example'
  ];

  for (const rf of rootFiles) {
    const fp = path.join(rootDir, rf);
    if (fs.existsSync(fp)) {
      fileMap.push([rf, fp]);
    }
  }

  // Ensure no sensitive files or credentials accidentally included
  const forbiddenPatterns = [
    /^\.env$/i,
    /^\.env\.(?!example)/i,
    /id_rsa/i,
    /key\.pem/i,
    /neo4j_password/i,
    /^node_modules[\\/]/i,
    /^out[\\/]/i
  ];

  for (const [archivePath] of fileMap) {
    const normalized = archivePath.replace(/\\/g, '/');
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(normalized)) {
        throw new Error(`Security check failed: forbidden file ${archivePath} in fileMap!`);
      }
    }
  }

  const outZip = path.join(rootDir, 'originx-submission-source.zip');
  zipFiles(fileMap, outZip);
}

main();
