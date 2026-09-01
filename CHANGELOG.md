# Changelog

## 0.1.11 - 2026-09-01

### Fixed

- Fixed adaptive chart ticks when resizing a chart vertically; Y-axis ticks now recompute when only the rendered height changes.

## 0.1.10 - 2026-09-01

### Fixed

- Kept crosshair value labels readable at different chart panel sizes by scaling the SVG label text from the rendered chart height.

## 0.1.9 - 2026-09-01

### Fixed

- Kept client-side chart tick rounding aligned with the server renderer at exact powers of ten.
- Fixed wheel-circumference calibration so large but stable wheel/GPS mismatches are detected instead of being rejected as untrusted windows.
- Added clearer Copilot language model errors for missing sign-in, extension authorization, blocked requests, and unavailable models.
