# Changelog

## 0.17.1 - 2026-10-03

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 22). Re-indexing is not required.

### Fixed

- **Same-route context and route elevation never reached the prompt**: the current ride's route and checkpoints were not computed on the real analysis path, so only unit tests had seen them. Verified now by building real prompts from the 39-ride database: checkpoint splits, final-climb history and the route elevation consensus appear.
- "Recent same-route rides" were the oldest five instead of the latest five; checkpoint differences are printed as signed `m:ss`.
- Device ascent/descent stored as 0/0 (no figure written) is no longer shown as a measured `device 0/0 m`.
- Summary types written in the answer language (for example "пороговая") are normalized to the code's labels, so the history shows `code X / model Y` only for real disagreements; the tail now lists the allowed types.

### Changed

- History rows are shorter: only the latest six carry the full summary (older ones keep type and advice category), the unchanged HR-profile date and `source fit` are omitted, and the explanation of AI summaries is stated once. Block budgets in the log were recalibrated to measured sizes (history 4500, training volume 3200, user context 3200, segments 1600 characters).

## 0.17.0 - 2026-10-03

### Upgrade Notes

- Run **FIT: Rebuild Derived Features** once, then **FIT: Re-analyze Outdated Analyses** (analysis format 21). The rebuild now also assigns routes in chronological order and, unlike before, saves its result. Re-indexing is not required.

### Added

- **Same-route identity (GPS)**: rides are matched by track geometry (same / reversed / partial / different), grouped into routes, and the prompt gets per-2-km checkpoint splits against the median of prior same-route rides plus the final-climb history.
- **Route elevation consensus**: with at least five same-route rides, per-ride constant altitude offsets are removed and the per-bin median gives a stable route ascent/descent (about 117 m for the development loop, closed within 1 m) that is shown next to the computed and device figures.
- **Altitude quality flags** in the prompt: `ALT_MISSING_START`, `ALT_GAP` and `ALT_SETTLING` (barometer drift in the first minutes, measured against the route consensus, or from start-vs-end of a closed loop).

- **Structured carry-forward**: the analysis ends with a short machine-readable SUMMARY (type, finding, advice category, advice, open question, revised). It is cut from the displayed text, stored in `activity_analysis.summary_json`, and later prompts see these compact summaries (code class vs model type) plus the recent advice categories instead of full past analyses. Older analyses fall back to their first 400 characters.
- **Prompt restructure**: the analysis prompt is sent as two messages - instructions with 15 positive principles and the response format first, data and questions last - replacing ~45 evidence rules (rules 6.6k -> ~3.8k characters). The log records per-block budgets and overshoots.
- **FIT: Evaluate Analysis Prompt** (dev command) regenerates a fixed set of analyses without touching stored ones and writes `eval/<run>/report.md` with automatic checks (valid tail, type vs code class, repeated advice category, numbers not in the prompt, missed quality flags) and deltas against the previous run. `node scripts/prompt-eval/check.js <dir>` runs the same checks on eval runs or LLM logs.

### Fixed

- **FIT: Rebuild Derived Features** and **FIT: Tidy Heart-Rate Profiles** failed with a ReferenceError because the command module never received their handlers.

- Derived features, route assignments and elevation profiles computed while building an analysis were never written back to the database, and **Rebuild Derived Features** did not save its result. They are now persisted.
- Route assignment is idempotent: repeated analyses no longer inflate a route's ride count, and assignments no longer depend on a feature row existing.

## 0.16.0 - 2026-10-03

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** after updating (analysis format 20). Re-indexing is not required, but **FIT: Rebuild Derived Features** once will pre-populate the new cache for all activities (it is also filled lazily as analyses run).

### Added

- **Heuristic session class**: a deterministic classifier (session-class.js) labels each ride as recovery / endurance / tempo / threshold / VO2max-anaerobic / mixed / unstructured / undetermined from zone shares, the 20-minute peak versus the LTHR estimate, sustained Zone-4 runs and hard-effort counts, with confidence, reasons and alternatives. The prompt receives it as a computed, revisable label and asks the model to confirm or dispute it in one sentence instead of re-deriving zone percentages.
- **Per-session intensity in history**: recent-activity rows now include the L/M/H split, the 20-minute peak, TRIMP and the session class, so the stimulus mix of recent sessions is visible to the model.
- **Period load**: 7/28-day blocks report the TRIMP sum with HR coverage and the session-class mix, plus a Foster-style week monotony and strain (descriptive, imported days only).
- **Derived-feature cache**: an `activity_features` table stores segments, zones, peaks, session class and load per activity, keyed by feature version, segmentation/power settings, the dated HR profile and the athlete profile. Stale keys recompute lazily; **FIT: Rebuild Derived Features** refreshes everything with progress. History beyond the 40 most recent activities per sport is now served from the cache instead of being skipped.
- **Tested LTHR**: an optional lactate-threshold HR field on the dated profile; hrTSS and the prompt use it directly instead of an estimate when present.
- Zone 1's floor now follows the Karvonen reserve when a resting HR is known, and TRIMP's averaged male/female coefficients for sex "other" are disclosed in the provenance block.

