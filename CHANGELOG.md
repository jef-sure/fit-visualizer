# Changelog

## 0.26.9 - 2026-10-04

### Fixed

- The route card on a partial ride now says it plainly: "This ride: 33.7 km, only part of it on this 20.9 km route; the facts below describe the route" — instead of showing the route's 20.4 km as if the ride had covered it. Full same-direction/reversed rides are unaffected; the card's numbers are route facts by design and stay the same across rides of one route.

## 0.26.8 - 2026-10-04

### Fixed

- **Switching activities could silently stop updating the page** (route card and everything else), traced to a crash risk introduced in 0.26.7: the model-picker's default-label lookup called the async `selectPreferredModel` without `await`. A throw inside an async function becomes a rejected promise, not a synchronous exception, so the surrounding `try/catch` never caught it; the rejection went unhandled on a later tick, which Node's default behavior turns into a crash of the process the extension host runs in. This fired whenever a pinned model id (`analysisModelId` or the new `comparisonModelId`) was momentarily unavailable — plausible with a flaky BYOK endpoint mid-session.
- The middle-tier model default (comparison and chat) was unreachable whenever any offered model had a known price, because that check ran before the tier check. It also matched `gpt-5-mini` as middle tier on the `gpt-5` substring; cheap and flagship markers are now excluded from the middle-tier match.

## 0.26.7 - 2026-10-04

### Changed

- **Comparison and chat default to a middle-tier model** (sonnet/gemini/gpt-5 class: a named middle tier when one is listed, else the median of the price-ranked list), with their own pins `fitVisualizer.comparisonModelId` and `fitVisualizer.chatModelId` and dropdown labels naming the model each default resolves to. The analysis keeps its cheapest-model default and `analysisModelId`.

## 0.26.6 - 2026-10-04

### Changed

- **AI comparison and follow-up chat follow the same model policy as the analysis** (picked model, else the pinned one, else the cheapest) and both get their own model dropdown next to the trigger button. Before, they silently took the vendor's first-listed model, which in practice meant the most expensive one for every comparison.

## 0.26.5 - 2026-10-04

### Fixed

- Selecting another activity sometimes did not change the page: the render waits for the model list, and `selectChatModels()` without a vendor filter waits for every provider — one slow BYOK endpoint froze it indefinitely. The call is now bounded by a 3 s timeout in both the activity page and FIT: Select Analysis Model; on timeout the picker falls back to an empty list rather than blocking the page.

## 0.26.4 - 2026-10-04

### Changed

- Analysis format 34: the analysis prompt now forbids the fabrication patterns seen in model testing on 39 rides: a split delta must be quoted at its own mark and never generalized to a stretch it does not cover (with its sign kept), segment numbers and km marks are different axes that cannot reference km beyond the ride's length, and an invented instruction or preference may never be presented as the user's own words. Principles budget grows to fit.

## 0.26.3 - 2026-10-04

### Fixed

- A climb segment whose virtual-power estimate was downgraded to "rough description only" (a motion-estimate check failed, even at the same grade as a neighbouring segment) used to leave the Effort cell quietly blank. It now says **vPower n/a**, with the estimate and the reason in the hover title, in both the segment table and the map/chart hover tooltip.

### Changed

- **Route card redesigned.** "Rides on this route" and direction are now a badge, length/ascent/descent are metric tiles matching the rest of the page, and climbs are pill badges instead of a run-on sentence.

## 0.26.2 - 2026-10-04

### Fixed

- BYOK and other non-copilot models can be chosen for analysis. The model picker (analysis card and FIT: Select Analysis Model) lists every model the editor offers, and a picked or pinned model id is resolved across vendors; before, everything filtered by the configured vendor and such models never appeared.

## 0.26.1 - 2026-10-04

### Upgrade Notes

- Install and open the extension; a progress notification shows the background rebuild of segments and checkpoints. Then run **FIT: Re-analyze Outdated Analyses** if you upgraded from before format 33.

### Fixed

- The automatic background rebuild of derived features now shows the same progress notification as the manual one ("FIT Visualizer: rebuilding derived features", N/M); before, it ran invisibly and there was no way to tell old segments from new.

## 0.26.0 - 2026-10-04

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 33). Segments and checkpoints are recomputed in the background on the first start; re-indexing is not required.

### Changed

