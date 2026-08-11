# FIT Visualizer

Visualize and analyze cycling FIT files directly in VS Code.

FIT Visualizer builds a local ride database and gives you fast charts, route maps, ride comparisons, heart-rate zones, and AI-assisted activity analysis.

## Highlights

- Open FIT files in a custom visual editor
- Auto-index rides into local SQLite storage
- Compare two activities in one view
- View speed, heart rate, and altitude by distance
- Render GPS track on an interactive map
- Save dated heart-rate zone profiles
- Generate analysis from current and historical rides

## Quick Start

1. Open the folder that contains your FIT files.
2. Run FIT: Index New Files.
3. Open a FIT file or run FIT: Browse Loaded Data.
4. (Optional) Configure Heart Rate Zone Profile.
5. Click Analyze Activity.

## Commands

- FIT: Visualize File
- FIT: Browse Loaded Data
- FIT: Index All Files
- FIT: Index New Files
- FIT: Index This File

FIT files also include Explorer context-menu actions.

## Heart-Rate Zones

- Supports dated zone profiles
- Auto-calc uses sex, age, resting HR, and observed max HR
- Manual overrides can be saved and reused

## Local Data

- Database: .fit-visualizer/fit-data.sqlite
- Scope: workspace-local (or selected folder)
- Indexed rides persist between sessions
