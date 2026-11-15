# Mimic Windows Software Reverse Engineering & Decompilation Plan

## 1. Architecture (`src/reverse/`)
- `src/reverse/orchestrator/tool_registry.mjs`: Auto-discovers optional tools (`7z`/`7za`, `upx`, `innoextract`, `ilspycmd`, `analyzeHeadless`, `objdump`, `msiinfo`, `msiextract`, `lessmsi`, `uncompyle6`, `decompyle3`, `python3`) with version probing and availability status.
- `src/reverse/detection/file_identifier.mjs`: Magic-byte, PE section/CLR/bundle/packer, OLE2/MSI, and installer framework detector (`PE32`, `PE32+`, `.NET Framework`, `Modern .NET`, `Single-File .NET`, `Electron`, `PyInstaller`, `Nuitka`, `AutoIt`, `UPX`, `Inno Setup`, `NSIS`, `InstallShield`, `Advanced Installer`, `WiX Burn`, `Squirrel`, `MSI`).
- `src/reverse/engines/pe_analyzer.mjs`: Zero-dependency PE32/PE32+ parser (COFF headers, sections + Shannon entropy, imports, exports, CLR/.NET header, CodeView PDB debug info, Authenticode cert presence, `.rsrc` manifest/version info).
- `src/reverse/analysis/strings_analyzer.mjs`: ASCII & UTF-16LE string extractor with URL, IPv4, filesystem path, registry key, and PDB path classification.
- `src/reverse/engines/msi_analyzer.mjs` & `src/reverse/extractors/msi_extractor.mjs`: Pure-JS OLE2 CFB parser + MSI table/CAB inspector, plus safe `msiinfo`/`msiextract`/`lessmsi`/`7z` extraction adapters.
- `src/reverse/extractors/pyinstaller_extractor.mjs` & `src/reverse/engines/python_decompiler.mjs`: PyInstaller CArchive (`MEI`) extractor, `.pyc` header parser, Python `dis` disassembler, and optional `uncompyle6`/`decompyle3` decompiler adapter.
- `src/reverse/extractors/archive_extractor.mjs`: Safe `7z`/`innoextract`/`upx -d` extraction with strict path-traversal guards and timeouts (never executes target binaries).
- `src/reverse/engines/dotnet_decompiler.mjs` & `src/reverse/engines/native_decompiler.mjs`: `ilspycmd` adapter for `.NET -> C#`, Ghidra `analyzeHeadless` + `objdump` adapter for native disassembly/pseudocode.
- `src/reverse/orchestrator/analysis_pipeline.mjs`: Runs the full static pipeline into `analyses/<slug>/` and writes `analysis-report.json` with explicit per-stage statuses (`extracted`, `decompiled`, `partial`, `unsupported`, `failed`).

## 2. CLI & Dashboard Integration
- `src/cli.js`: Add `inspect-bin <file> [name]` and `tools` commands.
- `src/dashboard.js`: Add **Software Analysis** section with drag-and-drop upload, tool availability badges, SSE progress, analyzed projects list, file/table/code browser, and ZIP/JSON export.

## 3. Testing & Documentation
- `test/reverse_engineering.test.mjs`: Synthetic PE32/PE32+/.NET/UPX/Inno/NSIS/PyInstaller/MSI-CAB/corrupted/path-traversal tests.
- `README.md`: Document supported formats, optional tools, CLI & Studio usage, security model, and limitations.