- **Checkpoints sit at segment boundaries, and prior rides are matched by place on the road, not by kilometre.** The fixed 2-km grid is gone: a mark is placed at every segment boundary, long stretches between boundaries gain an extra mark every 2 km, and each mark carries its GPS position. When this ride's marks are compared with prior rides of the same route, a prior mark counts when it stands within 150 m of the same place — so two rides with different segmentation are still compared point-to-point, and marks that exist only in one ride simply get no line instead of a false pairing. The two-activity comparison table pairs marks the same way.
- **Segments follow the effort, not the terrain.** Until now a ride was cut by grade (2.5 %) and a segment of "flat" could hold 14 minutes at anything from 16 to 40 km/h. Now the ride is cut where heart rate or power settles at a different level: a step of about 5 bpm or 30 W that lasts at least a minute starts a new segment. Terrain only names the segment (climb, descent, flat). The method was picked from ten candidates on 39 real rides (see `scripts/segmentation-lab`): within a segment of the open stretch the heart rate varies by about 2 bpm, and there, where 25 km/h is easy and 19 km/h is hard, the two are told apart (about 15 bpm between them).
- Heart rate is read 20 s back, because it trails the effort that causes it. Power (measured or estimated) is the second channel and takes over when heart rate is missing; rides with neither fall back to grade.
- A typical ride now has 20–25 segments per hour instead of about 5, so the prompt's segment-line guideline is 32 per hour. Only alternating work/rest patterns (three or more repeats) are collapsed into one line; a run of same-kind segments is no longer merged, because the new segmentation separated them on purpose.
- The prompt's character budget for the segment block grows from 1600 to 4000 for the same reason.
- Settings: `effortMinSegmentSeconds` (60), `effortHrStepBpm` (5) and `effortPowerStepWatts` (30) replace `effortWindowSeconds`, `minEffortMacroSeconds`, `effortMergeTolerancePct` and `effortCostThreshold`.

### Added

- `scripts/segmentation-lab`: the experiment harness behind the choice (strategies, metrics, HTML reports). Not part of the extension package.

## 0.25.0 - 2026-10-04

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 31). Derived features rebuild themselves in the background; re-indexing is not required.

### Added

- **Analysis model dropdown**: the analysis card shows the model that produced the analysis and a Model selector listing the models the current vendor offers (with a default entry naming the model it resolves to). Choosing a model and pressing **Analyze Again** re-analyzes with that model as a one-off, without changing the pinned setting, so the same ride can be compared across models.

### Changed

- **The analysis reads like a coach, not a report**: the prompt now has a Voice section — second person in one register, plain sentences, a caveat stated once where it changes the conclusion, a couple of numbers per point, and the answer's own headings. Zone and class names (recovery, endurance, tempo, threshold, VO2max, mixed, unstructured, undetermined) are translated, not left in English inside another language.

### Fixed

- The model signature under the analysis ("Analyzed by …") now substitutes the placeholders; a template-literal escaping bug left "{0} · {1} · {2}" on screen.
- Form fields, selects and textareas use a dedicated, clearly visible border on dark themes, with a shared focus style.
- The data-quality flags block was printed twice in the analysis prompt; the chat prompt also duplicated the route context and the altitude block.
- `OFFSET_CHANGED` never reached a prompt; it is now appended to the ride's own flags.
- The activity page always rendered the session-class and data-quality chips empty.
- The route filter's "All routes" hid every routed ride; filtering is now one round trip that keeps a consistent selection.
- Route-page checkpoint medians use the latest five rides before this one, matching the prompt.
- A hike with a "trail" sub-sport no longer maps to running.
- The derived-feature rebuild is serialized with every other database writer, so a background rebuild cannot overwrite freshly stored analyses.

## 0.24.0 - 2026-10-04

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 30). Derived features rebuild themselves in the background; re-indexing is not required.

### Added

- **Sport profiles**: running, hiking, walking and swimming now get their own units and vocabulary in the analysis. Running and walking show pace in min/km and cadence in steps/min, swimming shows min/100 m, and hiking keeps km/h with ascent/descent as the point of the ride. Power metrics are cycling-only and are hidden for the other sports, and each non-cycling sport gets a short cue in the prompt (for example, swimming mentions min/100 m and SWOLF).

## 0.23.0 - 2026-10-04

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 29). The derived-feature cache rebuilds itself in the background (it now stores per-ride checkpoints for the route section).

### Added

- **Route section detail**: the activity page now shows checkpoint splits against the median of the latest same-direction rides, the typical speed by route section, and a mini chart of the final climb time across rides.
- **Route filter** in the activity list: a selector narrows the activity and comparison lists to one route, and the choice is remembered.

### Changed

- Long segments (10+ min) now report cadence and the temperature span; the temporal-halves line gains the temperature.
- A climb of at least 3 min followed by a minute of continuous movement reports the post-climb HR drop (descriptive; suppressed on a stop or an HR gap).
- The period block reports RPE against TRIMP when session notes carry RPE (descriptive, no correlation below six rides).

## 0.22.0 - 2026-10-04

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 28). Rebuilding derived features and re-indexing are not required.

### Added

