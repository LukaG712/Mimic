import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';

import { isSafeSubpath, discoverTools, resolvePythonExecutable } from '../src/reverse/orchestrator/tool_registry.mjs';
import { analyzePE } from '../src/reverse/engines/pe_analyzer.mjs';
import { identifyBinary } from '../src/reverse/detection/file_identifier.mjs';
import { analyzeStrings } from '../src/reverse/analysis/strings_analyzer.mjs';
import { parseOle2Container, analyzeMsi } from '../src/reverse/engines/msi_analyzer.mjs';
import { extractPyInstaller } from '../src/reverse/extractors/pyinstaller_extractor.mjs';
import { analyzeSoftware } from '../src/reverse/orchestrator/analysis_pipeline.mjs';

function buildSyntheticPE({
  is64 = false,
  isDotNet = false,
  isSingleFileDotNet = false,
  sections = [{ name: '.text', data: Buffer.from('MZ_CODE_SECTION https://api.example.com/v1 192.168.1.50 HKLM\\Software\\Mimic C:\\Users\\dev\\app.pdb') }],
  extraTail = Buffer.alloc(0)
} = {}) {
  const peOffset = 0x80;
  const optSize = is64 ? 0xf0 : 0xe0;
  const numSections = sections.length;
  const headersEnd = peOffset + 4 + 20 + optSize + numSections * 40;
  const firstRawOffset = Math.ceil(headersEnd / 0x200) * 0x200;

  let curRaw = firstRawOffset;
  let curRva = 0x1000;
  const sectionMetas = sections.map(sec => {
    const rawSize = Math.max(0x200, Math.ceil(sec.data.length / 0x200) * 0x200);
    const meta = {
      name: sec.name,
      data: sec.data,
      rawOffset: curRaw,
      rawSize,
      virtualAddress: curRva,
      virtualSize: sec.data.length
    };
    curRaw += rawSize;
    curRva += Math.ceil(Math.max(sec.data.length, 0x1000) / 0x1000) * 0x1000;
    return meta;
  });

  const totalSize = curRaw + extraTail.length;
  const buf = Buffer.alloc(totalSize);

  // DOS header
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(peOffset, 0x3c);

  // PE signature + COFF header
  buf.write('PE\0\0', peOffset, 'ascii');
  const coff = peOffset + 4;
  buf.writeUInt16LE(is64 ? 0x8664 : 0x014c, coff); // Machine
  buf.writeUInt16LE(numSections, coff + 2);
  buf.writeUInt32LE(1700000000, coff + 4); // TimeDateStamp
  buf.writeUInt16LE(optSize, coff + 16);
  buf.writeUInt16LE(0x0002, coff + 18); // EXECUTABLE_IMAGE

  // Optional header
  const opt = coff + 20;
  buf.writeUInt16LE(is64 ? 0x020b : 0x010b, opt);
  buf.writeUInt8(14, opt + 2); // MajorLinkerVersion
  buf.writeUInt32LE(0x1000, opt + 16); // AddressOfEntryPoint
  if (is64) {
    buf.writeBigUInt64LE(0x140000000n, opt + 24);
    buf.writeUInt16LE(3, opt + 68); // Console subsystem
    buf.writeUInt32LE(16, opt + 108); // NumberOfRvaAndSizes
    if (isDotNet) {
      const ddStart = opt + 112;
      buf.writeUInt32LE(0x2000, ddStart + 14 * 8); // CLR header RVA
      buf.writeUInt32LE(0x48, ddStart + 14 * 8 + 4);
    }
  } else {
    buf.writeUInt32LE(0x00400000, opt + 28);
    buf.writeUInt16LE(2, opt + 68); // GUI subsystem
    buf.writeUInt32LE(16, opt + 92);
    if (isDotNet) {
      const ddStart = opt + 96;
      buf.writeUInt32LE(0x2000, ddStart + 14 * 8);
      buf.writeUInt32LE(0x48, ddStart + 14 * 8 + 4);
    }
  }

  // Section headers & data
  const secTable = opt + optSize;
  sectionMetas.forEach((m, idx) => {
    const off = secTable + idx * 40;
    buf.write(m.name.slice(0, 8), off, 'ascii');
    buf.writeUInt32LE(m.virtualSize, off + 8);
    buf.writeUInt32LE(m.virtualAddress, off + 12);
    buf.writeUInt32LE(m.rawSize, off + 16);
    buf.writeUInt32LE(m.rawOffset, off + 20);
    m.data.copy(buf, m.rawOffset);
  });

  if (isSingleFileDotNet) {
    const marker = Buffer.from('hostfxr.dll\0.NETCoreApp\0SingleFileHost', 'utf8');
    marker.copy(buf, sectionMetas[0].rawOffset + 120);
  }
  if (extraTail.length > 0) {
    extraTail.copy(buf, curRaw);
  }

  return buf;
}

