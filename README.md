# FIT Visualizer

FIT Visualizer is a VS Code extension for cyclists who want fast, local insight from `.fit` files without leaving their editor.

It indexes your rides into SQLite, gives you rich activity views (charts, map, comparisons, HR zones), and can generate analysis with Copilot using the data you actually have.

This repository follows a clean split of responsibilities:

- `cycSync.py` downloads FIT files from the Cycplus device.
- `fit-visualizer/` parses, indexes, visualizes, and analyzes those files.

## What It Can Do

- Open any `.fit` file directly in a custom visual editor.
- Auto-index files when needed, so the first open just works.
- Index all files, only new files, or one selected file.
- Browse already indexed activities without reparsing.
- Compare two rides in one view.
- Render speed, heart rate, and altitude vs distance charts.
- Render GPS route with an interactive map overlay.
- Store manual average/max HR for rides where HR summary is missing.
- Generate AI analysis from current-ride + historical context.

## Heart Rate Zones: Stable, Dated, and Override-Friendly

The extension supports practical real-world HR behavior:

- **Dated profiles:** zone settings are tied to an effective date.
- **Stable fallback:** if an activity has no date-matching profile, the last saved profile is used.
- **Auto-calc first:** use sex, age, resting HR, and observed HR maxima from your database.
- **Manual override next:** edit auto values before saving.

### Auto-calc Inputs

- Sex
- Age
- Resting HR
- Observed max HR from your indexed data

### Auto-calc Method

- Formula-based max HR baseline by sex and age
- Karvonen reserve for zone starts (Z2-Z5)
- Final max HR uses the stronger signal between formula and observed data

### Data Persistence

- Dated zone profiles are saved in `heart_rate_profiles`.
- Athlete inputs (sex, age, resting HR) are saved in `athlete_profile` for reuse.
- Saving HR profile changes invalidates cached analyses so results regenerate with current settings.

## Analysis Behavior (Designed to Avoid Misleading Claims)

- Uses only data available for that activity and allowed history context.
- Excludes future rides from baseline/trend computation.
- Compares against distance-compatible prior rides (not arbitrary sessions).
- Explicitly handles low-history situations (for example, first training rides).

## Commands

- **FIT: Visualize File**
- **FIT: Browse Loaded Data**
- **FIT: Index All Files**
- **FIT: Index New Files**
- **FIT: Index This File**

`.fit` files also get context-menu actions in Explorer.

## Typical Workflow

1. Download rides with `cycSync.py`.
2. Run **FIT: Index New Files**.
3. Open a ride or use **FIT: Browse Loaded Data**.
4. If needed, set/auto-calc HR zones in **Heart Rate Zone Profile**.
5. Click **Analyze Activity** for generated training commentary.

## Data Storage

- Main database: `.fit-visualizer/fit-data.sqlite`
- Scope: workspace-local (or selected folder, depending on indexing entry point)
- Existing data is reused across sessions.
