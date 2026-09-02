# Changelog

## 0.13.15 - 2026-09-02

### Fixed

- Fixed translation generation crashing after confirmation for newly generated locales because the exported webview prompt builder was missing its `translationMessages` import.

## 0.13.7 - 2026-09-01

### Fixed

- Completed Russian localization for the activity UI, charts, map statistics, and heart-rate zones.

## 0.13.4 - 2026-09-01

### Fixed

- Comparison text was rendered at the default small font size, making it look like a footnote next to the main analysis text. It now matches the font size and line height of the AI Analysis text.

## 0.13.3 - 2026-09-01

### Changed

- The AI comparison list now shows every saved comparison for the current activity, labelled the same way as the "Compare with" dropdown (date, sport, distance, duration), regardless of what is currently selected in that dropdown. Previously only the comparison for the exact pair selected right now was shown, so a saved comparison effectively disappeared as soon as you picked a different activity or cleared the selection.
- Selecting a comparison activity that already has a saved comparison now offers **Compare Again** instead of silently reusing the cached result with no visible way to redo it from that state.

## 0.13.2 - 2026-09-01

### Changed

- Every AI feature now lives in the single **AI Analysis** section: the analysis itself, the comparison against the selected activity, and the follow-up chat, in that order. The comparison no longer sits in a separate section elsewhere on the page.

### Fixed

- The comparison controls appeared only when the selected activity had a GPS track, so choosing one without recorded points - a manually logged ride, for instance - silently offered no way to compare at all. Availability now follows the dropdown selection itself.

## 0.13.1 - 2026-09-01

### Fixed

- The **Compare with AI** button was rendered at the very bottom of the activity page, below the map, the analysis and the follow-up chat, so it was effectively impossible to find after picking a comparison activity. It now sits directly under the numeric comparison table, where both rides are already shown side by side.
- Opening an activity that produced no segments crashed the whole panel, because the segment breakdown returned no display rows for an empty list.

## 0.13.0 - 2026-09-01

### Added

- Added `fitVisualizer.powerModel.dragArea` and `fitVisualizer.powerModel.rollingResistance` so the estimated-power model can be matched to your riding position and tyres.

### Changed

- Estimated power now includes the work of accelerating rider and bike. Leaving it out made stop-and-go riding read as far easier than it was, because only steady-state forces were counted.
- The default frontal area used for estimated power moved from 0.25 to 0.32 m². The old value describes a tucked time-trial position and understated aerodynamic drag for normal riding. Re-index to recalculate stored estimates.

### Fixed

- Wheel calibration no longer measures the GPS path by summing raw distances between fixes, which always overstates it because position noise adds length but never removes it. The noise is now estimated from the scatter across the direction of travel and removed. Under the current trust thresholds this is a small correction, since windows noisy enough to matter are already rejected; it keeps the measurement honest if those thresholds are ever relaxed.

## 0.12.3 - 2026-09-01

### Fixed

- When power is estimated from motion, time spent stopped is now recorded as zero watts instead of being left blank. Blank samples were skipped by Normalized Power, xPower and average power, which inflated them - and Intensity Factor and TSS with them - on rides with many stops.
- Normalized Power, xPower and the rolling averages behind decoupling now weight each sample by the time it represents rather than counting samples equally, so sparsely recorded stretches no longer count for less than densely recorded ones. Evenly recorded rides are unaffected.

## 0.12.2 - 2026-09-01

### Fixed

- TRIMP and aerobic decoupling returned `0` when they could not be calculated, which is indistinguishable from a real zero and skewed averages. Both now return no value at all, matching the other derived workload metrics. Legacy zero TRIMP values are cleared on upgrade.
- A genuine 0% decoupling is no longer hidden from the AI prompt and the activity summary; only a missing value is omitted. Perfect aerobic coupling is a finding, not an absence of data.

## 0.12.1 - 2026-09-01

### Fixed

- The migration that clears legacy zero sentinels from derived workload metrics blanked every metric on a row as soon as any single one of them was zero, discarding genuinely measured values. Each column is now cleared independently. Activities affected by earlier runs can be restored with `FIT: Index All Files`.

## 0.12.0 - 2026-09-01

### Added

- Added cumulative, directed AI comparison between two selected activities: a "Compare with AI" button next to the existing comparison dropdown asks Copilot to compare the primary workout against the chosen one, segment by segment, without assuming segments align by list position. Comparisons accumulate per directed pair (A-vs-B and B-vs-A are stored separately) and can be individually removed and recomputed.
- Segments interrupted by a short stop (e.g. a traffic light) are merged into one logical segment for the comparison prompt, noting the pause duration, instead of being read as two unrelated segments.

## 0.11.0 - 2026-09-01

### Added

- Added `fitVisualizer.preferCheapAnalysisModel` to prefer a cheaper/smaller language model for one-off activity analysis (not the follow-up chat), trying an `Auto` model family first, then a configurable model-name heuristic (`fitVisualizer.cheapModelMarkers`), then falling back to the default model.

## 0.10.1 - 2026-09-01

### Changed

- Segment breakdown lines now include the segment's distance, placed next to speed (and shown for stops when known).
- The segment breakdown is now embedded inside the `This Workout` block of the AI prompt, right after the workout's own aggregates, instead of appearing as a separate block after cross-activity history.
- Renamed the prompt's `Previous Analysis` block to `Previous Workout Analysis` to avoid confusion with `Recent Activity History` (analyses of other activities) and the `## Workout Analysis` output heading.

## 0.10.0 - 2026-09-01

### Added

- Added manual activity creation: log activities without FIT files with custom distance, duration, and heart rate data. Manual activities are included in baseline comparisons and historical aggregates for AI analysis.

## 0.9.18 - 2026-09-01

### Added

- Added grouped terrain segments across the activity table, charts, AI context, and map, with meaningful hover details and route metric values.

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