function buildSyntheticPyInstaller(basePeBuf, pycBytes) {
  const compressedPyc = zlib.deflateSync(pycBytes);
  const compressedEvil = zlib.deflateSync(Buffer.from('evil'));

  const entriesData = Buffer.concat([compressedPyc, compressedEvil]);
  const entry1Name = Buffer.from('main\0', 'utf8');
  const entry1Len = 18 + entry1Name.length;
  const entry1 = Buffer.alloc(entry1Len);
  entry1.writeUInt32BE(entry1Len, 0);
  entry1.writeUInt32BE(0, 4);
  entry1.writeUInt32BE(compressedPyc.length, 8);
  entry1.writeUInt32BE(pycBytes.length, 12);
  entry1.writeUInt8(1, 16);
  entry1.writeUInt8('s'.charCodeAt(0), 17);
  entry1Name.copy(entry1, 18);

  const entry2Name = Buffer.from('../../evil.txt\0', 'utf8');
  const entry2Len = 18 + entry2Name.length;
  const entry2 = Buffer.alloc(entry2Len);
  entry2.writeUInt32BE(entry2Len, 0);
  entry2.writeUInt32BE(compressedPyc.length, 4);
  entry2.writeUInt32BE(compressedEvil.length, 8);
  entry2.writeUInt32BE(4, 12);
  entry2.writeUInt8(1, 16);
  entry2.writeUInt8('x'.charCodeAt(0), 17);
  entry2Name.copy(entry2, 18);

  const toc = Buffer.concat([entry1, entry2]);
  const cookieSize = 88;
  const pkgLen = entriesData.length + toc.length + cookieSize;
  const cookie = Buffer.alloc(cookieSize);
  Buffer.from([0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e]).copy(cookie, 0);
  cookie.writeUInt32BE(pkgLen, 8);
  cookie.writeUInt32BE(entriesData.length, 12); // tocOffset
  cookie.writeUInt32BE(toc.length, 16); // tocLen
  cookie.writeUInt32BE(311, 20); // Python 3.11
  Buffer.from('python311.dll\0', 'utf8').copy(cookie, 24);

  return Buffer.concat([basePeBuf, entriesData, toc, cookie]);
}

function buildSyntheticMsi() {
  // Minimal valid OLE2 Compound File (512-byte sectors) with 1 FAT sector, 1 Directory sector, and embedded MSCF CAB
  const buf = Buffer.alloc(512 * 4);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  buf.writeUInt16LE(9, 0x1e); // sectorSize = 512
  buf.writeUInt32LE(1, 0x2c); // 1 FAT sector
  buf.writeUInt32LE(1, 0x30); // firstDirSector = 1
  buf.writeUInt32LE(0, 0x4c); // DIFAT[0] = sector 0

  // Sector 0 (offset 512): FAT
  const fatOff = 512;
  buf.writeUInt32LE(0xfffffffd, fatOff); // sector 0 = FAT
  buf.writeUInt32LE(0xfffffffe, fatOff + 4); // sector 1 = ENDOFCHAIN (dir)

  // Sector 1 (offset 1024): Directory entries
  const dirOff = 1024;
  // Root Entry
  const rootName = Buffer.from('Root Entry\0', 'utf16le');
  rootName.copy(buf, dirOff);
  buf.writeUInt16LE(rootName.length, dirOff + 64);
  buf.writeUInt8(5, dirOff + 66);

  // MSI 6-bit encoded table stream: 0x4840 ('!') + 'Property'
  const propName = Buffer.from([0x40, 0x48, 0x19, 0x00]); // simplified MSI table marker
  propName.copy(buf, dirOff + 128);
  buf.writeUInt16LE(6, dirOff + 128 + 64);
  buf.writeUInt8(2, dirOff + 128 + 66);

  // Sector 2 (offset 1536): Embedded MSCF CAB signature + external cab string
  const dataOff = 1536;
  Buffer.from([0x4d, 0x53, 0x43, 0x46, 0x00, 0x00, 0x00, 0x00]).copy(buf, dataOff);
  buf.writeUInt32LE(128, dataOff + 8);
  Buffer.from('data1.cab', 'ascii').copy(buf, dataOff + 32);

  return buf;
}

