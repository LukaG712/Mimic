/**
 * Zero-dependency Windows PE32 / PE32+ (Portable Executable) Static Analyzer
 * Parses COFF headers, Optional Header, sections + entropy, imports, exports,
 * CLR/.NET header, CodeView PDB debug info, Authenticode presence, and XML manifests.
 */

const MACHINE_NAMES = {
  0x014c: 'x86 (i386)',
  0x8664: 'x64 (AMD64)',
  0x01c4: 'ARM (Thumb-2)',
  0xaa64: 'ARM64 (AArch64)',
  0x0200: 'IA64'
};

const SUBSYSTEM_NAMES = {
  1: 'Native',
  2: 'Windows GUI',
  3: 'Windows CUI (Console)',
  5: 'OS/2 CUI',
  7: 'POSIX CUI',
  9: 'Windows CE GUI',
  10: 'EFI Application',
  14: 'Xbox'
};

function calcEntropy(buf) {
  if (!buf || buf.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) counts[buf[i]]++;
  let entropy = 0;
  const len = buf.length;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / len;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(3));
}

function readCString(buf, offset, maxLen = 256) {
  if (offset < 0 || offset >= buf.length) return '';
  let end = offset;
  const limit = Math.min(buf.length, offset + maxLen);
  while (end < limit && buf[end] !== 0) end++;
  return buf.subarray(offset, end).toString('ascii');
}

export function rvaToOffset(rva, sections) {
  if (!rva) return -1;
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      const off = s.rawPointer + (rva - s.virtualAddress);
      return off >= 0 ? off : -1;
    }
  }
  return -1;
}

