/**
 * Windows Binary, Runtime, Packer, and Installer Format Identifier
 * Detects PE32/PE32+, .NET (Framework/Modern/Single-File), Electron, PyInstaller,
 * Nuitka, AutoIt, UPX, Inno Setup, NSIS, InstallShield, Advanced Installer,
 * WiX Burn, Squirrel, and MSI packages.
 */

import fs from 'fs';
import { analyzePE } from '../engines/pe_analyzer.mjs';

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PYINSTALLER_COOKIE = Buffer.from([0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e]);

function hasMarker(buf, marker) {
  return buf.indexOf(marker) !== -1;
}

export function identifyBinary(filePath, existingBuffer = null) {
  const buf = existingBuffer || fs.readFileSync(filePath);
  const ext = (filePath.split('.').pop() || '').toLowerCase();

  // 1. MSI / OLE2 Compound Document
  if (buf.length >= 8 && buf.subarray(0, 8).equals(OLE2_MAGIC)) {
    return {
      kind: 'msi',
      fileType: 'Windows Installer Package (MSI / OLE2 Compound File)',
      architecture: 'Windows Installer',
      runtime: 'Windows Installer',
      compiler: null,
      installerFramework: 'Windows Installer (MSI)',
      packers: [],
      isSupported: true,
      pe: null
    };
  }

  // 2. ZIP / Self-contained archive
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    return {
      kind: 'archive',
      fileType: 'ZIP Archive',
      architecture: 'N/A',
      runtime: 'Archive',
      compiler: null,
      installerFramework: null,
      packers: [],
      isSupported: true,
      pe: null
    };
  }

  // 3. PE Executable / DLL / Installer
  const pe = analyzePE(buf);
  if (!pe.isPE) {
    return {
      kind: 'unsupported',
      fileType: ext ? `Unknown (${ext})` : 'Unknown binary',
      architecture: null,
      runtime: null,
      compiler: null,
      installerFramework: null,
      packers: [],
      isSupported: false,
      pe: null,
      reason: pe.error || 'Not a valid PE or MSI file'
    };
  }

  const sectionNames = new Set(pe.sections.map(s => s.name.toUpperCase()));
  const importDllsLower = new Set(pe.dependencies.map(d => d.toLowerCase()));

  // Detect packers / protectors
  const packers = [];
  if (sectionNames.has('UPX0') || sectionNames.has('UPX1') || hasMarker(buf, 'UPX!')) {
    packers.push('UPX');
  }
  if (sectionNames.has('.ASPACK') || sectionNames.has('.ADATA')) packers.push('ASPack');
  if (sectionNames.has('.THEMIDA') || hasMarker(buf, 'Themida')) packers.push('Themida');
  if (sectionNames.has('.VMP0') || sectionNames.has('.VMP1')) packers.push('VMProtect');
  if (sectionNames.has('.MPRESS1') || sectionNames.has('.MPRESS2')) packers.push('MPRESS');
  if (sectionNames.has('PEC2') || hasMarker(buf, 'PEC2')) packers.push('PECompact');
  if (sectionNames.has('.ENIGMA1') || sectionNames.has('.ENIGMA2')) packers.push('Enigma Protector');
  if (hasMarker(buf, '__pyarmor__')) packers.push('PyArmor');
  if (hasMarker(buf, 'ConfuserEx')) packers.push('ConfuserEx');
  if (hasMarker(buf, 'costura.')) packers.push('Costura.Fody');
  if (pe.sections.some(s => s.entropy >= 7.4 && s.rawSize > 4096) && packers.length === 0) {
    packers.push('High-Entropy Section (Possible Packer/Encrypted Payload)');
  }

  // Detect installer frameworks
  let installerFramework = null;
  if (hasMarker(buf, 'Inno Setup Setup Data') || hasMarker(buf, 'Inno Setup Messages')) {
    installerFramework = 'Inno Setup';
  } else if (hasMarker(buf, 'NullsoftInst')) {
    installerFramework = 'NSIS (Nullsoft Scriptable Install System)';
  } else if (sectionNames.has('.WIXBURN') || hasMarker(buf, 'WixBurn')) {
    installerFramework = 'WiX Burn';
  } else if (hasMarker(buf, 'InstallShield')) {
    installerFramework = 'InstallShield';
  } else if (hasMarker(buf, 'Advanced Installer')) {
    installerFramework = 'Advanced Installer';
  } else if (hasMarker(buf, 'Squirrel') && (hasMarker(buf, 'Update.exe') || hasMarker(buf, 'nuspec'))) {
    installerFramework = 'Squirrel';
  } else if (hasMarker(buf, ';!@Install@!UTF-8!')) {
    installerFramework = '7-Zip SFX';
  } else if (hasMarker(buf, 'Rar!') && pe.isExecutable) {
    installerFramework = 'WinRAR SFX';
  }

  // Detect runtime & compiler/toolchain
  let runtime = 'Native Win32/PE';
  let compiler = `MSVC / Linker ${pe.linkerVersion}`;
  let kind = 'native-pe';

  if (hasMarker(buf, PYINSTALLER_COOKIE) || hasMarker(buf, 'PYZ\0') || hasMarker(buf, 'PyInstaller')) {
    kind = 'pyinstaller';
    runtime = 'Python (PyInstaller Bundle)';
    compiler = 'PyInstaller';
  } else if (hasMarker(buf, '__nuitka_') || hasMarker(buf, 'nuitka')) {
    kind = 'nuitka';
    runtime = 'Python (Nuitka Compiled)';
    compiler = 'Nuitka';
  } else if (hasMarker(buf, 'AU3!EA06') || hasMarker(buf, 'AutoIt v3')) {
    kind = 'autoit';
    runtime = 'AutoIt v3';
    compiler = 'Aut2Exe';
  } else if (hasMarker(buf, 'ELECTRON_RUN_AS_NODE') || hasMarker(buf, 'resources/app.asar') || hasMarker(buf, 'app.asar')) {
    kind = 'electron';
    runtime = 'Electron (Chromium + Node.js)';
    compiler = 'Electron';
  } else if (pe.hasClrHeader) {
    kind = 'dotnet';
    runtime = '.NET Framework / CLR Assembly';
    compiler = 'Roslyn / .NET CLR';
  } else if (hasMarker(buf, 'coreclr.dll') || hasMarker(buf, 'hostfxr.dll') || hasMarker(buf, '.NETCoreApp')) {
    kind = 'dotnet-singlefile';
    runtime = hasMarker(buf, 'Bundle') || hasMarker(buf, 'SingleFileHost')
      ? 'Modern .NET (Self-Contained / Single-File)'
      : 'Modern .NET';
    compiler = '.NET SDK';
  } else if (hasMarker(buf, 'rustc') || hasMarker(buf, '/cargo/') || hasMarker(buf, 'panicked at')) {
    compiler = 'Rust (rustc / LLVM)';
  } else if (hasMarker(buf, 'Go build ID:') || sectionNames.has('.GOPCLNT')) {
    compiler = 'Go (gc)';
  } else if (importDllsLower.has('vcruntime140.dll') || importDllsLower.has('msvcp140.dll')) {
    compiler = `MSVC C/C++ (Linker ${pe.linkerVersion})`;
  } else if (hasMarker(buf, 'MinGW') || hasMarker(buf, 'GCC:')) {
    compiler = 'GCC / MinGW';
  }

  if (installerFramework) {
    kind = 'exe-installer';
  }

  return {
    kind,
    fileType: `${pe.format} ${pe.isDll ? 'DLL' : 'Executable'} (${pe.architecture})`,
    architecture: pe.architecture,
    runtime,
    compiler,
    installerFramework,
    packers,
    isSupported: true,
    pe
  };
}