- **Model signature and picker**: the analysis card shows "Analyzed by `<modelId>` · format `<N>` · `<date>`", and the answering model id is stored with the analysis. A new **FIT: Select Analysis Model** command lists the models the current vendor offers (plus a default/cheapest entry) and writes `fitVisualizer.analysisModelId`.
- **Session notes in the manual-activity form**: **FIT: Add Manual Activity** now asks for the same five optional notes as the activity page (RPE, purpose, feeling, conditions, note), stored in `activity_notes`.

### Changed

- **Chat and comparison follow the coaching principles**: both prompts now include the numbered principles, the session notes (and AI-inferred notes) of the activities, data-quality flags, and the same-route/route-profile context. The comparison states the route relation (same route, same/reversed direction, or different) and shows an aligned checkpoint table only on the same route; different routes drop checkpoints. The chat no longer appends a SUMMARY tail and explains in-segment slowdowns from the route-stretch breakdown first.
- **LLM log retention compresses instead of deleting**: a log past its retention keeps its metric fields (response, promptBlocks, overBudget, modelId, analysisVersion) and drops only the prompt; only after three times the retention is the whole file removed, so `check.js` history survives while space is reclaimed.

## 0.21.0 - 2026-10-04

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 27). Rebuilding derived features and re-indexing are not required.

### Added

- **Data-quality flags** ([data-quality.js](./data-quality.js)): one place that turns measured recording quirks into `warn`/`info` flags — heart-rate dropout, late start, contact loss, absent HR, a hot device (temperature is device, not air), elapsed mismatch, timezone/offset change, speed-sensor/GPS mismatch, smart recording and GPS gaps. Warn flags reach the prompt as a single short block with the rule to use each once where it changes a conclusion; the activity page shows all of them as chips.
- **Barometer-settling figures**: when the altitude flag `ALT_SETTLING` is set, the workout fields add the ascent/descent recomputed from the settled moment with a reference to the flag, instead of the drift-skewed opening.
- **Observed max HR with provenance**: auto-calculated max HR now uses the highest 15-second rolling average across rides and records where it came from (activity, date, window). The prompt states the source (`Max HR Source: observed 15 s window 171 bpm on 2026-08-14 / formula 172`), and the profile form flags an observed peak more than 15 bpm above the formula.
- **Session class and data-quality chips** on the activity page, with the class evidence in a tooltip.

### Changed

- **Two-level session notes**: the SUMMARY tail now also produces `purpose` and `conditions` that the model infers from the ride's data, and the Session Notes form pre-fills with them, marked as AI-inferred. A user-declared value always wins field by field (a declared purpose suppresses the inferred purpose, declared conditions suppress the inferred conditions); saving any note makes it the user's own. The prompt shows both sources separately.
- The **Same-Route Context** budget is raised to 2200 characters (checkpoint rows now carry prior best and prior median HR).

## 0.20.2 - 2026-10-04

### Removed

- The **FIT: Rebuild Derived Features** command. Indexing (**FIT: Index All Files / New / This File**) now rebuilds the derived-feature cache and routes as part of the same run, and updates that change the derived-feature format rebuild it in the background on the next start. There is no separate step to remember.

## 0.20.1 - 2026-10-04

### Changed

- **Derived features rebuild themselves**: after an update that changes the derived-feature version, the cache and routes are rebuilt once, silently in the background when the extension starts (the derived-feature version bump to 2 makes the previous cache stale). The **FIT: Rebuild Derived Features** command remains for manual use, but upgrades no longer ask you to run it.

## 0.20.0 - 2026-10-04

### Upgrade Notes

- Run **FIT: Rebuild Derived Features** once (the elevation consensus now includes rides in the opposite direction), then **FIT: Re-analyze Outdated Analyses** (analysis format 26). Re-indexing is only needed to restore the device ascent/descent figures (they were stored scaled by 1000 in earlier versions).

### Added

- **Route-stretch breakdown**: a long flat segment on a known route is broken at direction-effect and section boundaries, and each stretch's speed is compared with the median for that section in this riding direction, with a computed verdict ("speed follows the route; HR rises N bpm at route-typical speed", "slower than route-typical on km X-Y", …). A route-typical speed change is no longer presented as this ride's dynamics, and the prompt forbids listing its cause as an open question. Replaces the temporal-halves line for routed segments.
- **Checkpoint verdicts**: checkpoint rows add the prior best time and the prior median HR, and one computed line states whether the ride was faster or slower at higher, similar or lower heart rate ("3:15 faster at HR 159 vs 139 — more effort, not evidence of efficiency").
- **Reversed rides in the elevation consensus**: the route consensus is built from both directions (23 of 34 loop rides instead of 20); settling detection mirrors the profile so the ride's first minutes stay first. Ride 158 now gets its `ALT_SETTLING`.

### Fixed

- A device that wrote no ascent figure (stored 0/0) is no longer shown as a disagreeing source in the workout fields.
- Session ascent/descent parsed in kilometres was stored without scaling (0.128 instead of 128 m); **FIT: Index All Files** restores the real figures.