export function analyzePE(buf) {
  if (!buf || buf.length < 64 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    return { isPE: false, error: 'Missing MZ DOS signature' };
  }

  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    return { isPE: false, error: 'Missing PE\\0\\0 signature' };
  }

  const coffOff = peOffset + 4;
  const machine = buf.readUInt16LE(coffOff);
  const numberOfSections = buf.readUInt16LE(coffOff + 2);
  const timeDateStamp = buf.readUInt32LE(coffOff + 4);
  const sizeOfOptionalHeader = buf.readUInt16LE(coffOff + 16);
  const characteristics = buf.readUInt16LE(coffOff + 18);

  const optOff = coffOff + 20;
  if (optOff + 2 > buf.length) {
    return { isPE: false, error: 'Truncated PE optional header' };
  }

  const magic = buf.readUInt16LE(optOff);
  const is64 = magic === 0x020b;
  const is32 = magic === 0x010b;
  if (!is32 && !is64) {
    return { isPE: false, error: `Unsupported PE optional header magic: 0x${magic.toString(16)}` };
  }

  const majorLinker = buf[optOff + 2];
  const minorLinker = buf[optOff + 3];
  const entryPointRva = buf.readUInt32LE(optOff + 16);
  const imageBase = is64
    ? '0x' + buf.readBigUInt64LE(optOff + 24).toString(16)
    : '0x' + buf.readUInt32LE(optOff + 28).toString(16);
  const subsystem = optOff + 68 + 2 <= buf.length ? buf.readUInt16LE(optOff + 68) : 0;

  const numRvaOff = optOff + (is64 ? 108 : 92);
  const numberOfRvaAndSizes = numRvaOff + 4 <= buf.length ? Math.min(16, buf.readUInt32LE(numRvaOff)) : 0;
  const dataDirStart = optOff + (is64 ? 112 : 96);

  const dataDirectories = [];
  for (let i = 0; i < numberOfRvaAndSizes; i++) {
    const off = dataDirStart + i * 8;
    if (off + 8 > buf.length) break;
    dataDirectories.push({
      rva: buf.readUInt32LE(off),
      size: buf.readUInt32LE(off + 4)
    });
  }

  // Parse Section Table
  const secTableOff = optOff + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < Math.min(numberOfSections, 96); i++) {
    const sOff = secTableOff + i * 40;
    if (sOff + 40 > buf.length) break;
    const rawName = buf.subarray(sOff, sOff + 8);
    const nullIdx = rawName.indexOf(0);
    const name = rawName.subarray(0, nullIdx >= 0 ? nullIdx : 8).toString('ascii');
    const virtualSize = buf.readUInt32LE(sOff + 8);
    const virtualAddress = buf.readUInt32LE(sOff + 12);
    const rawSize = buf.readUInt32LE(sOff + 16);
    const rawPointer = buf.readUInt32LE(sOff + 20);
    const secChars = buf.readUInt32LE(sOff + 36);
    const sliceEnd = Math.min(buf.length, rawPointer + rawSize);
    const entropy = rawSize > 0 && rawPointer < buf.length
      ? calcEntropy(buf.subarray(rawPointer, sliceEnd))
      : 0;

    sections.push({
      name,
      virtualAddress,
      virtualSize,
      rawPointer,
      rawSize,
      characteristics: secChars,
      entropy
    });
  }

  // Parse Import Table (DataDirectory[1])
  const imports = [];
  const impDir = dataDirectories[1];
  if (impDir && impDir.rva > 0) {
    let descOff = rvaToOffset(impDir.rva, sections);
    let safety = 0;
    while (descOff >= 0 && descOff + 20 <= buf.length && safety++ < 256) {
      const iltRva = buf.readUInt32LE(descOff);
      const nameRva = buf.readUInt32LE(descOff + 12);
      const iatRva = buf.readUInt32LE(descOff + 16);
      if (iltRva === 0 && nameRva === 0 && iatRva === 0) break;

      const dllNameOff = rvaToOffset(nameRva, sections);
      const dllName = dllNameOff >= 0 ? readCString(buf, dllNameOff, 128) : '';
      const functions = [];

      const lookupRva = iltRva || iatRva;
      let thunkOff = rvaToOffset(lookupRva, sections);
      const entrySize = is64 ? 8 : 4;
      let fnCount = 0;
      while (thunkOff >= 0 && thunkOff + entrySize <= buf.length && fnCount++ < 512) {
        if (is64) {
          const val = buf.readBigUInt64LE(thunkOff);
          if (val === 0n) break;
          if ((val & (1n << 63n)) !== 0n) {
            functions.push(`Ordinal #${Number(val & 0xffffn)}`);
          } else {
            const hintOff = rvaToOffset(Number(val & 0x7fffffffn), sections);
            if (hintOff >= 0 && hintOff + 2 < buf.length) {
              const fnName = readCString(buf, hintOff + 2, 128);
              if (fnName) functions.push(fnName);
            }
          }
        } else {
          const val = buf.readUInt32LE(thunkOff);
          if (val === 0) break;
          if ((val & 0x80000000) !== 0) {
            functions.push(`Ordinal #${val & 0xffff}`);
          } else {
            const hintOff = rvaToOffset(val, sections);
            if (hintOff >= 0 && hintOff + 2 < buf.length) {
              const fnName = readCString(buf, hintOff + 2, 128);
              if (fnName) functions.push(fnName);
            }
          }
        }
        thunkOff += entrySize;
      }

      if (dllName) {
        imports.push({ dll: dllName, functions });
      }
      descOff += 20;
    }
  }

  // Parse Export Table (DataDirectory[0])
  const exports = [];
  let exportDllName = null;
  const expDir = dataDirectories[0];
  if (expDir && expDir.rva > 0) {
    const expOff = rvaToOffset(expDir.rva, sections);
    if (expOff >= 0 && expOff + 40 <= buf.length) {
      const nameOff = rvaToOffset(buf.readUInt32LE(expOff + 12), sections);
      if (nameOff >= 0) exportDllName = readCString(buf, nameOff, 128);
      const numNames = Math.min(buf.readUInt32LE(expOff + 24), 512);
      const namesRva = buf.readUInt32LE(expOff + 32);
      const namesOff = rvaToOffset(namesRva, sections);
      if (namesOff >= 0) {
        for (let i = 0; i < numNames && namesOff + i * 4 + 4 <= buf.length; i++) {
          const fnNameRva = buf.readUInt32LE(namesOff + i * 4);
          const fnNameOff = rvaToOffset(fnNameRva, sections);
          if (fnNameOff >= 0) {
            const fnName = readCString(buf, fnNameOff, 128);
            if (fnName) exports.push(fnName);
          }
        }
      }
    }
  }

  // Parse Debug Directory (DataDirectory[6]) for CodeView PDB path
  const pdbPaths = [];
  const dbgDir = dataDirectories[6];
  if (dbgDir && dbgDir.rva > 0 && dbgDir.size >= 28) {
    const dbgOff = rvaToOffset(dbgDir.rva, sections);
    if (dbgOff >= 0) {
      const count = Math.min(Math.floor(dbgDir.size / 28), 16);
      for (let i = 0; i < count; i++) {
        const entryOff = dbgOff + i * 28;
        if (entryOff + 28 > buf.length) break;
        const dbgType = buf.readUInt32LE(entryOff + 12);
        const rawPtr = buf.readUInt32LE(entryOff + 24);
        const rawSz = buf.readUInt32LE(entryOff + 16);
        if (dbgType === 2 && rawPtr > 0 && rawPtr + 24 < buf.length) {
          const sig = buf.subarray(rawPtr, rawPtr + 4).toString('ascii');
          if (sig === 'RSDS') {
            const pdb = readCString(buf, rawPtr + 24, Math.min(260, rawSz));
            if (pdb) pdbPaths.push(pdb);
          }
        }
      }
    }
  }

  // CLR Runtime Header (DataDirectory[14]) -> .NET metadata presence
  const clrDir = dataDirectories[14];
  const hasClrHeader = Boolean(clrDir && clrDir.rva > 0 && clrDir.size > 0);

  // Security / Authenticode Certificate Table (DataDirectory[4] uses raw file offset!)
  const secDir = dataDirectories[4];
  const hasAuthenticode = Boolean(secDir && secDir.rva > 0 && secDir.size > 0);

  // Check for embedded XML application manifest
  let embeddedManifest = null;
  const manifestStart = buf.indexOf('<assembly');
  if (manifestStart >= 0) {
    const manifestEnd = buf.indexOf('</assembly>', manifestStart);
    if (manifestEnd > manifestStart && manifestEnd - manifestStart < 32768) {
      embeddedManifest = buf.subarray(manifestStart, manifestEnd + '</assembly>'.length).toString('utf8');
    }
  }

  return {
    isPE: true,
    format: is64 ? 'PE32+' : 'PE32',
    architecture: MACHINE_NAMES[machine] || `0x${machine.toString(16)}`,
    is64Bit: is64,
    isDll: Boolean(characteristics & 0x2000),
    isExecutable: Boolean(characteristics & 0x0002),
    subsystem: SUBSYSTEM_NAMES[subsystem] || `Subsystem(${subsystem})`,
    compiledAt: timeDateStamp > 0 ? new Date(timeDateStamp * 1000).toISOString() : null,
    linkerVersion: `${majorLinker}.${minorLinker}`,
    entryPointRva: '0x' + entryPointRva.toString(16),
    imageBase,
    hasClrHeader,
    hasAuthenticode,
    authenticodeSize: hasAuthenticode ? secDir.size : 0,
    sections,
    imports,
    dependencies: imports.map(i => i.dll),
    exportDllName,
    exports,
    pdbPaths,
    embeddedManifest
  };
}