async function runTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-re-test-'));

  try {
    // 1. Path traversal guard
    assert.strictEqual(isSafeSubpath('/tmp/safe', '/tmp/safe/sub/file.txt'), true);
    assert.strictEqual(isSafeSubpath('/tmp/safe', '/tmp/safe/../etc/passwd'), false);
    assert.strictEqual(isSafeSubpath('/tmp/safe', '/etc/passwd'), false);

    // 2. Tool discovery
    const tools = discoverTools();
    assert.ok(tools['7z'] && typeof tools['7z'].available === 'boolean');
    assert.ok(tools.python3 && tools.python3.available, 'python3 should be available');

    // 3. PE32 & PE32+ static analysis + strings
    const pe32 = buildSyntheticPE({ is64: false });
    const pe32Res = analyzePE(pe32);
    assert.strictEqual(pe32Res.isPE, true);
    assert.strictEqual(pe32Res.architecture, 'x86 (i386)');
    assert.strictEqual(pe32Res.subsystem, 'Windows GUI');

    const pe64 = buildSyntheticPE({ is64: true });
    const pe64Path = path.join(tmpRoot, 'native64.exe');
    fs.writeFileSync(pe64Path, pe64);
    const id64 = identifyBinary(pe64Path, pe64);
    assert.strictEqual(id64.kind, 'native-pe');
    assert.strictEqual(id64.architecture, 'x64 (AMD64)');

    const strRes = analyzeStrings(pe64);
    assert.ok(strRes.urls.includes('https://api.example.com/v1'));
    assert.ok(strRes.ipAddresses.includes('192.168.1.50'));
    assert.ok(strRes.registryKeys.some(k => k.includes('HKLM\\Software\\Mimic')));
    assert.ok(strRes.pdbPaths.some(p => p.includes('app.pdb')));

    // 4. .NET & Single-File .NET detection
    const dotnetPe = buildSyntheticPE({ is64: true, isDotNet: true });
    const dotnetId = identifyBinary(path.join(tmpRoot, 'app.exe'), dotnetPe);
    assert.strictEqual(dotnetId.kind, 'dotnet');
    assert.strictEqual(dotnetId.runtime, '.NET Framework / CLR Assembly');

    const sfDotnet = buildSyntheticPE({ is64: true, isSingleFileDotNet: true });
    const sfId = identifyBinary(path.join(tmpRoot, 'sf.exe'), sfDotnet);
    assert.strictEqual(sfId.kind, 'dotnet-singlefile');

    // 5. UPX, Inno Setup, NSIS detection
    const upxPe = buildSyntheticPE({
      sections: [{ name: 'UPX0', data: Buffer.from('UPX! packed') }]
    });
    assert.ok(identifyBinary('upx.exe', upxPe).packers.includes('UPX'));

    const innoPe = buildSyntheticPE({ extraTail: Buffer.from('Inno Setup Setup Data (6.0.0)') });
    assert.strictEqual(identifyBinary('setup.exe', innoPe).installerFramework, 'Inno Setup');

    const nsisPe = buildSyntheticPE({ extraTail: Buffer.from('NullsoftInst') });
    assert.strictEqual(identifyBinary('nsis.exe', nsisPe).installerFramework, 'NSIS (Nullsoft Scriptable Install System)');

    const burnPe = buildSyntheticPE({ extraTail: Buffer.from('WixBurn') });
    assert.strictEqual(identifyBinary('burn.exe', burnPe).installerFramework, 'WiX Burn');

    const mpressPe = buildSyntheticPE({ sections: [{ name: '.MPRESS1', data: Buffer.from('packed') }] });
    assert.ok(identifyBinary('mpress.exe', mpressPe).packers.includes('MPRESS'));

    // 5b. VS_VERSION_INFO parsing
    const verPayload = Buffer.concat([
      Buffer.from('VS_VERSION_INFO\0', 'utf16le'),
      Buffer.from('ProductName\0\0MimicTestApp\0CompanyName\0\0Antigravity\0FileVersion\x00\x002.4.1.0\0', 'utf16le')
    ]);
    const verPe = buildSyntheticPE({ extraTail: verPayload });
    const verParsed = analyzePE(verPe);
    assert.strictEqual(verParsed.versionInfo.ProductName, 'MimicTestApp');
    assert.strictEqual(verParsed.versionInfo.CompanyName, 'Antigravity');
    assert.strictEqual(verParsed.versionInfo.FileVersion, '2.4.1.0');

    // 6. PyInstaller extraction + path traversal blocking + Python bytecode disassembly
    const pyBin = resolvePythonExecutable();
    assert.ok(pyBin, 'resolvePythonExecutable() should find Python 3');
    const pycOut = path.join(tmpRoot, 'sample.pyc');
    execFileSync(pyBin, [
      '-c',
      'import marshal, sys; code = compile("x = 42\\nprint(x)", "<test>", "exec"); open(sys.argv[1], "wb").write(b"\\x00"*16 + marshal.dumps(code))',
      pycOut
    ]);
    const pycBytes = fs.readFileSync(pycOut);
    const pyiExe = buildSyntheticPyInstaller(pe64, pycBytes);
    const pyiPath = path.join(tmpRoot, 'pyi_app.exe');
    fs.writeFileSync(pyiPath, pyiExe);

    assert.strictEqual(identifyBinary(pyiPath, pyiExe).kind, 'pyinstaller');

    const pyiAnalysisDir = path.join(tmpRoot, 'out-pyi');
    const pyiReport = await analyzeSoftware(pyiPath, pyiAnalysisDir);
    assert.strictEqual(pyiReport.report.extraction.status, 'extracted');
    assert.ok(pyiReport.report.durationMs >= 0);
    assert.strictEqual(pyiReport.report.file.sourcePath, undefined, 'sourcePath should not leak by default');
    assert.ok(pyiReport.report.extraction.files.includes('main.pyc'));
    assert.strictEqual(pyiReport.report.extraction.blockedPaths.length, 1);
    assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'evil.txt')), false, 'Path traversal file must never be written');
    assert.ok(
      pyiReport.report.decompilation.files.some(f => f.output.endsWith('main.dis.txt') || f.output.endsWith('main.py')),
      'Python bytecode should be disassembled or decompiled'
    );

    // 6b. Real 7z ZIP archive extraction via pipeline
    if (tools['7z']?.available) {
      const zipSrcDir = path.join(tmpRoot, 'zip-src');
      fs.mkdirSync(path.join(zipSrcDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(zipSrcDir, 'sub', 'hello.txt'), 'hello from mimic archive', 'utf8');
      const zipPath = path.join(tmpRoot, 'bundle.zip');
      execFileSync(pyBin, [
        '-c',
        'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])',
        zipPath,
        zipSrcDir
      ]);
      const zipOut = path.join(tmpRoot, 'out-zip');
      const zipRep = await analyzeSoftware(zipPath, zipOut);
      assert.strictEqual(zipRep.report.extraction.status, 'extracted');
      assert.ok(zipRep.report.extraction.files.some(f => f.endsWith('hello.txt')));
    }

    // 7. MSI OLE2 container & CAB detection
    const msiBuf = buildSyntheticMsi();
    const msiPath = path.join(tmpRoot, 'installer.msi');
    fs.writeFileSync(msiPath, msiBuf);
    const ole2 = parseOle2Container(msiBuf);
    assert.strictEqual(ole2.isOle2, true);
    assert.strictEqual(ole2.embeddedCabs.length, 1);
    const msiRes = await analyzeMsi(msiPath, tools, msiBuf);
    assert.strictEqual(msiRes.isMsi, true);
    assert.ok(msiRes.ole2.externalCabs.some(c => c.name === 'data1.cab'));

    // 8. Unsupported / invalid file
    const badPath = path.join(tmpRoot, 'random.bin');
    fs.writeFileSync(badPath, Buffer.from('NOT_A_VALID_BINARY_12345'));
    const badReport = await analyzeSoftware(badPath, path.join(tmpRoot, 'out-bad'));
    assert.strictEqual(badReport.report.overallStatus, 'unsupported');
    assert.ok(fs.existsSync(badReport.reportPath));

    console.log('✓ reverse_engineering tests passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('❌ reverse_engineering test failed:', err);
  process.exit(1);
});