### Changed

- The route profile block drops the per-section speed table (kept in the segment breakdown); it gains the rule not to ask about wind where a direction effect explains the stretch.
- History rows: full summaries for the three latest only, the whole block is capped at 4500 characters by dropping whole oldest entries; routed rides drop the ascent line; `peak20` appears only for threshold/VO2max classes.
- The SUMMARY tail asks for one question whose answer would change the advice — "usually none".
- Candidate segment comparisons and the full previous-analysis text are omitted for rides with a GPS-confirmed route (or a stored summary).
- Prompt size on the 39-ride database: mean 21.8k characters (was 24.7k).

## 0.19.1 - 2026-10-04

### Changed

- Documentation: the AI-assisted analysis section of both READMEs now describes the current prompt (session notes, heuristic session class, same-route context with checkpoints and the route-typical pattern, derived route profile, altitude-quality flags, per-session intensity and structured AI summaries in history, the two-message layout with fifteen principles) instead of the pre-0.17 layout; the local-data section lists the derived tables and what survives a rebuild; `fitVisualizer.analysisModelId` is in the settings table. A test now checks that every contributed setting appears in both READMEs.

## 0.19.0 - 2026-10-03

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 25). Notes you enter are used by the next analysis of that ride; changing notes does not mark a saved analysis as outdated, so re-analyze the ride explicitly.

### Added

- **Session notes** on the activity page: perceived effort (RPE 1-10), purpose (commute, endurance, tempo, intervals, recovery, race, social, other), feeling, conditions (headwind, tailwind, rain, heat, cold, group, traffic, night, new route) and a free note, all optional. The analysis and chat prompts receive them as user-declared facts: the declared purpose replaces the inferred training direction, RPE is treated as the athlete's own measure of effort, and the model is told not to ask again for what is declared. Earlier rides in the history carry their RPE and purpose.
- Without notes the prompt tells the model where they are entered and that asking for them is a data suggestion, not pacing advice. Previous analyses asked for RPE and wind in 16 of 39 answers and filed it under pacing.

## 0.18.3 - 2026-10-03

### Added

- **Route card on the activity page**: for a ride on a repeated route, a "Route" section shows the number of rides, the direction of this ride relative to the first one, length, ascent/descent and the climbs derived from the data, with an editable route name and a note about the route (terrain, usual wind). The note is included in the AI analysis of every ride on that route; re-analyze saved analyses to apply a changed note. The derived figures appear after the first analysis of a ride on that route.

### Removed

- The **FIT: Edit Route Note** palette command (quick pick plus input box); the same note is edited in the route card next to the ride it describes.

## 0.18.2 - 2026-10-03

### Removed

- The developer command **FIT: Evaluate Analysis Prompt** (and its `eval/` output). Prompt checks run offline on the existing LLM logs with `node scripts/prompt-eval/check.js <folder> [baseline-folder]`; the script and its checks are no longer part of the packaged extension.

## 0.18.1 - 2026-10-03

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 24). Re-indexing is not required; the route profile is computed from stored records on first use.

### Added

- **Derived route profile**: for a route with enough rides, the prompt now states what the data show about the route itself - its length and ascent, the climbs in the current riding direction (from the elevation consensus at 100 m resolution, so a short steep ramp is not averaged away), the typical moving speed per 2 km section in this direction versus the opposite one with the section grade, and near-flat stretches where one direction is clearly slower than the other. For the development loop this surfaces, without any manual note, that km 4-10 is ridden at about 27.5 km/h one way and 21-23 km/h the other, and the reverse for km 10-16: a direction effect consistent with prevailing wind or surface, not a fitness signal. Wind itself is never inferred or claimed.

## 0.18.0 - 2026-10-03

### Upgrade Notes

- Run **FIT: Re-analyze Outdated Analyses** (analysis format 23). Optionally run **FIT: Edit Route Note** first to describe your routes (for example "second half climbs, often a headwind") so the note is used in the re-analysis.

### Added

- **Route-typical pattern**: for a route with at least five comparable earlier rides, the prompt states in how many of them the second half is slower than the first and the median drop, and where this ride falls among them. A regular pattern (for the development loop, 17 of 19 rides) is presented as a property of the route; the model is told to discuss only how the ride differs from it, instead of re-raising "late slowdown: effort or wind?" in every analysis.
- **FIT: Edit Route Note**: a user note per route (terrain, prevailing wind) that is added to every analysis of that route.

### Changed

- Same-route comparisons (checkpoint splits, final-climb history, route-typical pattern) now use only rides in the same direction as the current one. 14 of the 36 loop rides in the development database are ridden in the opposite direction; mixing both directions compared opposite climbs and winds. Partial rides no longer get split comparisons. The route elevation consensus still covers the first-ride direction only.
- The summary's `open` field excludes route-wide patterns.

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
