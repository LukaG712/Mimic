/**
 * Unified Windows Software Reverse-Engineering Pipeline
 * Orchestrates identification, static PE/MSI analysis, safe extraction,
 * optional decompilation, and structured report generation.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { discoverTools } from './tool_registry.mjs';
import { identifyBinary } from '../detection/file_identifier.mjs';
import { analyzeStrings } from '../analysis/strings_analyzer.mjs';
import { analyzeMsi } from '../engines/msi_analyzer.mjs';
import { extractMsi } from '../extractors/msi_extractor.mjs';
import { extractPyInstaller } from '../extractors/pyinstaller_extractor.mjs';
import { decompilePythonBytecode } from '../engines/python_decompiler.mjs';
import { extractInstallerOrArchive } from '../extractors/archive_extractor.mjs';
import { decompileDotNet } from '../engines/dotnet_decompiler.mjs';
import { decompileNative } from '../engines/native_decompiler.mjs';

export async function analyzeSoftware(filePath, outDir, options = {}) {
  const startedAt = Date.now();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const extractEnabled = options.extract !== false;
  const decompileEnabled = options.decompile !== false;
  const maxFileSizeBytes = options.maxFileSizeBytes || 100 * 1024 * 1024;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${path.basename(filePath)}`);
  }

  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error('Target path must be a regular file');
  }
  if (stats.size > maxFileSizeBytes) {
    throw new Error(`File exceeds maximum allowed size (${maxFileSizeBytes} bytes)`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  onProgress({ phase: 'hashing', message: `Reading ${path.basename(filePath)}...` });

  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  onProgress({ phase: 'tools', message: 'Discovering reverse-engineering tools...' });
  const tools = options.tools || discoverTools();

  onProgress({ phase: 'identify', message: 'Identifying binary format, runtime, packers, and installer...' });
  const identity = identifyBinary(filePath, buf);

  onProgress({ phase: 'strings', message: 'Extracting strings, URLs, IPs, paths, and registry keys...' });
  const strings = analyzeStrings(buf);

  const report = {
    schemaVersion: '1.0',
    analyzedAt: new Date().toISOString(),
    durationMs: 0,
    safetyNotice: 'Static analysis & isolated extraction only. Target binary and installer custom actions were NOT executed.',
    file: {
      name: path.basename(filePath),
      ...(options.includeSourcePath ? { sourcePath: path.resolve(filePath) } : {}),
      size: stats.size,
      sha256
    },
    identity: {
      kind: identity.kind,
      fileType: identity.fileType,
      architecture: identity.architecture,
      runtime: identity.runtime,
      compiler: identity.compiler,
      installerFramework: identity.installerFramework,
      packers: identity.packers || [],
      isSupported: identity.isSupported
    },
    pe: identity.pe || null,
    msi: null,
    strings,
    extraction: {
      status: 'not_run',
      toolUsed: null,
      files: [],
      blockedPaths: [],
      notes: []
    },
    decompilation: {
      status: 'not_run',
      toolUsed: null,
      files: [],
      notes: []
    },
    toolsAvailable: Object.fromEntries(
      Object.entries(tools).map(([k, v]) => [k, { available: v.available, version: v.version }])
    ),
    toolsUsed: [],
    overallStatus: 'partial',
    notes: []
  };

  if (!identity.isSupported) {
    report.overallStatus = 'unsupported';
    report.notes.push(identity.reason || 'Unsupported binary format.');
    const reportPath = path.join(outDir, 'analysis-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    return { outDir, reportPath, report };
  }

  let targetForDecompile = filePath;

  // MSI Pipeline
  if (identity.kind === 'msi') {
    onProgress({ phase: 'msi', message: 'Parsing MSI OLE2 container and database tables...' });
    report.msi = await analyzeMsi(filePath, tools, buf);
    if (report.msi.notes?.length) report.notes.push(...report.msi.notes);

    if (extractEnabled) {
      onProgress({ phase: 'extract', message: 'Safely extracting MSI payload (without executing custom actions)...' });
      const ext = await extractMsi(filePath, outDir, tools, report.msi);
      report.extraction = {
        status: ext.status,
        toolUsed: ext.toolUsed,
        files: ext.files || [],
        blockedPaths: [],
        notes: ext.notes || []
      };
    }
  }
  // PyInstaller Pipeline
  else if (identity.kind === 'pyinstaller') {
    if (extractEnabled) {
      onProgress({ phase: 'extract', message: 'Extracting PyInstaller CArchive entries...' });
      const ext = extractPyInstaller(filePath, outDir, buf);
      report.extraction = {
        status: ext.status,
        toolUsed: 'mimic-pyinstaller-extractor',
        pyVersion: ext.pyVersion,
        pyLibName: ext.pyLibName,
        files: ext.files || [],
        blockedPaths: ext.blockedPaths || [],
        notes: ext.notes || []
      };

      if (decompileEnabled && ext.pycFiles?.length > 0) {
        onProgress({ phase: 'decompile', message: `Inspecting ${ext.pycFiles.length} extracted .pyc bytecode files...` });
        const dec = await decompilePythonBytecode(ext.pycFiles, outDir, tools);
        report.decompilation = {
          status: dec.status,
          toolUsed: dec.toolUsed,
          files: dec.files || [],
          notes: dec.notes || []
        };
      }
    }
  }
  // Installers, Electron, Archives, or UPX-packed binaries
  else if (
    identity.kind === 'exe-installer' ||
    identity.kind === 'electron' ||
    identity.kind === 'archive' ||
    identity.packers?.includes('UPX')
  ) {
    if (extractEnabled) {
      onProgress({ phase: 'extract', message: `Extracting ${identity.installerFramework || identity.fileType}...` });
      const ext = await extractInstallerOrArchive(filePath, outDir, identity, tools);
      report.extraction = {
        status: ext.status,
        toolUsed: ext.toolUsed,
        files: ext.files || [],
        blockedPaths: [],
        notes: ext.notes || []
      };
      if (ext.unpackedBinaryPath) {
        targetForDecompile = ext.unpackedBinaryPath;
      }
    }
  }

  // Decompilation for .NET or Native PE (if not already handled)
  if (decompileEnabled && report.decompilation.status === 'not_run') {
    if (identity.kind === 'dotnet' || identity.kind === 'dotnet-singlefile') {
      onProgress({ phase: 'decompile', message: 'Running .NET decompiler (ilspycmd)...' });
      const dec = await decompileDotNet(targetForDecompile, outDir, tools);
      report.decompilation = {
        status: dec.status,
        toolUsed: dec.toolUsed,
        files: dec.files || [],
        notes: dec.notes || []
      };
    } else if (
      identity.kind === 'native-pe' ||
      identity.kind === 'nuitka' ||
      identity.kind === 'autoit' ||
      (identity.pe?.isPE && targetForDecompile !== filePath)
    ) {
      onProgress({ phase: 'decompile', message: 'Running native binary disassembly/decompilation...' });
      const dec = await decompileNative(targetForDecompile, outDir, tools);
      report.decompilation = {
        status: dec.status,
        toolUsed: dec.toolUsed,
        files: dec.files || [],
        notes: dec.notes || []
      };
    }
  }

  // Collect toolsUsed and overallStatus
  const used = new Set();
  if (report.extraction.toolUsed) used.add(report.extraction.toolUsed);
  if (report.decompilation.toolUsed) used.add(report.decompilation.toolUsed);
  if (report.msi?.status === 'extracted' && tools.msiinfo?.available) used.add('msiinfo');
  report.toolsUsed = [...used];

  if (report.decompilation.status === 'decompiled') {
    report.overallStatus = 'decompiled';
  } else if (report.extraction.status === 'extracted') {
    report.overallStatus = 'extracted';
  } else if (
    report.decompilation.status === 'partial' ||
    report.extraction.status === 'partial' ||
    report.pe?.isPE ||
    report.msi?.isMsi
  ) {
    report.overallStatus = 'partial';
  } else {
    report.overallStatus = 'failed';
  }

  report.durationMs = Date.now() - startedAt;
  const reportPath = path.join(outDir, 'analysis-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  onProgress({ phase: 'done', message: `Analysis complete (${report.overallStatus}) in ${report.durationMs}ms.` });

  return { outDir, reportPath, report };
}
