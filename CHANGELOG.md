# Changelog

## 0.9.11 - 2026-09-01

### Changed

- Made chart and map segment hover details match the grouped context used by AI, with compact terrain bars below chart data.

## 0.9.10 - 2026-09-01

### Changed

- Presented grouped segment analysis as a table using the same rows sent to AI.

## 0.9.9 - 2026-09-01

### Changed

- Show the same grouped segment context in the activity view that is sent to AI analysis.

## 0.9.8 - 2026-09-01

### Fixed

- Omitted missing distance and grade values from stopped segments instead of displaying false zeros.

## 0.9.7 - 2026-09-01

### Fixed

- Merged adjacent terrain sections with similar effort signals to avoid artificial flat-segment fragmentation.

## 0.9.6 - 2026-09-01

### Fixed

- Kept short continuous terrain sections, including climbs, from being split into noisy effort micro-segments.

## 0.9.5 - 2026-09-01

### Fixed

- Made segment tables show power only when its effort basis is meaningful and omit misleading elevation gain on descents.

## 0.9.4 - 2026-09-01

### Fixed

- Restored activity browser rendering after refactoring and added a smoke test for renderer dependencies.

## 0.9.0 - 2026-09-01

### Added

- Added a compact activity table for detected segments and device-recorded FIT laps when available.

## 0.8.0 - 2026-09-01

### Added

- Added localized hover details for terrain segments on the map and chart bands.

## 0.7.0 - 2026-09-01

### Added

- Added a shared chart control for low-opacity terrain segment bands behind speed, heart-rate, and altitude data.

## 0.6.0 - 2026-09-01

### Added

- Added route coloring by detected terrain segments, including a legend for climbs, descents, flats, stops, and technical descents.

## 0.5.1 - 2026-09-01

### Changed

- Refactored chart geometry, data, models, overlays, SVG renderers, and activity webview presentation into focused modules; the webview module now owns activity browser/content markup, inline client behavior, shared styles, and presentation helpers.

## 0.5.0 - 2026-09-01

### Added

- Added opt-in Copilot generation and local caching of UI translations for languages without a packaged bundle.

## 0.4.2 - 2026-09-01

### Added

- Added a centralized localized UI message catalog for the activity view, controls, and live status messages.

## 0.4.1 - 2026-09-01

### Fixed

- Extended localized hover explanations to all core activity summary and comparison metrics.

## 0.4.0 - 2026-09-01

### Added

- Added localized hover explanations for key activity and training-load terms.

## 0.3.0 - 2026-09-01

### Added

- AI analysis and follow-up chat now respond in the VS Code interface language by default.

## 0.2.0 - 2026-09-01

### Added

- Added a configurable VS Code language-model vendor for activity analysis and follow-up chat.

## 0.1.20 - 2026-09-01

### Fixed

- Treated unavailable derived workload metrics as missing data instead of zero, including existing indexed activities.

## 0.1.19 - 2026-09-01

### Fixed

- Improved adaptive chart axes: readable labels, denser ticks on resize, and headroom above the highest Y value.

## 0.1.9 - 2026-09-01

### Fixed

- Fixed chart tick rounding at exact powers of ten.
- Fixed wheel calibration for large stable wheel/GPS mismatches.
- Clarified Copilot model availability and permission errors.