### Changed

- LTHR estimation priority: tested value > middle of the Threshold zone > 85 % of the reserve > 85 % of max HR, removing the previous ~5 bpm disagreement between the two zone systems.

## 0.15.0 - 2026-10-03

### Upgrade Notes

- **Existing users: re-index your FIT files.** New per-activity fields (device timezone offset, device ascent/descent, device elapsed/moving time) are extracted at indexing. Run **FIT: Index All Files**, then **FIT: Re-analyze Outdated Analyses** (analysis format 19).

### Added

- Local time support: the UTC offset configured on the bike computer is read from the FIT `local_timestamp` (file-name fallback, quarter-hour quantization, sanity limits) and stored per activity. AI prompts show the local start time with its zone label; active days and history dates use local dates. A device timezone that disagrees with nearby rides produces an explicit prompt note instead of silently distorted day counts.
- Device-written session data is now stored: total ascent/descent, moving time and elapsed time. When the device's ascent disagrees with the computed one beyond 15 %/15 m, the prompt shows both sources and tells the model to treat ascent and the first segment's grade with caution.
- `fitVisualizer.analysisModelId` pins one-off analyses to a specific model id (overrides the cheapest-model selection) for reproducible prompt experiments; an unavailable id fails loudly.

### Changed

- A device session left recording for hours no longer distorts elapsed time: when the session elapsed exceeds the recorded span beyond tolerance, records win and the prompt states the discrepancy (for example an "8:54" session elapsed for a 57-minute ride).

## 0.14.1 - 2026-10-03

### Upgrade Notes

- The AI prompt changed, so saved analyses are one format behind. Run **FIT: Re-analyze Outdated Analyses** to refresh them (analysis format 18); **Index New Files** is not needed.
- Optional: run **FIT: Tidy Heart-Rate Profiles** once to collapse duplicate dated profiles created by earlier saves.

### Added

- Heart-rate values entered from another device (manual avg/max) now reach AI analysis, chat and comparison as a clearly labelled user-reported summary, instead of being invisible to the model. Earlier rides without a recorded HR series stop looking "heart-rate free".
- **FIT: Tidy Heart-Rate Profiles** previews and removes consecutive duplicate dated profiles and lists max-HR flips. Saving an identical profile no longer creates a new dated row, so history stops forking; a max-HR value that returns between two others is flagged as a possible accidental flip.
- Offline map mode: `fitVisualizer.map.tiles: none` draws the route without any tile requests. The default `osm` mode still loads OpenStreetMap tiles, and the privacy sections of both READMEs now say so explicitly.
- `fitVisualizer.llmChatLogRetentionDays` (default 180) keeps chat and comparison logs longer than one-off analysis logs, which stay at `llmLogRetentionDays` (default 30).
- Segment-budget warnings now appear in a dedicated **FIT Visualizer: Analysis** output channel, as a once-per-session notification, and next to the segments table in the activity view — previously they existed only inside JSON log files.

### Changed

- User messages about earlier workouts are supplied once, under Dated User Context, instead of being duplicated inside Recent Activity History.
- Chat and AI comparison prompts receive the dated heart-rate profile; the comparison is told that differing profiles change HR comparability. Chat responses are no longer capped at 4-8 sentences.
- Map fallback texts ("no GPS points", "map library failed") are localized like the rest of the UI; webview messages validate activity ids before database access.
- `bugs` and `homepage` links added to the package manifest; the built VSIX is no longer tracked in git.

## 0.14.0 - 2026-10-02

### Upgrade Notes

- Re-index existing FIT files with **FIT: Index All Files**, then run **FIT: Re-analyze Outdated Analyses** to refresh saved AI analyses (analysis format 17). **Index New Files** does not refresh existing records.
- Indexing is local; optional AI re-analysis sends context through GitHub Copilot and may consume your allowance.

### Added

- AI analysis is more sports-specific: it classifies the session type (recovery, endurance, tempo, threshold, VO2max/anaerobic, mixed) from evidence, and receives a low/moderate/high intensity distribution for the session and 7/28-day periods, peak sustained heart rate over 1/5/20/60 minutes with prior same-sport bests over 28 and 90 days, and VAM for climbs of at least 2 minutes and 25 m.
- **FIT: Update Model Prices** downloads and validates GitHub's official default-tier token prices, persists a local extension cache and applies it to subsequent analysis requests. Network, format or storage failures preserve the previous prices.
- Rewritten English and Russian documentation with real activity analysis and dialogue examples, data-quality limits, privacy details and upgrade instructions.

### Changed

