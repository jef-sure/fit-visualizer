# FIT Visualizer

Visualize and analyze cycling and running FIT files directly in VS Code.

FIT Visualizer builds a local ride database and gives you fast charts, route maps, ride comparisons, heart-rate zones, automatic effort segmentation, and AI-assisted activity analysis grounded in your own training history.

## Highlights

- Open FIT files in a custom visual editor
- Auto-index rides into local SQLite storage
- Compare two activities in one view
- Speed, heart rate, and altitude charts by distance — with adaptive axis labels that add detail as you resize
- Overlay any two extra metrics (grade, altitude, speed, heart rate) on top of a chart
- Shared crosshair across all three charts: hover one, see the exact value at that point on all of them
- Render GPS track on an interactive map, with Ctrl/Cmd + scroll to zoom so scrolling the page doesn't fight the map
- Automatic ride segmentation — splits a ride into climbs, descents, flats, and stops, and estimates effort with a physics-based power model on climbs or heart rate elsewhere, honestly labeling which one applies to each segment
- Wheel-circumference calibration hint — compares your wheel sensor's distance against GPS on trustworthy straight stretches and suggests a correction when there's enough evidence, silent otherwise
- Save dated heart-rate zone profiles
- Generate AI analysis of the current ride in the context of comparable past rides, recent training load, and personal records
- Re-analyze activities in bulk after an update changes how analysis works, instead of doing it one by one

## Requirements

- GitHub Copilot Chat, installed and signed in — AI analysis runs through it. Everything else (charts, map, segmentation, zones, calibration) works without it.

## Quick Start

1. Open the folder that contains your FIT files.
2. Run **FIT: Index New Files**.
3. Open a FIT file or run **FIT: Browse Loaded Data**.
4. (Optional) Configure your Heart Rate Zone Profile.
5. Click **Analyze Activity**.

## Commands

- FIT: Visualize File
- FIT: Browse Loaded Data
- FIT: Index All Files
- FIT: Index New Files
- FIT: Index This File
- FIT: Re-analyze Outdated Analyses — re-runs AI analysis for every activity whose stored analysis predates the current analysis format, instead of clicking through each one by hand

Right-click a `.fit` file in the Explorer for two shortcuts to the commands above — **Visualize File** and **Index This File** — nothing else is added there; segmentation, analysis, and everything else still happens inside the visual editor once the file is open.

## Effort Segmentation

Each ride is split into segments by terrain (climb, descent, flat) and by effort within each terrain type, plus stops. Segments show duration, distance, average grade, and an effort estimate:

- **Climbs** (grade steep enough that gravity dominates over aerodynamics) use a physics-based virtual power estimate from your mass, grade, and speed.
- **Everywhere else** — flats, descents, technical sections — use heart rate, since virtual power isn't reliable where aerodynamic drag and wind matter more than grade.
- Segments where speed data itself is unreliable (technical descents, poor GPS reception) are marked as such, with no effort number attached rather than a misleading one.

This segmentation also feeds the AI analysis, so it can reason about specific intervals rather than only ride-wide averages.

Thresholds (grade cutoff, minimum segment length, stop detection, GPS trust window, etc.) are configurable — see **Settings** below — and are meant to be tuned to your own terrain and riding style rather than used as fixed defaults.

## Wheel Calibration

If your bike uses a wheel speed sensor, its distance depends on a configured wheel circumference — which drifts if tire pressure changes or was mismeasured to begin with. FIT Visualizer compares the sensor's distance against GPS on long, straight, well-tracked stretches across your recent rides, and — only once there's enough trustworthy distance accumulated and the deviation is real, not GPS noise — suggests a corrected circumference. It stays silent otherwise; there's no partial progress indicator to watch.

## AI-Assisted Analysis

Analysis runs through GitHub Copilot's chat models (whichever model your Copilot picker is currently using — this can change over time, and each request logs which one answered). Analysis considers:

- The current ride's own stats and segment breakdown
- Comparable prior rides (similar distance) for baseline context
- Recent training load and personal records
- Recent AI analyses of other rides (last 30 days, or the most recent one if the last month is empty), so trends carry across rides rather than resetting each time

Prompts and responses are logged locally (see **Settings**) so you can review exactly what was sent and received.

## Heart-Rate Zones

- Supports dated zone profiles
- Auto-calc uses sex, age, resting HR, and observed max HR
- Manual overrides can be saved and reused

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `fitVisualizer.maxHeartRate` | — | Legacy fallback max HR; prefer a dated zone profile in the activity view. |
| `fitVisualizer.logLlmRequests` | `true` | Write each Copilot prompt/response to `.fit-visualizer/logs`. |
| `fitVisualizer.llmLogRetentionDays` | `30` | Delete request logs older than this; `0` keeps them indefinitely. |
| `fitVisualizer.segmentation.gradeThresholdPct` | `2.5` | Grade (%) separating climbs/descents from flat terrain. |
| `fitVisualizer.segmentation.gradeHysteresisPct` | `0.5` | Extra margin required to switch terrain type, to stop flapping right at the threshold. |
| `fitVisualizer.segmentation.minSegmentSeconds` | `45` | Shorter segments get merged into a neighbor. |
| `fitVisualizer.segmentation.technicalGradePct` | `-8` | Descent grade below which an erratic speed trace marks the segment as technical (no effort estimate). |
| `fitVisualizer.segmentation.effortWindowSeconds` | `10` | Averaging window before splitting a segment into intervals. |
| `fitVisualizer.segmentation.effortCostThreshold` | — | Merge-cost limit for interval detection; left empty, it's derived from the ride's own noise level. |
| `fitVisualizer.segmentation.stopSpeedKmh` | `1` | Speed at/below which a record counts as stopped. |
| `fitVisualizer.segmentation.stopMinSeconds` | `10` | Minimum duration to count as a stop or auto-paused gap. |
| `fitVisualizer.segmentation.gpsTrustMinKm` | `1` | Minimum continuous, straight distance before a GPS window can confirm — or calibrate against — the recorded speed. |

Segmentation thresholds are tuned for typical road/gravel riding; if your terrain is very different (very short punchy climbs, near-constant technical trail), expect to adjust them.

## Local Data

- Database: `.fit-visualizer/fit-data.sqlite`
- Copilot request/response logs: `.fit-visualizer/logs` (see `logLlmRequests`/`llmLogRetentionDays` above)
- Scope: workspace-local (or selected folder)
- Indexed rides persist between sessions
