# Changelog

## 0.5.3 - 2026-09-01

### Changed

- Extracted activity summary calculation into a reusable module.

## 0.5.2 - 2026-09-01

### Changed

- Extracted chart series, GPS, elevation, and statistics helpers from the extension host module.

## 0.5.1 - 2026-09-01

### Changed

- Extracted reusable chart geometry and tick helpers from the extension host module.

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
