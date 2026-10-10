const path = require('node:path');
const vscode = require('vscode');

function registerCommands(context, services) {
  const {
    addAndBrowseManualActivity,
    escapeHtml,
    getLocalDbPath,
    indexFitFolder,
    indexFitUris,
    openActivityBrowser,
    pickSingleFitFile,
    prepareFitForVisualization,
    reanalyzeOutdatedActivities,
    reanalyzeSelectedActivities,
    rebuildDerivedFeatures,
    rememberDatabasePath,
    resolveActiveDbPath,
    resolveFitUri,
    selectAnalysisModel,
    selectDatabaseFolder,
    showActivityBrowserInPanel,
    updateModelPriceTable,
    upgradeBeforeOpening,
  } = services;

  const register = (command, errorPrefix, handler) => vscode.commands.registerCommand(
    command,
    (...args) => runCommand(errorPrefix, () => handler(...args))
  );

  const openFit = register('fitVisualizer.openFit', 'FIT visualization failed', async (resource) => {
    const targetUri = await resolveFitUri(resource);
    if (!targetUri) {
      vscode.window.showInformationMessage('Select a .fit file in Explorer or open one in the editor.');
      return;
    }

    const { dbPath, activityId } = await prepareFitForVisualization(targetUri.fsPath);
    await openActivityBrowser(context, dbPath, activityId);
  });

  const browse = register('fitVisualizer.browse', 'FIT browser failed', async () => {
    const dbPath = await resolveActiveDbPath() || await selectDatabaseFolder();
    if (dbPath) {
      await openActivityBrowser(context, dbPath);
    }
  });

  const indexAll = register('fitVisualizer.indexAll', 'FIT DB index failed', () => indexFitFolder(false));
  const indexNew = register('fitVisualizer.indexNew', 'FIT DB index failed', () => indexFitFolder(true));
  const updateModelPrices = register(
    'fitVisualizer.updateModelPrices',
    vscode.l10n.t('FIT model price update failed'),
    () => updateModelPriceTable()
  );

  const selectModel = register(
    'fitVisualizer.selectAnalysisModel',
    vscode.l10n.t('FIT model selection failed'),
    () => selectAnalysisModel()
  );

  const reanalyzeOutdated = register(
    'fitVisualizer.reanalyzeOutdated',
    'FIT re-analysis failed',
    () => reanalyzeOutdatedActivities()
  );

  const reanalyzeSelected = register(
    'fitVisualizer.reanalyzeSelected',
    'FIT re-analysis failed',
    (selection) => reanalyzeSelectedActivities(typeof selection === 'string' ? selection : undefined)
  );

  const indexOne = register('fitVisualizer.indexOne', 'FIT DB index failed', async (resource) => {
    const targetUri = resource?.fsPath?.toLowerCase().endsWith('.fit')
      ? resource
      : await pickSingleFitFile();
    if (!targetUri) {
      return;
    }

    const baseDir = vscode.workspace.getWorkspaceFolder(targetUri)?.uri.fsPath
      || path.dirname(targetUri.fsPath);
    const dbPath = await getLocalDbPath(baseDir);
    await rememberDatabasePath(dbPath);
    const result = await indexFitUris([targetUri], dbPath, 'Indexing one FIT file...');
    // Re-indexing replaces the records, and the cached segments, checkpoints and route of the
    // ride are derived from them; routes are derived oldest ride first, so the whole set is redone.
    await rebuildDerivedFeatures({ silent: false, skipStaleCheck: true, reason: 'indexing', dbPath });
    vscode.window.showInformationMessage(
      vscode.l10n.t('FIT DB index complete: {0} indexed, {1} failed.', result.saved, result.failed)
    );
  });

  const addManual = register(
    'fitVisualizer.addManualActivity',
    'Add manual activity failed',
    () => addAndBrowseManualActivity()
  );

  const customEditor = vscode.window.registerCustomEditorProvider(
    'fitVisualizer.fitEditor',
    createFitEditorProvider(context, {
      escapeHtml,
      prepareFitForVisualization,
      showActivityBrowserInPanel,
      upgradeBeforeOpening,
    }),
    {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: true },
    }
  );

  return [openFit, browse, indexAll, indexNew, indexOne, addManual, reanalyzeOutdated, reanalyzeSelected, updateModelPrices, selectModel, customEditor];
}

function createFitEditorProvider(context, services) {
  return {
    openCustomDocument: async (uri) => ({
      uri,
      dispose() {},
    }),

    resolveCustomEditor: async (document, panel) => {
      try {
        const { dbPath, activityId } = await services.prepareFitForVisualization(document.uri.fsPath);
        panel.title = path.basename(document.uri.fsPath);
        // While an update puts the database in order, the tab says so instead of staying blank.
        await services.upgradeBeforeOpening(dbPath, () => {
          panel.webview.html = `<!DOCTYPE html><html><body><p>${services.escapeHtml(vscode.l10n.t('FIT Visualizer is putting the database in order after an update. The page opens when it is done.'))}</p></body></html>`;
        });
        await services.showActivityBrowserInPanel(context, panel, dbPath, activityId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.webview.html = `<!DOCTYPE html><html><body><h1>FIT visualization failed</h1><p>${services.escapeHtml(message)}</p></body></html>`;
        vscode.window.showErrorMessage(`FIT visualization failed: ${message}`);
      }
    },
  };
}

async function runCommand(errorPrefix, handler) {
  try {
    return await handler();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`${errorPrefix}: ${message}`);
    return undefined;
  }
}

module.exports = {
  registerCommands,
};