- Bulk re-analysis now includes both outdated and missing analyses automatically, with one confirmation of the request count instead of a mode selector. Current analyses remain untouched.
- Grade for motion power and terrain now shares a robust spatial height/distance fit (30-120 m windows), with recording breaks, quality diagnostics, applicability limits and grade/mass sensitivity instead of a blanket 18% slope rejection.
- AI analysis, chat and comparison distinguish observations, user reports and revisable AI hypotheses; support absent/multiple/changing goals; and avoid treating postoperative recovery as something FIT can establish.
- AI context includes equal 7/28-day volume periods, covered HR intensity by sport, an adaptive 28/56/90-day observation window, candidate ordered segment comparisons, long-segment dynamics and device laps.
- Dated user reports from earlier activity chats survive stale analyses and numeric history windows. The AI cache format is now version 17; old analyses need re-analysis.
- Automatic maximum heart rate now uses the Tanaka estimate; manually entered HR overrides are excluded from AI context and automatic profiles.
- One-off AI analysis now uses the cheapest available Copilot model by default, ranked by GitHub's published per-token prices (built-in table in `model-pricing.js`). Previously the setting was off by default and the first listed model answered, which in practice was an expensive one. Set `fitVisualizer.preferCheapAnalysisModel` to `false` to restore the old behavior. Chat and comparison are unchanged.
- TRIMP and hrTSS are integrated over recorded heart-rate samples; hrTSS is measured relative to the reserve between resting HR and an estimated threshold HR (middle of the Threshold zone).
- Power:HR decoupling uses normalized power relative to average HR across ride halves and is unavailable without measured power.
- Power-metric sample weighting adapts to normal recording cadence, preserving Garmin Smart Recording intervals while limiting exceptional gaps.
- AI comparisons use prior activities of the same sport, robust trends adapt their threshold to historical variability, and motion-estimated whole-ride power metrics are omitted from AI prompts.

### Fixed

- Segment lines in AI prompts show grade/vpower diagnostics only where vpower is the quoted effort, and HR/grade coverage only when incomplete. The segment-budget log warning now counts the rows the prompt actually shows.
- AI analyses focus on what is new versus recent activities, recommend the step best supported by the observed pattern instead of branching on hypothetical goals, avoid repeating standard caveats, and no longer re-ask intent questions already asked or answered. The practical step may address execution, route, data capture or load, and identical load advice is not restated while the pattern is unchanged. A data gap already reported is not repeated as the practical step, period statistics stay attached to their date ranges, and technical terms are translated into the response language.
- Fresh AI analyses and comparisons use the VS Code language regardless of archived messages or earlier AI replies. Only the latest chat question may change the chat response language; fresh analyses do not answer archived questions.
- AI prompts explicitly exclude the current activity from historical totals and anchor relative dates in earlier analyses to their activity dates. Shifted rolling windows or missing summary detail are not grounds to declare earlier figures wrong; corrections require comparable periods and evidence.
- FIT indexing now shows progress and writes a persistent completion summary with indexed/failed counts to its Output channel, in addition to the completion notification. Indexing and price-update feedback use the bundled English/Russian translations.
- Earlier activities no longer use a later dated HR profile, and missing original FIT HR cannot fall back to a manual override.
- Rough flat/descent vpower no longer creates effort pseudo-intervals without HR; segment coverage and half-by-half dynamics use recording-time weights.
- Grouped repeats retain coverage and vpower limitations; segments merged across short stops no longer inherit first-part dynamics or route samples. Spatially validated grade is retained for recording intervals up to 30 seconds.
- Missing decoupling or temperature is no longer formatted as a measured zero in AI prompts.
- Corrected heart-rate zone names and six untranslated Russian UI labels.
- Prevented stale analyses and their old model replies from feeding into re-analysis prompts.

## 0.13.32 - 2026-10-02

### Fixed

- Chart width no longer changes when overlays are toggled: the right margin is always sized for both overlay axes.
- Each overlay color keeps its own axis column, so overlay axes never overlap and one axis never moves when the other is toggled.
- Chart margins are set in screen pixels, so first and last axis labels fit without being clipped or shifted at any panel size.
- Axis labels, axis titles and the crosshair keep their size and proportions on narrow or tall panels.
- Axis ticks, including overlay axis ticks, are no longer drawn beyond the data range.
- Axis labels are larger (13 px, axis titles 14 px) for readability.
- Y-axis tick density adapts to the panel height, so labels never overlap on low panels: grid lines stay, and only every second label is shown when space is short; the Y-axis title is hidden when it is taller than the plot.
- Overlay toggles are no longer shown above charts that have no data (for example heart rate on rides without a heart-rate sensor).

## 0.13.25 - 2026-09-07

### Fixed

- Fixed manual activity

## 0.13.24 - 2026-09-03

### Added

- Added independent, color-matched Y-axis scales on the right side of activity charts for active metric overlays. Up to two overlay scales can be shown at once.
- Added active overlay values to the chart crosshair, including localized labels and units, with each value shown in the color of its overlay line.

### Changed

- Increased overlay Y-axis tick density while suppressing only labels that would visually collide, including collisions caused by ticks clamped to the chart edges.
- Removed the overlapping upper kilometer labels from charts while retaining the vertical distance markers and bottom distance axis.

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
